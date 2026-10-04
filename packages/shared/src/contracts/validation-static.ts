import { z } from 'zod';

export const StaticSideSchema = z.enum(['ORIGINAL', 'PATCHED']);
export const StaticClassSchema = z.enum([
  'UNCHANGED',
  'RESOLVED',
  'INTRODUCED',
  'CHANGED',
  'INCOMPARABLE',
]);
export const StaticStatusSchema = z.enum([
  'COMPLETE',
  'UNSUPPORTED',
  'TRUNCATED',
  'TIMED_OUT',
  'FAILED',
]);
export const StaticFindingsQuerySchema = z
  .object({
    afterId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    side: StaticSideSchema.optional(),
    rule: z
      .string()
      .max(120)
      .regex(/^[a-zA-Z0-9/_-]+$/)
      .optional(),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
    classification: StaticClassSchema.optional(),
  })
  .strict();
export type StaticFindingsQuery = z.infer<typeof StaticFindingsQuerySchema>;
export type StaticClass = z.infer<typeof StaticClassSchema>;
export type StaticStatus = z.infer<typeof StaticStatusSchema>;
export interface ValidationFindingView {
  id: string;
  side: 'ORIGINAL' | 'PATCHED';
  analyzer: string;
  ruleId: string;
  severity: string;
  category: string;
  path: string;
  startLine: number;
  endLine: number;
  message: string;
  occurrenceFingerprint: string;
  findingDigest: string;
  classification: StaticClass;
  comparability: string;
  counterpartDigest: string | null;
  diffRelation: 'EDITED_RANGE' | 'CHANGED_FILE' | 'UNCHANGED_FILE';
}
export interface ValidationStaticView {
  analyses: Array<{
    side: 'ORIGINAL' | 'PATCHED';
    status: StaticStatus;
    reason: string | null;
    rulesetVersion: string;
    rulesetDigest: string;
    configurationDigest: string;
    fingerprintVersion: string;
    sourceDigest: string;
    inputDigest: string;
    resultDigest: string;
    findingCount: number;
    durationMs: number;
  }>;
  summary: Record<StaticClass, number>;
  items: ValidationFindingView[];
  nextAfterId: string | null;
  limitations: string;
}
export const STATIC_LIMITATIONS =
  'Limited pattern and secret-scan coverage, not a security verdict. Resolved means the analyzer no longer detected this occurrence; introduced does not prove an exploitable vulnerability. Ambiguous and secret-value identities are incomparable. Passing these checks does not establish that the proposal is safe.';
