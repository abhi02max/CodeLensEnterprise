import {
  ReviewStage,
  ToolName,
  ToolRunStatus,
  toErrorMessage,
  type JsonValue,
  type PipelineNode,
  type PipelineState,
  type Role,
  type ToolContext,
  type ToolLogger,
} from '@codelens/shared';
import type { McpToolRegistry } from './registry';

/**
 * Review pipeline orchestration.
 *
 * The pipeline is a declared DAG rather than a hardcoded sequence, which buys
 * three things that matter:
 *
 *   1. Partial degradation. `predict_pr_risk` depends on `extract_ml_features`,
 *      which depends on `run_static_analysis`. If Semgrep is missing, features are
 *      still extracted with zeroed finding counts and the risk prediction is
 *      marked DEGRADED rather than skipped. The graph makes that policy explicit
 *      in one place instead of scattering null checks through every stage.
 *
 *   2. Reproducibility. Deterministic stages always run in dependency order, so
 *      two runs of the same commit with the same prompt version are comparable.
 *      The model gets discretionary tool access only after the graph completes.
 *
 *   3. Auditability. Every node produces a ToolRun row, and successful runs
 *      accumulate into `validEvidenceIds` — the set of ids AI findings are allowed
 *      to cite. The evidence filter downstream is only meaningful because this set
 *      is built here from what actually executed.
 */

export const REVIEW_PIPELINE: readonly PipelineNode[] = [
  {
    tool: ToolName.GET_PR_DIFF,
    dependsOn: [],
    // Without a diff there is nothing to review, so this is the one hard failure.
    critical: true,
  },
  {
    tool: ToolName.GET_REPO_METADATA,
    dependsOn: [],
    critical: false,
  },
  {
    tool: ToolName.RUN_STATIC_ANALYSIS,
    dependsOn: [ToolName.GET_PR_DIFF],
    critical: false,
  },
  {
    tool: ToolName.EXTRACT_ML_FEATURES,
    dependsOn: [ToolName.GET_PR_DIFF],
    // Runs even when static analysis failed; finding counts fall back to zero.
    critical: false,
  },
  {
    tool: ToolName.PREDICT_PR_RISK,
    dependsOn: [ToolName.EXTRACT_ML_FEATURES],
    critical: false,
    condition: (state) => state.outputs.has(ToolName.EXTRACT_ML_FEATURES),
  },
  {
    tool: ToolName.RETRIEVE_CODE_CONTEXT,
    dependsOn: [ToolName.GET_PR_DIFF],
    critical: false,
    // Skipped on an unindexed repository rather than failing; the review proceeds
    // without repository context and says so.
    condition: (state) => {
      const metadata = state.outputs.get(ToolName.GET_REPO_METADATA);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
      return (metadata as Record<string, unknown>).indexed === true;
    },
  },
  {
    tool: ToolName.GENERATE_AI_REVIEW,
    dependsOn: [
      ToolName.GET_PR_DIFF,
      ToolName.RUN_STATIC_ANALYSIS,
      ToolName.PREDICT_PR_RISK,
      ToolName.RETRIEVE_CODE_CONTEXT,
    ],
    critical: false,
  },
  {
    tool: ToolName.GENERATE_TEST_SUGGESTIONS,
    dependsOn: [ToolName.GENERATE_AI_REVIEW],
    critical: false,
    condition: (state) => state.outputs.has(ToolName.GENERATE_AI_REVIEW),
  },
  {
    tool: ToolName.CREATE_REVIEW_REPORT,
    // Depends on EVERY artifact producer, not just the diff.
    //
    // This is the one node whose dependency list must be exhaustive. It is the only tool that
    // persists, so anything that completes after it is silently lost: an earlier version
    // depended on get_pr_diff alone, and the topological sort legitimately scheduled it before
    // predict_pr_risk — producing a stored report with no risk score and no findings, while
    // every tool reported success.
    //
    // These edges are advisory (see isRequired), so a failed or skipped upstream tool still
    // lets the report persist whatever did succeed.
    dependsOn: [
      ToolName.GET_PR_DIFF,
      ToolName.RUN_STATIC_ANALYSIS,
      ToolName.PREDICT_PR_RISK,
      ToolName.RETRIEVE_CODE_CONTEXT,
      ToolName.GENERATE_AI_REVIEW,
      ToolName.GENERATE_TEST_SUGGESTIONS,
    ],
    critical: true,
  },
  {
    tool: ToolName.POST_GITHUB_COMMENT,
    dependsOn: [ToolName.CREATE_REVIEW_REPORT],
    critical: false,
    // Requires an explicit request; never posts by default.
    condition: (state) => state.outputs.has(ToolName.CREATE_REVIEW_REPORT),
  },
  {
    tool: ToolName.CREATE_AUDIT_LOG,
    // Last, so its summary describes the whole run. With no dependencies it was scheduled
    // third and recorded "pipeline completed with 2 tool runs".
    dependsOn: [ToolName.CREATE_REVIEW_REPORT],
    critical: false,
  },
];

