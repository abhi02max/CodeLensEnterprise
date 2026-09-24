'use client';

import { RiskBadge, RiskMeter } from '@/components/risk';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import { minutes } from '@/lib/format';
import type { RiskView } from '@/lib/types';

/**
 * ML risk and its attributions.
 *
 * The attributions are the point of this panel, not the score. A number with no explanation is
 * something reviewers learn to ignore, so each contributing feature is shown with its direction,
 * its value and the model's reason — which is also what makes a wrong score arguable instead of
 * merely annoying.
 */
export function RiskPanel({ risk }: { risk: RiskView | null }) {
  if (!risk) {
    return (
      <Card>
        <CardHeader title="Risk" />
        <EmptyState
          title="No risk prediction"
          description="The ML service did not produce a score for this run."
        />
      </Card>
    );
  }

  const increasing = risk.reasons.filter((reason) => reason.direction === 'INCREASES_RISK');
  const decreasing = risk.reasons.filter((reason) => reason.direction === 'DECREASES_RISK');
  const maxContribution = Math.max(...risk.reasons.map((r) => Math.abs(r.contribution)), 0.01);

  return (
    <Card>
      <CardHeader
        title="ML risk"
        subtitle={`${risk.modelName} · ${risk.modelVersion}`}
        actions={<RiskBadge level={risk.level} />}
      />
      <CardBody className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="numeric text-3xl font-semibold tracking-tight text-slate-900">
              {risk.score}
              <span className="text-base font-normal text-slate-400">/100</span>
            </span>
            <span className="text-xs text-slate-500">
              confidence {Math.round(risk.confidence * 100)}%
            </span>
          </div>
          <div className="mt-2">
            <RiskMeter score={risk.score} level={risk.level} />
          </div>
        </div>

        {/*
          A baseline model is labelled as such. The score looks identical either way, and letting a
          heuristic pass as a trained model would be the most misleading thing on this screen.
        */}
        {risk.isBaseline && (
          <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            Produced by a heuristic baseline, not a model trained on this organization&rsquo;s review
            history. Treat it as weak evidence.
          </p>
        )}

        <dl className="divide-y divide-surface-border border-y border-surface-border">
          <Field label="Predicted review time">
            {minutes(risk.predictedReviewTimeMinutes)}
            {risk.reviewTimeRange && (
              <span className="ml-1 font-normal text-slate-500">
                ({minutes(risk.reviewTimeRange.lower)}–{minutes(risk.reviewTimeRange.upper)})
              </span>
            )}
          </Field>
          <Field label="Probability">{(risk.probability * 100).toFixed(1)}%</Field>
        </dl>

        {risk.reasons.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-slate-700">Why this score</p>
            <ul className="space-y-1.5">
              {[...increasing, ...decreasing].map((reason) => (
                <li key={reason.feature}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-800">
                      {reason.label}
                    </span>
                    <span className="numeric shrink-0 text-xs text-slate-500">
                      {reason.direction === 'INCREASES_RISK' ? '+' : '−'}
                      {Math.abs(reason.contribution).toFixed(2)}
                    </span>
                  </div>
                  {/* Bar width is relative to the largest contributor, so the ordering is
                      readable even when every contribution is small. */}
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className={
                        reason.direction === 'INCREASES_RISK'
                          ? 'h-full rounded-full bg-risk-high'
                          : 'h-full rounded-full bg-risk-low'
                      }
                      style={{
                        width: `${Math.max(3, (Math.abs(reason.contribution) / maxContribution) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{reason.explanation}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {risk.similarPullRequests.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-slate-700">Similar past changes</p>
            <ul className="space-y-1">
              {risk.similarPullRequests.slice(0, 4).map((similar) => (
                <li key={similar.reference} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-slate-600">{similar.title}</span>
                  <Badge
                    tone={
                      similar.outcome === 'REVERTED'
                        ? 'danger'
                        : similar.outcome === 'APPROVED'
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {similar.outcome.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {risk.degradedReason && (
          <p className="text-xs text-amber-800">{risk.degradedReason}</p>
        )}
      </CardBody>
    </Card>
  );
}
