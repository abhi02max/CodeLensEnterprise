import { materializeExactSnapshot } from '@codelens/github/dist/exact-git-snapshot';
import type { ExactGitReader } from '@codelens/github/dist/exact-git-file';
import { MATERIALIZATION_LIMITS, type MaterializationRequest } from '@codelens/patch-core';
import { requestMaterialization } from './client';

/** Foundation-only adapter: authorization/ACCEPTED lifecycle belongs to the future domain. */
export async function materializeExactProposal(
  input: {
    reader: ExactGitReader;
    repository: string;
    proposal: MaterializationRequest['proposal'];
    socketPath: string;
    key: Buffer;
  },
  parentSignal?: AbortSignal,
) {
  const deadlineAt = Date.now() + MATERIALIZATION_LIMITS.deadlineMs;
  const budget = AbortSignal.timeout(MATERIALIZATION_LIMITS.deadlineMs);
  const signal = parentSignal ? AbortSignal.any([budget, parentSignal]) : budget;
  const snapshot = await materializeExactSnapshot(
    input.reader,
    input.repository,
    input.proposal.headSha,
    signal,
  );
  return requestMaterialization(
    input.socketPath,
    input.key,
    { version: 1, snapshot, proposal: input.proposal },
    signal,
    deadlineAt,
  );
}
