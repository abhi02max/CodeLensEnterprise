'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, X } from 'lucide-react';
import type { PatchApplicationView } from '@codelens/shared';
import { Alert, Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { ValidationStaticPanel } from './validation-static-panel';

const comparisons: Record<string, string> = {
  BOTH_PASS: 'Original and patched candidate passed the check.',
  ORIGINAL_PASS_PATCHED_FAIL:
    'The patched candidate failed a check that passed on the original pinned head.',
  ORIGINAL_FAIL_PATCHED_PASS:
    'The patched candidate passed a check that failed on the original pinned head.',
  BOTH_FAIL: 'Original and patched candidate failed the check.',
  UNSUPPORTED: 'The repository is unsupported by this fixed profile.',
  INCONCLUSIVE: 'The observations do not support a conclusive comparison.',
};
export function ValidationPanel({ application }: { application: PatchApplicationView }) {
  const client = useQueryClient();
  const requestId = React.useRef<string | null>(null);
  const [afterId, setAfterId] = React.useState<string | undefined>();
  const query = useQuery({
    queryKey: ['validations', application.id, afterId],
    queryFn: () => api.validations(application.id, afterId),
    refetchInterval: 1000,
  });
  const mutation = useMutation({
    mutationFn: (cancelId?: string) => {
      if (cancelId) return api.cancelValidation(cancelId, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestValidation(application.id, {
        requestId: requestId.current,
        profiles: ['typescript-typecheck-v1', 'vitest-unit-v1'],
      });
    },
    onSuccess: () => {
      requestId.current = null;
      void client.invalidateQueries({ queryKey: ['validations', application.id] });
    },
  });
  const blocked = query.data?.items.some(
    (v) => v.cleanup === 'UNCERTAIN' || ['QUEUED', 'PREPARING', 'RUNNING'].includes(v.state),
  );
  return (
    <section
      aria-label={`Validation for application ${application.id}`}
      className="mt-3 border-t border-surface-border pt-3"
    >
      <h4 className="text-sm font-semibold">Paired validation</h4>
      <p className="my-2 text-xs">
        Passing these checks does not establish that the proposal is safe.
      </p>
      <Button
        size="sm"
        disabled={mutation.isPending || query.isPending || query.isError || blocked || !!afterId}
        onClick={() => mutation.mutate(undefined)}
      >
        <CheckSquare size={14} />
        Validate original and patched candidate
      </Button>
      {query.isError && (
        <Alert tone="danger">
          Could not load validation observations.{' '}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {mutation.isError && (
        <Alert tone="danger">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : 'Validation request unavailable.'}
        </Alert>
      )}
      <ul className="mt-2 space-y-3">
        {query.data?.items.map((v) => (
          <li key={v.id} className="border-b border-surface-border pb-2">
            <p role="status" className="text-sm font-medium">
              {v.state} · {v.outcome ?? 'Not compared'} · Cleanup {v.cleanup}
            </p>
            <p className="break-all text-xs">
              Validation {v.id} · Application {v.applicationId} · Pinned head {v.headSha}
            </p>
            {v.stale && (
              <p className="text-xs text-amber-700">
                Historical validation: stale relative to current head. No rebasing performed.
              </p>
            )}
            {v.failureCategory && (
              <p className="text-xs">Infrastructure category: {v.failureCategory}</p>
            )}
            {v.comparisons.map((c) => (
              <p key={c.profile} className="mt-1 text-xs">
                {c.profile} v1: {comparisons[c.outcome]}
              </p>
            ))}
            {v.steps.map((s) => (
              <details key={s.id} className="mt-2 text-xs">
                <summary>
                  {s.profile} v{s.profileVersion} · {s.side} · {s.outcome}
                </summary>
                <p>
                  Broker observation: exit {s.observed.exitCode ?? 'Unavailable'} ·{' '}
                  {s.observed.termination} · {s.observed.durationMs} ms · OOM{' '}
                  {s.observed.oom ? 'Yes' : 'No'}
                </p>
                <p>
                  Untrusted runner report: {s.runnerReported.status}
                  {s.runnerReported.report
                    ? ` · ${s.runnerReported.report.passed} passed / ${s.runnerReported.report.failed} failed / ${s.runnerReported.report.total} total`
                    : ''}
                </p>
                <p className="break-all">
                  Input {s.inputDigest} · Result {s.resultDigest}
                </p>
                {(['stdout', 'stderr'] as const).map((stream) => (
                  <React.Fragment key={stream}>
                    <p className="break-all">
                      {stream}:{' '}
                      {s.observed[stream].complete ? 'Captured stream' : 'Captured prefix'} SHA-256{' '}
                      {s.observed[stream].digest}
                    </p>
                    {s.observed[stream].excerpt && (
                      <pre
                        aria-label={`${s.side} ${stream} excerpt`}
                        className="max-h-40 overflow-auto whitespace-pre-wrap break-all"
                      >
                        {s.observed[stream].excerpt}
                      </pre>
                    )}
                  </React.Fragment>
                ))}
              </details>
            ))}
            <ValidationStaticPanel
              validationId={v.id}
              active={['QUEUED', 'PREPARING', 'RUNNING'].includes(v.state)}
            />
            <details className="mt-1 text-xs">
              <summary>Validation identities and limitations</summary>
              <p className="break-all">
                Snapshot {v.snapshotDigest} · Candidate {v.candidateDigest} · Proposal{' '}
                {v.proposalDigest}
              </p>
              <p className="break-all">
                Image {v.image} · Bundle {v.bundleDigest} · Configuration {v.configurationDigest}
              </p>
              <p>{v.limitations}</p>
            </details>
            {['QUEUED', 'PREPARING', 'RUNNING'].includes(v.state) && (
              <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(v.id)}>
                <X size={14} />
                Cancel validation
              </Button>
            )}
          </li>
        ))}
      </ul>
      {afterId && (
        <Button size="sm" onClick={() => setAfterId(undefined)}>
          First validations
        </Button>
      )}
      {query.data?.nextAfterId && (
        <Button size="sm" onClick={() => setAfterId(query.data!.nextAfterId!)}>
          More validations
        </Button>
      )}
    </section>
  );
}
