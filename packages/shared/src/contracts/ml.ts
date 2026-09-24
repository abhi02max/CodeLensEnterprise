import { z } from 'zod';
import { MlStatus, RiskLevel } from '../enums';
import { PrFeaturesSchema } from '../ml-features';

/**
 * Wire contract with `apps/ml-service`.
 *
 * These schemas are mirrored by Pydantic models in `app/schemas.py`. The API
 * validates responses against them, so a drift between the two services shows
 * up as a clear validation error rather than a wrong risk score.
 */

// ---------------------------------------------------------------- risk

export const PredictRiskRequestSchema = z.object({
  features: PrFeaturesSchema,
  /** Scope for per-org models; falls back to the global model when absent. */
  organizationId: z.string().optional(),
  /** Return SHAP attributions. Slower, so the UI asks only on the risk page. */
  includeExplanation: z.boolean().default(true),
});
export type PredictRiskRequest = z.infer<typeof PredictRiskRequestSchema>;

/** One SHAP contribution, ordered by absolute impact. */
export const RiskReasonSchema = z.object({
  feature: z.string(),
  label: z.string(),
  /** Raw feature value for this PR. */
  value: z.number(),
  /** Signed SHAP value: positive pushes risk up. */
  contribution: z.number(),
  direction: z.enum(['INCREASES_RISK', 'DECREASES_RISK']),
  explanation: z.string(),
});
export type RiskReason = z.infer<typeof RiskReasonSchema>;

export const PredictRiskResponseSchema = z.object({
  risk_score: z.number().min(0).max(100),
  risk_level: z.nativeEnum(RiskLevel),
  /**
   * Calibrated probability that this PR needs changes. Distinct from
   * risk_score, which is the 0-100 presentation of the same quantity.
   */
  probability: z.number().min(0).max(1),
  /**
   * Model's own confidence in the prediction, reduced when the feature vector
   * sits far from the training distribution. Low confidence is surfaced to the
   * reviewer rather than hidden.
   */
  confidence: z.number().min(0).max(1),
  top_risk_reasons: z.array(RiskReasonSchema),
  model_name: z.string(),
  model_version: z.string(),
  /** True when a documented heuristic baseline produced this, not a fitted model. */
  is_baseline: z.boolean(),
  /**
   * Advisory notes from the service: a saturated probability that was clamped, a feature
   * vector far from the training distribution, or a malformed input that was tolerated.
   * Surfaced to the reviewer rather than swallowed.
   */
  warnings: z.array(z.string()).default([]),
});
export type PredictRiskResponse = z.infer<typeof PredictRiskResponseSchema>;

// ---------------------------------------------------------------- review time

export const PredictReviewTimeRequestSchema = z.object({
  features: PrFeaturesSchema,
  organizationId: z.string().optional(),
});

export const PredictReviewTimeResponseSchema = z.object({
  minutes: z.number().min(0),
  /** Prediction interval, because a point estimate alone is misleading. */
  lower_minutes: z.number().min(0),
  upper_minutes: z.number().min(0),
  model_version: z.string(),
});
export type PredictReviewTimeResponse = z.infer<typeof PredictReviewTimeResponseSchema>;

// ---------------------------------------------------------------- similar PRs

export const SimilarPrsRequestSchema = z.object({
  features: PrFeaturesSchema,
  k: z.number().int().min(1).max(25).default(5),
  organizationId: z.string().optional(),
});

export const SimilarPrSchema = z.object({
  /** External reference the API resolves back to a PullRequest row. */
  reference: z.string(),
  similarity: z.number().min(0).max(1),
  /** What happened to that PR: the whole point of showing it. */
  outcome: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVERTED', 'UNKNOWN']),
  title: z.string(),
  risk_score: z.number().min(0).max(100),
});
export type SimilarPr = z.infer<typeof SimilarPrSchema>;

export const SimilarPrsResponseSchema = z.object({
  neighbours: z.array(SimilarPrSchema),
  model_version: z.string(),
});

// ---------------------------------------------------------------- clustering

export const ClusterIssuesRequestSchema = z.object({
  /** Finding messages to cluster. */
  texts: z.array(z.string()).min(1).max(500),
  organizationId: z.string().optional(),
});

export const IssueClusterSchema = z.object({
  cluster_id: z.number().int(),
  label: z.string(),
  /** Indices into the input `texts` array. */
  member_indices: z.array(z.number().int()),
  /** Terms that characterise the cluster, from the TF-IDF centroid. */
  top_terms: z.array(z.string()),
  size: z.number().int().min(1),
});
export type IssueCluster = z.infer<typeof IssueClusterSchema>;

export const ClusterIssuesResponseSchema = z.object({
  clusters: z.array(IssueClusterSchema),
  model_version: z.string(),
});
export type ClusterIssuesResponse = z.infer<typeof ClusterIssuesResponseSchema>;

// ---------------------------------------------------------------- issue typing

export const ClassifyIssueRequestSchema = z.object({
  texts: z.array(z.string()).min(1).max(500),
});

export const ClassifyIssueResponseSchema = z.object({
  predictions: z.array(
    z.object({
      text: z.string(),
      issue_type: z.string(),
      probabilities: z.record(z.number()),
    }),
  ),
  model_version: z.string(),
});

// ---------------------------------------------------------------- model metadata

export const ModelMetricsSchema = z.object({
  model_name: z.string(),
  task: z.enum(['classification', 'regression', 'clustering', 'neighbours']),
  trained_at: z.string(),
  n_samples: z.number().int(),
  metrics: z.record(z.number()),
  /** Present for tree ensembles. */
  feature_importances: z.record(z.number()).nullable(),
});
export type ModelMetrics = z.infer<typeof ModelMetricsSchema>;

export const ModelsInfoResponseSchema = z.object({
  feature_schema_version: z.number().int(),
  artifacts_dir: z.string(),
  /** Which estimator currently serves /predict/risk. */
  active_risk_model: z.string(),
  models: z.array(ModelMetricsSchema),
  /**
   * Bagging vs boosting comparison table. Kept in the API surface because the
   * model-selection rationale belongs in the product, not a notebook.
   */
  comparison: z.array(
    z.object({
      model_name: z.string(),
      roc_auc: z.number(),
      f1: z.number(),
      precision: z.number(),
      recall: z.number(),
      accuracy: z.number(),
      fit_seconds: z.number(),
    }),
  ),
});
export type ModelsInfoResponse = z.infer<typeof ModelsInfoResponseSchema>;

// ---------------------------------------------------------------- persisted view

/** What the API stores and returns for a PR's risk analysis. */
export interface MlPredictionView {
  id: string;
  status: MlStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  probability: number;
  confidence: number;
  isBaseline: boolean;
  predictedReviewTimeMinutes: number | null;
  reviewTimeRange: { lower: number; upper: number } | null;
  topRiskReasons: RiskReason[];
  similarPullRequests: Array<{
    pullRequestId: string | null;
    reference: string;
    title: string;
    number: number | null;
    similarity: number;
    outcome: string;
    riskScore: number;
  }>;
  issueClusters: IssueCluster[];
  modelName: string;
  modelVersion: string;
  featureSchemaVersion: number;
  features: Record<string, number | string>;
  createdAt: string;
  /** Set when status is UNAVAILABLE or DEGRADED. */
  degradedReason: string | null;
}
