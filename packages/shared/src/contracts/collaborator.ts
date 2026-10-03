import { z } from 'zod';
import { InvestigationToolSchema } from './investigation';

export const COLLABORATION_EVIDENCE_TYPES = [
  'FILE_RANGE',
  'PR_DIFF',
  'CHANGED_FILE',
  'TEST_CANDIDATE',
  'SEARCH_MATCH',
  'RAG_CONTEXT',
  'COMMENT_SNAPSHOT',
  'STATIC_FINDING',
  'AI_FINDING',
  'ML_EVIDENCE',
  'REPORT_SNAPSHOT',
  'REPOSITORY_METADATA',
] as const;

export const CollaborationCitationSchema = z
  .object({
    evidenceId: z.string().min(1).max(64),
    claim: z.string().trim().min(1).max(200),
    strength: z.enum(['OBSERVED', 'INFERRED']),
  })
  .strict();
export const CollaboratorActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('RESPOND'),
      content: z.string().trim().min(1).max(8000),
      citations: z.array(CollaborationCitationSchema).max(16),
      certainty: z.enum(['EVIDENCE_BASED', 'UNKNOWN']),
    })
    .strict(),
  z
    .object({
      action: z.literal('REQUEST_TOOLS'),
      tools: z
        .array(z.object({ tool: InvestigationToolSchema, input: z.unknown() }).strict())
        .min(1)
        .max(8),
    })
    .strict(),
]);
export type CollaboratorAction = z.infer<typeof CollaboratorActionSchema>;
export type CollaborationCitation = z.infer<typeof CollaborationCitationSchema>;
export const RetryCollaborationSchema = z
  .object({ attempt: z.number().int().min(0).max(1000) })
  .strict();
export type CollaborationExecutionState =
  | 'RECORDED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';
export interface CollaborationExecutionView {
  turnId: string;
  status: CollaborationExecutionState;
  attempt: number;
  failureCategory: string | null;
  provider: string | null;
  model: string | null;
  providerRequests: number;
  providerRetries: number;
  repairs: number;
  rounds: number;
  toolCalls: number;
  contextBytes: number;
  outputTokens: number;
  startedAt: string | null;
  completedAt: string | null;
  stale: boolean;
}
