'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { AnalyzeButton } from '@/components/analyze-button';
import { RiskBadge, RunStatusBadge } from '@/components/risk';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { ActivityPanel } from '@/components/workspace/activity-panel';
import { AiReviewPanel } from '@/components/workspace/ai-review-panel';
import { CommentsPanel, type DraftAnchor } from '@/components/workspace/comments-panel';
import { ContextPanel } from '@/components/workspace/context-panel';
import { FindingsPanel } from '@/components/workspace/findings-panel';
import { GatePanel } from '@/components/workspace/gate-panel';
import { RiskPanel } from '@/components/workspace/risk-panel';
import { SharePanel } from '@/components/workspace/share-panel';
import { ToolRunsPanel } from '@/components/workspace/tool-runs-panel';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { duration, relativeTime, shortSha } from '@/lib/format';
import { useSession } from '@/lib/providers';
import type { FindingView } from '@/lib/types';

/**
 * The review workspace. This is the screen the product exists to show.
 *
 * Everything comes from one request: `GET /review-sessions/:id` returns the pull request, the
 * latest run, risk, findings, retrieved context, tool provenance, verdicts, threads, share links
 * and the caller's permissions together. Fetching those separately would make the page assemble
 * itself in visible stages, with the merge gate — the most decision-relevant part — arriving last.
 */
