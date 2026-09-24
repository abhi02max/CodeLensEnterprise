import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  REVIEW_STAGE_ORDER,
  PROMPT_VERSION,
  ReviewRunStatus,
  ReviewStage,
  ToolName,
  reviewRunProgress,
  toErrorMessage,
  type JsonValue,
  type PipelineState,
  type Role,
} from '@codelens/shared';
import { McpToolRegistry, ReviewOrchestrator, describeDegradation } from '@codelens/ai-agent';
import { Prisma, RunTrigger, ToolRunStatus } from '@codelens/database';
import { NestToolLogger } from '../common/tool-logger';
import { NotFoundError, RateLimitedError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit-logs/audit.service';
import { PolicyService } from '../organizations/policy.service';
import { ToolRegistryService } from '../mcp-tools/tool-registry.service';
import { QueueService } from '../queues/queue.service';
import type { JobStatus } from '../queues/queue.types';
import { RunScratchpad } from './run-scratchpad';

export interface RunAnalysisParams {
  organizationId: string;
  pullRequestId: string;
  userId: string | null;
  userRole: Role;
  traceId: string;
  trigger: RunTrigger;
  force: boolean;
  postToGithub: boolean;
  dryRun?: boolean;

  /**
   * Called once the ReviewRun row exists.
   *
   * The queue worker publishes this id as job progress immediately, which lets a client
   * stop polling the opaque job and start polling the run itself — where per-tool status,
   * findings and partial results are visible while the pipeline is still executing.
   */
  onRunCreated?: (reviewRunId: string) => void;

  /** Stage transitions, with a precomputed percentage for progress reporting. */
  onStageChange?: (stage: ReviewStage, percent: number) => void;
}

/**
 * The analysis pipeline.
 *
 * Creates a ReviewRun, drives the eleven tools through `ReviewOrchestrator`'s declared DAG,
 * persists every ToolRun, and finalises the run's status.
 *
 * Two mechanisms are worth calling out because they are what make this safe to expose:
 *
 * IDEMPOTENCY. A run is keyed on (pullRequestId, headSha, promptVersion, featureSchemaVersion).
 * Re-requesting analysis of unchanged code returns the existing run instead of paying for it
 * twice. A new commit, a prompt revision, or a feature schema bump all produce a genuinely
 * different analysis and therefore a new run.
 *
 * ADVISORY LOCKING. A Redis lock stops two workers analysing the same pull request
 * concurrently. The idempotency key is the real correctness guarantee; the lock exists to avoid
 * obviously wasted LLM spend.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly registry: ToolRegistryService,
    private readonly scratchpad: RunScratchpad,
    private readonly queues: QueueService,
  ) {}

  /**
   * Queue an analysis run and return a pollable job.
   *
   * The pull request is resolved here rather than in the worker for two reasons. It turns a
   * bad id into an immediate 404 instead of a job that fails a few seconds later in a place
   * the caller is not looking. And it pins the head SHA at request time, so the job analyses
   * the commit the caller asked about even if the branch moves before a worker picks it up.
   */
  async enqueue(params: {
    organizationId: string;
    pullRequestId: string;
    userId: string | null;
    userRole: Role;
    traceId: string;
    trigger: RunTrigger;
    force: boolean;
    postToGithub: boolean;
  }): Promise<JobStatus> {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: params.pullRequestId, organizationId: params.organizationId },
      select: { id: true, headSha: true, repositoryId: true },
    });

    if (!pullRequest) throw new NotFoundError('Pull request', params.pullRequestId);

    return this.queues.enqueueAnalysis({
      organizationId: params.organizationId,
      pullRequestId: pullRequest.id,
      repositoryId: pullRequest.repositoryId,
      headSha: pullRequest.headSha,
      userId: params.userId,
      userRole: params.userRole,
      traceId: params.traceId,
      trigger: params.trigger,
      force: params.force,
      postToGithub: params.postToGithub,
    });
  }

  /**
   * Run the full pipeline synchronously.
   *
   * Called by the BullMQ worker. The HTTP endpoint enqueues rather than calling this directly,
   * because a full run can take minutes.
   */
  async run(params: RunAnalysisParams): Promise<{
    reviewRunId: string;
    status: ReviewRunStatus;
    reused: boolean;
    degradation: string[];
  }> {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: params.pullRequestId, organizationId: params.organizationId },
      select: {
        id: true,
        number: true,
        headSha: true,
        repositoryId: true,
        repository: { select: { fullName: true } },
      },
    });

    if (!pullRequest) throw new NotFoundError('Pull request', params.pullRequestId);

    const idempotencyKey = [
      pullRequest.id,
      pullRequest.headSha,
      PROMPT_VERSION,
      1,
    ].join(':');

    // ---- reuse an equivalent completed run
    if (!params.force) {
      const existing = await this.prisma.unscoped.reviewRun.findUnique({
        where: { idempotencyKey },
        select: { id: true, status: true },
      });

      if (existing && existing.status === ReviewRunStatus.COMPLETED) {
        this.logger.log(
          `Reusing completed run ${existing.id} for ${pullRequest.repository.fullName}` +
            `#${pullRequest.number} at ${pullRequest.headSha.slice(0, 7)}`,
        );

        return {
          reviewRunId: existing.id,
          status: existing.status,
          reused: true,
          degradation: [],
        };
      }
    }

    // ---- per-organization rate limit
    //
    // Separate from the HTTP throttler, which is per IP. Without this one tenant could queue
    // hundreds of analyses and starve every other tenant's workers.
    const limit = await this.redis.consumeRateLimit(
      `analysis:${params.organizationId}`,
      60,
      3600,
    );

    if (!limit.allowed) {
      throw new RateLimitedError(
        `This organization has reached its analysis limit of 60 runs per hour. ` +
          `Resets in ${Math.ceil(limit.resetInSeconds / 60)} minutes.`,
        limit.resetInSeconds,
      );
    }

    const lockKey = `analysis:lock:${pullRequest.id}:${pullRequest.headSha}`;
    const acquired = await this.redis.acquireLock(lockKey, 900);

    if (!acquired) {
      throw new RateLimitedError(
        'An analysis of this pull request at this commit is already running.',
        60,
      );
    }

    // A forced re-run needs a distinct key, or it would collide with the run it replaces.
    const runKey = params.force ? `${idempotencyKey}:${Date.now()}` : idempotencyKey;

    const reviewRun = await this.prisma.unscoped.reviewRun.upsert({
      where: { idempotencyKey: runKey },
      create: {
        organizationId: params.organizationId,
        pullRequestId: pullRequest.id,
        status: ReviewRunStatus.RUNNING,
        stage: ReviewStage.PENDING,
        trigger: params.trigger,
        triggeredByUserId: params.userId,
        headSha: pullRequest.headSha,
        promptVersion: PROMPT_VERSION,
        featureSchemaVersion: 1,
        idempotencyKey: runKey,
      },
      update: {
        status: ReviewRunStatus.RUNNING,
        stage: ReviewStage.PENDING,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
      },
      select: { id: true },
    });

    this.scratchpad.create({
      reviewRunId: reviewRun.id,
      organizationId: params.organizationId,
      pullRequestId: pullRequest.id,
      repositoryId: pullRequest.repositoryId,
    });

    params.onRunCreated?.(reviewRun.id);

    const aiSettings = await this.policy.getAiSettings(params.organizationId);
    const controller = new AbortController();
    const startedAt = Date.now();

    try {
      const orchestrator = new ReviewOrchestrator(this.registry.registry, {
        persistToolRun: (record) =>
          this.persistToolRun(reviewRun.id, record),
        onStageChange: (stage) =>
          this.updateStage(reviewRun.id, stage, params.onStageChange),
        buildInput: (tool, state) =>
          this.buildToolInput(tool, state, {
            organizationId: params.organizationId,
            pullRequestId: pullRequest.id,
            repositoryId: pullRequest.repositoryId,
            reviewRunId: reviewRun.id,
            postToGithub: params.postToGithub,
          }),
        logger: new NestToolLogger('Pipeline', {
          traceId: params.traceId,
          reviewRunId: reviewRun.id,
          pr: `${pullRequest.repository.fullName}#${pullRequest.number}`,
        }),
      });

      const result = await orchestrator.run({
        organizationId: params.organizationId,
        userId: params.userId,
        userRole: params.userRole,
        reviewRunId: reviewRun.id,
        traceId: params.traceId,
        dryRun: params.dryRun ?? false,
        budgetCents: aiSettings.maxCostCentsPerRun,
        signal: controller.signal,
      });

      const status =
        result.status === 'FAILED'
          ? ReviewRunStatus.FAILED
          : result.status === 'PARTIAL'
            ? ReviewRunStatus.PARTIAL
            : ReviewRunStatus.COMPLETED;

      await this.prisma.unscoped.reviewRun.update({
        where: { id: reviewRun.id },
        data: {
          status,
          stage: result.failedCriticalTool ? undefined : ReviewStage.DONE,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          promptTokens: result.totalTokens.prompt,
          completionTokens: result.totalTokens.completion,
          costCents: result.totalCostCents,
          hadStaticAnalysis: result.capabilities.staticAnalysis,
          hadMlRisk: result.capabilities.mlRisk,
          hadRagContext: result.capabilities.ragContext,
          hadAiReview: result.capabilities.aiReview,
          error: result.failedCriticalTool
            ? `Critical tool ${result.failedCriticalTool} failed: ` +
              `${result.state.failures.get(result.failedCriticalTool) ?? 'unknown error'}`
            : null,
        },
      });

      const degradation = describeDegradation(result);

      await this.audit.record({
        organizationId: params.organizationId,
        action:
          status === ReviewRunStatus.FAILED
            ? AuditAction.REVIEW_RUN_FAILED
            : AuditAction.REVIEW_RUN_COMPLETED,
        actorId: params.userId,
        resourceType: 'ReviewRun',
        resourceId: reviewRun.id,
        description:
          `Analysis run ${status.toLowerCase()} for ${pullRequest.repository.fullName}` +
          `#${pullRequest.number} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
          (result.totalCostCents > 0 ? ` (${result.totalCostCents}c)` : ''),
        metadata: {
          status,
          durationMs: Date.now() - startedAt,
          capabilities: result.capabilities,
          costCents: result.totalCostCents,
          tokens: result.totalTokens.total,
          skipped: result.skipped.map((entry) => `${entry.tool}: ${entry.reason}`),
        },
        traceId: params.traceId,
      });

      this.logger.log(
        `Run ${reviewRun.id} ${status} in ${Math.round((Date.now() - startedAt) / 1000)}s ` +
          `(static=${result.capabilities.staticAnalysis} ml=${result.capabilities.mlRisk} ` +
          `rag=${result.capabilities.ragContext} ai=${result.capabilities.aiReview})`,
      );

      return { reviewRunId: reviewRun.id, status, reused: false, degradation };
    } catch (error) {
      const message = toErrorMessage(error);

      await this.prisma.unscoped.reviewRun.update({
        where: { id: reviewRun.id },
        data: {
          status: ReviewRunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      });

      await this.audit.record({
        organizationId: params.organizationId,
        action: AuditAction.REVIEW_RUN_FAILED,
        actorId: params.userId,
        resourceType: 'ReviewRun',
        resourceId: reviewRun.id,
        description: `Analysis run failed: ${message}`,
        traceId: params.traceId,
      });

      throw error;
    } finally {
      // Always release, so a crash does not block re-analysis for the full lock TTL.
      await this.redis.releaseLock(lockKey);
      this.scratchpad.release(reviewRun.id);
    }
  }

  /**
   * Assemble each tool's input from the pipeline state.
   *
   * This is where tool composition actually happens: the orchestrator owns ordering, and this
   * function owns data flow. Returning null skips the tool.
   */
  private async buildToolInput(
    tool: ToolName,
    state: PipelineState,
    ctx: {
      organizationId: string;
      pullRequestId: string;
      repositoryId: string;
      reviewRunId: string;
      postToGithub: boolean;
    },
  ): Promise<JsonValue | null> {
    switch (tool) {
      case ToolName.GET_PR_DIFF:
        return { pullRequestId: ctx.pullRequestId, refresh: false };

      case ToolName.GET_REPO_METADATA:
        return { repositoryId: ctx.repositoryId };

      case ToolName.RUN_STATIC_ANALYSIS:
        return { pullRequestId: ctx.pullRequestId, repositoryId: ctx.repositoryId };

      case ToolName.EXTRACT_ML_FEATURES:
        return { pullRequestId: ctx.pullRequestId, repositoryId: ctx.repositoryId };

      case ToolName.PREDICT_PR_RISK: {
        // Features come from the scratchpad rather than the previous tool's output, because
        // the output is a summary while the scratchpad holds the real vector.
        const features = this.scratchpad.get(ctx.reviewRunId)?.features;
        if (!features) return null;

        return {
          organizationId: ctx.organizationId,
          features: features as unknown as JsonValue,
          includeExplanation: true,
        };
      }

      case ToolName.RETRIEVE_CODE_CONTEXT:
        return {
          repositoryId: ctx.repositoryId,
          pullRequestId: ctx.pullRequestId,
          maxTokensPerFile: this.config.rag.maxContextTokensPerFile,
        };

      case ToolName.GENERATE_AI_REVIEW: {
        // The evidence set is the crux of the anti-hallucination design: only ToolRuns that
        // actually succeeded may be cited, and the model is shown the mapping so it can cite
        // real ids rather than inventing them.
        const evidenceIds: Record<string, string> = {};

        for (const [toolName, toolRunId] of state.toolRunIds.entries()) {
          evidenceIds[toolName] = toolRunId;
        }

        return {
          pullRequestId: ctx.pullRequestId,
          repositoryId: ctx.repositoryId,
          validEvidenceIds: [...state.validEvidenceIds],
          evidenceIds,
        };
      }

      case ToolName.GENERATE_TEST_SUGGESTIONS: {
        const missingTests =
          this.scratchpad.get(ctx.reviewRunId)?.aiReview?.review.missingTests ?? [];
        return {
          pullRequestId: ctx.pullRequestId,
          repositoryId: ctx.repositoryId,
          missingTests,
        };
      }

      case ToolName.CREATE_REVIEW_REPORT:
        return { reviewRunId: ctx.reviewRunId, pullRequestId: ctx.pullRequestId };

      case ToolName.POST_GITHUB_COMMENT: {
        if (!ctx.postToGithub) return null;

        const policy = await this.policy.getPolicy(ctx.organizationId);

        // Requires both an explicit request and the organization opt-in. Neither alone is
        // enough to write to a customer's repository.
        if (!policy.autoPostGithubComment && !ctx.postToGithub) return null;

        return {
          pullRequestId: ctx.pullRequestId,
          reviewRunId: ctx.reviewRunId,
          includeFileBreakdown: false,
          includeRiskScore: true,
          includeChecklist: true,
          minSeverity: 'MEDIUM',
          categories: [],
        };
      }

      case ToolName.CREATE_AUDIT_LOG: {
        const scratch = this.scratchpad.get(ctx.reviewRunId);
        const risk = scratch?.prediction?.response;

        return {
          action: AuditAction.TOOL_EXECUTED,
          resourceType: 'ReviewRun',
          resourceId: ctx.reviewRunId,
          description:
            `Pipeline completed with ${state.toolRunIds.size} tool run(s)` +
            (risk ? `, risk ${Math.round(risk.risk_score)}/100` : ''),
          metadata: {
            toolsSucceeded: [...state.toolRunIds.keys()],
            toolsFailed: [...state.failures.keys()],
          },
        };
      }

      default:
        return null;
    }
  }

  private async persistToolRun(
    reviewRunId: string,
    record: {
      tool: ToolName;
      status: ToolRunStatus | string;
      sequence: number;
      input: JsonValue | null;
      output: JsonValue | null;
      error: string | null;
      durationMs: number;
      cacheHit: boolean;
      tokenUsage: { prompt: number; completion: number; total: number } | null;
      costCents: number;
      startedAt: Date;
      finishedAt: Date;
    },
  ): Promise<string> {
    const row = await this.prisma.unscoped.toolRun.create({
      data: {
        reviewRunId,
        tool: record.tool,
        status: record.status as ToolRunStatus,
        sequence: record.sequence,
        // Prisma distinguishes JSON null from SQL NULL and so excludes bare `null` from
        // InputJsonValue, hence the explicit JsonNull for skipped tools.
        input:
          record.input === null
            ? Prisma.JsonNull
            : (truncateJson(record.input) as Prisma.InputJsonValue),
        output:
          record.output === null
            ? Prisma.JsonNull
            : (truncateJson(record.output) as Prisma.InputJsonValue),
        error: record.error,
        durationMs: record.durationMs,
        cacheHit: record.cacheHit,
        promptTokens: record.tokenUsage?.prompt ?? null,
        completionTokens: record.tokenUsage?.completion ?? null,
        costCents: record.costCents,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
      select: { id: true },
    });

    return row.id;
  }

  private async updateStage(
    reviewRunId: string,
    stage: ReviewStage,
    onStageChange?: (stage: ReviewStage, percent: number) => void,
  ): Promise<void> {
    // Fired before the write so queue progress is not delayed by database latency, and so a
    // failed write still reports progress.
    onStageChange?.(stage, this.progressOf(stage));

    await this.prisma.unscoped.reviewRun
      .update({ where: { id: reviewRunId }, data: { stage } })
      .catch(() => {
        // Progress reporting must never fail a run.
      });
  }

  /** Progress for the UI, derived from the stage. */
  progressOf(stage: ReviewStage): number {
    return reviewRunProgress(stage, REVIEW_STAGE_ORDER);
  }
}

/**
 * Cap the size of persisted tool input and output.
 *
 * Tools already return summaries, but a pathological diff or a long analyzer error could still
 * produce a very large JSON value, and ToolRun is an audit table rather than a blob store.
 */
function truncateJson(value: JsonValue, maxChars = 60_000): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return value;

  return {
    _truncated: true,
    _originalSizeBytes: serialized.length,
    _note:
      'This tool payload exceeded the audit row size cap and was truncated. The full ' +
      'artifacts are persisted in their own tables.',
    preview: serialized.slice(0, 2000),
  };
}
