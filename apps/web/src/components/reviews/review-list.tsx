'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { AnalyzeButton } from '../analyze-button';
import { Alert, Button, EmptyState, LoadingRegion, Skeleton, StatusLabel } from '../ui/primitives';
import { RunStatusBadge } from '../risk';
import { relativeTime } from '@/lib/format';
import { reviewsHref } from '@/lib/review-inbox';
import type { PullRequestListItem } from '@/lib/types';

export function ReviewListLoading() {
  return (
    <LoadingRegion label="Loading reviews" className="py-4">
      <div className="mt-4 divide-y divide-structure" aria-hidden="true">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className="space-y-3 py-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function ListError({ subject, onRetry }: { subject: string; onRetry: () => void }) {
  return (
    <Alert title={`Could not load ${subject}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>Please try again.</p>
        <Button onClick={onRetry}>Retry</Button>
      </div>
    </Alert>
  );
}

export function ReviewsEmpty({
  kind,
  onReset,
}: {
  kind: 'repositories' | 'reviews' | 'filtered' | 'page';
  onReset: () => void;
}) {
  if (kind === 'filtered')
    return (
      <EmptyState
        title="No reviews match these filters"
        action={<Button onClick={onReset}>Clear filters</Button>}
      />
    );
  if (kind === 'page')
    return (
      <EmptyState
        title="No reviews on this page"
        action={<Button onClick={onReset}>Return to first page</Button>}
      />
    );
  return (
    <EmptyState
      title={kind === 'repositories' ? 'No repositories connected' : 'No reviews yet'}
      description={
        kind === 'repositories'
          ? 'Connect a repository to get started.'
          : 'No pull requests have been imported into this workspace.'
      }
      action={
        <Link
          className="text-compact font-medium text-selected-text hover:underline"
          href="/repositories"
        >
          {kind === 'repositories' ? 'Connect a repository' : 'View repositories'}
        </Link>
      }
    />
  );
}

export function ReviewList({ items }: { items: PullRequestListItem[] }) {
  return (
    <ul aria-label="Reviews" className="divide-y divide-structure">
      {items.map((pr) => (
        <li
          key={pr.id}
          className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_10rem_9rem] lg:grid-cols-[minmax(0,1fr)_11rem_10rem]"
        >
          <div className="min-w-0">
            <Link
              href={`/reviews/${encodeURIComponent(pr.id)}`}
              className="break-words text-panel font-semibold text-content-primary hover:underline"
            >
              {pr.title}
            </Link>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-metadata text-content-muted">
              <Link
                href={reviewsHref({ repositoryId: pr.repository.id })}
                className="break-all text-content-secondary hover:underline"
              >
                {pr.repository.fullName}
              </Link>
              <span>#{pr.number}</span>
              <span>{pr.author.login}</span>
              <span>{pr.draft ? 'Draft' : pr.state.toLowerCase()}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-metadata text-content-muted">
              <span className="hidden max-w-full break-all sm:inline">
                {pr.headRef} → {pr.baseRef}
              </span>
              <span>
                {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}
              </span>
              <span className="numeric">
                <span aria-label={`${pr.additions} additions`}>+{pr.additions}</span> /{' '}
                <span aria-label={`${pr.deletions} deletions`}>-{pr.deletions}</span>
              </span>
              <span>Updated {relativeTime(pr.updatedAt)}</span>
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-metadata md:block md:space-y-2">
            <div className="flex items-baseline gap-2">
              <dt className="text-content-muted">Stored risk</dt>
              <dd>
                {pr.risk ? (
                  <StatusLabel
                    label={`${pr.risk.score} ${pr.risk.level}`}
                    tone={
                      pr.risk.level === 'HIGH' || pr.risk.level === 'CRITICAL'
                        ? 'danger'
                        : pr.risk.level === 'MEDIUM'
                          ? 'warning'
                          : 'neutral'
                    }
                  />
                ) : (
                  <StatusLabel label="Unavailable" tone="unavailable" />
                )}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-content-muted">Analysis</dt>
              <dd>
                {pr.latestRun ? (
                  <RunStatusBadge status={pr.latestRun.status} />
                ) : (
                  <StatusLabel label="Not analyzed" />
                )}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-3 md:flex-col md:items-end md:justify-center md:gap-2">
            <Link
              href={`/reviews/${encodeURIComponent(pr.id)}`}
              aria-label={`Open review #${pr.number}: ${pr.title}`}
              className="inline-flex min-h-9 items-center gap-2 rounded-control bg-interactive px-3 py-2 text-compact font-medium text-content-inverse hover:bg-interactive-hover"
            >
              Open review
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
            <AnalyzeButton pullRequestId={pr.id} size="sm" variant="ghost" />
          </div>
        </li>
      ))}
    </ul>
  );
}
