import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { isRetryEligible } from '../retry-eligibility';
import { AppConfigService } from '../../config/app-config.service';
import type { BaseJobData, JobProgress, ManagedQueue } from '../queue.types';
import { isWorkerProcess } from '../worker-mode';

/**
 * Shared processor behaviour: startup gating, concurrency and lifecycle logging.
 *
 * The startup gating is the part that matters. Workers are declared with
 * `autorun: false` and started here only when this process is supposed to run them, which
 * is what makes `RUN_WORKERS_IN_API=false` a real deployment mode rather than a flag that
 * is read and ignored. Running the API and the workers as separate processes is the
 * difference between a slow analysis making the dashboard slow and it not.
 *
 * Concurrency is applied at runtime rather than in the `@Processor` decorator because
 * decorator arguments are evaluated at import time, before configuration is loaded.
 */
export abstract class BaseQueueProcessor<TData extends BaseJobData>
  extends WorkerHost
  implements OnApplicationBootstrap
{
  protected abstract readonly queueName: ManagedQueue;
  protected abstract readonly logger: Logger;

  constructor(protected readonly config: AppConfigService) {
    super();
  }

  /**
   * How many jobs this worker runs at once.
   *
   * Overridden per queue. The defaults are not arbitrary: analysis is CPU- and
   * subprocess-heavy, while indexing and syncing are bounded by third-party rate limits,
   * where more concurrency makes things strictly worse.
   */
  protected concurrency(): number {
    return this.config.queue.concurrency;
  }

  onApplicationBootstrap(): void {
    // A dedicated worker process always consumes, whatever RUN_WORKERS_IN_API says: that flag
    // describes whether the *API* should double as a worker, and the production layout sets
    // it to false precisely so this process exists.
    const dedicated = isWorkerProcess();

    if (!dedicated && !this.config.queue.runWorkersInApi) {
      this.logger.log(
        `Worker for "${this.queueName}" is registered but not started ` +
          `(RUN_WORKERS_IN_API=false). Run "pnpm --filter @codelens/api worker" to process it.`,
      );
      return;
    }

    const concurrency = this.concurrency();
    this.worker.concurrency = concurrency;

    // `run()` resolves when the worker closes, so it is intentionally not awaited here;
    // awaiting it would block application bootstrap forever.
    void this.worker.run().catch((error: unknown) => {
      this.logger.error(
        `Worker for "${this.queueName}" stopped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });

    this.logger.log(
      `Worker for "${this.queueName}" started with concurrency ${concurrency}` +
        (dedicated ? ' (dedicated worker process)' : ' (in-process with the API)'),
    );
  }

  /** Publish progress. Never allowed to fail a job. */
  protected async report(job: Job<TData>, progress: JobProgress): Promise<void> {
    try {
      await job.updateProgress(progress);
    } catch {
      // Progress is a UI affordance. Losing it is not a reason to fail real work.
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<TData>): void {
    this.logger.log(
      `Started ${job.name} ${job.id} trace=${job.data.traceId} ` +
        `attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<TData>): void {
    const durationMs =
      job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null;

    this.logger.log(
      `Completed ${job.name} ${job.id} trace=${job.data.traceId}` +
        (durationMs === null ? '' : ` in ${Math.round(durationMs / 1000)}s`),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TData> | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const willRetry = isRetryEligible(job, error);

    this.logger.error(
      `Failed ${job?.name ?? 'job'} ${job?.id ?? '?'} ` +
        `trace=${job?.data.traceId ?? 'unknown'} ` +
        `(attempt ${job?.attemptsMade ?? 0}/${attempts}, ` +
        `${willRetry ? 'retry eligible' : 'giving up'}): ${error.message}`,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    // A stall means the worker stopped renewing its lock: usually the event loop was
    // blocked, or the process died mid-job. Worth surfacing loudly because the job is
    // about to be reprocessed.
    this.logger.warn(
      `Job ${jobId} on "${this.queueName}" stalled and will be reprocessed. The previous ` +
        `attempt either blocked the event loop past the lock duration or the process died.`,
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.warn(`Worker error on "${this.queueName}": ${error.message}`);
  }
}
