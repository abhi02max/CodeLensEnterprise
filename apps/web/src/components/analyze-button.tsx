'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { useJobPolling } from '@/lib/use-job-polling';

/**
 * Trigger an analysis and follow the job.
 *
 * Analysis is queued, so this cannot report a result directly. It surfaces the job's own stage
 * while it runs, which is the only truthful progress available and happens to be the more
 * informative thing to show: "Static analysis" tells a demo audience what the product is doing in
 * a way a spinner does not.
 */
export function AnalyzeButton({
  pullRequestId,
  size = 'md',
  label = 'Analyze',
  variant = 'primary',
  onComplete,
}: {
  pullRequestId: string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  onComplete?: () => void;
}) {
  const queryClient = useQueryClient();
  const [handle, setHandle] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const job = useJobPolling(handle, {
    onSettled: () => {
      // The run wrote findings, a prediction, context and possibly an AI review, so the lists and
      // the workspace are all stale now.
      void queryClient.invalidateQueries({ queryKey: ['pull-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['review-session', pullRequestId] });
      onComplete?.();
    },
  });

  const trigger = useMutation({
    mutationFn: () => api.analyze(pullRequestId, true),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      if (result.job) {
        setHandle(result.job.id);
        return;
      }

      // `sync: true` is not requested, so a null job means the API answered from an equivalent
      // completed run. Nothing to poll; just refresh.
      void queryClient.invalidateQueries({ queryKey: ['pull-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['review-session', pullRequestId] });
      onComplete?.();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not queue the analysis'),
  });

  const running = trigger.isPending || job.isRunning;
  const statusUnavailable = Boolean(handle) && (job.isError || job.isTimedOut);
  const stage = job.job?.progress?.stage;

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button
        variant={variant}
        size={size}
        loading={running}
        onClick={() => (statusUnavailable ? void job.checkStatus() : trigger.mutate())}
        title={
          running
            ? 'Analysis in progress'
            : statusUnavailable
              ? 'Check the existing job before starting another'
              : 'Run the full review pipeline'
        }
      >
        {running
          ? stage && stage !== 'QUEUED'
            ? formatStage(stage)
            : 'Queued…'
          : statusUnavailable
            ? 'Check status'
            : label}
      </Button>

      {handle && running && (
        <span
          className="max-w-[16rem] truncate font-mono text-[0.625rem] text-content-muted"
          title={handle}
        >
          {handle}
        </span>
      )}

      {job.job?.state === 'FAILED' && (
        <span className="text-xs text-state-danger-text">
          {job.job.failedReason ?? 'The analysis job failed'}
        </span>
      )}

      {statusUnavailable && (
        <span className="max-w-[16rem] text-right text-xs text-state-danger-text">
          {job.isTimedOut
            ? 'Analysis is taking longer than expected. Check its status before starting another.'
            : 'Could not check job status. The analysis may still be running.'}
        </span>
      )}

      {error && (
        <span className="max-w-[16rem] text-right text-xs text-state-danger-text">{error}</span>
      )}
    </div>
  );
}

function formatStage(stage: string): string {
  const spaced = stage.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
