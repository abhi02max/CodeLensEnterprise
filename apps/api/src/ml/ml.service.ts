import { Injectable, Logger } from '@nestjs/common';
import {
  ClusterIssuesResponseSchema,
  ModelsInfoResponseSchema,
  PredictReviewTimeResponseSchema,
  PredictRiskResponseSchema,
  SimilarPrsResponseSchema,
  authoritativeRiskBand,
  type ClusterIssuesResponse,
  type IssueCluster,
  type PredictReviewTimeResponse,
  type PredictRiskResponse,
  type PrFeatures,
  type RiskReason,
  type SimilarPr,
  type StrictRiskPairRequest,
} from '@codelens/shared';
import { requestStrictRiskPair } from './strict-risk-client';
import { UpstreamUnavailableError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';

/**
 * HTTP client for the Python ML service.
 *
 * Two properties matter more than the request plumbing:
 *
 * 1. RESPONSES ARE VALIDATED against the Zod schemas in `packages/shared`. The ML service
 *    has its own Pydantic models, and the two can drift — a feature renamed on one side
 *    produces a wrong risk score rather than an error. Validating here turns that silent
 *    corruption into an explicit failure at the boundary.
 *
 * 2. EVERY METHOD DEGRADES. The ML service is explicitly optional: reviews must still
 *    produce static analysis and an AI review when it is unreachable. So the predict
 *    methods return a null-ish result with a reason rather than throwing, and the caller
 *    records the run as DEGRADED.
 */
@Injectable()
export class MlService {
  private readonly logger = new Logger(MlService.name);

  /**
   * Simple circuit breaker. After repeated failures the client stops attempting requests
   * for a cool-off window, so a hard-down ML service adds a few milliseconds per review
   * instead of a multi-second timeout on every stage that touches it.
   */
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly FAILURE_THRESHOLD = 4;
  private static readonly COOL_OFF_MS = 30_000;

  constructor(private readonly config: AppConfigService) {}

  get baseUrl(): string {
    return this.config.ml.url;
  }

  predictRiskPair(input: StrictRiskPairRequest, expectedArtifactDigest?: string) {
    return requestStrictRiskPair(
      this.baseUrl,
      input,
      this.config.ml.timeoutMs,
      expectedArtifactDigest,
    );
  }

  private get circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  /**
   * Risk prediction.
   *
   * Returns `status: 'UNAVAILABLE'` with a reason rather than throwing. A review without a
   * risk score is degraded; a review that fails because the risk service blinked is
   * broken, and the second is much worse.
   */
  async predictRisk(params: {
    features: PrFeatures;
    organizationId?: string;
    includeExplanation?: boolean;
  }): Promise<
    | { status: 'OK'; prediction: PredictRiskResponse }
    | { status: 'UNAVAILABLE'; reason: string }
  > {
    const result = await this.request('/predict/risk', PredictRiskResponseSchema, {
      features: params.features,
      organizationId: params.organizationId,
      includeExplanation: params.includeExplanation ?? true,
    });

    if (!result.ok) return { status: 'UNAVAILABLE', reason: result.error };

    // Validate the authoritative service band; never undo its low-confidence cap.
    if (
      authoritativeRiskBand(result.value.risk_score, result.value.confidence) !==
      result.value.risk_level
    )
      return { status: 'UNAVAILABLE', reason: 'ML_BAND_POLICY_MISMATCH' };

    return {
      status: 'OK',
      prediction: result.value,
    };
  }

  async predictReviewTime(params: {
    features: PrFeatures;
    organizationId?: string;
  }): Promise<PredictReviewTimeResponse | null> {
    const result = await this.request('/predict/review-time', PredictReviewTimeResponseSchema, {
      features: params.features,
      organizationId: params.organizationId,
    });

    return result.ok ? result.value : null;
  }

  async similarPullRequests(params: {
    features: PrFeatures;
    k?: number;
    organizationId?: string;
  }): Promise<SimilarPr[]> {
    const result = await this.request('/similar/pull-requests', SimilarPrsResponseSchema, {
      features: params.features,
      k: params.k ?? 5,
      organizationId: params.organizationId,
    });

    return result.ok ? result.value.neighbours : [];
  }

  /**
   * Cluster finding text into recurring patterns.
   *
   * Returns an empty array on failure: the issue-pattern panel disappearing is a much
   * smaller problem than the review failing.
   */
  async clusterIssues(params: {
    texts: string[];
    organizationId?: string;
  }): Promise<IssueCluster[]> {
    if (params.texts.length === 0) return [];

    const result = await this.request<ClusterIssuesResponse>(
      '/cluster/issues',
      ClusterIssuesResponseSchema,
      { texts: params.texts.slice(0, 500), organizationId: params.organizationId },
    );

    return result.ok ? result.value.clusters : [];
  }

  /** Model metadata and the bagging-vs-boosting comparison table. */
  async modelsInfo(): Promise<
    | { status: 'OK'; info: ReturnType<typeof ModelsInfoResponseSchema.parse> }
    | { status: 'UNAVAILABLE'; reason: string }
  > {
    const result = await this.request('/models/info', ModelsInfoResponseSchema, undefined, 'GET');
    return result.ok
      ? { status: 'OK', info: result.value }
      : { status: 'UNAVAILABLE', reason: result.error };
  }

  /**
   * Turn a prediction into the persisted shape, resolving KNN neighbour references back to
   * real pull requests where possible.
   */
  buildRiskReasons(prediction: PredictRiskResponse): RiskReason[] {
    return prediction.top_risk_reasons;
  }

  private async request<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } },
    body?: unknown,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    if (this.circuitOpen) {
      return {
        ok: false,
        error: `ML service circuit is open after ${this.consecutiveFailures} consecutive failures; retrying shortly`,
      };
    }

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.ml.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');

        // 503 from the ML service means "models not loaded", which is a deployment state
        // rather than a transient fault, so it does not trip the breaker.
        if (response.status !== 503) this.recordFailure();

        return {
          ok: false,
          error: `ML service ${path} returned ${response.status}: ${text.slice(0, 300)}`,
        };
      }

      const json: unknown = await response.json();
      const parsed = schema.safeParse(json);

      if (!parsed.success) {
        // A contract drift, not a network fault. Logged at error because it means the two
        // services disagree about their shared schema and needs a human.
        const issues = parsed.error.issues
          .slice(0, 6)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');

        this.logger.error(
          `ML service ${path} returned a payload that failed validation. The Pydantic ` +
            `models in apps/ml-service and the Zod contracts in packages/shared have ` +
            `drifted. ${issues}`,
        );

        return { ok: false, error: `ML response failed schema validation: ${issues}` };
      }

      this.consecutiveFailures = 0;
      return { ok: true, value: parsed.data };
    } catch (error) {
      this.recordFailure();

      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message.includes('abort') || message.includes('timeout');

      return {
        ok: false,
        error: timedOut
          ? `ML service timed out after ${this.config.ml.timeoutMs}ms at ${path}`
          : `Could not reach the ML service at ${url}: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= MlService.FAILURE_THRESHOLD && !this.circuitOpen) {
      this.circuitOpenUntil = Date.now() + MlService.COOL_OFF_MS;
      this.logger.warn(
        `ML service circuit opened for ${MlService.COOL_OFF_MS / 1000}s after ` +
          `${this.consecutiveFailures} consecutive failures. Risk scores will be omitted ` +
          `from reviews until it recovers.`,
      );
    }
  }

  /** Ask the ML service to reload artifacts after a retrain. */
  async reloadModels(): Promise<{ reloaded: boolean; detail?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models/reload`, { method: 'POST' });
      if (!response.ok) return { reloaded: false, detail: `HTTP ${response.status}` };

      // Reset the breaker: a successful reload means the service is healthy again.
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;

      const body = (await response.json()) as { reloaded?: boolean; detail?: string | null };
      return { reloaded: Boolean(body.reloaded), detail: body.detail ?? undefined };
    } catch (error) {
      return {
        reloaded: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
