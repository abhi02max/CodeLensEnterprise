import { z } from 'zod';

export const VALIDATION_AI = {
  packet: 'validation-ai-evidence-v1',
  prompt: 'validation-ai-review-v1',
  schema: 'validation-ai-result-v1',
  contextBytes: 32768,
  entries: 100,
  patchBytes: 20480,
  staticEntries: 40,
  observationEntries: 8,
  mlBytes: 4096,
  outputBytes: 16384,
  staticBytes: 8192,
  packetBytes: 28672,
  requests: 2,
  requestMs: 25000,
  executionMs: 60000,
  outputTokens: 2048,
} as const;
export const VALIDATION_AI_DISCLAIMER =
  'AI re-review is an advisory assessment grounded in the persisted validation evidence. It does not approve, merge, or certify the patch.';
export const ValidationAiRequestSchema = z.object({ requestId: z.string().uuid() }).strict();
export const ValidationAiStateSchema = z.enum([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
const id = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().max(700);
const nullableText = z.string().max(160).nullable();
export const ValidationAiLineageSchema = z
  .object({
    organizationId: id,
    repositoryId: id,
    pullRequestId: id,
    validationId: id,
    applicationId: id,
    proposalId: id,
    proposalRevision: z.number().int().positive(),
    proposalDigest: digest,
    baseSha: sha,
    headSha: sha,
    snapshotDigest: digest,
    candidateDigest: digest,
    staticIds: z.array(id).length(2),
    mlComparisonId: z.string().uuid(),
  })
  .strict();
export const ValidationAiTrustSchema = z.enum([
  'SERVER_LINEAGE',
  'EXACT_REVISION_SOURCE',
  'DETERMINISTIC_DERIVED',
  'BROKER_OBSERVATION',
  'UNTRUSTED_RUNNER_REPORT',
  'ADVISORY_ML',
  'HUMAN_DECISION',
]);
const payloads = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LINEAGE'), value: ValidationAiLineageSchema }).strict(),
  z
    .object({
      type: z.literal('PATCH'),
      path: z.string().min(1).max(500),
      oldBlobSha: sha,
      oldContentHash: digest,
      newContentHash: digest,
      diff: z.string().max(20480),
    })
    .strict(),
  z
    .object({
      type: z.literal('DECISION'),
      status: z.literal('ACCEPTED'),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('BROKER'),
      side: z.enum(['ORIGINAL', 'PATCHED']),
      profile: z.string().max(40),
      outcome: z.enum(['PASS', 'FAIL', 'UNSUPPORTED', 'INCONCLUSIVE']),
      inputDigest: digest,
      resultDigest: digest,
      started: z.boolean(),
      termination: nullableText,
      exitCode: z.number().int().nullable(),
      oom: z.boolean(),
      cleanup: z.string().max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal('RUNNER'),
      side: z.enum(['ORIGINAL', 'PATCHED']),
      profile: z.string().max(40),
      status: z.string().max(32),
      kind: nullableText,
      total: z.number().int().nonnegative().nullable(),
      failed: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('STATIC_ANALYSIS'),
      side: z.enum(['ORIGINAL', 'PATCHED']),
      status: z.enum(['COMPLETE', 'UNSUPPORTED', 'TRUNCATED', 'TIMED_OUT', 'FAILED']),
      reason: nullableText,
      rulesetVersion: z.string().max(80),
      rulesetDigest: digest,
      configurationDigest: digest,
      sourceDigest: digest,
      resultDigest: digest,
      findingCount: z.number().int().nonnegative(),
      included: z.number().int().nonnegative(),
      omitted: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('STATIC_FINDING'),
      side: z.enum(['ORIGINAL', 'PATCHED']),
      analyzer: z.string().max(40),
      ruleId: z.string().max(120),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
      category: z.string().max(40),
      path: z.string().max(512),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      message: text,
      classification: z.enum(['UNCHANGED', 'RESOLVED', 'INTRODUCED', 'CHANGED', 'INCOMPARABLE']),
      comparability: z.string().max(64),
      findingDigest: digest,
      counterpartDigest: digest.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ML'),
      state: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']),
      outcome: z.enum(['LOWER', 'UNCHANGED', 'HIGHER', 'INCOMPARABLE', 'UNAVAILABLE']).nullable(),
      deltaTenths: z.number().int().nullable(),
      bandMovement: nullableText,
      resultDigest: digest.nullable(),
      frozenMetadataDigest: digest.nullable(),
      featureSchemaVersion: z.string().max(80),
      extractorVersion: z.string().max(80),
      modelIdentity: z.string().max(2048).nullable(),
      assessments: z
        .array(
          z
            .object({
              side: z.enum(['ORIGINAL', 'PATCHED']),
              availability: z.enum(['AVAILABLE', 'UNAVAILABLE']),
              scoreTenths: z.number().int().min(0).max(1000).nullable(),
              band: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable(),
              warnings: z.array(z.string().max(160)).max(10),
              staticResultDigest: digest.nullable(),
            })
            .strict(),
        )
        .max(2),
      limitation: text,
    })
    .strict(),
]);
export const ValidationAiEvidenceSchema = z
  .object({
    id: digest,
    sourceId: id,
    trust: ValidationAiTrustSchema,
    contentDigest: digest,
    payload: payloads,
  })
  .strict();
