'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
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

export function ActivityError({
  error,
  retry,
  pending,
}: {
  error: unknown;
  retry: () => void;
  pending: boolean;
}) {
  const status = error instanceof ApiError ? error.status : undefined;
  const forbidden = status === 403;
  const unauthorized = status === 401;
  const message = forbidden
    ? 'Activity is visible to admins and owners.'
    : unauthorized
      ? 'Your session could not be confirmed. Sign in again to view activity.'
      : error instanceof ApiError && error.code === 'NETWORK_ERROR'
        ? 'Activity could not be reached. Check your connection and try again.'
        : status !== undefined && status >= 500
          ? 'The activity service is unavailable. Try again.'
          : 'Activity could not be loaded. Try again.';
  return (
    <div className="px-4 py-3">
      <Alert tone={forbidden || unauthorized ? 'info' : 'danger'} title="Activity unavailable">
        <p>{message}</p>
      </Alert>
      {!forbidden && !unauthorized && (
        <Button className="mt-2" size="sm" loading={pending} onClick={retry}>
          Retry activity
        </Button>
      )}
    </div>
  );
}

/**
 * Activity feed from the audit trail.
 *
 * Renders only the four fields the API marks as safe for display: action, actor, description and
 * time. `metadata` is deliberately not rendered even though the endpoint returns it — it carries
 * finding fingerprints, capability flags and resource ids, and a panel that prints whatever it is
 * handed is how internal detail ends up on a screen during a demo.
 */
export function ActivityPanel({
  resourceId,
  title = 'Activity',
  limit = 12,
}: {
  resourceId?: string;
  title?: string;
  /** Lower in the workspace sidebar, where activity is context rather than the subject. */
  limit?: number;
}) {
  const logs = useQuery({
    queryKey: ['audit-logs', resourceId ?? 'all', limit],
    queryFn: () => api.auditLogs({ pageSize: limit, ...(resourceId ? { resourceId } : {}) }),
  });

  return (
    <Card>
      <CardHeader title={title} subtitle="Recorded in the audit trail" />

      {logs.isLoading ? (
        <div className="space-y-2 px-4 py-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-7 w-full" />
          ))}
        </div>
      ) : logs.error ? (
        <ActivityError
          error={logs.error}
          retry={() => void logs.refetch()}
          pending={logs.isFetching}
        />
      ) : logs.data && logs.data.items.length === 0 ? (
        <EmptyState title="No recorded activity" />
      ) : (
        <ul className="divide-y divide-surface-border">
          {logs.data?.items.map((entry) => (
            <li key={entry.id} className="px-4 py-1.5">
              {/* Action, time and actor on one line: three stacked lines per entry made this panel
                  1078px tall in the sidebar, where it is supporting context, not the subject. */}
              <div className="flex items-baseline gap-2">
                <Badge tone="outline" className="shrink-0">
                  {entry.action}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
                  {entry.actor ? entry.actor.name : entry.actorType.toLowerCase()}
                </span>
                <span className="shrink-0 text-xs text-content-muted">
                  {relativeTime(entry.createdAt)}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-700">{entry.description}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
