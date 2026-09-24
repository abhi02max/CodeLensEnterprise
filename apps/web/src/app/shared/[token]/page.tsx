'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { RiskBadge, RiskMeter, SEVERITY_ORDER, SeverityBadge } from '@/components/risk';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Label,
  Skeleton,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { absoluteTime, minutes, shortSha } from '@/lib/format';
import type { Severity } from '@/lib/types';

/**
 * Read-only shared review.
 *
 * Outside the authenticated shell on purpose: no nav, no sign-out, no organization switcher. The
 * recipient is not a user of this workspace, and showing them chrome they cannot use would imply
 * otherwise.
 *
 * Everything rendered here comes from the share endpoint's own allowlisted payload. The page does
 * not reach for tool runs, comments, share links, permissions or ids, because the API does not
 * return them on this route — that redaction is enforced server-side, and this page is written to
 * match rather than to filter.
 */
export default function SharedReviewPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [passphrase, setPassphrase] = React.useState('');
  const [submitted, setSubmitted] = React.useState<string | undefined>(undefined);

  const review = useQuery({
    queryKey: ['shared-review', token, submitted],
    queryFn: () => api.sharedReview(token, submitted),
    retry: false,
  });

  const error = review.error as ApiError | null;
  const needsPassphrase = error?.status === 401;

  if (needsPassphrase) {
    return (
      <Shell>
        <Card className="mx-auto max-w-sm">
          <CardHeader title="Passphrase required" />
          <CardBody>
            <p className="text-xs text-slate-600">
              This shared review is passphrase protected.
            </p>

            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(passphrase);
              }}
            >
              <div>
                <Label htmlFor="passphrase">Passphrase</Label>
                <Input
                  id="passphrase"
                  type="password"
                  autoFocus
                  className="mt-1"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </div>

              {submitted !== undefined && (
                <Alert tone="danger">That passphrase is not correct.</Alert>
              )}

              <Button type="submit" variant="primary" className="w-full">
                Open review
              </Button>
            </form>
          </CardBody>
        </Card>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Alert
          tone={error.code === 'NETWORK_ERROR' ? 'warning' : 'danger'}
          className="mx-auto max-w-md"
          title={error.code === 'NETWORK_ERROR' ? 'API unreachable' : 'This link does not work'}
        >
          {/*
            The API returns an identical 404 for unknown, expired and revoked tokens, so the copy
            here does not speculate about which. Guessing on the client would leak exactly what the
            server withholds.
          */}
          {error.code === 'NETWORK_ERROR'
            ? error.message
            : 'The link may have expired, been revoked, or never existed.'}
        </Alert>
      </Shell>
    );
  }

  if (!review.data) {
    return (
      <Shell>
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </Shell>
    );
  }

  const data = review.data;
  const { pullRequest } = data;

  return (
    <Shell>
      <div className="space-y-3">
        <div className="rounded-lg border border-surface-border bg-white px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span>{data.repository.fullName}</span>
                <span aria-hidden="true">/</span>
                <span className="numeric">#{pullRequest.number}</span>
                <Badge tone="outline">{pullRequest.state.toLowerCase()}</Badge>
                <Badge tone="neutral">{data.scope.toLowerCase()} view</Badge>
                {data.redactCode && <Badge tone="neutral">code redacted</Badge>}
              </div>

              <h1 className="mt-1 text-lg font-semibold leading-snug tracking-tight text-slate-900">
                {pullRequest.title}
              </h1>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>{pullRequest.authorLogin}</span>
                <span className="font-mono">{shortSha(pullRequest.headSha)}</span>
                <span className="numeric">
                  +{pullRequest.additions} −{pullRequest.deletions} · {pullRequest.changedFiles} file
                  {pullRequest.changedFiles === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            {data.risk && <RiskBadge level={data.risk.level} score={data.risk.score} />}
          </div>

          <p className="mt-2.5 border-t border-surface-border pt-2 text-xs text-slate-500">
            Read-only shared review · access expires {absoluteTime(data.expiresAt)}
          </p>
        </div>

        {data.run?.stale && (
          <Alert tone="warning" title="Out of date">
            This analysis ran against an earlier commit than the current pull request head.
          </Alert>
        )}

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {data.aiReview && (
              <Card>
                <CardHeader
                  title="AI review"
                  actions={
                    data.aiReview.effectiveRecommendation ? (
                      <Badge
                        tone={
                          data.aiReview.effectiveRecommendation === 'APPROVE' ? 'success' : 'danger'
                        }
                      >
                        {data.aiReview.effectiveRecommendation.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    ) : undefined
                  }
                />
                <CardBody className="space-y-3">
                  {data.aiReview.executiveSummary && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-slate-700">Summary</h3>
                      <p className="text-sm text-slate-700">{data.aiReview.executiveSummary}</p>
                    </section>
                  )}

                  {data.aiReview.recommendationRationale && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-slate-700">
                        Why this recommendation
                      </h3>
                      <p className="text-sm text-slate-700">
                        {data.aiReview.recommendationRationale}
                      </p>
                    </section>
                  )}

                  {data.aiReview.technicalSummary && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-slate-700">Technical detail</h3>
                      <p className="whitespace-pre-line text-sm text-slate-700">
                        {data.aiReview.technicalSummary}
                      </p>
                    </section>
                  )}

                  {data.aiReview.beginnerExplanation && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-slate-700">In plain terms</h3>
                      <p className="whitespace-pre-line text-sm text-slate-700">
                        {data.aiReview.beginnerExplanation}
                      </p>
                    </section>
                  )}

                  {data.aiReview.reviewerChecklist &&
                    data.aiReview.reviewerChecklist.length > 0 && (
                      <section>
                        <h3 className="mb-1 text-xs font-semibold text-slate-700">Checklist</h3>
                        <ul className="space-y-1">
                          {data.aiReview.reviewerChecklist.map((item) => (
                            <li key={item.item} className="flex items-start gap-2">
                              <Badge
                                tone={item.status === 'LIKELY_SATISFIED' ? 'success' : 'warning'}
                              >
                                {item.status === 'LIKELY_SATISFIED' ? 'ok' : 'check'}
                              </Badge>
                              <span className="text-xs text-slate-700">{item.item}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                  {data.aiReview.openQuestions && data.aiReview.openQuestions.length > 0 && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-slate-700">Open questions</h3>
                      <ul className="space-y-0.5">
                        {data.aiReview.openQuestions.map((question) => (
                          <li key={question} className="text-xs text-slate-600">
                            · {question}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </CardBody>
              </Card>
            )}

            {!data.aiReview && data.summary && (
              <Card>
                <CardHeader title="Summary" />
                <CardBody>
                  <p className="text-sm text-slate-700">{data.summary}</p>
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Findings"
                subtitle={`${data.findingSummary.new} new of ${data.findingSummary.total} total`}
                actions={
                  <Badge tone="outline">
                    blocking at {data.findingSummary.blockingSeverity.toLowerCase()}
                  </Badge>
                }
              />

              <div className="flex flex-wrap gap-2 border-b border-surface-border px-4 py-2">
                {SEVERITY_ORDER.map((severity) => {
                  const count = data.findingSummary.bySeverity[severity] ?? 0;
                  if (count === 0) return null;

                  return (
                    <span key={severity} className="flex items-center gap-1">
                      <SeverityBadge severity={severity as Severity} />
                      <span className="numeric text-xs text-slate-600">{count}</span>
                    </span>
                  );
                })}
              </div>

              {data.findings.length === 0 ? (
                <CardBody>
                  <p className="text-xs text-slate-500">
                    {data.scope === 'SUMMARY'
                      ? 'This link shares summary counts only. Individual findings are not included.'
                      : 'No findings were reported.'}
                  </p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-surface-border">
                  {/*
                    Sorted most-severe-first here rather than trusting the payload order. The API
                    orders by `severity: desc`, but Prisma sorts enums by declaration position, and
                    Severity is declared CRITICAL-first — so `desc` yields INFO first. A screenshot
                    review caught the shared page listing MEDIUM above CRITICAL, which inverts the
                    one thing a shared review is meant to communicate.
                  */}
                  {sortBySeverity(data.findings).map((finding, index) => (
                    <li key={`${finding.ruleId}-${index}`} className="px-4 py-2.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <SeverityBadge severity={finding.severity} />
                        <code className="rounded bg-surface-muted px-1 py-0.5 text-xs text-slate-700">
                          {finding.ruleId}
                        </code>
                        {finding.preexisting && <Badge tone="neutral">pre-existing</Badge>}
                      </div>
                      {finding.path && (
                        <p className="mt-1 font-mono text-xs text-slate-500">
                          {finding.path}
                          {finding.line ? `:${finding.line}` : ''}
                        </p>
                      )}
                      <p className="mt-1 text-sm text-slate-700">{finding.message}</p>
                      {finding.snippet && (
                        <pre className="mt-1.5 overflow-x-auto rounded bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100">
                          <code>{finding.snippet}</code>
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-3">
            {data.risk && (
              <Card>
                <CardHeader title="Risk" actions={<RiskBadge level={data.risk.level} />} />
                <CardBody className="space-y-3">
                  <div>
                    <span className="numeric text-3xl font-semibold tracking-tight text-slate-900">
                      {data.risk.score}
                      <span className="text-base font-normal text-slate-400">/100</span>
                    </span>
                    <div className="mt-2">
                      <RiskMeter score={data.risk.score} level={data.risk.level} />
                    </div>
                  </div>

                  {data.risk.isBaseline && (
                    <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                      Produced by a heuristic baseline rather than a trained model.
                    </p>
                  )}

                  <dl className="divide-y divide-surface-border border-y border-surface-border">
                    <Field label="Confidence">{Math.round(data.risk.confidence * 100)}%</Field>
                    <Field label="Predicted review time">
                      {minutes(data.risk.predictedReviewTimeMinutes)}
                    </Field>
                  </dl>

                  {data.risk.reasons.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-semibold text-slate-700">Why</p>
                      <ul className="space-y-1">
                        {data.risk.reasons.slice(0, 6).map((reason) => (
                          <li key={reason.feature} className="text-xs">
                            <span className="font-medium text-slate-800">{reason.label}</span>
                            <span className="text-slate-500"> — {reason.explanation}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader title="Human review" />
              <CardBody>
                <dl className="divide-y divide-surface-border">
                  <Field label="Approvals">{data.verdicts.approvals}</Field>
                  <Field label="Changes requested">{data.verdicts.changesRequested}</Field>
                  <Field label="Needs discussion">{data.verdicts.needsDiscussion}</Field>
                </dl>

                {data.verdicts.reviewers.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {data.verdicts.reviewers.map((reviewer) => (
                      <li key={`${reviewer.name}-${reviewer.at}`} className="flex justify-between gap-2">
                        {/* Names only. The share payload has no ids or email addresses to leak. */}
                        <span className="truncate text-xs text-slate-700">{reviewer.name}</span>
                        <Badge tone={reviewer.verdict === 'APPROVED' ? 'success' : 'danger'}>
                          {reviewer.verdict.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {data.ragContext && (
              <Card>
                <CardHeader title="Repository context" />
                <CardBody>
                  <p className="text-xs text-slate-600">
                    {data.ragContext.chunkCount} chunk(s) retrieved from{' '}
                    {data.ragContext.files.length} file(s).
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {data.ragContext.files.slice(0, 8).map((file) => (
                      <li key={file} className="truncate font-mono text-xs text-slate-500">
                        {file}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}
          </div>
        </div>

        {data.degradation.length > 0 && (
          <Card>
            <CardHeader title="Limitations of this review" />
            <CardBody>
              <ul className="space-y-1">
                {data.degradation.map((note) => (
                  <li key={note} className="text-xs text-slate-600">
                    · {note}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>
    </Shell>
  );
}

/** Most severe first, then by file and line so repeat renders are stable. */
function sortBySeverity<T extends { severity: Severity; path: string | null; line: number | null }>(
  findings: T[],
): T[] {
  return [...findings].sort((left, right) => {
    const bySeverity =
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity);
    if (bySeverity !== 0) return bySeverity;

    const byPath = (left.path ?? '').localeCompare(right.path ?? '');
    if (byPath !== 0) return byPath;

    return (left.line ?? 0) - (right.line ?? 0);
  });
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="border-b border-surface-border bg-white px-4 py-2.5">
        <div className="mx-auto flex max-w-[1400px] items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[0.625rem] font-bold text-white">
            CL
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            CodeLens Enterprise
          </span>
          <span className="ml-auto text-xs text-slate-500">Shared review</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-4">{children}</main>
    </div>
  );
}
