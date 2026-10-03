import { z } from 'zod';
import { RepositoryPathSchema } from './investigation';

export const PATCH_LIMITS = Object.freeze({
  files: 10,
  changedLines: 500,
  bytes: 65536,
  evidence: 16,
  operations: 32,
  text: 8192,
});
const evidence = z.array(z.string().min(1).max(64)).min(1).max(PATCH_LIMITS.evidence);
export const PatchOperationSchema = z
  .object({
    startLine: z.number().int().min(1).max(1000000),
    endLine: z.number().int().min(1).max(1000000),
    expectedText: z.string().max(PATCH_LIMITS.text),
    replacement: z.string().max(PATCH_LIMITS.text),
  })
  .strict();
export const PatchFileSchema = z
  .object({
    operation: z.literal('MODIFY'),
    path: RepositoryPathSchema,
    expectedBlobSha: z.string().regex(/^[a-f0-9]{40}$/),
    edits: z.array(PatchOperationSchema).min(1).max(PATCH_LIMITS.operations),
    evidenceIds: evidence,
  })
  .strict();
export const PatchIntentSchema = z
  .object({
    summary: z.string().trim().min(1).max(300),
    rationale: z.string().trim().min(1).max(2000),
    limitations: z.string().trim().min(1).max(1000),
    files: z.array(PatchFileSchema).min(1).max(PATCH_LIMITS.files),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.files.map((f) => f.path.toLowerCase());
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate or case-colliding paths' });
    if (new TextEncoder().encode(JSON.stringify(value)).length > PATCH_LIMITS.bytes)
      ctx.addIssue({ code: 'custom', message: 'Proposal exceeds serialized bounds' });
    for (const file of value.files) {
      if (new Set(file.evidenceIds).size !== file.evidenceIds.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate evidence' });
      const sorted = [...file.edits].sort((a, b) => a.startLine - b.startLine);
      for (let i = 0; i < sorted.length; i++)
        if (
          sorted[i]!.endLine < sorted[i]!.startLine ||
          (i > 0 && sorted[i]!.startLine <= sorted[i - 1]!.endLine)
        )
          ctx.addIssue({ code: 'custom', message: 'Invalid or overlapping ranges' });
    }
    if (new Set(value.files.flatMap((f) => f.evidenceIds)).size > PATCH_LIMITS.evidence)
      ctx.addIssue({ code: 'custom', message: 'Too many evidence relationships' });
  });
export type PatchIntent = z.infer<typeof PatchIntentSchema>;
export const PatchStatusSchema = z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED']);
export type PatchStatus = z.infer<typeof PatchStatusSchema>;
export const PatchDecisionSchema = z
  .object({ requestId: z.string().uuid(), decision: z.enum(['ACCEPTED', 'REJECTED']) })
  .strict();
export const PatchRevisionSchema = z
  .object({ requestId: z.string().uuid(), proposal: PatchIntentSchema })
  .strict();
export const PatchFeedbackSchema = z
  .object({ requestId: z.string().uuid(), content: z.string().trim().min(1).max(8000) })
  .strict();
export interface PatchProposalView {
  id: string;
  conversationId: string;
  turnId: string;
  attemptId: string | null;
  parentId: string | null;
  revision: number;
  headSha: string;
  baseSha: string;
  authorType: 'AI' | 'HUMAN';
  authorId: string;
  provider: string | null;
  model: string | null;
  summary: string;
  rationale: string;
  limitations: string;
  digest: string;
  fileCount: number;
  changedLines: number;
  status: PatchStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedById: string | null;
  stale: boolean;
  files: Array<{
    path: string;
    operation: 'MODIFY';
    oldBlobSha: string;
    oldContentHash: string;
    newContentHash: string;
    diff: string;
    edits: z.infer<typeof PatchOperationSchema>[];
    evidenceIds: string[];
  }>;
}
export interface PatchProposalList {
  items: PatchProposalView[];
  nextAfterId: string | null;
}