/** Maps each tool to the stage shown in the UI progress indicator. */
const TOOL_STAGE: Record<ToolName, ReviewStage> = {
  [ToolName.GET_PR_DIFF]: ReviewStage.FETCHING_DIFF,
  [ToolName.GET_REPO_METADATA]: ReviewStage.FETCHING_DIFF,
  [ToolName.RUN_STATIC_ANALYSIS]: ReviewStage.STATIC_ANALYSIS,
  [ToolName.EXTRACT_ML_FEATURES]: ReviewStage.FEATURE_EXTRACTION,
  [ToolName.PREDICT_PR_RISK]: ReviewStage.RISK_PREDICTION,
  [ToolName.RETRIEVE_CODE_CONTEXT]: ReviewStage.CONTEXT_RETRIEVAL,
  [ToolName.GENERATE_AI_REVIEW]: ReviewStage.AI_REVIEW,
  [ToolName.GENERATE_TEST_SUGGESTIONS]: ReviewStage.TEST_SUGGESTIONS,
  [ToolName.CREATE_REVIEW_REPORT]: ReviewStage.REPORT_ASSEMBLY,
  [ToolName.POST_GITHUB_COMMENT]: ReviewStage.PUBLISHING,
  [ToolName.CREATE_AUDIT_LOG]: ReviewStage.DONE,
};

export interface ToolRunRecord {
  tool: ToolName;
  status: ToolRunStatus;
  sequence: number;
  /** Null for a skipped tool, which never received an input. */
  input: JsonValue | null;
  output: JsonValue | null;
  error: string | null;
  durationMs: number;
  cacheHit: boolean;
  tokenUsage: { prompt: number; completion: number; total: number } | null;
  costCents: number;
  startedAt: Date;
  finishedAt: Date;
}

export interface OrchestratorHooks {
  /** Persist a ToolRun and return its database id, which becomes evidence. */
  persistToolRun(record: ToolRunRecord): Promise<string>;
  onStageChange(stage: ReviewStage, progress: number): Promise<void>;
  /** Build the input for a node from the outputs produced so far. */
  buildInput(tool: ToolName, state: PipelineState): Promise<JsonValue | null>;
  logger: ToolLogger;
}

export interface OrchestratorOptions {
  organizationId: string;
  userId: string | null;
  userRole: Role;
  reviewRunId: string;
  traceId: string;
  dryRun: boolean;
  budgetCents: number;
  signal: AbortSignal;
  /** Restrict execution to a subset of the pipeline. */
  onlyTools?: ToolName[];
}

export interface PipelineResult {
  state: PipelineState;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  failedCriticalTool: ToolName | null
  totalCostCents: number;
  totalTokens: { prompt: number; completion: number; total: number };
  capabilities: {
    staticAnalysis: boolean;
    mlRisk: boolean;
    ragContext: boolean;
    aiReview: boolean;
  };
  skipped: Array<{ tool: ToolName; reason: string }>;
}

