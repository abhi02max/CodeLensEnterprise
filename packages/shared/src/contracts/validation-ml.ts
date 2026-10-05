import { z } from 'zod';
import { StrictRiskIdentitySchema, StrictRiskFeaturesSchema } from './ml-strict';
export const ValidationMlRequestSchema = z.object({ requestId: z.string().uuid() }).strict();
export const ValidationMlStateSchema = z.enum([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const ValidationMlOutcomeSchema = z.enum([
  'LOWER',
  'UNCHANGED',
  'HIGHER',
  'INCOMPARABLE',
  'UNAVAILABLE',
]);
export const VALIDATION_ML_LIMITATIONS =
  'ML risk movement is an advisory model signal and does not establish that the proposal is safe or correct. Metadata is frozen once from persisted PR/history data at assessment preparation, not a historical Git snapshot. No SHAP, RAG, AI re-review or automatic decision. A timeout/cancellation does not necessarily terminate synchronous inference.';
export interface ValidationMlView {
  id: string;
  validationId: string;
  applicationId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  baseSha: string;
  headSha: string;
  snapshotDigest: string;
  candidateDigest: string;
  baseSourceDigest: string | null;
  state: z.infer<typeof ValidationMlStateSchema>;
  outcome: z.infer<typeof ValidationMlOutcomeSchema> | null;
  deltaTenths: number | null;
  bandMovement: string | null;
  failureCategory: string | null;
  frozenMetadataDigest: string | null;
  metadataProvenance: string;
  featureSchemaVersion: string;
  extractorVersion: string;
  diffPolicyVersion: string;
  staticPolicyVersion: string;
  textNormalizationVersion: string;
  modelIdentity: z.infer<typeof StrictRiskIdentitySchema> | null;
  resultDigest: string | null;
  stale: boolean;
  createdAt: string;
  completedAt: string | null;
  assessments: Array<{
    side: 'ORIGINAL' | 'PATCHED';
    featureDigest: string | null;
    features: z.infer<typeof StrictRiskFeaturesSchema> | null;
    staticResultDigest: string | null;
    availability: 'AVAILABLE' | 'UNAVAILABLE';
    scoreTenths: number | null;
    band: string | null;
    probabilityMicros: number | null;
    confidenceMillis: number | null;
    warnings: string[];
    failureCategory: string | null;
  }>;
  limitations: string;
}
