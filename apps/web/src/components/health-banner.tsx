'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Degraded-dependency banner.
 *
 * Shows only when something is actually wrong, and names which dependency and what it costs. The
 * distinction the API draws between required and optional is carried through: Postgres down is an
 * outage, the LLM provider missing is a reduced review. Collapsing them into one red bar would
 * train people to ignore the bar.
 */
export function HealthBanner() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    // Polled because a dependency can recover while the tab is open, and a banner that outlives
    // the problem is worse than no banner.
    refetchInterval: 30_000,
  });

  if (!data || data.status === 'ok') return null;

  const failing = data.checks.filter((check) => !check.ok);
  const down = failing.filter((check) => check.required);
  const degraded = failing.filter((check) => !check.required);
  const isOutage = down.length > 0;

  return (
    <div
      role="status"
      className={
        isOutage
          ? 'border-b border-state-danger-border bg-state-danger-bg px-4 py-2'
          : 'border-b border-state-warning-border bg-state-warning-bg px-4 py-2'
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span
          className={
            isOutage
              ? 'font-semibold text-state-danger-text'
              : 'font-semibold text-state-warning-text'
          }
        >
          {isOutage ? 'Service outage' : 'Running degraded'}
        </span>
        <span className={isOutage ? 'text-state-danger-text' : 'text-state-warning-text'}>
          {(isOutage ? down : degraded)
            .map((check) => `${check.name}: ${check.detail ?? 'unavailable'}`)
            .join(' · ')}
        </span>
      </div>
    </div>
  );
}