export class ReviewOrchestrator {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly hooks: OrchestratorHooks,
  ) {}

  /**
   * Record a ToolRun for a tool that was deliberately not executed.
   *
   * Skipped tools get a row rather than being silently absent, because "this tool did not run,
   * and here is why" is materially different from "no record exists". Without it, an auditor
   * cannot distinguish a tool that was intentionally bypassed from one that was never wired up,
   * and a reviewer cannot see that, say, the GitHub comment was withheld on purpose.
   */
  private async recordSkipped(
    tool: ToolName,
    sequence: number,
    reason: string,
  ): Promise<void> {
    const now = new Date();

    try {
      await this.hooks.persistToolRun({
        tool,
        status: ToolRunStatus.SKIPPED,
        sequence,
        input: null,
        output: null,
        error: reason,
        durationMs: 0,
        cacheHit: false,
        tokenUsage: null,
        costCents: 0,
        startedAt: now,
        finishedAt: now,
      });
    } catch {
      // Audit bookkeeping must never fail a run.
    }
  }

  async run(
    options: OrchestratorOptions,
    pipeline: readonly PipelineNode[] = REVIEW_PIPELINE,
  ): Promise<PipelineResult> {
    const state: PipelineState = {
      outputs: new Map(),
      failures: new Map(),
      toolRunIds: new Map(),
      validEvidenceIds: new Set(),
    };

    const skipped: Array<{ tool: ToolName; reason: string }> = [];
    let sequence = 0;
    let spentCents = 0;
    const totalTokens = { prompt: 0, completion: 0, total: 0 };
    let failedCriticalTool: ToolName | null = null;

    const nodes = options.onlyTools
      ? pipeline.filter((node) => options.onlyTools?.includes(node.tool))
      : pipeline;

    const ordered = topologicalSort(nodes);

    for (const [index, node] of ordered.entries()) {
      if (options.signal.aborted) {
        skipped.push({ tool: node.tool, reason: 'Run cancelled' });
        continue;
      }

      // ---- dependency check
      //
      // A dependency that failed does not automatically skip this node. The graph
      // declares the relationship; whether to proceed is the node's `condition`.
      // This is what lets feature extraction survive a static analysis failure
      // while risk prediction correctly refuses to run without features.
      const missingCritical = node.dependsOn.filter(
        (dependency) => !state.outputs.has(dependency) && isRequired(node, dependency),
      );

      if (missingCritical.length > 0) {
        const reason = `Required dependencies unavailable: ${missingCritical.join(', ')}`;
        skipped.push({ tool: node.tool, reason });
        state.failures.set(node.tool, reason);
        sequence += 1;
        await this.recordSkipped(node.tool, sequence, reason);
        continue;
      }

      if (node.condition && !node.condition(state)) {
        const reason = 'Preconditions not met for this run';
        skipped.push({ tool: node.tool, reason });
        sequence += 1;
        await this.recordSkipped(node.tool, sequence, reason);
        continue;
      }

      // ---- build input
      const input = await this.hooks.buildInput(node.tool, state);

      if (input === null) {
        const reason = 'Not requested for this run';
        skipped.push({ tool: node.tool, reason });
        sequence += 1;
        await this.recordSkipped(node.tool, sequence, reason);
        continue;
      }

      // ---- stage progress
      const stage = TOOL_STAGE[node.tool];
      await this.hooks.onStageChange(stage, Math.round((index / ordered.length) * 100));

      // ---- execute
      sequence += 1;
      const startedAt = new Date();

      const ctx: ToolContext = {
        organizationId: options.organizationId,
        userId: options.userId,
        userRole: options.userRole,
        reviewRunId: options.reviewRunId,
        traceId: options.traceId,
        dryRun: options.dryRun,
        remainingBudgetCents: Math.max(0, options.budgetCents - spentCents),
        signal: options.signal,
        logger: this.hooks.logger,
      };

      const result = await this.registry.invoke(node.tool, input, ctx);
      const finishedAt = new Date();

      if (result.ok) {
        const { output, meta } = result.value;

        spentCents += meta.costCents;
        if (meta.tokenUsage) {
          totalTokens.prompt += meta.tokenUsage.prompt;
          totalTokens.completion += meta.tokenUsage.completion;
          totalTokens.total += meta.tokenUsage.total;
        }

        const toolRunId = await this.hooks.persistToolRun({
          tool: node.tool,
          status: ToolRunStatus.SUCCESS,
          sequence,
          input,
          output: output as JsonValue,
          error: null,
          durationMs: meta.durationMs,
          cacheHit: meta.cacheHit,
          tokenUsage: meta.tokenUsage,
          costCents: meta.costCents,
          startedAt,
          finishedAt,
        });

        state.outputs.set(node.tool, output as JsonValue);
        state.toolRunIds.set(node.tool, toolRunId);

        // Only successful runs become citable evidence. A failed analyzer must not
        // be usable to justify a finding.
        state.validEvidenceIds.add(toolRunId);

        this.hooks.logger.info(`${node.tool} succeeded`, {
          durationMs: meta.durationMs,
          costCents: meta.costCents,
          cacheHit: meta.cacheHit,
        });
        continue;
      }

      // ---- failure
      const error = result.error;
      const status =
        error.code === 'TIMED_OUT'
          ? ToolRunStatus.TIMED_OUT
          : error.code === 'BLOCKED_DRY_RUN'
            ? ToolRunStatus.SKIPPED
            : ToolRunStatus.FAILED;

      await this.hooks.persistToolRun({
        tool: node.tool,
        status,
        sequence,
        input,
        output: null,
        error: `${error.code}: ${error.message}`,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        cacheHit: false,
        tokenUsage: null,
        costCents: 0,
        startedAt,
        finishedAt,
      });

      state.failures.set(node.tool, error.message);

      this.hooks.logger.warn(`${node.tool} failed`, {
        code: error.code,
        message: error.message,
        critical: node.critical,
      });

      if (node.critical) {
        failedCriticalTool = node.tool;
        break;
      }
    }

    /**
     * Capabilities reflect whether a layer actually produced a result, not merely whether its
     * tool returned without error.
     *
     * A tool can succeed and still deliver nothing: `generate_ai_review` returns
     * `status: 'SKIPPED'` when no provider is configured, and `predict_pr_risk` returns
     * `status: 'UNAVAILABLE'` when the ML service is down. Both are successful executions of a
     * documented degraded path. Treating presence-of-output as capability marked a run
     * `hadAiReview: true` when no review existed, which would have made the UI present an
     * incomplete review as a complete one.
     */
    const producedResult = (tool: ToolName): boolean => {
      const output = state.outputs.get(tool);
      if (output === undefined || output === null) return false;
      if (typeof output !== 'object' || Array.isArray(output)) return true;

      const status = (output as Record<string, unknown>).status;
      if (typeof status !== 'string') return true;

      return status !== 'SKIPPED' && status !== 'UNAVAILABLE';
    };

    const capabilities = {
      staticAnalysis: producedResult(ToolName.RUN_STATIC_ANALYSIS),
      mlRisk: producedResult(ToolName.PREDICT_PR_RISK),
      // Retrieval "succeeds" with zero chunks on an unindexed repository, which is not context.
      ragContext: (() => {
        const output = state.outputs.get(ToolName.RETRIEVE_CODE_CONTEXT);
        if (!output || typeof output !== 'object' || Array.isArray(output)) return false;

        const withContext = (output as Record<string, unknown>).filesWithContext;
        const overview = (output as Record<string, unknown>).repositoryOverview;

        return (
          (typeof withContext === 'number' && withContext > 0) ||
          (Array.isArray(overview) && overview.length > 0)
        );
      })(),
      aiReview: producedResult(ToolName.GENERATE_AI_REVIEW),
    };

    // PARTIAL rather than COMPLETED when an optional layer was lost. The
    // distinction is surfaced in the UI so nobody mistakes a degraded review for
    // a full one.
    const status: PipelineResult['status'] = failedCriticalTool
      ? 'FAILED'
      : state.failures.size > 0
        ? 'PARTIAL'
        : 'COMPLETED';

    if (!failedCriticalTool) {
      await this.hooks.onStageChange(ReviewStage.DONE, 100);
    }

    return {
      state,
      status,
      failedCriticalTool,
      totalCostCents: spentCents,
      totalTokens,
      capabilities,
      skipped,
    };
  }
}

