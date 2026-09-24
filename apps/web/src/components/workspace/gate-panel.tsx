'use client';

import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import type { ReviewGateStatus } from '@/lib/types';

/**
 * Merge gate.
 *
 * Blocking reasons and warnings are kept visually distinct because the API keeps them
 * semantically distinct: a blocker stops the merge, a warning is advice. Rendering them in one
 * list would make the risk-score warning look like a veto, which is exactly the confusion the
 * backend split was designed to avoid.
 */
export function GatePanel({ gate }: { gate: ReviewGateStatus }) {
  return (
    <Card>
      <CardHeader
        title="Merge gate"
        subtitle={`${gate.currentApprovals} of ${gate.requiredApprovals} required approval(s)`}
        actions={
          <span
            className={
              gate.readyToMerge
                ? 'inline-flex items-center rounded border border-green-200 bg-green-50 px-1.5 py-0.5 text-xs font-semibold text-risk-low'
                : 'inline-flex items-center rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-risk-critical'
            }
          >
            {gate.readyToMerge ? 'Ready to merge' : 'Blocked'}
          </span>
        }
      />
      <CardBody className="space-y-3">
        {gate.blockingReasons.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-700">
              Blocking ({gate.blockingReasons.length})
            </p>
            <ul className="space-y-1">
              {gate.blockingReasons.map((reason) => (
                <li key={reason} className="flex gap-1.5 text-xs text-slate-700">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-risk-critical" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {gate.warnings.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-700">
              Advisory ({gate.warnings.length})
            </p>
            <ul className="space-y-1">
              {gate.warnings.map((warning) => (
                <li key={warning} className="flex gap-1.5 text-xs text-slate-600">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-risk-medium" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {gate.blockingReasons.length === 0 && gate.warnings.length === 0 && (
          <p className="text-xs text-slate-500">
            Nothing is blocking this change under the current review policy.
          </p>
        )}

        {gate.changesRequestedBy.length > 0 && (
          <p className="text-xs text-slate-500">
            Changes requested by{' '}
            {gate.changesRequestedBy.map((reviewer) => reviewer.name).join(', ')}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
