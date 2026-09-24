'use client';

import * as React from 'react';
import { SeverityBadge } from '@/components/risk';
import { Badge, Button, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { cents } from '@/lib/format';
import type { AiReviewStatus, AiReviewView } from '@/lib/types';

const RECOMMENDATION_TONE = {
  APPROVE: 'success',
  REQUEST_CHANGES: 'danger',
  COMMENT_ONLY: 'warning',
} as const;

/**
 * The AI review, or a clear account of why there isn't one.
 *
 * The absent case gets as much design attention as the present one, because with no provider key
 * configured it is the case a demo actually shows. `aiReviewStatus.state` distinguishes a
 * deliberate skip from a provider failure, and `retryable` decides whether the user is offered a
 * re-run or told to change configuration — a generic "unavailable" would leave them guessing.
 */
export function AiReviewPanel({
  aiReview,
  status,
  onRetry,
  canRetry,
}: {
  aiReview: AiReviewView | null;
  status: AiReviewStatus;
  onRetry?: () => void;
  canRetry: boolean;
}) {
  if (!aiReview) {
    return <AiReviewUnavailable status={status} onRetry={onRetry} canRetry={canRetry} />;
  }

  return (
    <Card>
      <CardHeader
        title="AI review"
        subtitle={`${aiReview.provider.toLowerCase()} · ${aiReview.model}`}
        actions={
          <div className="flex items-center gap-1.5">
            <Badge tone={RECOMMENDATION_TONE[aiReview.effectiveRecommendation]}>
              {aiReview.effectiveRecommendation.replace(/_/g, ' ').toLowerCase()}
            </Badge>
            <span className="text-xs text-slate-500">
              {Math.round(aiReview.confidence * 100)}%
            </span>
          </div>
        }
      />
      <CardBody className="space-y-3">
        {/*
          A policy override is called out with both recommendations visible. The model's opinion is
          not hidden — a reviewer should be able to see that the agent wanted to approve and that
          policy refused, because that disagreement is information.
        */}
        {aiReview.policyOverridden && (
          <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
            <p className="font-semibold">
              Policy overrode the model: {aiReview.modelRecommendation.replace(/_/g, ' ').toLowerCase()} →{' '}
              {aiReview.effectiveRecommendation.replace(/_/g, ' ').toLowerCase()}
            </p>
            <ul className="mt-1 space-y-0.5">
              {aiReview.policyReasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          </div>
        )}

        <Section title="Summary">
          <p className="text-sm text-slate-700">{aiReview.executiveSummary}</p>
        </Section>

        <Section title="Why this recommendation">
          <p className="text-sm text-slate-700">{aiReview.recommendationRationale}</p>
        </Section>

        <Collapsible title="Technical detail">
          <p className="whitespace-pre-line text-sm text-slate-700">{aiReview.technicalSummary}</p>
        </Collapsible>

        <Collapsible title="Explain for someone new to this codebase">
          <p className="whitespace-pre-line text-sm text-slate-700">
            {aiReview.beginnerExplanation}
          </p>
        </Collapsible>

        {aiReview.findings.length > 0 && (
          <Section title={`AI findings (${aiReview.findings.length})`}>
            <ul className="space-y-2">
              {aiReview.findings.map((finding, index) => (
                <li
                  key={`${finding.title}-${index}`}
                  className="rounded border border-surface-border px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <SeverityBadge severity={finding.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900">{finding.title}</p>
                      {finding.path && (
                        <p className="font-mono text-xs text-slate-500">
                          {finding.path}
                          {finding.line ? `:${finding.line}` : ''}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-slate-700">{finding.explanation}</p>

                      {finding.suggestedFix && (
                        <pre className="mt-1.5 overflow-x-auto rounded bg-slate-900 px-2.5 py-2 text-xs text-slate-100">
                          <code>{finding.suggestedFix}</code>
                        </pre>
                      )}

                      {/*
                        Evidence count, not the ids. The fact that a finding is grounded in a real
                        tool run is what a reviewer needs; the cuid itself is internal plumbing.
                      */}
                      {finding.evidence.length > 0 && (
                        <p className="mt-1 text-xs text-slate-500">
                          Backed by {finding.evidence.length} tool run
                          {finding.evidence.length === 1 ? '' : 's'}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {aiReview.reviewerChecklist.length > 0 && (
          <Section title="Reviewer checklist">
            <ul className="space-y-1">
              {aiReview.reviewerChecklist.map((item) => (
                <li key={item.item} className="flex items-start gap-2">
                  <Badge
                    tone={
                      item.status === 'LIKELY_SATISFIED'
                        ? 'success'
                        : item.status === 'NEEDS_ATTENTION'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {item.status === 'LIKELY_SATISFIED'
                      ? 'ok'
                      : item.status === 'NEEDS_ATTENTION'
                        ? 'check'
                        : 'unknown'}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-800">
                      {item.item}
                      {item.fromPolicy && (
                        <span className="ml-1 font-normal text-slate-400">(policy)</span>
                      )}
                    </p>
                    {item.rationale && <p className="text-xs text-slate-500">{item.rationale}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {aiReview.suggestedTestCases.length > 0 && (
          <Collapsible title={`Suggested tests (${aiReview.suggestedTestCases.length})`}>
            <ul className="space-y-2">
              {aiReview.suggestedTestCases.map((test) => (
                <li key={test.description}>
                  <div className="flex items-baseline gap-2">
                    <Badge tone={test.priority === 'HIGH' ? 'warning' : 'neutral'}>
                      {test.priority.toLowerCase()}
                    </Badge>
                    <p className="text-xs font-medium text-slate-800">{test.description}</p>
                  </div>
                  <p className="font-mono text-xs text-slate-500">{test.path}</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-900 px-2.5 py-2 text-xs text-slate-100">
                    <code>{test.code}</code>
                  </pre>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}

        {aiReview.missingTests.length > 0 && (
          <Section title="Untested behaviour">
            <ul className="space-y-0.5">
              {aiReview.missingTests.map((gap) => (
                <li key={gap} className="text-xs text-slate-600">
                  · {gap}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {aiReview.openQuestions.length > 0 && (
          <Section title="Open questions">
            <ul className="space-y-0.5">
              {aiReview.openQuestions.map((question) => (
                <li key={question} className="text-xs text-slate-600">
                  · {question}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-surface-border pt-2 text-xs text-slate-500">
          <span>{aiReview.tokenUsage.total.toLocaleString()} tokens</span>
          <span>{cents(aiReview.costCents)}</span>
          {aiReview.usedMapReduce && <span>map-reduce</span>}
          {aiReview.droppedFindingCount > 0 && (
            <span title="Findings removed because they cited no verifiable tool run">
              {aiReview.droppedFindingCount} unsupported finding
              {aiReview.droppedFindingCount === 1 ? '' : 's'} dropped
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function AiReviewUnavailable({
  status,
  onRetry,
  canRetry,
}: {
  status: AiReviewStatus;
  onRetry?: () => void;
  canRetry: boolean;
}) {
  const tone =
    status.state === 'FAILED'
      ? { border: 'border-amber-200', bg: 'bg-amber-50', text: 'text-amber-900', label: 'Failed' }
      : { border: 'border-surface-border', bg: 'bg-surface-subtle', text: 'text-slate-700', label: 'Not generated' };

  const heading =
    status.state === 'SKIPPED'
      ? 'AI review skipped'
      : status.state === 'FAILED'
        ? 'AI review failed'
        : 'AI review not run';

  return (
    <Card>
      <CardHeader
        title="AI review"
        actions={<Badge tone={status.state === 'FAILED' ? 'warning' : 'neutral'}>{tone.label}</Badge>}
      />
      <CardBody>
        <div className={`rounded-md border px-3 py-2.5 ${tone.border} ${tone.bg}`}>
          <p className={`text-sm font-semibold ${tone.text}`}>{heading}</p>
          <p className={`mt-1 text-xs ${tone.text}`}>
            {status.reason ?? 'No further detail is available for this run.'}
          </p>

          <div className="mt-2 flex items-center gap-2">
            {/*
              The retry affordance follows the API's own classification. Offering "try again" for a
              rejected API key would waste the user's time and teach them the button is a lie.
            */}
            {status.retryable ? (
              canRetry && onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  Re-run analysis
                </Button>
              ) : (
                <span className="text-xs text-slate-500">
                  Re-running may succeed. Ask someone with analysis permission to trigger it.
                </span>
              )
            ) : (
              <span className="text-xs text-slate-500">
                Re-running will not help until the underlying configuration changes.
              </span>
            )}
          </div>
        </div>

        <p className="mt-2.5 text-xs text-slate-500">
          Static analysis, ML risk and retrieved context below are unaffected.
        </p>
      </CardBody>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold text-slate-700">{title}</h3>
      {children}
    </section>
  );
}

/** Long prose is collapsed by default so the panel stays scannable. */
function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded border border-surface-border">
      <summary className="cursor-pointer list-none px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-surface-subtle">
        <span className="inline-block w-3 text-slate-400 group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="border-t border-surface-border px-2.5 py-2">{children}</div>
    </details>
  );
}
