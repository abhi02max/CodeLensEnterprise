import { z } from 'zod';

export const InvestigationToolSchema = z.enum([
  'read_pr_diff',
  'list_changed_files',
  'read_file_range',
  'search_repository',
  'retrieve_context',
  'read_analysis_evidence',
  'read_review_thread',
  'inspect_tests',
  'read_repository_metadata',
]);
export type InvestigationTool = z.infer<typeof InvestigationToolSchema>;
export const EvidenceProvenanceSchema = z.enum([
  'EXACT_REVISION',
  'INDEXED_CONTEXT',
  'SNAPSHOT',
  'DERIVED',
]);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;
export const InvestigationStatusSchema = z.enum([
  'RUNNING',
  'SUCCESS',
  'PARTIAL',
  'UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'LIMITED',
]);
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !/[\\%:\x00-\x1f\x7f]/.test(path) &&
      !path.startsWith('/') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Expected an unencoded relative repository path',
  );
const id = z.string().min(1).max(64);
const page = { cursor: z.number().int().min(0).max(1000).default(0) };
const query = z.string().trim().min(1).max(500);
export const InvestigationInputSchemas = {
  read_pr_diff: z.object({ path: RepositoryPathSchema.optional(), ...page }).strict(),
  list_changed_files: z.object(page).strict(),
  read_file_range: z
    .object({
      path: RepositoryPathSchema,
      startLine: z.number().int().min(1).max(1000000),
      endLine: z.number().int().min(1).max(1000000),
      side: z.enum(['HEAD', 'BASE']).default('HEAD'),
    })
    .strict()
    .refine((x) => x.endLine >= x.startLine && x.endLine - x.startLine < 200, 'Maximum 200 lines'),
  search_repository: z
    .object({ query, paths: z.array(RepositoryPathSchema).max(5).default([]), ...page })
    .strict(),
  retrieve_context: z
    .object({
      query,
      symbols: z.array(z.string().min(1).max(100)).max(8).default([]),
      paths: z.array(RepositoryPathSchema).max(5).default([]),
      topK: z.number().int().min(1).max(8).default(5),
    })
    .strict(),
  read_analysis_evidence: z
    .object({
      source: z.enum(['STATIC', 'AI', 'ML', 'REPORT']).default('REPORT'),
      findingId: id.optional(),
      findingIndex: z.number().int().min(0).max(199).optional(),
      ...page,
    })
    .strict(),
  read_review_thread: z.object({ commentId: id, ...page }).strict(),
  inspect_tests: z
    .object({ query, paths: z.array(RepositoryPathSchema).max(5).default([]), ...page })
    .strict(),
  read_repository_metadata: z.object({}).strict(),
} as const;
export const InvestigationRequestSchema = z
  .object({ requestId: z.string().uuid(), input: z.unknown() })
  .strict();
export const InvestigationPageSchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).max(10000).default(0),
    limit: z.coerce.number().int().min(1).max(25).default(10),
  })
  .strict();
export type InvestigationPage = z.infer<typeof InvestigationPageSchema>;
export interface EvidenceView {
  id: string;
  toolCallId: string;
  sourceType: string;
  sourceId: string | null;
  provenance: EvidenceProvenance;
  observedRevision: string | null;
  indexRevision: string | null;
  path: string | null;
  side: string | null;
  startLine: number | null;
  endLine: number | null;
  contentHash: string;
  blobHash: string | null;
  payloadHash: string;
  excerpt: string;
  truncated: boolean;
  redacted: boolean;
  method: string;
  metadata: Record<string, unknown>;
  trust: 'UNTRUSTED_DATA';
  observedAt: string;
}
export interface InvestigationResult {
  id: string;
  turnId: string;
  tool: InvestigationTool;
  version: string;
  sequence: number;
  status: InvestigationStatus;
  coverage: string;
  evidence: EvidenceView[];
  nextCursor: number | null;
  failureCategory: string | null;
  diagnostic: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
}
