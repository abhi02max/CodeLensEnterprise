'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowRight, Github, RefreshCw } from 'lucide-react';
import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  LoadingRegion,
  PageHeader,
  Skeleton,
  StatusLabel,
} from '@/components/ui/primitives';
import { ListPagination } from '@/components/list-pagination';
import { ListError } from '@/components/reviews/review-list';
import { api } from '@/lib/api';
import { ApiError, API_URL } from '@/lib/api-client';
import { useSession } from '@/lib/providers';
import { relativeTime } from '@/lib/format';
import { reviewsHref } from '@/lib/review-inbox';
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
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const repos = useQuery({
    queryKey: ['repositories', 'list', page],
    queryFn: () => api.repositories(page, 25),
  });
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
      <PageHeader
        title="Repositories"
        subtitle="Connected source and repository reviews."
        actions={
          <>
            {!user?.githubConnected && (
              <Button onClick={() => window.location.assign(`${API_URL}/auth/github?mode=link`)}>
                <Github className="h-4 w-4" aria-hidden="true" />
                Connect GitHub
              </Button>
            )}
            <Button
              onClick={() =>
                jobHandle && (job.isError || job.isTimedOut)
                  ? void job.checkStatus()
                  : sync.mutate()
              }
              loading={sync.isPending || job.isRunning}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {job.isRunning
                ? 'Syncing…'
                : job.isError || job.isTimedOut
                  ? 'Check sync status'
                  : 'Sync from GitHub'}
            </Button>
          </>
        }
      />
      {error && (
        <div role="alert" className="text-state-danger-text">
          <p>Could not queue the sync</p>
          <p>{error.message}</p>
        </div>
      )}
      {jobHandle && <JobPanel handle={jobHandle} state={job} />}
      {repos.isError ? (
        <ListError subject="repositories" onRetry={() => void repos.refetch()} />
      ) : repos.isPending ? (
        <LoadingRegion label="Loading repositories">
          <div className="mt-4 space-y-4">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-20 w-full" />
            ))}
          </div>
        </LoadingRegion>
      ) : (
        repos.data && (
          <>
            {repos.data.items.length === 0 ? (
              <EmptyState
                title={page > 1 ? 'No repositories on this page' : 'No repositories connected'}
                description={page > 1 ? undefined : 'Connect GitHub to manage repository access.'}
                action={
                  page > 1 ? (
                    <Button onClick={() => setPage(1)}>Return to first page</Button>
                  ) : undefined
                }
              />
            ) : (
              <ul
                aria-label="Connected repositories"
                className="divide-y divide-structure border-t border-structure"
              >
                {repos.data.items.map((repo) => (
                  <li
                    key={repo.id}
                    className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_12rem_auto]"
                  >
                    <div className="min-w-0">
                      <Link
                        href={reviewsHref({ repositoryId: repo.id })}
                        className="break-all text-panel font-semibold hover:underline"
                      >
                        {repo.fullName}
                      </Link>
                      {repo.description && (
                        <p className="mt-1 break-words text-compact text-content-muted">
                          {repo.description}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-metadata text-content-muted">
                        <span>{repo.private ? 'Private' : 'Public'}</span>
                        <span className="break-all">{repo.defaultBranch}</span>
                        {repo.primaryLanguage && <span>{repo.primaryLanguage}</span>}
                        <span>{repo.openPullRequestCount} open PRs</span>
                        <span>Synced {relativeTime(repo.lastSyncedAt)}</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <StatusLabel
                        label={repo.indexStatus.replace(/_/g, ' ').toLowerCase()}
                        tone={INDEX_TONE[repo.indexStatus]}
                      />
                      {repo.indexStatus === 'INDEXED' && (
                        <p className="text-metadata text-content-muted">
                          {repo.indexedChunkCount} indexed chunks
                        </p>
                      )}
                      {repo.indexError && (
                        <p className="break-words text-metadata text-state-danger-text">
                          {repo.indexError}
                        </p>
                      )}
                    </div>
                    <Link
                      href={reviewsHref({ repositoryId: repo.id })}
                      aria-label={`View reviews for ${repo.fullName}`}
                      className="inline-flex min-h-9 items-center gap-2 justify-self-start rounded-control px-2 py-2 text-compact font-medium text-selected-text hover:bg-selected md:justify-self-end"
                    >
                      View reviews
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <ListPagination {...repos.data} pending={repos.isFetching} onPage={setPage} />
          </>
        )
      )}
    </div>
  );
}

function JobPanel({ handle, state }: { handle: string; state: ReturnType<typeof useJobPolling> }) {
  const result = state.job?.result as
    | {
        repositories?: number;
        totalSynced?: number;
        failed?: number;
        results?: Array<{ fullName: string; error: string | null }>;
      }
    | null
    | undefined;

  const failures = result?.results?.filter((entry) => entry.error) ?? [];

  return (
    <Card>
      <CardHeader
        title="Sync job"
        subtitle={<span className="font-mono text-[0.6875rem]">{handle}</span>}
        actions={
          <Badge
            tone={
              state.isError || state.isTimedOut || state.job?.state === 'FAILED'
                ? 'danger'
                : state.isRunning
                  ? 'info'
                  : 'success'
            }
          >
            {state.isError || state.isTimedOut ? 'STATUS UNKNOWN' : (state.job?.state ?? 'QUEUED')}
          </Badge>
        }
      />
      <div className="px-4 py-3 text-xs text-content-secondary">
        {state.isError && (
          <p className="text-state-danger-text">
            Could not check the sync job. It may still be running.
          </p>
        )}
        {state.isTimedOut && (
          <p className="text-state-danger-text">
            Sync is taking longer than expected. Check its status before starting another.
          </p>
        )}
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
              <li key={entry.fullName} className="text-state-warning-text">
                <span className="font-medium">{entry.fullName}</span>: {entry.error}
              </li>
            ))}
          </ul>
        )}

        {state.job?.failedReason && (
          <p className="text-state-danger-text">{state.job.failedReason}</p>
        )}
      </div>
    </Card>
  );
}
