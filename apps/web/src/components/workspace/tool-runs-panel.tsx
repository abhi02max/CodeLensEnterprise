'use client';

import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { duration, toolLabel } from '@/lib/format';
import type { ToolRunSummary } from '@/lib/types';

/**
 * Pipeline provenance: which of the eleven tools ran, in what order, and how long each took.
 *
 * This is what makes the review auditable rather than a black box, so it is shown in the
 * authenticated workspace. `output` is not rendered — the API already omits it from the workspace
 * payload, and it holds raw analyzer and provider payloads.
 *
 * A tool's `error` is shown because it is sanitized upstream by design; the classifier writes those
 * messages for a reviewer to read.
 */
export function ToolRunsPanel({ toolRuns }: { toolRuns: ToolRunSummary[] }) {
  const succeeded = toolRuns.filter((run) => run.status === 'SUCCESS').length;

  return (
    <Card>
      <CardHeader
        title="Pipeline"
        subtitle={`${succeeded} of ${toolRuns.length} tool(s) succeeded`}
      />
      <ol className="divide-y divide-surface-border">
        {toolRuns.map((run) => (
          <li key={run.id} className="flex items-center gap-2 px-4 py-1.5">
            <span className="numeric w-4 shrink-0 text-xs text-content-muted">{run.sequence}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
              {toolLabel(run.tool)}
            </span>

            {run.cacheHit && <Badge tone="outline">cached</Badge>}

            <Badge
              tone={
                run.status === 'SUCCESS'
                  ? 'success'
                  : run.status === 'SKIPPED'
                    ? 'neutral'
                    : 'danger'
              }
            >
              {run.status.toLowerCase()}
            </Badge>

            <span className="numeric w-14 shrink-0 text-right text-xs text-content-muted">
              {duration(run.durationMs)}
            </span>
          </li>
        ))}
      </ol>

      {toolRuns.some((run) => run.error) && (
        <div className="border-t border-surface-border px-4 py-2">
          <ul className="space-y-1">
            {toolRuns
              .filter((run) => run.error)
              .map((run) => (
                <li key={`${run.id}-error`} className="text-xs text-slate-600">
                  <span className="font-medium">{toolLabel(run.tool)}:</span> {run.error}
                </li>
              ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
