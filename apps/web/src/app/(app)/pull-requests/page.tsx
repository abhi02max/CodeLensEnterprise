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
                <tr className="whitespace-nowrap border-b border-surface-border text-left text-xs text-slate-500">
                  {/*
                    Columns drop out below `lg` so the two that matter on a narrow screen — risk and
                    the action — stay on screen. Previously the table scrolled inside its container,
                    which passed an overflow check while leaving risk and Analyze unreachable on a
                    phone without a horizontal swipe nobody would guess at.

                    Hiding the columns was not enough on its own: `table-layout: auto` sizes columns
                    from their content, and the title cell asked for up to `max-w-lg` (512px), which
                    is wider than a phone. The table stayed wider than its container and Risk and
                    Actions sat off-screen anyway. `w-full max-w-0` on the title cell inverts that —
                    it asks for nothing and absorbs whatever is left after the other columns are
                    satisfied, so the title ellipsizes instead of pushing them out.
                  */}
                  <th scope="col" className="px-4 py-2 font-medium">PR</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Author</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">Branch</th>
                  <th scope="col" className="px-3 py-2 font-medium">Risk</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Latest run</th>
                  <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Reviews</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {prs.data?.items.map((pr) => (
                  <tr key={pr.id} className="hover:bg-surface-subtle">
                    <td className="w-full max-w-0 px-4 py-2">
                      <Link href={`/reviews/${pr.id}`} className="group flex items-baseline gap-2">
                        <span className="numeric shrink-0 text-xs text-slate-500">#{pr.number}</span>
                        <span className="truncate font-medium text-slate-900 group-hover:underline">
                          {pr.title}
                        </span>
                        {pr.draft && <Badge tone="neutral">draft</Badge>}
                      </Link>
                      <p className="numeric mt-0.5 text-xs text-slate-500">
                        +{pr.additions} −{pr.deletions} · {pr.changedFiles} file
                        {pr.changedFiles === 1 ? '' : 's'} · updated {relativeTime(pr.updatedAt)}
                      </p>
                    </td>
                    {/* `whitespace-nowrap` on the narrow columns is load-bearing: the title cell is
                        `w-full max-w-0`, so it absorbs all slack and leaves every other column at
                        its min-content width. Without this, "samir-patel" broke at the hyphen and
                        "chore/ledger-logging → main" wrapped onto three lines. */}
                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-slate-600 lg:table-cell">
                      {pr.author.login}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 xl:table-cell">
                      <span className="font-mono text-xs text-slate-600">
                        {pr.headRef}
                        <span className="text-slate-400"> → {pr.baseRef}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {pr.risk ? (
                        <RiskBadge level={pr.risk.level} score={pr.risk.score} />
                      ) : (
                        <span className="text-xs text-slate-400">not analysed</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 md:table-cell">
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
                    <td className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">
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
                    <td className="whitespace-nowrap px-4 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Kicking off an analysis from a phone is not a real workflow, and the two
                            buttons together left the title barely an ellipsis wide. Review stays. */}
                        <span className="hidden sm:inline-flex">
                          <AnalyzeButton pullRequestId={pr.id} size="sm" />
                        </span>
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
