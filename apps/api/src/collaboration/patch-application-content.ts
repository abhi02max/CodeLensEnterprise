import {
  materializeCandidate,
  MaterializationResultSchema,
  normalizePatch,
  type MaterializationRequest,
} from '@codelens/patch-core';
import type { ExactSnapshot } from '@codelens/github/dist/exact-git-snapshot';
import { PatchOperationSchema } from '@codelens/shared';

export type StoredApplicationProposal = {
  headSha: string;
  baseSha: string;
  digest: string;
  summary: string;
  rationale: string;
  limitations: string;
  files: Array<{
    path: string;
    operation: string;
    oldBlobSha: string;
    oldContentHash: string;
    newContentHash: string;
    diff: string;
    edits: unknown;
    evidenceIds: string[];
  }>;
};

/** Reconstruct intent from immutable server records, not worker or browser input. */
export function reconstructApplication(
  snapshot: ExactSnapshot,
  proposal: StoredApplicationProposal,
) {
  if (proposal.files.some((f) => f.operation !== 'MODIFY')) throw new Error('PROPOSAL_REJECTED');
  const intent = normalizePatch({
    summary: proposal.summary,
    rationale: proposal.rationale,
    limitations: proposal.limitations,
    files: proposal.files.map((f) => ({
      path: f.path,
      operation: 'MODIFY',
      expectedBlobSha: f.oldBlobSha,
      edits: PatchOperationSchema.array().parse(f.edits),
      evidenceIds: f.evidenceIds,
    })),
  });
  const payload: MaterializationRequest = {
    version: 1,
    snapshot,
    proposal: {
      headSha: proposal.headSha,
      baseSha: proposal.baseSha,
      digest: proposal.digest,
      intent,
    },
  };
  const candidate = materializeCandidate(payload);
  for (const file of proposal.files) {
    const original = candidate.originals.find((f) => f.path === file.path);
    const result = candidate.candidates.find((f) => f.path === file.path);
    if (
      !original ||
      !result ||
      original.contentHash !== file.oldContentHash ||
      result.contentHash !== file.newContentHash
    )
      throw new Error('PROPOSAL_REJECTED');
  }
  return { payload, expected: candidate.result };
}

export function verifyApplicationManifest(
  expected: ReturnType<typeof materializeCandidate>['result'],
  actual: unknown,
) {
  // Strict parsing plus exact ordered manifest comparison rejects duplicate, extra and omitted files.
  const result = MaterializationResultSchema.parse(actual);
  if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error('MANIFEST_REJECTED');
  return result;
}
