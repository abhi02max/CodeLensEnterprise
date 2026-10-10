'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '@/components/ui/primitives';
import { DecisionWorkspace } from '@/components/workspace/decision-workspace';
import { AiReviewPanel } from '@/components/workspace/ai-review-panel';
import { CommentsPanel, type DraftAnchor } from '@/components/workspace/comments-panel';
import { ContextPanel } from '@/components/workspace/context-panel';
import { ConversationPanel } from '@/components/workspace/conversation-panel';
import { RiskPanel } from '@/components/workspace/risk-panel';
import { ToolRunsPanel } from '@/components/workspace/tool-runs-panel';
import { ReviewWorkspace } from '@/components/workspace/review-workspace';
import { CandidateWorkspace } from '@/components/workspace/candidate-workspace';
import '@/components/workspace/review-workspace.css';
import '@/components/workspace/candidate-workspace.css';
import '@/components/workspace/decision-workspace.css';
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
  const [decisionPin, setDecisionPin] = React.useState<{ sessionId: string; head: string } | null>(
    null,
  );
  const session = useQuery({
    queryKey: ['review-session', sessionId],
    queryFn: () => api.session_(sessionId),
  });
  const prId = session.data?.pullRequestId;
  React.useEffect(() => {
    if (session.data)
      setDecisionPin((pin) =>
        pin?.sessionId === sessionId ? pin : { sessionId, head: session.data!.pullRequest.headSha },
      );
  }, [sessionId, session.data]);
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
              : mode === 'Decision'
                ? 'review-support-layout decision-support-layout'
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
            <DecisionWorkspace
              session={data}
              target={
                detail.data && !detail.isError
                  ? {
                      id: detail.data.id,
                      repositoryId: detail.data.repository.id,
                      headSha: detail.data.headSha,
                    }
                  : undefined
              }
              currentUserId={user?.id ?? null}
              refresh={refresh}
              initialReviewedHead={
                decisionPin?.sessionId === sessionId ? decisionPin.head : undefined
              }
              onReviewedHead={(head) => setDecisionPin({ sessionId, head })}
              auditAllowed={role === 'ADMIN' || role === 'OWNER'}
            />
          )}
        </div>
      )}
    />
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
