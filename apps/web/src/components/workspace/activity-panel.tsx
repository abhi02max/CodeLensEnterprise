'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';

/**
 * Activity feed from the audit trail.
 *
 * Renders only the four fields the API marks as safe for display: action, actor, description and
 * time. `metadata` is deliberately not rendered even though the endpoint returns it — it carries
 * finding fingerprints, capability flags and resource ids, and a panel that prints whatever it is
 * handed is how internal detail ends up on a screen during a demo.
 */
export function ActivityPanel({ resourceId, title = 'Activity' }: { resourceId?: string; title?: string }) {
  const logs = useQuery({
    queryKey: ['audit-logs', resourceId ?? 'all'],
    queryFn: () => api.auditLogs({ pageSize: 12, ...(resourceId ? { resourceId } : {}) }),
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
        <div className="px-4 py-3 text-xs text-slate-500">
          {/* An ADMIN-only endpoint: a developer seeing this panel empty is expected, not broken. */}
          Activity is visible to admins and owners.
        </div>
      ) : logs.data && logs.data.items.length === 0 ? (
        <EmptyState title="No recorded activity" />
      ) : (
        <ul className="divide-y divide-surface-border">
          {logs.data?.items.map((entry) => (
            <li key={entry.id} className="px-4 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <Badge tone="outline">{entry.action}</Badge>
                <span className="shrink-0 text-xs text-slate-400">
                  {relativeTime(entry.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-700">{entry.description}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {entry.actor ? entry.actor.name : `${entry.actorType.toLowerCase()} (no actor)`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
