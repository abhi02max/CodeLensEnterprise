import { z } from 'zod';

export const PATCH_APPLICATION_DEADLINE_MS = 150000;
export const PATCH_APPLICATION_LIMITATIONS =
  'The accepted proposal was materialized against its pinned revision inside an isolated ephemeral workspace. No tests, builds, commits, pushes or repository changes were performed.';
export const PatchApplicationStatusSchema = z.enum([
  'QUEUED',
  'PREPARING',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'CANCELLED',
]);
export const PatchApplicationCleanupSchema = z.enum(['NOT_STARTED', 'UNCERTAIN', 'DISPOSED']);
export const PatchApplicationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedProposalRevision: z.number().int().min(1),
    expectedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const PatchApplicationCancelSchema = z.object({ requestId: z.string().uuid() }).strict();
export type PatchApplicationRequest = z.infer<typeof PatchApplicationRequestSchema>;
export type PatchApplicationStatus = z.infer<typeof PatchApplicationStatusSchema>;
export type PatchApplicationCleanup = z.infer<typeof PatchApplicationCleanupSchema>;
export interface PatchApplicationFileResultView {
  path: string;
  oldBlobSha: string;
  oldContentHash: string;
  contentHash: string;
  byteLength: number;
}
export interface PatchApplicationView {
  limitations: string;
  id: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  headSha: string;
  baseSha: string;
  requestedById: string;
  status: PatchApplicationStatus;
  cleanup: PatchApplicationCleanup;
  failureCategory: string | null;
  executorImage: string;
  policyVersion: string;
  stale: boolean;
  createdAt: string;
  deadlineAt: string;
  completedAt: string | null;
  attempts: Array<{
    generation: number;
    status: PatchApplicationStatus;
    cleanup: PatchApplicationCleanup;
    failureCategory: string | null;
    jobId: string;
    startedAt: string | null;
    completedAt: string | null;
    snapshotDigest: string | null;
    manifestDigest: string | null;
    files: PatchApplicationFileResultView[];
  }>;
}
export interface PatchApplicationList {
  items: PatchApplicationView[];
  nextAfterId: string | null;
}