export default function ReviewWorkspacePage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const queryClient = useQueryClient();
  const { user } = useSession();

  const [anchor, setAnchor] = React.useState<DraftAnchor | null>(null);

  const session = useQuery({
    queryKey: ['review-session', sessionId],
    queryFn: () => api.session_(sessionId),
  });

  const data = session.data;
  const error = session.error as ApiError | null;

  if (error) {
    return (
      <Alert
        tone={error.code === 'NETWORK_ERROR' ? 'warning' : 'danger'}
        title={
          error.status === 404
            ? 'Review session not found'
            : error.code === 'NETWORK_ERROR'
              ? 'API unreachable'
              : 'Could not load the review'
        }
      >
        <p>{error.message}</p>
        {error.traceId && (
          <p className="mt-1 font-mono text-[0.6875rem] opacity-70">trace {error.traceId}</p>
        )}
        <Link href="/pull-requests" className="mt-2 inline-block text-xs underline">
          Back to pull requests
        </Link>
      </Alert>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-3 xl:grid-cols-3">
          <Skeleton className="h-64 xl:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const { pullRequest, repository, permissions } = data;

  return (
    <div className="space-y-3">
      {/* ---------------------------------------------------------------- header */}
      <div className="rounded-lg border border-surface-border bg-white px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <Link href="/repositories" className="hover:underline">
                {repository.fullName}
              </Link>
              <span aria-hidden="true">/</span>
              <span className="numeric">#{pullRequest.number}</span>
              {pullRequest.draft && <Badge tone="neutral">draft</Badge>}
              <Badge tone="outline">{pullRequest.state.toLowerCase()}</Badge>
            </div>

            <h1 className="mt-1 text-lg font-semibold leading-snug tracking-tight text-slate-900">
              {pullRequest.title}
            </h1>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>{pullRequest.author.login}</span>
              <span className="font-mono">
                {pullRequest.headRef}
                <span className="text-slate-400"> → {pullRequest.baseRef}</span>
              </span>
              <span className="font-mono">{shortSha(pullRequest.headSha)}</span>
              <span className="numeric">
                +{pullRequest.additions} −{pullRequest.deletions} · {pullRequest.changedFiles} file
                {pullRequest.changedFiles === 1 ? '' : 's'} · {pullRequest.commitCount} commit
                {pullRequest.commitCount === 1 ? '' : 's'}
              </span>
              <a
                href={pullRequest.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline hover:text-slate-800"
              >
                View on GitHub
              </a>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {data.risk && <RiskBadge level={data.risk.level} score={data.risk.score} />}
              {data.run && <RunStatusBadge status={data.run.status} />}
            </div>
            {permissions.canTriggerAnalysis && (
              <AnalyzeButton
                pullRequestId={sessionId}
                onComplete={() =>
                  void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] })
                }
              />
            )}
          </div>
        </div>

        {data.run && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-surface-border pt-2 text-xs text-slate-500">
            <span>stage {data.run.stage.replace(/_/g, ' ').toLowerCase()}</span>
            <span>{duration(data.run.durationMs)}</span>
            <span>finished {relativeTime(data.run.finishedAt)}</span>
            {data.run.triggeredBy && <span>by {data.run.triggeredBy.name}</span>}
            <CapabilityDots capabilities={data.run.capabilities} />
          </div>
        )}
      </div>

      {/* ---- stale analysis is called out loudly: approving against it would approve unreviewed code */}
      {data.run?.stale && (
        <Alert tone="warning" title="This analysis is out of date">
          It ran against {shortSha(data.run.headSha)} but the pull request head is now{' '}
          {shortSha(pullRequest.headSha)}. Re-run the analysis before relying on the findings below.
        </Alert>
      )}

      {!data.analyzed && (
        <Card>
          <EmptyState
            title="Not analysed yet"
            description="Run the review pipeline to produce findings, a risk score and repository context."
            action={
              permissions.canTriggerAnalysis ? (
                <AnalyzeButton
                  pullRequestId={sessionId}
                  onComplete={() =>
                    void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] })
                  }
                />
              ) : undefined
            }
          />
        </Card>
      )}

      {/* ---------------------------------------------------------------- body
          Panels whose only content comes from a run are omitted when there is no run. They used to
          render regardless, so an un-analysed pull request — PR #415 in the demo data is one click
          from the main path — showed the "Not analysed yet" call-out followed by four more cards
          each repeating that there is nothing to show. Discussion, the merge gate, the verdict
          controls, sharing and activity all work without a run, so those stay. */}
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          {data.analyzed && (
            <AiReviewPanel
              aiReview={data.aiReview}
              status={data.aiReviewStatus}
              canRetry={permissions.canTriggerAnalysis}
              onRetry={() => {
                void api.analyze(sessionId, true).then(() => {
                  void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
                });
              }}
            />
          )}

          {data.analyzed && (
            <FindingsPanel
              findings={data.findings}
              comments={data.comments}
              canComment={permissions.canComment}
              onDiscuss={(finding: FindingView) =>
                setAnchor({
                  path: finding.path ?? '',
                  line: finding.line ?? 1,
                  findingFingerprint: finding.fingerprint,
                  ruleId: finding.ruleId,
                })
              }
            />
          )}

          <CommentsPanel
            sessionId={sessionId}
            comments={data.comments}
            canComment={permissions.canComment}
            canModerate={permissions.canModerateComments}
            currentUserId={user?.id ?? null}
            draftAnchor={anchor}
            onClearAnchor={() => setAnchor(null)}
          />

          {data.analyzed && <ContextPanel context={data.ragContext} />}
        </div>

        {/*
          Sidebar order is status, then action, then evidence. The merge gate answers "can this
          ship" and so comes first; the verdict controls act on that answer; risk, metrics and
          pipeline explain it. Having the verdict buttons above the gate meant the first thing a
          reviewer saw was a control rather than the state it changes.
        */}
        <div className="space-y-3">
          <GatePanel gate={data.gate} />
          <VerdictPanel sessionId={sessionId} session={data} />
          {data.analyzed && <RiskPanel risk={data.risk} />}
          {data.metrics && <MetricsPanel metrics={data.metrics} />}
          {data.analyzed && <ToolRunsPanel toolRuns={data.toolRuns} />}
          <SharePanel
            sessionId={sessionId}
            shareLinks={data.shareLinks}
            permissions={permissions}
          />
          <ActivityPanel title="Recent activity" limit={6} />
        </div>
      </div>

      {/* Guarded on `analyzed` too: with no run there is nothing to have degraded, and the one entry
          the API returns in that case ("has not been analysed yet") is the same sentence the empty
          state and the merge gate already carry, under a heading that contradicts it. */}
      {data.analyzed && data.degradation.length > 0 && (
        <Card>
          <CardHeader title="Degraded in this run" subtitle="What was unavailable and why" />
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
  );
}

function CapabilityDots({
  capabilities,
}: {
  capabilities: { staticAnalysis: boolean; mlRisk: boolean; ragContext: boolean; aiReview: boolean };
}) {
  const entries: Array<[string, boolean]> = [
    ['static', capabilities.staticAnalysis],
    ['ml risk', capabilities.mlRisk],
    ['context', capabilities.ragContext],
    ['ai review', capabilities.aiReview],
  ];

  return (
    <span className="flex items-center gap-2">
      {entries.map(([label, ok]) => (
        <span key={label} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className={ok ? 'h-1.5 w-1.5 rounded-full bg-risk-low' : 'h-1.5 w-1.5 rounded-full bg-slate-300'}
          />
          <span className={ok ? 'text-slate-600' : 'text-slate-400 line-through'}>{label}</span>
        </span>
      ))}
    </span>
  );
}