export const ValidationAiPacketSchema = z
  .object({
    version: z.literal(VALIDATION_AI.packet),
    lineage: ValidationAiLineageSchema,
    entries: z.array(ValidationAiEvidenceSchema).min(1).max(100),
    coverage: z
      .object({
        omittedStaticFindings: z.number().int().nonnegative(),
        excluded: z.tuple([
          z.literal('ORIGINAL_AI'),
          z.literal('RAG'),
          z.literal('RUNNER_OUTPUT'),
          z.literal('SOURCE_EXCERPTS'),
        ]),
        limitations: z.array(text).max(12),
      })
      .strict(),
  })
  .strict();
const claim = z
  .object({
    text: z.string().min(1).max(700),
    evidenceIds: z
      .array(digest)
      .min(1)
      .max(8)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const ValidationAiResultSchema = z
  .object({
    assessment: z.enum(['ACCEPTABLE', 'NEEDS_CHANGES', 'INCONCLUSIVE']),
    summary: claim,
    addressedConcerns: z.array(claim).max(10),
    residualConcerns: z.array(claim).max(10),
    introducedConcerns: z.array(claim).max(10),
    suggestedFollowups: z.array(claim).max(10),
    limitations: z.array(z.string().min(1).max(500)).min(1).max(10),
  })
  .strict();
export type ValidationAiPacket = z.infer<typeof ValidationAiPacketSchema>;
export type ValidationAiEvidence = z.infer<typeof ValidationAiEvidenceSchema>;
export type ValidationAiResult = z.infer<typeof ValidationAiResultSchema>;
export interface ValidationAiAccounting {
  requests: number;
  retries: number;
  repairs: number;
  reservedTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  unknownRequests: number;
  durationMs: number;
}
export interface ValidationAiView {
  id: string;
  validationId: string;
  state: z.infer<typeof ValidationAiStateSchema>;
  lineage: ValidationAiPacket['lineage'];
  packetDigest: string | null;
  packetVersion: string;
  promptVersion: string;
  schemaVersion: string;
  requestedProvider: string;
  requestedModel: string;
  reportedProvider: string | null;
  reportedModel: string | null;
  result: ValidationAiResult | null;
  failureCategory: string | null;
  stale: boolean;
  coverage: ValidationAiPacket['coverage'] | null;
  evidence: ValidationAiEvidence[];
  accounting: ValidationAiAccounting | null;
  createdAt: string;
  completedAt: string | null;
}
