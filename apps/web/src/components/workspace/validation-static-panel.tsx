'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StaticFindingsQuery } from '@codelens/shared';
import { api } from '@/lib/api';
import { Alert, Button } from '@/components/ui/primitives';

const interpretation: Record<string, string> = {
  RESOLVED: 'Static analyzer no longer detected this occurrence in the patched candidate.',
  INTRODUCED: 'Static analyzer detected this new occurrence in the patched candidate.',
  CHANGED: 'The matched occurrence has changed analyzer-relevant content or severity.',
  UNCHANGED: 'The unique normalized occurrence remains detected on both sides.',
  INCOMPARABLE: 'These observations cannot be confidently matched.',
};
export function ValidationStaticPanel({
  validationId,
  active,
}: {
  validationId: string;
  active: boolean;
}) {
  const [filters, setFilters] = React.useState<Partial<StaticFindingsQuery>>({});
  const [afterId, setAfterId] = React.useState<string>();
  const previousActive = React.useRef(active);
  const query = useQuery({
    queryKey: ['validation-static', validationId, filters, afterId],
    queryFn: () => api.validationStatic(validationId, { ...filters, afterId }),
    refetchInterval: active ? 1000 : false,
    refetchOnWindowFocus: false,
  });
  React.useEffect(() => {
    if (previousActive.current && !active) void query.refetch();
    previousActive.current = active;
  }, [active, validationId, query.refetch]);
  return (
    <section
      aria-label="Static occurrence comparison"
      className="mt-3 border-t border-surface-border pt-2"
    >
      <h5 className="text-sm font-semibold">Static occurrence comparison</h5>
      {query.isPending && <p className="text-xs">Loading static observations.</p>}
      {query.isError && (
        <Alert tone="danger">
          Static observations unavailable.{' '}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {query.data && !query.isError && (
        <>
          {!query.data.analyses.length && (
            <p className="text-xs">
              No static analysis observations recorded. This is not a zero-findings result.
            </p>
          )}
          {query.data.analyses.map((a) => (
            <p key={a.side} className="text-xs">
              {a.side}: {a.status}
              {a.reason ? ` (${a.reason})` : ''} · {a.findingCount} observations
            </p>
          ))}
          <details className="text-xs">
            <summary>Static source and analyzer identities</summary>
            {query.data.analyses.map((a) => (
              <p key={a.side} className="break-all">
                {a.side} · {a.rulesetVersion} · {a.fingerprintVersion}
                <br />
                Source {a.sourceDigest} · Rules {a.rulesetDigest} · Configuration{' '}
                {a.configurationDigest}
              </p>
            ))}
          </details>
          {query.data.analyses.length === 2 &&
          query.data.analyses.every((a) => a.status === 'COMPLETE') &&
          new Set(query.data.analyses.map((a) => a.side)).size === 2 ? (
            <p className="my-2 text-xs">
              {Object.entries(query.data.summary)
                .map(([key, n]) => `${key}: ${n}`)
                .join(' · ')}
            </p>
          ) : (
            <p className="my-2 text-xs">
              Comparison unavailable: missing or incomplete analysis is not a clean result.
            </p>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            {(
              [
                ['side', 'Side', ['ORIGINAL', 'PATCHED']],
                [
                  'classification',
                  'Comparison',
                  ['UNCHANGED', 'RESOLVED', 'INTRODUCED', 'CHANGED', 'INCOMPARABLE'],
                ],
                ['severity', 'Severity', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']],
              ] as const
            ).map(([key, label, values]) => (
              <label key={key}>
                {label}
                <select
                  className="ml-1 border border-surface-border bg-white p-1"
                  aria-label={`Static ${label.toLowerCase()}`}
                  value={filters[key] ?? ''}
                  onChange={(e) => {
                    setFilters({ ...filters, [key]: e.target.value || undefined });
                    setAfterId(undefined);
                  }}
                >
                  <option value="">All</option>
                  {values.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              Rule
              <input
                aria-label="Static rule"
                className="ml-1 w-48 border border-surface-border p-1"
                value={filters.rule ?? ''}
                maxLength={120}
                onChange={(e) => {
                  const rule = e.target.value;
                  if (/^[a-zA-Z0-9/_-]*$/.test(rule)) {
                    setFilters({ ...filters, rule: rule || undefined });
                    setAfterId(undefined);
                  }
                }}
              />
            </label>
          </div>
          <ul className="mt-2 space-y-2">
            {query.data.items.map((f) => (
              <li key={f.id} className="break-words text-xs">
                <details>
                  <summary>
                    {f.side} · {f.classification} · {f.severity} · {f.ruleId} · {f.path}:
                    {f.startLine}
                  </summary>
                  <p>{f.message}</p>
                  <p>{interpretation[f.classification]}</p>
                  <p>
                    {f.diffRelation} · {f.comparability}
                  </p>
                  <p className="break-all">
                    Occurrence {f.occurrenceFingerprint} · Finding {f.findingDigest}
                  </p>
                  {f.counterpartDigest && (
                    <p className="break-all">Other-side finding {f.counterpartDigest}</p>
                  )}
                </details>
              </li>
            ))}
          </ul>
          {afterId && (
            <Button size="sm" onClick={() => setAfterId(undefined)}>
              First static findings
            </Button>
          )}
          {query.data.nextAfterId && (
            <Button size="sm" onClick={() => setAfterId(query.data!.nextAfterId!)}>
              More static findings
            </Button>
          )}
          <p className="mt-2 text-xs">{query.data.limitations}</p>
        </>
      )}
    </section>
  );
}
