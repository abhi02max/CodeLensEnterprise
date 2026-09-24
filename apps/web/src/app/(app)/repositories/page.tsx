'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { relativeTime } from '@/lib/format';
import { useJobPolling } from '@/lib/use-job-polling';

const INDEX_TONE = {
  INDEXED: 'success',
  INDEXING: 'info',
  QUEUED: 'info',
  STALE: 'warning',
  FAILED: 'danger',
  NOT_INDEXED: 'neutral',
} as const;

export default function RepositoriesPage() {
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => api.repositories(1, 100) });

  const [jobHandle, setJobHandle] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const job = useJobPolling(jobHandle, {
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['repositories'] }),
  });

  const sync = useMutation({
    mutationFn: () => api.syncRepositories(),
    onMutate: () => setError(null),
    onSuccess: (result) => setJobHandle(result.job.id),
    onError: (caught) => setError(caught as ApiError),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Repositories</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Connected repositories and their retrieval index state.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => sync.mutate()}
          loading={sync.isPending || job.isRunning}
        >
          {job.isRunning ? 'Syncing…' : 'Sync from GitHub'}
        </Button>
      </div>

      {error && (
        <Alert title="Could not queue the sync" tone={error.code === 'NETWORK_ERROR' ? 'warning' : 'danger'}>
          {error.message}
        </Alert>
      )}

      {/*
        The job panel is shown for a queued sync rather than a spinner, because the work happens in
        a worker process and the only honest thing to show is the job's own state.
      */}
      {jobHandle && <JobPanel handle={jobHandle} state={job} />}

      <Card>
        <CardHeader
          title="Connected"
          subtitle={repos.data ? `${repos.data.total} repositor${repos.data.total === 1 ? 'y' : 'ies'}` : 'Loading'}
        />

        {repos.isLoading ? (
          <div className="space-y-2 px-4 py-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-10 w-full" />
            ))}
          </div>
        ) : repos.data && repos.data.items.length === 0 ? (
          <EmptyState
            title="No repositories connected"
            description="Connect a GitHub repository through the API, or run the seed script to load the demo workspace."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-slate-500">
                  {/* Same reasoning as the pull request table: index state and open-PR count are
                      what a narrow screen needs; branch and language are reference detail. */}
                  <th scope="col" className="px-4 py-2 font-medium">Repository</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Visibility</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">Default branch</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Language</th>
                  <th scope="col" className="px-3 py-2 font-medium">Index</th>
                  <th scope="col" className="px-3 py-2 font-medium">Open PRs</th>
                  <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">Last sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {repos.data?.items.map((repo) => (
                  <tr key={repo.id} className="hover:bg-surface-subtle">
                    {/* `w-full max-w-0` for the same reason as the pull request table: it lets this
                        column absorb the leftover width instead of demanding `max-w-md` and pushing
                        Index and Open PRs off a narrow screen. */}
                    <td className="w-full max-w-0 px-4 py-2">
                      <Link
                        href={`/pull-requests?repositoryId=${repo.id}`}
                        className="block truncate font-medium text-slate-900 hover:underline"
                      >
                        {repo.fullName}
                      </Link>
                      {repo.description && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {repo.description}
                        </p>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 md:table-cell">
                      <Badge tone={repo.private ? 'neutral' : 'outline'}>
                        {repo.private ? 'Private' : 'Public'}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-xs text-slate-600 xl:table-cell">
                      {repo.defaultBranch}
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-slate-600 lg:table-cell">
                      {repo.primaryLanguage ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={INDEX_TONE[repo.indexStatus]}>
                        {repo.indexStatus.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      {repo.indexStatus === 'INDEXED' && (
                        <span className="numeric ml-1.5 text-xs text-slate-500">
                          {repo.indexedChunkCount} chunks
                        </span>
                      )}
                      {repo.indexError && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-red-700" title={repo.indexError}>
                          {repo.indexError}
                        </p>
                      )}
                    </td>
                    <td className="numeric px-3 py-2 text-slate-800">{repo.openPullRequestCount}</td>
                    <td className="hidden px-4 py-2 text-xs text-slate-500 md:table-cell">
                      {relativeTime(repo.lastSyncedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function JobPanel({
  handle,
  state,
}: {
  handle: string;
  state: ReturnType<typeof useJobPolling>;
}) {
  const result = state.job?.result as
    | { repositories?: number; totalSynced?: number; failed?: number; results?: Array<{ fullName: string; error: string | null }> }
    | null
    | undefined;

  const failures = result?.results?.filter((entry) => entry.error) ?? [];

  return (
    <Card>
      <CardHeader
        title="Sync job"
        subtitle={<span className="font-mono text-[0.6875rem]">{handle}</span>}
        actions={<Badge tone={state.isRunning ? 'info' : state.job?.state === 'FAILED' ? 'danger' : 'success'}>
          {state.job?.state ?? 'QUEUED'}
        </Badge>}
      />
      <div className="px-4 py-3 text-xs text-slate-600">
        {state.job?.progress?.message && <p>{state.job.progress.message}</p>}

        {state.job?.state === 'COMPLETED' && result && (
          <p>
            Synced {result.totalSynced ?? 0} pull request(s) across {result.repositories ?? 0}{' '}
            repositor{result.repositories === 1 ? 'y' : 'ies'}
            {result.failed ? `, ${result.failed} failed` : ''}.
          </p>
        )}

        {/*
          Per-repository failures are shown individually. The processor deliberately continues past
          one inaccessible repository, so a single summary count would hide which one broke.
        */}
        {failures.length > 0 && (
          <ul className="mt-2 space-y-1">
            {failures.map((entry) => (
              <li key={entry.fullName} className="text-amber-800">
                <span className="font-medium">{entry.fullName}</span>: {entry.error}
              </li>
            ))}
          </ul>
        )}

        {state.job?.failedReason && <p className="text-red-700">{state.job.failedReason}</p>}
      </div>
    </Card>
  );
}
