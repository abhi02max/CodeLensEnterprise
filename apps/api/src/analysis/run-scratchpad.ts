import { Injectable, Logger } from '@nestjs/common';
import type {
  AiReview,
  ApprovalRecommendation,
  PrContextBundle,
  PrFeatures,
  PrMetricsView,
  PredictRiskResponse,
  StaticAnalysisSummary,
  SuggestedTestCase,
} from '@codelens/shared';
import type { GetPrDiffOutputType, GetRepoMetadataOutputType } from '../mcp-tools/tool-io.schemas';

/**
 * Per-run intermediate storage.
 *
 * Exists to solve a specific tension. Tools compose — static analysis consumes the diff,
 * feature extraction consumes the analysis, the AI review consumes all of it — but the
 * intermediate payloads are large: a full diff with patches, hundreds of findings, and
 * thousands of tokens of retrieved context.
 *
 * Writing all of that into `ToolRun.output` would make those rows enormous and turn the
 * audit table into a blob store, while passing it through the orchestrator's `PipelineState`
 * means serialising it to JSON on every hop.
 *
 * So the split is: `ToolRun.output` records a compact, auditable *summary* of what a tool
 * produced, and the full payload lives here in memory for the duration of the run. The
 * `create_review_report` tool is what durably persists the parts worth keeping.
 *
 * In-memory is sufficient because a single analysis run executes entirely within one worker
 * process. The scratchpad is keyed by reviewRunId and cleared when the run finishes; a TTL
 * sweep guards against a crashed run leaking memory.
 */
export interface RunState {
  organizationId: string;
  pullRequestId: string;
  repositoryId: string;
  createdAt: number;

  diff?: GetPrDiffOutputType;
  repoMetadata?: GetRepoMetadataOutputType;
  staticAnalysis?: StaticAnalysisSummary;
  metrics?: PrMetricsView;
  features?: PrFeatures;
  prediction?: {
    response: PredictRiskResponse;
    reviewTimeMinutes: number | null;
    reviewTimeRange: { lower: number; upper: number } | null;
    similar: Array<{
      reference: string;
      title: string;
      similarity: number;
      outcome: string;
      riskScore: number;
    }>;
    degradedReason: string | null;
  };
  context?: PrContextBundle;
  aiReview?: {
    review: AiReview;
    effectiveRecommendation: ApprovalRecommendation;
    policyOverridden: boolean;
    policyReasons: string[];
    droppedFindingCount: number;
    usedMapReduce: boolean;
    provider: string;
    model: string;
    promptVersion: string;
    tokenUsage: { prompt: number; completion: number; total: number };
    costCents: number;
  };
  testSuggestions?: SuggestedTestCase[];
  /** True when the diff sent to the provider had secrets redacted. */
  redactedBeforeSend?: boolean;
}

/** Runs older than this are assumed abandoned and are swept. */
const MAX_RUN_AGE_MS = 30 * 60 * 1000;

@Injectable()
export class RunScratchpad {
  private readonly logger = new Logger(RunScratchpad.name);
  private readonly runs = new Map<string, RunState>();

  create(params: {
    reviewRunId: string;
    organizationId: string;
    pullRequestId: string;
    repositoryId: string;
  }): RunState {
    this.sweep();

    const state: RunState = {
      organizationId: params.organizationId,
      pullRequestId: params.pullRequestId,
      repositoryId: params.repositoryId,
      createdAt: Date.now(),
    };

    this.runs.set(params.reviewRunId, state);
    return state;
  }

  /**
   * Fetch run state, throwing if absent.
   *
   * Absence means a tool ran without the pipeline having initialised the run, which is a
   * programming error rather than a recoverable condition — so it throws loudly instead of
   * silently producing an empty review.
   */
  require(reviewRunId: string): RunState {
    const state = this.runs.get(reviewRunId);

    if (!state) {
      throw new Error(
        `No scratchpad state for review run ${reviewRunId}. A tool executed outside of an ` +
          `initialised pipeline run.`,
      );
    }

    return state;
  }

  get(reviewRunId: string): RunState | undefined {
    return this.runs.get(reviewRunId);
  }

  update(reviewRunId: string, patch: Partial<RunState>): RunState {
    const state = this.require(reviewRunId);
    Object.assign(state, patch);
    return state;
  }

  release(reviewRunId: string): void {
    this.runs.delete(reviewRunId);
  }

  /** Drop abandoned runs so a crashed job does not retain a diff indefinitely. */
  private sweep(): void {
    const cutoff = Date.now() - MAX_RUN_AGE_MS;
    let swept = 0;

    for (const [runId, state] of this.runs.entries()) {
      if (state.createdAt < cutoff) {
        this.runs.delete(runId);
        swept += 1;
      }
    }

    if (swept > 0) {
      this.logger.warn(`Swept ${swept} abandoned run scratchpad(s) older than 30 minutes`);
    }
  }

  get activeRunCount(): number {
    return this.runs.size;
  }
}