/**
 * A dependency is required when the dependent node cannot function without it.
 *
 * Note that `create_review_report` depends on every artifact producer for ORDERING, but none of
 * those edges are required: the report must still persist whatever succeeded when an optional
 * layer failed. Ordering and necessity are separate concerns, which is exactly why the graph
 * declares edges and this function decides which ones block.
 *
 * `get_pr_diff` is required by everything downstream: there is no meaningful
 * analysis of an absent diff. Every other edge is advisory, which is what enables
 * graceful degradation.
 */
function isRequired(node: PipelineNode, dependency: ToolName): boolean {
  if (dependency === ToolName.GET_PR_DIFF) return true;
  if (node.tool === ToolName.PREDICT_PR_RISK && dependency === ToolName.EXTRACT_ML_FEATURES) {
    return true;
  }
  if (node.tool === ToolName.POST_GITHUB_COMMENT && dependency === ToolName.CREATE_REVIEW_REPORT) {
    return true;
  }
  return false;
}

/**
 * Kahn's algorithm over the declared graph.
 *
 * A cycle here is a programming error in the pipeline definition, not a runtime
 * condition, so it throws rather than degrading — silently dropping nodes would
 * produce a review missing stages with no indication why.
 */
export function topologicalSort(nodes: readonly PipelineNode[]): PipelineNode[] {
  const byName = new Map(nodes.map((node) => [node.tool, node]));
  const inDegree = new Map<ToolName, number>();
  const dependents = new Map<ToolName, ToolName[]>();

  for (const node of nodes) {
    inDegree.set(node.tool, 0);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      // Ignore edges to nodes excluded from this run.
      if (!byName.has(dependency)) continue;

      inDegree.set(node.tool, (inDegree.get(node.tool) ?? 0) + 1);
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.tool]);
    }
  }

  // Seed in declaration order so execution is stable across runs, which keeps
  // ToolRun sequence numbers comparable between reviews.
  const queue = nodes.filter((node) => (inDegree.get(node.tool) ?? 0) === 0).map((n) => n.tool);
  const sorted: PipelineNode[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    const node = byName.get(current);
    if (node) sorted.push(node);

    for (const dependent of dependents.get(current) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== nodes.length) {
    const unresolved = nodes
      .filter((node) => !sorted.includes(node))
      .map((node) => node.tool)
      .join(', ');
    throw new Error(`Review pipeline contains a dependency cycle involving: ${unresolved}`);
  }

  return sorted;
}

/** Read a typed output from pipeline state. */
export function readOutput<T>(state: PipelineState, tool: ToolName): T | null {
  const value = state.outputs.get(tool);
  return value === undefined ? null : (value as T);
}

/** Human-readable summary of what degraded, for the run detail page. */
export function describeDegradation(result: PipelineResult): string[] {
  const notes: string[] = [];

  if (!result.capabilities.staticAnalysis) {
    notes.push(
      'Static analysis did not complete, so findings are limited to what the AI could infer from the diff alone.',
    );
  }
  if (!result.capabilities.mlRisk) {
    notes.push('The ML risk model was unavailable, so this review has no risk score.');
  }
  if (!result.capabilities.ragContext) {
    notes.push(
      'Repository context was unavailable — index this repository for reviews that account for existing conventions.',
    );
  }
  if (!result.capabilities.aiReview) {
    notes.push(
      'The AI review could not be generated. Other analysis results are reported separately.',
    );
  }

  for (const entry of result.skipped) {
    notes.push(`${entry.tool} was skipped: ${entry.reason}`);
  }

  return notes;
}

export { toErrorMessage };
