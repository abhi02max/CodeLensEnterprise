'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { api } from './api';
import type { JobStatus } from './types';

const TERMINAL_STATES = new Set<JobStatus['state']>(['COMPLETED', 'FAILED']);

/**
 * Poll a background job until it reaches a terminal state.
 *
 * Polling rather than subscribing because the API exposes `GET /jobs/:id` and no event stream.
 * A socket would be nicer and is not worth a second transport for a demo flow that finishes in
 * about ten seconds.
 *
 * The interval stops at a terminal state instead of running forever, and `onSettled` fires exactly
 * once so callers can refetch the data the job changed without writing their own guard.
 */
export function useJobPolling(
  handle: string | null,
  options: { onSettled?: (job: JobStatus) => void; intervalMs?: number } = {},
) {
  const settledFor = React.useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['job', handle],
    queryFn: () => api.job(handle as string),
    enabled: Boolean(handle),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state && TERMINAL_STATES.has(state)) return false;
      return options.intervalMs ?? 900;
    },
    // A job that has not been picked up yet legitimately has no progress; that is not an error and
    // should not be retried away.
    retry: false,
  });

  const job = query.data ?? null;

  React.useEffect(() => {
    if (!job || !handle) return;
    if (!TERMINAL_STATES.has(job.state)) return;
    if (settledFor.current === handle) return;

    settledFor.current = handle;
    options.onSettled?.(job);
    // options is intentionally not a dependency: callers pass an inline object, and including it
    // would fire the callback on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, handle]);

  // Reset the guard when the caller starts a new job, so a second run also reports settlement.
  React.useEffect(() => {
    if (handle !== settledFor.current) settledFor.current = null;
  }, [handle]);

  return {
    job,
    isRunning: Boolean(handle) && (!job || !TERMINAL_STATES.has(job.state)),
    isError: query.isError,
  };
}
