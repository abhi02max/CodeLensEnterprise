import { z } from 'zod';

export const ML_CONTRACT = 'codelens-risk-inference-v1';
export const ML_FEATURE_SCHEMA = 'codelens-risk-features-v1';
export const ML_BAND_POLICY = 'risk-band-policy-v1';
export const ML_REQUEST_BYTES = 32768;
export const ML_RESPONSE_BYTES = 16384;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
const count = (max: number) => z.number().finite().int().min(0).max(max);
const text = (max: number) =>
  z
    .string()
    .refine((v) => Array.from(v).length <= max)
    .transform((v) =>
      v
        .normalize('NFC')
        .replace(/[ \t\r\n\f\v]+/g, ' ')
        .replace(/^ +| +$/g, ''),
    )
    .refine((v) => Array.from(v).length <= max && !/[\x00-\x1f\x7f]/.test(v));

export const StrictRiskFeaturesSchema = z
  .object({
    lines_added: count(1000000),
    lines_deleted: count(1000000),
    files_changed: count(1000),
    number_of_commits: count(10000),
    complexity_delta: z
      .number()
      .finite()
      .min(-1000000)
      .max(1000000)
      .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) <= 1e-7)
      .transform((v) => v || 0),
    security_findings_count: count(10000),
    dependency_changed: count(1),
    test_files_changed: count(1),
    auth_file_changed: count(1),
    database_file_changed: count(1),
    config_file_changed: count(1),
    payment_file_changed: count(1),
    previous_risky_file_count: count(1000),
    title_text: text(300),
    commit_text: text(2000),
  })
  .strict()
  .refine(
    (v) =>
      (v.files_changed > 0 || (!v.lines_added && !v.lines_deleted)) &&
      v.previous_risky_file_count <= v.files_changed,
  );

export const StrictRiskPairRequestSchema = z
  .object({
    contractVersion: z.literal(ML_CONTRACT),
    featureSchemaVersion: z.literal(ML_FEATURE_SCHEMA),
    organizationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .nullable()
      .optional(),
    original: StrictRiskFeaturesSchema,
    patched: StrictRiskFeaturesSchema,
  })
  .strict();

export const StrictRiskIdentitySchema = z
  .object({
    manifestVersion: z.literal(1),
    featureSchemaVersion: z.literal(ML_FEATURE_SCHEMA),
    artifactDigest: hash,
    preprocessingDigest: hash,
    calibrationDigest: hash,
    modelName: name,
    modelVersion: name,
    isBaseline: z.boolean(),
    contractVersion: z.literal(ML_CONTRACT),
    inferenceImplementation: z.literal('codelens-risk-inference-impl-v1'),
    bandPolicyVersion: z.literal(ML_BAND_POLICY),
    bundleScope: z.enum(['SHARED', 'ORGANIZATION']),
    organizationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .nullable(),
    runtimeIdentity: z.string().regex(/^[A-Za-z0-9_.:@/-]{1,128}$/),
    implementationDigest: hash,
    runtimeDigest: hash,
  })
  .strict()
  .refine((v) =>
    v.bundleScope === 'SHARED' ? v.organizationId === null : v.organizationId !== null,
  );

export function authoritativeRiskBand(score: number, confidence: number) {
  if (score >= 85) return confidence < 0.35 ? 'HIGH' : 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 35) return 'MEDIUM';
  return 'LOW';
}

export const StrictRiskObservationSchema = z
  .object({
    featureDigest: hash,
    scoreTenths: count(1000),
    probabilityMicros: count(1000000),
    confidenceMillis: count(1000),
    band: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    warnings: z.array(z.enum(['LOW_CONFIDENCE_CAP', 'PROBABILITY_CLAMPED'])).max(2),
  })
  .strict()
  .refine(
    (v) =>
      v.band === authoritativeRiskBand(v.scoreTenths / 10, v.confidenceMillis / 1000) &&
      Math.abs(v.scoreTenths - Math.round(v.probabilityMicros / 1000)) <= 1 &&
      new Set(v.warnings).size === v.warnings.length &&
      v.warnings.includes('LOW_CONFIDENCE_CAP') ===
        (v.scoreTenths >= 850 && v.confidenceMillis < 350),
  );

export const StrictRiskFailureSchema = z
  .object({
    status: z.literal('UNAVAILABLE'),
    contractVersion: z.literal(ML_CONTRACT),
    category: z.enum([
      'BUSY',
      'REQUEST_BOUND',
      'INVALID_REQUEST',
      'TIMEOUT',
      'ARTIFACT_INVALID',
      'ARTIFACT_UNAVAILABLE',
      'ARTIFACT_SCHEMA_MISMATCH',
      'ARTIFACT_DIGEST_MISMATCH',
      'ARTIFACT_MANIFEST_MISMATCH',
      'CALIBRATION_UNAVAILABLE',
      'MODEL_OUTPUT_INVALID',
      'INFERENCE_FAILED',
      'NO_MODEL_ASSESSMENT',
      'RESPONSE_BOUND',
      'SERVICE_UNAVAILABLE',
      'RESPONSE_INVALID',
      'IDENTITY_MISMATCH',
    ]),
  })
  .strict();

export const StrictRiskPairResponseSchema = z.union([
  z
    .object({
      status: z.literal('AVAILABLE'),
      identity: StrictRiskIdentitySchema,
      original: StrictRiskObservationSchema,
      patched: StrictRiskObservationSchema,
      resultDigest: hash,
    })
    .strict(),
  StrictRiskFailureSchema,
]);
export type StrictRiskPairRequest = z.input<typeof StrictRiskPairRequestSchema>;
export type StrictRiskPairResponse = z.infer<typeof StrictRiskPairResponseSchema>;
