import { UnrecoverableError, type Job } from 'bullmq';

export function isRetryEligible(job: Pick<Job, 'attemptsMade' | 'opts'> | undefined, error: Error): boolean {
  return Boolean(job && !(error instanceof UnrecoverableError) &&
    job.attemptsMade < (job.opts.attempts ?? 1));
}
