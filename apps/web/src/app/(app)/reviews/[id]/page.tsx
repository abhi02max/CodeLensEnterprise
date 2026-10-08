'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { AnalyzeButton } from '@/components/analyze-button';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { ActivityPanel } from '@/components/workspace/activity-panel';
import { AiReviewPanel } from '@/components/workspace/ai-review-panel';
import { CommentsPanel, type DraftAnchor } from '@/components/workspace/comments-panel';
import { ContextPanel } from '@/components/workspace/context-panel';
import { ConversationPanel } from '@/components/workspace/conversation-panel';
import { GatePanel } from '@/components/workspace/gate-panel';
import { RiskPanel } from '@/components/workspace/risk-panel';
import { SharePanel } from '@/components/workspace/share-panel';
import { ToolRunsPanel } from '@/components/workspace/tool-runs-panel';
import { ReviewWorkspace } from '@/components/workspace/review-workspace';
import { CandidateWorkspace } from '@/components/workspace/candidate-workspace';
import '@/components/workspace/review-workspace.css';
import '@/components/workspace/candidate-workspace.css';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { duration, relativeTime, shortSha } from '@/lib/format';
import { useSession } from '@/lib/providers';
import { reviewsHref } from '@/lib/review-inbox';

export default function ReviewWorkspacePage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const queryClient = useQueryClient();
  const { user, role } = useSession();
  const [anchor, setAnchor] = React.useState<DraftAnchor | null>(null);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const session = useQuery({
    queryKey: ['review-session', sessionId],
    queryFn: () => api.session_(sessionId),
  });
  const prId = session.data?.pullRequestId;
  const detail = useQuery({
    queryKey: ['workspace-pr', prId],
    queryFn: async () => {
      const { id, repository, headSha, baseSha, diffRevision } = await api.pullRequest(prId!);
      return { id, repository, headSha, baseSha, diffRevision };
    },
    enabled: Boolean(prId),
    refetchOnWindowFocus: false,
  });
  const diff = useQuery({
    queryKey: ['workspace-diff', prId],
    queryFn: () => api.pullRequestDiff(prId!),
    enabled: Boolean(prId),
    refetchOnWindowFocus: false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['workspace-pr', prId] });
    void queryClient.invalidateQueries({ queryKey: ['workspace-diff', prId] });
  };
  if (session.error) {
    const error = session.error as ApiError;
    return (
      <Alert
        tone={error.status === 404 ? 'warning' : 'danger'}
        title={error.status === 404 ? 'Review unavailable' : 'Could not load the review'}
      >
        <p>{error.message}</p>
        <Button size="sm" onClick={() => void session.refetch()}>
          Retry review read
        </Button>
        <Link className="ml-3 underline" href={reviewsHref()}>
          Back to Reviews
        </Link>
      </Alert>
    );
  }
  const data = session.data;
  if (!data)
    return (
      <div role="status" aria-label="Loading review">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="mt-3 h-96 w-full" />
      </div>
    );
  return (
    <ReviewWorkspace
      key={sessionId}
      session={data}
      detail={detail.data}
      diff={diff.data}
      diffLoading={detail.isPending || diff.isPending}
      diffError={detail.isError || diff.isError}
      refresh={refresh}
      conversationId={conversationId}
      selectConversation={setConversationId}
      discuss={(finding) => {
        const f = finding.staticFinding;
        if (f)
          setAnchor({
            path: f.path ?? '',
            line: f.line ?? 1,
            findingFingerprint: f.fingerprint,
            ruleId: f.ruleId,
          });
      }}
      support={(mode) => (
        <div
          className={
            mode === 'Candidates'
              ? 'review-support-layout candidate-support-layout'
              : 'review-support-layout'
          }
        >
          {mode === 'Candidates' && (
            <CandidateWorkspace
              key={sessionId}
              session={data}
              conversationId={conversationId}
              selectConversation={setConversationId}
            />
          )}
          {mode === 'Discussion' && (
            <>
              <CommentsPanel
                sessionId={sessionId}
                comments={data.comments}
                canComment={data.permissions.canComment}
                canModerate={data.permissions.canModerateComments}
                currentUserId={user?.id ?? null}
                draftAnchor={anchor}
                onClearAnchor={() => setAnchor(null)}
              />
              <ConversationPanel
                key={sessionId}
                sessionId={sessionId}
                context={data}
                controlledId={conversationId}
                onSelectConversation={setConversationId}
              />
            </>
          )}
          {mode === 'Analysis' && (
            <>
              {data.run && (
                <section
                  aria-label="Recorded analysis provenance"
                  className="text-xs text-content-secondary"
                >
                  <h2 className="font-semibold">Recorded analysis</h2>
                  <p>
                    {data.run.status} / {data.run.stage.replace(/_/g, ' ')} / head{' '}
                    {shortSha(data.run.headSha)} / {duration(data.run.durationMs)} / finished{' '}
                    {relativeTime(data.run.finishedAt)}
                  </p>
                  <p>
                    Capabilities:{' '}
                    {Object.entries(data.run.capabilities)
                      .map(
                        ([name, available]) =>
                          `${name}: ${available ? 'available' : 'unavailable'}`,
                      )
                      .join(' / ')}
                  </p>
                </section>
              )}
              {data.run?.status === 'FAILED' && (
                <Alert tone="danger" title="Analysis failed">
                  {data.run.error ?? 'See the recorded tool outcomes for available evidence.'}
                </Alert>
              )}
              {data.run?.stale && (
                <Alert tone="warning" title="Analysis is out of date">
                  Recorded analysis head {shortSha(data.run.headSha)} differs from the PR head.
                </Alert>
              )}
              {!data.analyzed && (
                <Alert tone="info" title="Not analysed yet">
                  No analysis evidence is available for this review.
                </Alert>
              )}
              {data.analyzed && (
                <AiReviewPanel
                  aiReview={data.aiReview}
                  status={data.aiReviewStatus}
                  canRetry={data.permissions.canTriggerAnalysis}
                  retryAction={
                    <AnalyzeButton
                      pullRequestId={data.pullRequestId}
                      size="sm"
                      label="Re-run analysis"
                      onComplete={refresh}
                    />
                  }
                />
              )}
              {data.analyzed && <RiskPanel risk={data.risk} />}
              {data.metrics && <MetricsPanel metrics={data.metrics} />}
              {data.analyzed && <ContextPanel context={data.ragContext} />}
              {data.analyzed && <ToolRunsPanel toolRuns={data.toolRuns} />}
              {data.analyzed && data.degradation.length > 0 && (
                <Alert tone="warning" title="Unavailable in this run">
                  <ul>
                    {data.degradation.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          )}
          {mode === 'Decision' && (
            <>
              <GatePanel gate={data.gate} />
              <VerdictPanel sessionId={sessionId} session={data} />
              <SharePanel
                sessionId={sessionId}
                shareLinks={data.shareLinks}
                permissions={data.permissions}
              />
              {(role === 'ADMIN' || role === 'OWNER') && (
                <ActivityPanel title="Recent organization activity" limit={6} />
              )}
            </>
          )}
        </div>
      )}
    />
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
  const [headChanged, setHeadChanged] = React.useState(false);

  const onError = (caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Could not submit the verdict');
    setHeadChanged(caught instanceof ApiError && caught.status === 409);
  };

  const refresh = () => {
    setSummary('');
    void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['pull-requests'] });
  };

  const approve = useMutation({
    mutationFn: () =>
      api.approve(sessionId, session.pullRequest.headSha, summary.trim() || undefined),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });

  const requestChanges = useMutation({
    mutationFn: () =>
      api.requestChanges(sessionId, session.pullRequest.headSha, summary.trim() || undefined),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });

  const refreshReview = useMutation({
    mutationFn: () =>
      queryClient.invalidateQueries(
        { queryKey: ['review-session', sessionId] },
        { throwOnError: true },
      ),
    onMutate: () => setSummary(''),
    onSuccess: () => {
      setError(null);
      setHeadChanged(false);
    },
    onError: () => setError('Could not refresh the review. Try again before submitting a verdict.'),
  });

  const { permissions } = session;
  const busy = approve.isPending || requestChanges.isPending || refreshReview.isPending;

  return (
    <Card>
      <CardHeader
        title="Your verdict"
        subtitle={`Applies to ${shortSha(session.pullRequest.headSha)}`}
      />
      <CardBody className="space-y-2.5">
        <p className="text-xs text-slate-500">
          This verdict concerns the PR head, not the isolated candidate. Accepting or validating a
          proposal does not change the PR branch.
        </p>
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
            {headChanged && (
              <Button disabled={busy} onClick={() => refreshReview.mutate()}>
                Refresh review
              </Button>
            )}

            <div className="flex gap-2">
              <Button
                variant="approve"
                className="flex-1"
                loading={approve.isPending}
                disabled={!permissions.canApprove || busy || headChanged}
                title={permissions.deniedReasons.canApprove}
                onClick={() => approve.mutate()}
              >
                Approve
              </Button>
              <Button
                variant="reject"
                className="flex-1"
                loading={requestChanges.isPending}
                disabled={!permissions.canRequestChanges || busy || headChanged}
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
            <span
              className={metrics.complexityDelta > 0 ? 'ml-1 text-risk-high' : 'ml-1 text-risk-low'}
            >
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
