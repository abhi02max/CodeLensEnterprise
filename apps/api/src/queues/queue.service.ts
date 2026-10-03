import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JOB_NAMES, PROMPT_VERSION, QUEUE_NAMES } from '@codelens/shared';
import { Queue, UnrecoverableError, type Job, type JobsOptions } from 'bullmq';
import { AppConfigService } from '../config/app-config.service';
import {
  AppException,
  NotFoundError,
  UpstreamUnavailableError,
  ValidationError,
} from '../common/errors';
import {
  JOB_IDS,
  MANAGED_QUEUES,
  encodeJobHandle,
  decodeJobHandle,
  type AnalyzePullRequestJobData,
  type BaseJobData,
  type IndexRepositoryJobData,
  type JobProgress,
  type JobState,
  type JobStatus,
  type ManagedQueue,
  type SyncPullRequestsJobData,
  type CollaborationJobData,
} from './queue.types';

/**
 * Producer side of the queue layer.
 *
 * Nothing in here knows how a job is executed; that lives in the processors. Keeping the
 * producer free of processor dependencies is what lets `RepositoriesService` enqueue an
 * indexing job without a module cycle back through `RagService`.
 *
 * Two behaviours are worth reading before using this:
 *
 * DEDUPLICATION. Job ids are deterministic. Enqueuing an analysis of the same pull request
 * at the same commit twice returns the first job rather than creating a second, and the
 * response says so via `deduplicated`. That makes a double-clicked button and a retried
 * HTTP request both harmless.
 *
 * TENANT SCOPING ON READ. Reads take an organization id and return 404 when the job belongs
 * to another tenant. Job ids are guessable — they are derived from resource ids — so
 * authorization cannot rely on them being secret.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues: Record<ManagedQueue, Queue>;

  constructor(
    @InjectQueue(QUEUE_NAMES.REVIEW_RUN) reviewRun: Queue,
    @InjectQueue(QUEUE_NAMES.REPO_INDEX) repoIndex: Queue,
    @InjectQueue(QUEUE_NAMES.PR_SYNC) prSync: Queue,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUE_NAMES.COLLABORATION) collaboration: Queue,
  ) {
    this.queues = {
      [QUEUE_NAMES.COLLABORATION]: collaboration,
      [QUEUE_NAMES.REVIEW_RUN]: reviewRun,
      [QUEUE_NAMES.REPO_INDEX]: repoIndex,
      [QUEUE_NAMES.PR_SYNC]: prSync,
    };
  }

  // ---------------------------------------------------------------- enqueue

  async enqueueCollaboration(data: CollaborationJobData): Promise<void> {
    const queue = this.queues[QUEUE_NAMES.COLLABORATION];
    const jobId = `collaborate-${data.turnId}-${data.attempt}`;
    // Retained failures and completions are never removed/replayed. Explicit retry has a new attempt ID.
    try {
      if (await queue.getJob(jobId)) return;
      await queue.add('collaborate', data, { jobId, attempts: 1 });
    } catch {
      throw new UpstreamUnavailableError('redis', 'Conversation saved; queue unavailable. Retry sending the same message.');
    }
  }

  /**
   * Queue a full analysis run.
   *
   * The caller is expected to have already validated that the pull request exists and
   * belongs to the organization: a job id handed back for a non-existent resource is a
   * 404 deferred by a few seconds.
   */
  async enqueueAnalysis(data: AnalyzePullRequestJobData, latestTerminalRunId: string | null = null): Promise<JobStatus> {
    const jobId = data.force
      ? JOB_IDS.analyzeForced(data.pullRequestId, data.headSha)
      : JOB_IDS.analyze(data.pullRequestId, data.headSha, PROMPT_VERSION, 1, latestTerminalRunId);

    return this.add(QUEUE_NAMES.REVIEW_RUN, JOB_NAMES.ANALYZE_PULL_REQUEST, jobId, data, {
      // A full run is minutes of work across several paid upstreams. Retrying it three
      // times on a deterministic failure is expensive and pointless, so transient
      // failures get one retry and deterministic ones are classified as unrecoverable
      // by the processor.
      attempts: Math.min(this.config.queue.maxAttempts, 2),
      backoff: { type: 'exponential', delay: 30_000 },
    });
  }

  async enqueueIndex(data: IndexRepositoryJobData): Promise<JobStatus> {
    return this.add(
      QUEUE_NAMES.REPO_INDEX,
      JOB_NAMES.INDEX_REPOSITORY,
      JOB_IDS.index(data.repositoryId, data.force),
      data,
      {
        attempts: this.config.queue.maxAttempts,
        // Longer than the analysis backoff: indexing failures are usually GitHub or
        // embedding-provider rate limits, which need minutes rather than seconds.
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
  }

  async enqueueSync(data: SyncPullRequestsJobData): Promise<JobStatus> {
    const jobId = data.repositoryId
      ? JOB_IDS.syncRepository(data.repositoryId)
      : JOB_IDS.syncOrganization(data.organizationId);

    return this.add(QUEUE_NAMES.PR_SYNC, JOB_NAMES.SYNC_PULL_REQUESTS, jobId, data, {
      attempts: this.config.queue.maxAttempts,
      backoff: { type: 'exponential', delay: 15_000 },
    });
  }

  /**
   * Add a job, collapsing onto an equivalent one when it already exists.
   *
   * The state machine here exists because BullMQ silently ignores an `add` whose job id is
   * already present, including for jobs retained after completion. Without this, a failed
   * job would block every subsequent attempt for as long as it was retained — the request
   * would appear to succeed and nothing would ever run.
   */
  private async add<T extends BaseJobData>(
    queueName: ManagedQueue,
    jobName: string,
    jobId: string,
    data: T,
    options: JobsOptions,
  ): Promise<JobStatus> {
    const queue = this.queues[queueName];

    try {
      const existing = await queue.getJob(jobId);

      if (existing) {
        const state = await existing.getState();

        if (state === 'completed') {
          // Genuine idempotency: same inputs, already answered. Hand back the answer.
          this.logger.log(`${queueName} job ${jobId} already completed; returning it`);
          return this.toStatus(queueName, existing, { deduplicated: true });
        }

        if (state === 'failed') {
          // A retained failure must not shadow a fresh attempt.
          await existing.remove();
        } else {
          this.logger.log(`${queueName} job ${jobId} is already ${state}; returning it`);
          return this.toStatus(queueName, existing, { deduplicated: true });
        }
      }

      const job = await queue.add(jobName, data, {
        jobId,
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400, count: 1000 },
        ...options,
      });

      this.logger.log(
        `Enqueued ${jobName} on ${queueName} as ${jobId} ` +
          `(org=${data.organizationId} trace=${data.traceId})`,
      );

      return this.toStatus(queueName, job, { deduplicated: false });
    } catch (error) {
      // Only connectivity failures are translated. Redis being unreachable must not surface
      // as a generic 500 — the caller's request was valid and will succeed on retry, and
      // that distinction is what tells a client to retry rather than to fix its input.
      //
      // Everything else is rethrown unchanged. Blanket-wrapping here hid a real defect once:
      // an invalid job id was reported as "the job queue is unavailable", which sent
      // debugging straight at Redis instead of at the id.
      if (isConnectivityError(error)) {
        throw new UpstreamUnavailableError(
          'redis',
          `Could not enqueue ${jobName}: the job queue is unavailable. ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------- read

  /** Job status for a tenant. Returns 404 for jobs belonging to another organization. */
  async describe(handle: string, organizationId: string): Promise<JobStatus> {
    const { queue: queueName, jobId } = decodeJobHandle(handle);
    const job = await this.queues[queueName].getJob(jobId);

    if (!job || (job.data as BaseJobData | undefined)?.organizationId !== organizationId) {
      // Deliberately indistinguishable from a job that never existed. Reporting 403 here
      // would confirm that a given pull request is being analysed by another tenant.
      throw new NotFoundError('Job', handle);
    }

    return this.toStatus(queueName, job, { deduplicated: false });
  }

  /**
   * Cancel a job that has not started.
   *
   * An already-running analysis is not cancellable here. Killing a worker mid-pipeline
   * would leave the ReviewRun row RUNNING forever and orphan the tool runs already
   * persisted, so this reports the situation instead of pretending to stop it.
   */
  async cancel(handle: string, organizationId: string): Promise<{ cancelled: boolean; state: JobState }> {
    const { queue: queueName, jobId } = decodeJobHandle(handle);
    if (queueName === QUEUE_NAMES.COLLABORATION)
      throw new ValidationError('Use the collaboration turn cancellation endpoint.');
    const job = await this.queues[queueName].getJob(jobId);

    if (!job || (job.data as BaseJobData | undefined)?.organizationId !== organizationId) {
      throw new NotFoundError('Job', handle);
    }

    const raw = await job.getState();

    if (raw === 'active') {
      throw new ValidationError(
        'This job has already started and cannot be cancelled. Wait for it to finish; a ' +
          'failed run leaves the previous analysis intact.',
      );
    }

    if (raw === 'completed' || raw === 'failed') {
      return { cancelled: false, state: normaliseState(raw) };
    }

    await job.remove();
    this.logger.log(`Cancelled ${queueName} job ${jobId}`);

    return { cancelled: true, state: 'QUEUED' };
  }

  /**
   * Queue depth, consumer count and head-of-queue age.
   *
   * `oldestWaitingAgeMs` is the number that actually matters, and it is here because
   * `workers` turned out not to be trustworthy. BullMQ derives the worker count from named
   * Redis client connections, so a worker constructed with `autorun: false` — exactly what
   * an API instance running with RUN_WORKERS_IN_API=false has — is counted even though it
   * consumes nothing. Verified: with workers disabled and one job enqueued, `workers` read 3
   * while the job sat untouched.
   *
   * Head-of-queue age has no such blind spot. It measures the symptom rather than a proxy
   * for the cause, so it catches no consumer attached, a consumer wedged on a job, a paused
   * queue, and one tenant starving another — all with one number.
   */
  async stats(): Promise<
    Array<{
      queue: ManagedQueue;
      /** Registered consumer connections. Informational only; see the note above. */
      workers: number;
      counts: Record<string, number>;
      paused: boolean;
      /** Age of the longest-waiting job, or null when nothing is waiting. */
      oldestWaitingAgeMs: number | null;
      error?: string;
    }>
  > {
    return Promise.all(
      MANAGED_QUEUES.map(async (name) => {
        const queue = this.queues[name];

        try {
          const [counts, workers, paused, waiting] = await Promise.all([
            queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
            queue.getWorkers(),
            queue.isPaused(),
            // A window rather than just the head: the wait list is not strictly ordered by
            // enqueue time once priorities and retries are involved.
            queue.getWaiting(0, 49),
          ]);

          const timestamps = waiting
            .map((job) => job.timestamp)
            .filter((value): value is number => typeof value === 'number' && value > 0);

          return {
            queue: name,
            workers: workers.length,
            counts,
            paused,
            oldestWaitingAgeMs:
              timestamps.length > 0 ? Date.now() - Math.min(...timestamps) : null,
          };
        } catch (error) {
          return {
            queue: name,
            workers: 0,
            counts: {},
            paused: false,
            oldestWaitingAgeMs: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  // ---------------------------------------------------------------- mapping

  private async toStatus(
    queueName: ManagedQueue,
    job: Job,
    flags: { deduplicated: boolean },
  ): Promise<JobStatus> {
    const raw = await job.getState();
    const state = normaliseState(raw);
    const progress = normaliseProgress(job.progress, state);

    return {
      id: encodeJobHandle(queueName, String(job.id)),
      queue: queueName,
      name: job.name,
      state,
      progress,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      deduplicated: flags.deduplicated,
      enqueuedAt: new Date(job.timestamp).toISOString(),
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      durationMs:
        job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
      reviewRunId:
        progress?.reviewRunId ??
        (isRunResult(job.returnvalue) ? job.returnvalue.reviewRunId : null),
    };
  }
}

/**
 * Whether an error is Redis being unreachable rather than the command being wrong.
 *
 * Matches on ioredis' `code` first, which is reliable, and falls back to the small set of
 * connection-state messages ioredis produces when the socket is gone.
 */
function isConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;

  if (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'].includes(code)
  ) {
    return true;
  }

  return /connection is closed|connection is already closed|stream isn't writeable|max retries per request|connect etimedout/i.test(
    error.message,
  );
}

function normaliseState(raw: string): JobState {
  switch (raw) {
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'active':
      return 'ACTIVE';
    case 'delayed':
      return 'DELAYED';
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
      return 'QUEUED';
    default:
      return 'UNKNOWN';
  }
}

function normaliseProgress(value: unknown, state: JobState): JobProgress | null {
  // BullMQ initialises progress to the number 0, before any processor has run. Reporting a
  // stage for that would be inventing one: the job has not started and has no stage yet, so
  // the job state is the only honest label.
  if (typeof value === 'number') return { percent: value, stage: state };

  if (value && typeof value === 'object' && 'percent' in value) {
    const record = value as Record<string, unknown>;

    return {
      percent: typeof record.percent === 'number' ? record.percent : 0,
      stage: typeof record.stage === 'string' ? record.stage : 'RUNNING',
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
      ...(typeof record.reviewRunId === 'string' ? { reviewRunId: record.reviewRunId } : {}),
    };
  }

  return null;
}

function isRunResult(value: unknown): value is { reviewRunId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reviewRunId' in value &&
    typeof (value as { reviewRunId: unknown }).reviewRunId === 'string'
  );
}

/**
 * Decide whether a failure is worth retrying.
 *
 * Shared by every processor so the policy is stated once. The rule: a job only retries if
 * running it again could plausibly produce a different outcome. A missing pull request, a
 * policy that forbids the operation, or invalid input will fail identically on every
 * attempt, and burning three attempts on them delays the real error reaching the user and
 * keeps a dead job occupying worker capacity.
 */
export function classifyJobError(error: unknown): Error {
  if (error instanceof AppException) {
    const deterministic =
      error.code === 'RESOURCE_NOT_FOUND' ||
      error.code === 'VALIDATION_FAILED' ||
      error.code === 'POLICY_VIOLATION' ||
      error.code === 'FORBIDDEN' ||
      error.code === 'GITHUB_NOT_CONNECTED' ||
      // A held lock means another worker is already doing this exact work, and a rate
      // limit will still be in force on the next attempt.
      error.code === 'RATE_LIMITED';

    if (deterministic) {
      return new UnrecoverableError(`${error.code}: ${errorMessageOf(error)}`);
    }
  }

  return error instanceof Error ? error : new Error(String(error));
}

function errorMessageOf(error: AppException): string {
  const response = error.getResponse();

  if (typeof response === 'object' && response !== null && 'message' in response) {
    return String((response as { message: unknown }).message);
  }

  return error.message;
}
