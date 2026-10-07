import type { PullRequestDiffRevision } from '@codelens/shared';
import { parseUnifiedPatch } from '@codelens/github';

interface File {
  patch: string | null;
  patchTruncated: boolean;
  additions: number;
  deletions: number;
}
export function patchAvailability(file: File, verified: boolean) {
  if (!verified) return 'UNVERIFIED' as const;
  if (file.patch === null) return 'UNAVAILABLE' as const;
  const hunks = parseUnifiedPatch(file.patch);
  const lines = hunks.flatMap((hunk) => hunk.lines);
  const complete =
    hunks.length > 0 &&
    hunks.every(
      (hunk) =>
        hunk.lines.filter((line) => line.type !== 'add').length === hunk.oldLines &&
        hunk.lines.filter((line) => line.type !== 'del').length === hunk.newLines,
    ) &&
    lines.filter((line) => line.type === 'add').length === file.additions &&
    lines.filter((line) => line.type === 'del').length === file.deletions;
  return file.patchTruncated || !complete ? ('PARTIAL' as const) : ('AVAILABLE' as const);
}

export function diffRevision(row: {
  baseSha: string;
  headSha: string;
  changedFiles: number;
  diffBaseSha: string | null;
  diffHeadSha: string | null;
  diffMergeBaseSha: string | null;
  diffVerifiedAt: Date | null;
  files: File[];
}): PullRequestDiffRevision {
  const verified = Boolean(
    row.diffVerifiedAt &&
      row.diffMergeBaseSha &&
      row.diffBaseSha === row.baseSha &&
      row.diffHeadSha === row.headSha,
  );
  const states = row.files.map((file) => patchAvailability(file, verified));
  return {
    provenance: verified ? 'VERIFIED' : 'UNVERIFIED',
    baseSha: row.diffBaseSha,
    headSha: row.diffHeadSha,
    mergeBaseSha: row.diffMergeBaseSha,
    fileSet: !verified
      ? 'UNVERIFIED'
      : row.files.length === row.changedFiles
        ? 'COMPLETE'
        : 'PARTIAL',
    patches: !verified
      ? 'UNVERIFIED'
      : states.length === 0
        ? 'COMPLETE'
        : states.every((state) => state === 'UNAVAILABLE')
          ? 'UNAVAILABLE'
          : states.every((state) => state === 'AVAILABLE')
            ? 'COMPLETE'
            : 'PARTIAL',
  };
}
