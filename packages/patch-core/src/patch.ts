import { createHash } from 'node:crypto';
import { structuredPatch, formatPatch } from 'diff';
import { PATCH_LIMITS, PatchIntentSchema, type PatchIntent } from '@codelens/shared';
import type { ExactGitFile } from '@codelens/github';
export class PatchCoreError extends Error {}

export const patchHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function normalizePatch(raw: PatchIntent): PatchIntent {
  const parsed = PatchIntentSchema.parse(raw);
  return {
    ...parsed,
    files: parsed.files
      .map((f) => ({
        ...f,
        edits: [...f.edits].sort((a, b) => a.startLine - b.startLine),
        evidenceIds: [...f.evidenceIds].sort(),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function applyAndConstruct(file: PatchIntent['files'][number], source: ExactGitFile) {
  if (
    !source.modificationEligible ||
    source.kind !== 'REGULAR_FILE' ||
    source.mode !== '100644' ||
    source.content === null ||
    source.contentHash === null ||
    source.path !== file.path ||
    source.objectSha !== file.expectedBlobSha
  )
    throw new PatchCoreError('Patch source preconditions are not satisfied.');
  const lines = source.content.split('\n');
  // A trailing newline is not an additional editable line. Keep it in the suffix.
  const lineCount = lines.length - (source.content.endsWith('\n') ? 1 : 0);
  let result = source.content;
  const edits = [...file.edits].sort((a, b) => a.startLine - b.startLine);
  let previousEnd = 0;
  for (const edit of edits) {
    if (
      edit.replacement.includes('\0') ||
      Buffer.from(edit.replacement, 'utf8').toString('utf8') !== edit.replacement
    )
      throw new PatchCoreError('Replacement must remain UTF-8 text without binary NUL bytes.');
    if (edit.startLine <= previousEnd || edit.endLine < edit.startLine || edit.endLine > lineCount)
      throw new PatchCoreError('Patch range is invalid or overlapping.');
    previousEnd = edit.endLine;
    if (lines.slice(edit.startLine - 1, edit.endLine).join('\n') !== edit.expectedText)
      throw new PatchCoreError('Patch expected text does not match the pinned source.');
  }
  for (const edit of [...edits].reverse()) {
    const start = lines.slice(0, edit.startLine - 1).reduce((n, s) => n + s.length + 1, 0);
    const length = lines.slice(edit.startLine - 1, edit.endLine).join('\n').length;
    result = result.slice(0, start) + edit.replacement + result.slice(start + length);
  }
  if (result === source.content) throw new PatchCoreError('Patch contains no change.');
  const patch = structuredPatch(
    'a/' + file.path,
    'b/' + file.path,
    source.content,
    result,
    '',
    '',
    { context: 3, maxEditLength: PATCH_LIMITS.changedLines, timeout: 1000 },
  );
  if (!patch) throw new PatchCoreError('Diff complexity or changed-line limit exceeded.');
  const changedLines = patch.hunks.reduce(
    (n, h) => n + h.lines.filter((line) => line.startsWith('+') || line.startsWith('-')).length,
    0,
  );
  return {
    content: result,
    file: {
      path: file.path,
      operation: 'MODIFY' as const,
      oldBlobSha: source.objectSha,
      oldContentHash: source.contentHash,
      newContentHash: patchHash(result),
      diff: formatPatch(patch),
      edits,
      evidenceIds: file.evidenceIds,
      changedLines,
    },
  };
}

export function constructPatchFile(file: PatchIntent['files'][number], source: ExactGitFile) {
  return applyAndConstruct(file, source).file;
}

export function materializePatchFile(file: PatchIntent['files'][number], source: ExactGitFile) {
  return applyAndConstruct(file, source);
}

export function canonicalPatch(
  pins: { headSha: string; baseSha: string },
  intent: PatchIntent,
  files: ReturnType<typeof constructPatchFile>[],
) {
  const changedLines = files.reduce((n, f) => n + f.changedLines, 0);
  const serialized = JSON.stringify({
    version: 1,
    ...pins,
    summary: intent.summary,
    rationale: intent.rationale,
    limitations: intent.limitations,
    files,
  });
  if (
    changedLines > PATCH_LIMITS.changedLines ||
    Buffer.byteLength(serialized) > PATCH_LIMITS.bytes
  )
    throw new PatchCoreError('Canonical patch exceeds proposal limits.');
  return { digest: patchHash(serialized), changedLines };
}
