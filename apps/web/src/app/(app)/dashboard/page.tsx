'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { RiskBadge, RunStatusBadge } from '@/components/risk';
import { Alert, Card, CardBody, CardHeader, EmptyState, Skeleton } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { duration, relativeTime } from '@/lib/format';
import type { RiskLevel } from '@/lib/types';

const RISK_LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export default function DashboardPage() {
  const org = useQuery({ queryKey: ['organization'], queryFn: () => api.organization() });
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => api.repositories(1, 100) });

  // Page size is generous because the risk summary is computed client-side from this one list
  // rather than from a separate analytics endpoint. Honest for a demo-scale dataset, and flagged
  // below so nobody mistakes it for a server-side aggregate.
  const prs = useQuery({
    queryKey: ['pull-requests', 'all'],
    queryFn: () => api.pullRequests({ pageSize: 100 }),
  });

  const error = (org.error ?? repos.error ?? prs.error) as ApiError | null;

  const items = prs.data?.items ?? [];
  const analysed = items.filter((pr) => pr.risk !== null);

  const byLevel = RISK_LEVELS.map((level) => ({
    level,
    count: analysed.filter((pr) => pr.risk?.level === level).length,
  }));

  const recentRuns = items
    .filter((pr) => pr.latestRun !== null)
    .sort((a, b) => {
      const left = a.latestRun?.finishedAt ?? a.updatedAt;
      const right = b.latestRun?.finishedAt ?? b.updatedAt;
      return new Date(right).getTime() - new Date(left).getTime();
    })
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {org.data?.name ?? <Skeleton className="inline-block h-5 w-40 align-middle" />}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {org.data ? (
              <>
                {org.data.slug} · {org.data.memberCount} member
                {org.data.memberCount === 1 ? '' : 's'} · plan {org.data.plan.toLowerCase()}
              </>
            ) : (
              'Loading workspace'
            )}
          </p>
        </div>
      </div>

      {error && (
        <Alert
          tone={error.code === 'NETWORK_ERROR' ? 'warning' : 'danger'}
          title={error.code === 'NETWORK_ERROR' ? 'API unreachable' : 'Could not load the dashboard'}
        >
          {error.message}
        </Alert>
      )}

      {/* ---- counts */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Repositories"
          value={repos.data?.total}
          detail={
            repos.data
              ? `${repos.data.items.filter((r) => r.indexStatus === 'INDEXED').length} indexed`
              : undefined
          }
          href="/repositories"
        />
        <StatCard
          label="Pull requests"
          value={prs.data?.total}
          detail={prs.data ? `${items.filter((pr) => pr.state === 'OPEN').length} open` : undefined}
          href="/pull-requests"
        />
        <StatCard label="Analysed" value={prs.data ? analysed.length : undefined} detail="with a risk score" />
        <StatCard
          label="Awaiting review"
          value={prs.data ? items.filter((pr) => pr.humanReviewSummary.approvals === 0).length : undefined}
          detail="no approval yet"
        />
      </div>

      {/* ---- risk distribution */}
      <Card>
        <CardHeader
          title="Risk summary"
          subtitle={
            prs.data
              ? `${analysed.length} of ${prs.data.total} pull request(s) have a completed risk prediction`
              : 'Loading'
          }
        />
        <CardBody>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {byLevel.map(({ level, count }) => (
              <div
                key={level}
                className="rounded-md border border-surface-border px-3 py-2.5"
              >
                <div className="flex items-center justify-between">
                  <RiskBadge level={level} />
                  <span className="numeric text-lg font-semibold text-slate-900">
                    {prs.isLoading ? <Skeleton className="inline-block h-5 w-6" /> : count}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {analysed.length === 0 && !prs.isLoading && (
            <p className="mt-3 text-xs text-slate-500">
              No pull request has been analysed yet. Open one and run an analysis to populate this.
            </p>
          )}
        </CardBody>
      </Card>

      {/* ---- recent runs */}
      <Card>
        <CardHeader title="Recent review runs" subtitle="Most recently finished analyses" />
        {prs.isLoading ? (
          <CardBody className="space-y-2">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-8 w-full" />
            ))}
          </CardBody>
        ) : recentRuns.length === 0 ? (
          <EmptyState
            title="No review runs yet"
            description="Analyse a pull request to see its run here."
          />
        ) : (
          <ul className="divide-y divide-surface-border">
            {recentRuns.map((pr) => (
              <li key={pr.id}>
                <Link
                  href={`/reviews/${pr.id}`}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-surface-subtle"
                >
                  <span className="numeric w-12 shrink-0 text-xs text-slate-500">#{pr.number}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{pr.title}</span>
                  {pr.risk && <RiskBadge level={pr.risk.level} score={pr.risk.score} />}
                  {pr.latestRun && <RunStatusBadge status={pr.latestRun.status} />}
                  <span className="hidden w-20 shrink-0 text-right text-xs text-slate-500 sm:block">
                    {relativeTime(pr.latestRun?.finishedAt ?? pr.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: number | undefined;
  detail?: string;
  href?: string;
}) {
  const inner = (
    <>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="numeric mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">
        {value === undefined ? <Skeleton className="inline-block h-7 w-10" /> : value}
      </p>
      {detail && <p className="mt-0.5 text-xs text-slate-500">{detail}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-lg border border-surface-border bg-white px-3 py-2.5 transition-colors hover:border-slate-300 hover:bg-surface-subtle"
      >
        {inner}
      </Link>
    );
  }

  return <div className="rounded-lg border border-surface-border bg-white px-3 py-2.5">{inner}</div>;
}
