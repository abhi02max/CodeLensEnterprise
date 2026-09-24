'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { RiskBadge, RunStatusBadge } from '@/components/risk';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { AnalyzeButton } from '@/components/analyze-button';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';

export default function PullRequestsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const repositoryId = params.get('repositoryId') ?? '';

  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => api.repositories(1, 100) });

  const prs = useQuery({
    queryKey: ['pull-requests', repositoryId || 'all'],
    queryFn: () => api.pullRequests({ pageSize: 100, ...(repositoryId ? { repositoryId } : {}) }),
  });

  const selectedRepo = repos.data?.items.find((repo) => repo.id === repositoryId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Pull requests</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selectedRepo ? selectedRepo.fullName : 'All connected repositories'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="repo-filter" className="text-xs text-slate-500">
            Repository
          </label>
          <Select
            id="repo-filter"
            value={repositoryId}
            onChange={(event) => {
              const next = event.target.value;
              // Pushed into the URL so a filtered list is linkable and survives a reload.
              router.replace(next ? `/pull-requests?repositoryId=${next}` : '/pull-requests');
            }}
          >
            <option value="">All repositories</option>
            {repos.data?.items.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Open and recent"
          subtitle={prs.data ? `${prs.data.total} pull request(s)` : 'Loading'}
        />

        {prs.isLoading ? (
          <div className="space-y-2 px-4 py-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-11 w-full" />
            ))}
          </div>
        ) : prs.data && prs.data.items.length === 0 ? (
          <EmptyState
            title="No pull requests"
            description="Sync a repository from GitHub, or run the seed script to load the demo data."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border text-left text-xs text-slate-500">
                  <th scope="col" className="px-4 py-2 font-medium">PR</th>
                  <th scope="col" className="px-3 py-2 font-medium">Author</th>
                  <th scope="col" className="px-3 py-2 font-medium">Branch</th>
                  <th scope="col" className="px-3 py-2 font-medium">Risk</th>
                  <th scope="col" className="px-3 py-2 font-medium">Latest run</th>
                  <th scope="col" className="px-3 py-2 font-medium">Reviews</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {prs.data?.items.map((pr) => (
                  <tr key={pr.id} className="hover:bg-surface-subtle">
                    <td className="px-4 py-2">
                      <Link href={`/reviews/${pr.id}`} className="group flex items-baseline gap-2">
                        <span className="numeric shrink-0 text-xs text-slate-500">#{pr.number}</span>
                        <span className="max-w-lg truncate font-medium text-slate-900 group-hover:underline">
                          {pr.title}
                        </span>
                        {pr.draft && <Badge tone="neutral">draft</Badge>}
                      </Link>
                      <p className="numeric mt-0.5 text-xs text-slate-500">
                        +{pr.additions} −{pr.deletions} · {pr.changedFiles} file
                        {pr.changedFiles === 1 ? '' : 's'} · updated {relativeTime(pr.updatedAt)}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{pr.author.login}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-slate-600">
                        {pr.headRef}
                        <span className="text-slate-400"> → {pr.baseRef}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {pr.risk ? (
                        <RiskBadge level={pr.risk.level} score={pr.risk.score} />
                      ) : (
                        <span className="text-xs text-slate-400">not analysed</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {pr.latestRun ? (
                        <div className="flex items-center gap-1.5">
                          <RunStatusBadge status={pr.latestRun.status} />
                          <span className="text-xs text-slate-500">
                            {relativeTime(pr.latestRun.finishedAt)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 text-xs">
                        {pr.humanReviewSummary.approvals > 0 && (
                          <Badge tone="success">{pr.humanReviewSummary.approvals} approved</Badge>
                        )}
                        {pr.humanReviewSummary.changesRequested > 0 && (
                          <Badge tone="danger">
                            {pr.humanReviewSummary.changesRequested} changes
                          </Badge>
                        )}
                        {pr.unresolvedCommentCount > 0 && (
                          <Badge tone="outline">{pr.unresolvedCommentCount} open</Badge>
                        )}
                        {pr.humanReviewSummary.approvals === 0 &&
                          pr.humanReviewSummary.changesRequested === 0 &&
                          pr.unresolvedCommentCount === 0 && (
                            <span className="text-slate-400">—</span>
                          )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <AnalyzeButton pullRequestId={pr.id} size="sm" />
                        <Link
                          href={`/reviews/${pr.id}`}
                          className="rounded-md border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-surface-muted"
                        >
                          Review
                        </Link>
                      </div>
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
