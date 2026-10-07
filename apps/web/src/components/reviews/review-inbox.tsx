'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Button, Label, PageHeader, Select } from '../ui/primitives';
import { ListPagination } from '../list-pagination';
import { ListError, ReviewList, ReviewListLoading, ReviewsEmpty } from './review-list';
import { api } from '@/lib/api';
import {
  hasReviewFilters,
  readReviewQuery,
  reviewEmptyKind,
  reviewsHref,
  type ReviewQuery,
} from '@/lib/review-inbox';

export function ReviewInbox() {
  const search = useSearchParams();
  const router = useRouter();
  const query = readReviewQuery(search);
  const repositories = useInfiniteQuery({
    queryKey: ['repositories', 'review-filter'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.repositories(pageParam, 50),
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const reviews = useQuery({
    queryKey: ['pull-requests', query],
    queryFn: () => api.pullRequests(query),
  });
  const options = repositories.data?.pages.flatMap((page) => page.items) ?? [];
  const selected = options.find((repo) => repo.id === query.repositoryId);
  const scopeName =
    selected?.fullName ??
    reviews.data?.items.find((pr) => pr.repository.id === query.repositoryId)?.repository.fullName;
  const change = (next: Partial<ReviewQuery>) =>
    router.push(reviewsHref({ ...query, ...next, page: 1 }));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Reviews"
        subtitle={
          query.repositoryId
            ? `Repository: ${scopeName ?? 'Selected repository'}`
            : 'All accessible reviews'
        }
      />
      <div className="flex flex-wrap items-end gap-3 border-b border-structure pb-4">
        <div className="min-w-0 flex-1 basis-64 max-w-full">
          <Label htmlFor="review-repository">Repository</Label>
          <Select
            id="review-repository"
            className="mt-1 w-full"
            value={query.repositoryId ?? ''}
            disabled={repositories.isPending}
            onChange={(event) => change({ repositoryId: event.target.value || undefined })}
          >
            <option value="">All repositories</option>
            {query.repositoryId && !selected && (
              <option value={query.repositoryId}>{scopeName ?? 'Selected repository'}</option>
            )}
            {options.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1 basis-32">
          <Label htmlFor="review-state">PR state</Label>
          <Select
            id="review-state"
            className="mt-1 w-full"
            value={query.state ?? ''}
            onChange={(event) =>
              change({ state: (event.target.value || undefined) as ReviewQuery['state'] })
            }
          >
            <option value="">All states</option>
            <option value="OPEN">Open</option>
            <option value="DRAFT">Draft</option>
            <option value="CLOSED">Closed</option>
            <option value="MERGED">Merged</option>
          </Select>
        </div>
        <div className="min-w-0 flex-1 basis-32">
          <Label htmlFor="review-risk">Stored risk</Label>
          <Select
            id="review-risk"
            className="mt-1 w-full"
            value={query.riskLevel ?? ''}
            onChange={(event) =>
              change({ riskLevel: (event.target.value || undefined) as ReviewQuery['riskLevel'] })
            }
          >
            <option value="">All risks</option>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((level) => (
              <option key={level}>{level}</option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1 basis-44">
          <Label htmlFor="review-order">Order</Label>
          <Select
            id="review-order"
            className="mt-1 w-full"
            value={
              query.sortBy === 'riskScore'
                ? 'risk'
                : query.sortOrder === 'asc'
                  ? 'oldest'
                  : 'recent'
            }
            onChange={(event) =>
              change({
                sortBy: event.target.value === 'risk' ? 'riskScore' : 'updatedAt',
                sortOrder: event.target.value === 'oldest' ? 'asc' : 'desc',
              })
            }
          >
            <option value="recent">Recently updated</option>
            <option value="oldest">Least recently updated</option>
            <option value="risk">Highest stored risk</option>
          </Select>
        </div>
        {hasReviewFilters(query) && (
          <Button variant="ghost" onClick={() => router.push(reviewsHref())}>
            Clear filters
          </Button>
        )}
      </div>
      {repositories.hasNextPage && (
        <Button
          size="sm"
          loading={repositories.isFetchingNextPage}
          onClick={() => void repositories.fetchNextPage()}
        >
          Load more repository options
        </Button>
      )}
      {repositories.isError && (
        <ListError subject="repository options" onRetry={() => void repositories.refetch()} />
      )}
      {reviews.isError ? (
        <ListError subject="reviews" onRetry={() => void reviews.refetch()} />
      ) : reviews.isPending ? (
        <ReviewListLoading />
      ) : (
        reviews.data && (
          <>
            {reviews.data.items.length ? (
              <ReviewList items={reviews.data.items} />
            ) : repositories.isPending ? (
              <ReviewListLoading />
            ) : repositories.isError ? null : (
              <ReviewsEmpty
                kind={reviewEmptyKind(repositories.data?.pages[0]?.total ?? 0, query)}
                onReset={() =>
                  router.push(reviewsHref(query.page > 1 ? { ...query, page: 1 } : {}))
                }
              />
            )}
            <ListPagination
              {...reviews.data}
              pending={reviews.isFetching}
              onPage={(page) => router.push(reviewsHref({ ...query, page }))}
            />
          </>
        )
      )}
    </div>
  );
}
