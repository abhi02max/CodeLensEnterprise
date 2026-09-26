import { QUEUE_NAMES, type Role } from '@codelens/shared';
import { randomUUID } from 'node:crypto';
import type { RunTrigger } from '@codelens/database';
import { NotFoundError } from '../common/errors';

/**
 * Queues this deployment actually processes.
 *
 * `QUEUE_NAMES` in `@codelens/shared` also declares `github-publish` and `model-retrain`.
 * They are deliberately not listed here: registering a queue nothing consumes produces a
 * silent backlog, which is worse than not offering the capability at all. They get added
 * alongside their processors.
 */
export const MANAGED_QUEUES = [
  QUEUE_NAMES.REVIEW_RUN,
  QUEUE_NAMES.REPO_INDEX,
  QUEUE_NAMES.PR_SYNC,
] as const;

export type ManagedQueue = (typeof MANAGED_QUEUES)[number];

function isManagedQueue(value: string): value is ManagedQueue {
  return (MANAGED_QUEUES as readonly string[]).includes(value);
}

/**
 * Every job carries its tenant.
 *
 * Not a convenience: it is the only thing that lets `GET /jobs/:id` decide whether the
 * caller is allowed to see a job. Without it, a job id from one organization would be
 * readable by any authenticated user in any other.
 */
export interface BaseJobData {
  organizationId: string;
  /** Null for webhook- and schedule-driven work, which has no human actor. */
  userId: string | null;
  traceId: string;
}

export interface AnalyzePullRequestJobData extends BaseJobData {
  pullRequestId: string;
  repositoryId: string;
  /**
   * Resolved at enqueue time rather than read in the worker.
   *
   * It is part of the job's identity: a job enqueued for commit abc must analyse abc even
   * if the branch has moved on by the time a worker picks it up. Re-reading the head SHA in
   * the worker would silently analyse different code than the caller asked about.
   */
  headSha: string;
  userRole: Role;
  trigger: RunTrigger;
  force: boolean;
  postToGithub: boolean;
}

export interface IndexRepositoryJobData extends BaseJobData {
  repositoryId: string;
  force: boolean;
  maxFiles: number | null;
  includePaths: string[];
}

export interface SyncPullRequestsJobData extends BaseJobData {
  /** Null syncs every connected repository in the organization. */
  repositoryId: string | null;
  state: 'open' | 'closed' | 'all';
  limit: number;
}

export type JobDataFor<Q extends ManagedQueue> = Q extends typeof QUEUE_NAMES.REVIEW_RUN
  ? AnalyzePullRequestJobData
  : Q extends typeof QUEUE_NAMES.REPO_INDEX
    ? IndexRepositoryJobData
    : Q extends typeof QUEUE_NAMES.PR_SYNC
      ? SyncPullRequestsJobData
      : never;

/**
 * Progress payload.
 *
 * `reviewRunId` is published as soon as the run row exists, well before the job finishes,
 * so the UI can switch from polling the job to polling the run and show per-tool detail
 * while the pipeline is still executing.
 */
export interface JobProgress {
  percent: number;
  stage: string;
  message?: string;
  reviewRunId?: string;
}

/**
 * Job state, normalised.
 *
 * BullMQ's raw states are lowercase and include internal ones (`prioritized`,
 * `waiting-children`) that mean nothing to a client. Collapsing them here keeps the
 * queue implementation out of the public API contract.
 */
export type JobState =
  | 'QUEUED'
  | 'DELAYED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN';

export interface JobStatus {
  /** Composite handle, safe to round-trip through a URL. */
  id: string;
  queue: ManagedQueue;
  name: string;
  state: JobState;
  progress: JobProgress | null;
  attemptsMade: number;
  maxAttempts: number;
  /** True when this handle refers to a pre-existing job rather than a newly created one. */
  deduplicated: boolean;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: unknown;
  failedReason: string | null;
  /** Populated for review-run jobs once the run row exists. */
  reviewRunId: string | null;
}

/**
 * Client-facing job handle.
 *
 * BullMQ job ids are only unique within a queue, so a bare id is ambiguous once there is
 * more than one queue. Encoding the queue into the handle keeps `GET /jobs/:id` a single
 * endpoint instead of one per queue, and keeps the queue topology out of the URL space.
 */
export function encodeJobHandle(queue: ManagedQueue, jobId: string): string {
  return `${queue}:${jobId}`;
}

export function decodeJobHandle(handle: string): { queue: ManagedQueue; jobId: string } {
  const separator = handle.indexOf(':');

  // Split on the first colon only. Queue names contain none, and BullMQ forbids them in job
  // ids, so the first colon is unambiguously the separator.
  if (separator > 0) {
    const queue = handle.slice(0, separator);
    const jobId = handle.slice(separator + 1);

    if (isManagedQueue(queue) && jobId.length > 0) return { queue, jobId };
  }

  // A malformed handle is reported as a missing job rather than a bad request: from the
  // caller's point of view there is no such job, and the distinction is not actionable.
  throw new NotFoundError('Job', handle);
}

/**
 * Deterministic job ids, so a duplicate request collapses onto the in-flight job.
 *
 * Separated with `-` rather than `:` because BullMQ reserves the colon for its own key
 * namespacing and rejects a custom id containing one outright. Analysis IDs include the
 * version and last terminal run, so a newer generation never replaces a retained job.
 */
export const JOB_IDS = {
  analyze: (pullRequestId: string, headSha: string, promptVersion: string,
    featureSchemaVersion: number, latestTerminalRunId: string | null): string =>
    `analyze-${pullRequestId}-${headSha}-${promptVersion}-${featureSchemaVersion}-${latestTerminalRunId ?? 'initial'}`,
  /** A forced re-run is a genuinely different job and must not collapse onto the old one. */
  analyzeForced: (pullRequestId: string, headSha: string): string =>
    `analyze-${pullRequestId}-${headSha}-force-${randomUUID()}`,
  index: (repositoryId: string, force: boolean): string =>
    force ? `index-${repositoryId}-force-${Date.now()}` : `index-${repositoryId}`,
  syncRepository: (repositoryId: string): string => `sync-repo-${repositoryId}`,
  syncOrganization: (organizationId: string): string => `sync-org-${organizationId}`,
} as const;
