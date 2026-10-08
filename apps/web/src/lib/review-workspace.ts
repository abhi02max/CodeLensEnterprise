import type {
  PullRequestDetail,
  PullRequestFilesView,
  PullRequestFileView,
} from '@codelens/shared';
import { parseUnifiedPatch } from '../../../../packages/github/src/diff-parser';
import type { FindingView, ReviewSession } from './types';

export { parseUnifiedPatch };

export type PrDiffIdentity = Pick<
  PullRequestDetail,
  'id' | 'repository' | 'headSha' | 'baseSha' | 'diffRevision'
>;
export type DiffIdentity = { trusted: boolean; reason: string };
export function diffIdentity(
  session: ReviewSession,
  detail: PrDiffIdentity,
  diff: PullRequestFilesView,
): DiffIdentity {
  const a = detail.diffRevision;
  const b = diff.diffRevision;
  if (a.provenance !== 'VERIFIED' || b.provenance !== 'VERIFIED')
    return {
      trusted: false,
      reason: 'UNVERIFIED diff provenance. Stored patches are not shown as verified code.',
    };
  if (!a.baseSha || !a.headSha || !a.mergeBaseSha || !b.baseSha || !b.headSha || !b.mergeBaseSha)
    return { trusted: false, reason: 'Required diff revision identity is missing.' };
  if (
    session.pullRequestId !== detail.id ||
    diff.pullRequestId !== detail.id ||
    session.repository.id !== detail.repository.id ||
    session.pullRequest.headSha !== a.headSha ||
    detail.headSha !== a.headSha ||
    detail.baseSha !== a.baseSha ||
    diff.headSha !== b.headSha ||
    diff.baseSha !== b.baseSha ||
    a.headSha !== b.headSha ||
    a.baseSha !== b.baseSha ||
    a.mergeBaseSha !== b.mergeBaseSha ||
    a.fileSet !== b.fileSet ||
    a.patches !== b.patches
  )
    return {
      trusted: false,
      reason:
        'Revision mismatch between review, PR detail and diff. Refresh before relying on code or anchors.',
    };
  return {
    trusted: true,
    reason: 'Verified imported diff snapshot; not a live GitHub freshness check.',
  };
}

export type WorkspaceFinding = {
  key: string;
  source: 'STATIC' | 'AI';
  severity: string;
  title: string;
  explanation: string;
  path: string | null;
  line: number | null;
  evidence: string[];
  suggestion: string | null;
  staticFinding: FindingView | null;
};
export function workspaceFindings(session: ReviewSession): WorkspaceFinding[] {
  return [
    ...session.findings.map((f) => ({
      key: `static:${f.id}`,
      source: 'STATIC' as const,
      severity: f.severity,
      title: f.message,
      explanation: `${f.analyzer} / ${f.ruleId}${f.preexisting ? ' / pre-existing' : ''}`,
      path: f.path,
      line: f.line,
      evidence: [],
      suggestion: null,
      staticFinding: f,
    })),
    ...(session.aiReview?.findings ?? []).map((f, index) => ({
      key: `ai:${index}`,
      source: 'AI' as const,
      severity: f.severity,
      title: f.title,
      explanation: f.explanation,
      path: f.path,
      line: f.line,
      evidence: f.evidence,
      suggestion: f.suggestedFix,
      staticFinding: null,
    })),
  ];
}

export type FindingAnchor =
  | { mapped: true; path: string; line: number }
  | { mapped: false; reason: string };
export function findingAnchor(
  finding: WorkspaceFinding,
  session: ReviewSession,
  identity: DiffIdentity,
  diff: PullRequestFilesView,
  coordinateCache?: Map<string, Map<number, number>>,
): FindingAnchor {
  if (finding.source !== 'STATIC')
    return { mapped: false, reason: 'AI location has no authoritative side/revision anchor.' };
  if (!identity.trusted) return { mapped: false, reason: identity.reason };
  if (!session.run || session.run.stale || session.run.headSha !== diff.headSha)
    return { mapped: false, reason: 'Analysis revision does not match the displayed diff.' };
  if (!finding.path || !finding.line || !Number.isSafeInteger(finding.line) || finding.line < 1)
    return { mapped: false, reason: 'No usable path and NEW-side line.' };
  const files = diff.files.filter((file) => file.filename === finding.path);
  if (files.length !== 1)
    return { mapped: false, reason: 'File is absent or ambiguous in this snapshot.' };
  const file = files[0]!;
  if (file.patchAvailability !== 'AVAILABLE' || file.patchTruncated || !file.patch)
    return { mapped: false, reason: 'File patch is partial, unavailable or unverified.' };
  let coordinates = coordinateCache?.get(file.filename);
  if (!coordinates) {
    coordinates = new Map<number, number>();
    for (const hunk of parseUnifiedPatch(file.patch)) {
      for (const line of hunk.lines) {
        if (line.newLineNumber !== null)
          coordinates.set(line.newLineNumber, (coordinates.get(line.newLineNumber) ?? 0) + 1);
      }
    }
    coordinateCache?.set(file.filename, coordinates);
  }
  if (coordinates.get(finding.line) !== 1)
    return { mapped: false, reason: 'NEW-side line is outside the available hunks or ambiguous.' };
  return { mapped: true, path: finding.path, line: finding.line };
}

export function patchState(file: PullRequestFileView): string {
  if (file.patchAvailability === 'UNVERIFIED') return 'UNVERIFIED patch';
  if (file.patchAvailability === 'UNAVAILABLE' || !file.patch)
    return 'Patch unavailable; this does not establish that the file is binary.';
  if (file.patchAvailability === 'PARTIAL' || file.patchTruncated)
    return 'Partial patch; omitted content is not shown and findings remain unmapped.';
  return 'Available patch';
}
