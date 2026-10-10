'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, X } from 'lucide-react';
import type { PatchProposalView } from '@codelens/shared';
import { Alert, Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { ValidationPanel } from './validation-panel';
import { operationPollingInterval } from '@/lib/operation-polling';

const labels: Record<string, string> = {
  QUEUED: 'Queued',
  PREPARING: 'Preparing exact snapshot',
  APPLYING: 'Materializing in isolation',
  APPLIED: 'Applied in isolated workspace',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export function PatchApplicationPanel({ proposal }: { proposal: PatchProposalView }) {
  const client = useQueryClient();
  const [afterId, setAfterId] = React.useState<string | undefined>();
  const requestId = React.useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['patch-applications', proposal.id, afterId],
    queryFn: () => api.patchApplications(proposal.id, afterId),
    refetchInterval: (q) =>
      operationPollingInterval(q.state.data?.items, q.state.status === 'error'),
  });
  const mutation = useMutation({
    mutationFn: (cancelId?: string) => {
      if (cancelId) return api.cancelPatchApplication(cancelId, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestPatchApplication(proposal.id, {
        requestId: requestId.current,
        expectedProposalRevision: proposal.revision,
        expectedProposalDigest: proposal.digest,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      setAfterId(undefined);
      void client.invalidateQueries({ queryKey: ['patch-applications', proposal.id] });
    },
  });
  const blocked = query.data?.items.some(
    (a) => a.cleanup === 'UNCERTAIN' || ['QUEUED', 'PREPARING', 'APPLYING'].includes(a.status),
  );
  return (
    <section
      aria-label="Isolated patch applications"
      className="mt-3 border-t border-surface-border pt-3"
    >
      {proposal.status === 'ACCEPTED' && (
        <Button
          disabled={mutation.isPending || query.isPending || query.isError || blocked || !!afterId}
          onClick={() => mutation.mutate(undefined)}
        >
          <Box size={14} />
          Prepare isolated application
        </Button>
      )}
      {query.isError && (
        <Alert tone="danger">
          Could not load isolated applications.{' '}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {mutation.isError && (
        <Alert tone="danger">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : 'Application request failed. No repository changes performed.'}
        </Alert>
      )}
      <ul className="mt-2 space-y-3">
        {query.data?.items.map((a) => (
          <li key={a.id} className="border-b border-surface-border pb-2">
            <p role="status" className="font-medium">
              {labels[a.status]} ·{' '}
              {a.cleanup === 'DISPOSED'
                ? 'Disposed'
                : a.cleanup === 'UNCERTAIN'
                  ? 'Cleanup uncertain'
                  : 'Workspace not started'}
            </p>
            <p className="break-all text-xs">
              Application {a.id} · Pinned head {a.headSha}
            </p>
            {a.stale && (
              <p className="text-xs text-amber-700">
                Stale relative to current head. This historical application is not rebased.
              </p>
            )}
            {a.status === 'APPLIED' && <p className="mt-1 text-xs">{a.limitations}</p>}
            {a.status === 'APPLIED' && a.cleanup === 'DISPOSED' && (
              <ValidationPanel application={a} />
            )}
            {a.failureCategory && <p className="text-xs">Failure category: {a.failureCategory}</p>}
            {a.attempts.map((attempt) => (
              <details key={attempt.generation} className="mt-1 text-xs">
                <summary>
                  Attempt {attempt.generation} · {attempt.files.length} verified file results
                </summary>
                <p className="break-all">Manifest: {attempt.manifestDigest ?? 'Not verified'}</p>
                <p className="break-all">Snapshot: {attempt.snapshotDigest ?? 'Not recorded'}</p>
                <p className="break-all">
                  Executor: {a.executorImage} · Policy {a.policyVersion}
                </p>
                <ul>
                  {attempt.files.map((f) => (
                    <li key={f.path} className="break-all">
                      {f.path} · {f.byteLength} bytes · SHA-256 {f.contentHash}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {['QUEUED', 'PREPARING', 'APPLYING'].includes(a.status) && (
              <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(a.id)}>
                <X size={14} />
                Cancel isolated application
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        {afterId && (
          <Button size="sm" onClick={() => setAfterId(undefined)}>
            First applications
          </Button>
        )}
        {query.data?.nextAfterId && (
          <Button size="sm" onClick={() => setAfterId(query.data!.nextAfterId!)}>
            More applications
          </Button>
        )}
      </div>
    </section>
  );
}
