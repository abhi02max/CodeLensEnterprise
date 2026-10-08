import type {
  PatchProposalView,
  PatchApplicationView,
  ValidationView,
  ValidationMlView,
  ValidationAiView,
} from '@codelens/shared';
import { parseUnifiedPatch } from './review-workspace';

export function executionActive(state: string): boolean {
  return ['QUEUED', 'PREPARING', 'APPLYING', 'RUNNING'].includes(state);
}

export function applicationMatches(p: PatchProposalView, a: PatchApplicationView): boolean {
  return (
    a.proposalId === p.id &&
    a.proposalRevision === p.revision &&
    a.proposalDigest === p.digest &&
    a.headSha === p.headSha &&
    a.baseSha === p.baseSha
  );
}

export function materializedAttempt(p: PatchProposalView, a: PatchApplicationView) {
  if (!applicationMatches(p, a) || a.status !== 'APPLIED' || a.cleanup !== 'DISPOSED') return null;
  const attempt = a.attempts.at(-1);
  if (
    !attempt ||
    attempt.status !== 'APPLIED' ||
    attempt.cleanup !== 'DISPOSED' ||
    !attempt.snapshotDigest ||
    !attempt.manifestDigest
  )
    return null;
  const paths = new Set(attempt.files.map((f) => f.path));
  if (paths.size !== attempt.files.length) return null;
  if (
    !p.files.every((f) => {
      const result = attempt.files.find((r) => r.path === f.path);
      return (
        result &&
        result.oldBlobSha === f.oldBlobSha &&
        result.oldContentHash === f.oldContentHash &&
        result.contentHash === f.newContentHash
      );
    })
  )
    return null;
  return attempt;
}

export function validationMatches(
  p: PatchProposalView,
  a: PatchApplicationView,
  v: ValidationView,
): boolean {
  const attempt = materializedAttempt(p, a);
  return (
    !!attempt &&
    v.applicationId === a.id &&
    v.proposalId === p.id &&
    v.proposalRevision === p.revision &&
    v.proposalDigest === p.digest &&
    v.headSha === p.headSha &&
    v.snapshotDigest === attempt.snapshotDigest &&
    v.candidateDigest === attempt.manifestDigest
  );
}

export function mlMatches(p: PatchProposalView, v: ValidationView, m: ValidationMlView): boolean {
  return (
    m.validationId === v.id &&
    m.applicationId === v.applicationId &&
    m.proposalId === p.id &&
    m.proposalRevision === p.revision &&
    m.proposalDigest === p.digest &&
    m.baseSha === p.baseSha &&
    m.headSha === v.headSha &&
    m.snapshotDigest === v.snapshotDigest &&
    m.candidateDigest === v.candidateDigest
  );
}

export function aiMatches(p: PatchProposalView, v: ValidationView, r: ValidationAiView): boolean {
  const l = r.lineage;
  return (
    r.validationId === v.id &&
    l.validationId === v.id &&
    l.applicationId === v.applicationId &&
    l.proposalId === p.id &&
    l.proposalRevision === p.revision &&
    l.proposalDigest === p.digest &&
    l.baseSha === p.baseSha &&
    l.headSha === v.headSha &&
    l.snapshotDigest === v.snapshotDigest &&
    l.candidateDigest === v.candidateDigest
  );
}

export function proposalPatch(patch: string | null | undefined) {
  if (!patch) return { state: 'UNAVAILABLE' as const, hunks: [] };
  // The shared parser accepts patch fragments; exclude the transport's final newline.
  const hunks = parseUnifiedPatch(patch.replace(/\n$/, ''));
  const complete =
    hunks.length > 0 &&
    hunks.every(
      (h) =>
        h.lines.filter((l) => l.type !== 'add').length === h.oldLines &&
        h.lines.filter((l) => l.type !== 'del').length === h.newLines,
    );
  return { state: complete ? ('AVAILABLE' as const) : ('PARTIAL' as const), hunks };
}