function VerdictPanel({
  sessionId,
  session,
}: {
  sessionId: string;
  session: import('@/lib/types').ReviewSession;
}) {
  const queryClient = useQueryClient();
  const [summary, setSummary] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const refresh = () => {
    setSummary('');
    void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['pull-requests'] });
  };

  const approve = useMutation({
    mutationFn: () => api.approve(sessionId, summary.trim() || undefined),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not submit the verdict'),
  });

  const requestChanges = useMutation({
    mutationFn: () => api.requestChanges(sessionId, summary.trim() || undefined),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not submit the verdict'),
  });

  const { permissions } = session;
  const busy = approve.isPending || requestChanges.isPending;

  return (
    <Card>
      <CardHeader
        title="Your verdict"
        subtitle={`Applies to ${shortSha(session.pullRequest.headSha)}`}
      />
      <CardBody className="space-y-2.5">
        {session.reviews.length > 0 && (
          <ul className="space-y-1 border-b border-surface-border pb-2">
            {session.reviews.map((review) => (
              <li key={review.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-slate-700">{review.reviewer.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge
                    tone={
                      review.verdict === 'APPROVED'
                        ? 'success'
                        : review.verdict === 'CHANGES_REQUESTED'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {review.verdict.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                  {/* A verdict against an older commit no longer counts, so it is labelled. */}
                  {review.stale && <Badge tone="neutral">stale</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {permissions.canApprove || permissions.canRequestChanges ? (
          <>
            <Textarea
              rows={2}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Optional summary for your verdict"
              aria-label="Verdict summary"
            />

            {error && <Alert tone="danger">{error}</Alert>}

            <div className="flex gap-2">
              <Button
                variant="approve"
                className="flex-1"
                loading={approve.isPending}
                disabled={!permissions.canApprove || busy}
                title={permissions.deniedReasons.canApprove}
                onClick={() => approve.mutate()}
              >
                Approve
              </Button>
              <Button
                variant="reject"
                className="flex-1"
                loading={requestChanges.isPending}
                disabled={!permissions.canRequestChanges || busy}
                onClick={() => requestChanges.mutate()}
              >
                Request changes
              </Button>
            </div>

            {/*
              The reason approval is unavailable is shown rather than left as a dead button. The
              common case is being the author of the change, which is not obvious from a greyed
              control.
            */}
            {!permissions.canApprove && permissions.deniedReasons.canApprove && (
              <p className="text-xs text-slate-500">{permissions.deniedReasons.canApprove}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-slate-500">
            {permissions.deniedReasons.canApprove ??
              'Your role does not allow submitting a verdict on this pull request.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function MetricsPanel({ metrics }: { metrics: import('@/lib/types').MetricsView }) {
  const flags: Array<[string, boolean]> = [
    ['auth', metrics.authFileChanged],
    ['payment', metrics.paymentFileChanged],
    ['database', metrics.databaseFileChanged],
    ['infra', metrics.infraFileChanged],
    ['dependency', metrics.dependencyChanged],
  ];

  const active = flags.filter(([, on]) => on);

  return (
    <Card>
      <CardHeader title="Change metrics" />
      <CardBody>
        <dl className="divide-y divide-surface-border">
          <Field label="Lines">
            +{metrics.linesAdded} / −{metrics.linesDeleted}
          </Field>
          <Field label="Files changed">{metrics.filesChanged}</Field>
          <Field label="Complexity">
            {metrics.complexityBefore} → {metrics.complexityAfter}
            <span className={metrics.complexityDelta > 0 ? 'ml-1 text-risk-high' : 'ml-1 text-risk-low'}>
              ({metrics.complexityDelta >= 0 ? '+' : ''}
              {metrics.complexityDelta})
            </span>
          </Field>
          <Field label="Test files changed">{metrics.testFilesChanged}</Field>
          <Field label="Security findings">{metrics.securityFindingsCount}</Field>
          <Field label="Historically risky files">{metrics.previousRiskyFileCount}</Field>
        </dl>

        {active.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {active.map(([label]) => (
              <Badge key={label} tone="warning">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
