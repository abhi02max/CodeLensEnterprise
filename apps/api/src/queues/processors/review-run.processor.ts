import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { QUEUE_NAMES, ReviewRunStatus, type ReviewStage } from '@codelens/shared';
import type { Job } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service';
import { AnalysisService } from '../../analysis/analysis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyJobError } from '../queue.service';
import type { AnalyzePullRequestJobData, ManagedQueue } from '../queue.types';
import { BaseQueueProcessor } from './base.processor';
import { isRetryEligible } from '../retry-eligibility';

/**
 * Runs the review pipeline off the queue.
 *
 * `autorun: false` hands start-up control to {@link BaseQueueProcessor}, which only starts
 * the worker when this process is meant to run workers.
 *
 * `lockDuration` is raised well above the default 30 seconds because a single pipeline stage
 * can legitimately occupy the worker for minutes — Semgrep on a large diff, or a
 * map-reduce AI review over many files. With the default, BullMQ would consider the job
 * stalled and hand it to a second worker while the first was still running it, producing two
 * concurrent analyses of the same commit.
 */
@Processor(QUEUE_NAMES.REVIEW_RUN, { autorun: false, lockDuration: 300_000 })
export class ReviewRunProcessor extends BaseQueueProcessor<AnalyzePullRequestJobData> {
  protected readonly queueName: ManagedQueue = QUEUE_NAMES.REVIEW_RUN;
  protected readonly logger = new Logger(ReviewRunProcessor.name);

  constructor(
    config: AppConfigService,
    private readonly analysis: AnalysisService,
    private readonly prisma: PrismaService,
  ) {
    super(config);
  }

  async process(job: Job<AnalyzePullRequestJobData>): Promise<{
    reviewRunId: string;
    status: string;
    reused: boolean;
    degradation: string[];
  }> {
    const data = job.data;

    // Carried across every progress write. Each `updateProgress` replaces the whole payload,
    // so reporting the run id only once would make it appear and then vanish from the
    // client's view on the next stage change.
    const previousProgress = job.progress;
    const previousRunId = previousProgress && typeof previousProgress === 'object' &&
      'reviewRunId' in previousProgress && typeof previousProgress.reviewRunId === 'string'
      ? previousProgress.reviewRunId : null;
    let reviewRunId: string | null = previousRunId;

    await this.report(job, { percent: 1, stage: 'PENDING', message: 'Starting analysis',
      ...(previousRunId ? { reviewRunId: previousRunId } : {}) });

    try {
      if (previousRunId) {
        await this.prisma.unscoped.reviewRun.updateMany({
          where: { id: previousRunId, organizationId: data.organizationId,
            status: ReviewRunStatus.RUNNING },
          data: { status: ReviewRunStatus.FAILED, finishedAt: new Date(),
            error: 'The prior worker stopped before this queued attempt began.' },
        });
      }
      const result = await this.analysis.run({
        organizationId: data.organizationId,
        pullRequestId: data.pullRequestId,
        userId: data.userId,
        userRole: data.userRole,
        traceId: data.traceId,
        trigger: data.trigger,
        force: data.force,
        postToGithub: data.postToGithub,
        headSha: data.headSha,

        // Published as soon as the row exists so a client can stop polling the job and
        // start polling the run, which exposes per-tool detail the job cannot.
        onRunCreated: (createdId) => {
          reviewRunId = createdId;

          void this.report(job, {
            percent: 3,
            stage: 'PENDING',
            reviewRunId: createdId,
            message: 'Review run created',
          });
        },

        onStageChange: (stage: ReviewStage, percent: number) => {
          void this.report(job, {
            percent,
            stage,
            message: describeStage(stage),
            ...(reviewRunId === null ? {} : { reviewRunId }),
          });
        },
      });

      await this.report(job, {
        percent: 100,
        stage: 'DONE',
        reviewRunId: result.reviewRunId,
        message: result.reused ? 'Reused an equivalent completed run' : 'Analysis complete',
      });

      return {
        reviewRunId: result.reviewRunId,
        status: result.status,
        reused: result.reused,
        degradation: result.degradation,
      };
    } catch (error) {
      // AnalysisService has already marked the ReviewRun FAILED and written an audit
      // entry, so there is nothing to clean up here — only a retry decision to make.
      throw classifyJobError(error);
    }
  }

  /**
   * Close out a run whose job has given up.
   *
   * `AnalysisService.run` marks the ReviewRun FAILED when the pipeline throws, but it cannot
   * do anything when the worker process dies mid-job: the row stays RUNNING forever and the
   * UI shows an analysis permanently in progress. BullMQ recovers the job through its stalled
   * check, and when that eventually exhausts the attempts this is the only place left that
   * knows which run to close.
   *
   * The run id comes from job progress, which is why the processor republishes it on every
   * progress write rather than only once.
   */
  @OnWorkerEvent('failed')
  async onJobExhausted(job: Job<AnalyzePullRequestJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    if (isRetryEligible(job, error)) return;

    const progress = job.progress;
    const reviewRunId =
      progress && typeof progress === 'object' && 'reviewRunId' in progress
        ? (progress as { reviewRunId?: unknown }).reviewRunId
        : undefined;

    if (typeof reviewRunId !== 'string') return;

    try {
      // Conditional on the row still being RUNNING: if the pipeline already recorded its own
      // failure, that error message is more specific than anything available here.
      const { count } = await this.prisma.unscoped.reviewRun.updateMany({
        where: { id: reviewRunId, status: ReviewRunStatus.RUNNING },
        data: {
          status: ReviewRunStatus.FAILED,
          finishedAt: new Date(),
          error:
            `The analysis job terminated without completing after ${job.attemptsMade} of ${attempts} allowed attempt(s). ` +
            `Check the job failure diagnostics and re-run the analysis.`,
        },
      });

      if (count > 0) {
        this.logger.warn(`Closed abandoned review run ${reviewRunId} left RUNNING by job ${job.id}`);
      }
    } catch (error) {
      this.logger.error(
        `Could not close abandoned review run ${reviewRunId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One at a time per worker by default is deliberate for this queue.
   *
   * A run spawns Semgrep and ESLint subprocesses and holds a full diff plus retrieved
   * context in memory. Overlapping several on one process mostly buys lock contention and
   * memory pressure; horizontal worker processes scale this better than raising
   * concurrency does.
   */
  protected override concurrency(): number {
    return Math.max(1, Math.min(this.config.queue.concurrency, 4));
  }
}

function describeStage(stage: ReviewStage): string {
  const descriptions: Partial<Record<ReviewStage, string>> = {
    PENDING: 'Preparing the run',
    FETCHING_DIFF: 'Fetching the diff from GitHub',
    STATIC_ANALYSIS: 'Running static analysis',
    FEATURE_EXTRACTION: 'Extracting risk features',
    RISK_PREDICTION: 'Predicting risk',
    CONTEXT_RETRIEVAL: 'Retrieving repository context',
    AI_REVIEW: 'Generating the AI review',
    TEST_SUGGESTIONS: 'Suggesting tests',
    REPORT_ASSEMBLY: 'Assembling the report',
    PUBLISHING: 'Publishing to GitHub',
    DONE: 'Complete',
  };

  return descriptions[stage] ?? stage;
}
