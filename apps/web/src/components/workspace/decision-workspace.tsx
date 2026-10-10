'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Label, Select, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { absoluteTime, shortSha } from '@/lib/format';
import {
  canDecide,
  currentAnalysis,
  currentVerdict,
  decisionReady,
  verdictLabels,
  actionFence,
  safeActionError,
  type WritableVerdict,
} from '@/lib/review-decision';
import type { ReviewSession } from '@/lib/types';
import { ReviewConfirmation } from './review-confirmation';
import { SharePanel } from './share-panel';

export function DecisionEvidence({ session }: { session: ReviewSession }) {
  const ready = currentAnalysis(session);
  return (
    <section aria-label="Decision evidence" className="decision-evidence">
      <h3>Recorded evidence</h3>
      {!ready ? (
        <Alert tone="warning">
          Current-head completed analysis is unavailable. Historical or partial analysis is not a
          clean result.
        </Alert>
      ) : (
        <dl>
          <div>
            <dt>Static / deterministic findings</dt>
            <dd>
              {session.findings.length} recorded;{' '}
              {session.findings.filter((f) => !f.preexisting).length} new to the analysis baseline.{' '}
              {session.findings.filter((f) => f.severity === 'CRITICAL').length} critical /{' '}
              {session.findings.filter((f) => f.severity === 'HIGH').length} high.
            </dd>
          </div>
          <div>
            <dt>Advisory ML</dt>
            <dd>
              {session.risk
                ? `${session.risk.score}/100 / ${session.risk.level} / ${session.risk.modelName} ${session.risk.modelVersion}`
                : 'Unavailable; no score inferred.'}
            </dd>
          </div>
          <div>
            <dt>Recorded AI review</dt>
            <dd>
              {session.aiReview
                ? `${session.aiReview.provider} / ${session.aiReview.model}; advisory, not human approval.`
                : `${session.aiReviewStatus.state}; no AI agreement inferred.`}
            </dd>
          </div>
          <div>
            <dt>Retrieved context</dt>
            <dd>
              {session.ragContext.chunkCount} recorded chunks; indexed context does not prove exact
              source applicability.
            </dd>
          </div>
        </dl>
      )}
      <p>
        Investigation, conversation and candidate evidence remain in their scoped views. No
        candidate is inferred as the decision target. This summary is not exhaustive.
      </p>
    </section>
  );
}

export function DecisionHistory({
  session,
  auditAllowed = false,
}: {
  session: ReviewSession;
  auditAllowed?: boolean;
}) {
  const [limit, setLimit] = React.useState(10);
  const rows = session.reviews.filter(
    (r) => !r.pullRequestId || r.pullRequestId === session.pullRequestId,
  );
  return (
    <section aria-label="Review decision history" className="decision-history">
      <h2>Review decision history</h2>
      <p>
        Recorded verdict rows, newest creation first. Same-reviewer, same-head updates replace the
        row; this is not a complete immutable audit trail.
      </p>
      {rows.length !== session.reviews.length && (
        <Alert tone="warning">Mismatched review records withheld.</Alert>
      )}
      {!rows.length ? (
        <p>No verdict rows returned by this review read.</p>
      ) : (
        <ol>
          {rows.slice(0, limit).map((review) => (
            <li key={review.id}>
              <div className="decision-history-heading">
                <h3>{verdictLabels[review.verdict]}</h3>
                <Badge tone={currentVerdict(review, session) ? 'neutral' : 'warning'}>
                  {currentVerdict(review, session) ? 'Known-head record' : 'Historical / stale'}
                </Badge>
              </div>
              <p>
                {review.reviewer?.name || 'Reviewer unavailable'} / created{' '}
                <time dateTime={review.createdAt}>{absoluteTime(review.createdAt)}</time>
              </p>
              <p>
                Recorded revision <code>{review.headSha || 'Unavailable'}</code>
              </p>
              {review.updatedAt && (
                <p>
                  Row updated{' '}
                  <time dateTime={review.updatedAt}>{absoluteTime(review.updatedAt)}</time>
                </p>
              )}
              <p className="decision-rationale">{review.summary || 'No rationale recorded.'}</p>
            </li>
          ))}
        </ol>
      )}
      <p>
        {Math.min(limit, rows.length)} of {rows.length} returned records. The existing endpoint is
        not paginated.
      </p>
      {limit < rows.length && (
        <Button onClick={() => setLimit((n) => n + 10)}>Show more recorded decisions</Button>
      )}
      {auditAllowed && <Link href="/activity">Organization history</Link>}
      <p>
        Organization audit access requires ADMIN or OWNER; it is separate from this verdict list.
      </p>
    </section>
  );
}

export function DecisionWorkspace({
  session,
  target,
  currentUserId,
  refresh,
  auditAllowed = false,
  initialReviewedHead,
  onReviewedHead,
}: {
  session: ReviewSession;
  target: { id: string; repositoryId: string; headSha: string } | undefined;
  currentUserId: string | null;
  refresh: () => void;
  auditAllowed?: boolean;
  initialReviewedHead?: string;
  onReviewedHead?: (head: string) => void;
}) {
  const [section, setSection] = React.useState<'Review' | 'History' | 'Sharing'>('Review');
  return (
    <div className="decision-workspace">
      <nav aria-label="Decision sections" className="decision-actions">
        {(['Review', 'History', 'Sharing'] as const).map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            aria-pressed={section === name}
            onClick={() => setSection(name)}
          >
            {name}
          </Button>
        ))}
      </nav>
      <div hidden={section !== 'Review'}>
        <HumanVerdict
          key={session.pullRequestId}
          active={section === 'Review'}
          session={session}
          target={target}
          currentUserId={currentUserId}
          refresh={refresh}
          initialReviewedHead={initialReviewedHead}
          onReviewedHead={onReviewedHead}
        />
      </div>
      {section === 'History' && <DecisionHistory session={session} auditAllowed={auditAllowed} />}
      {section === 'Sharing' && (
        <SharePanel
          key={session.pullRequestId}
          sessionId={session.pullRequestId}
          shareLinks={session.shareLinks}
          permissions={session.permissions}
        />
      )}
    </div>
  );
}

export function HumanVerdict({
  session,
  target,
  currentUserId,
  refresh,
  active = true,
  initialReviewedHead,
  onReviewedHead,
}: {
  session: ReviewSession;
  target: { id: string; repositoryId: string; headSha: string } | undefined;
  currentUserId: string | null;
  refresh: () => void;
  active?: boolean;
  initialReviewedHead?: string;
  onReviewedHead?: (head: string) => void;
}) {
  const client = useQueryClient();
  const [reviewedHead, setReviewedHead] = React.useState(
    initialReviewedHead ?? session.pullRequest.headSha,
  );
  const [verdict, setVerdict] = React.useState<WritableVerdict>('CHANGES_REQUESTED');
  const [summary, setSummary] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  const [freshRead, setFreshRead] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const fence = React.useRef(actionFence()).current;
  const ready = active && decisionReady(session, target, reviewedHead) && !conflict;
  const allowed = !!currentUserId && canDecide(session, verdict);
  const valid = summary.trim().length <= 10000;
  React.useEffect(() => {
    setConfirmed(false);
    setSummary('');
    setSuccess(null);
  }, [session.pullRequest.headSha, target?.headSha]);
  React.useEffect(() => {
    if (!active) setConfirmed(false);
  }, [active]);
  const reread = useMutation({
    retry: false,
    mutationFn: async () => {
      setFreshRead(false);
      const read = await api.session_(session.pullRequestId);
      if (
        read.pullRequestId !== session.pullRequestId ||
        read.sessionId !== session.sessionId ||
        read.repository.id !== session.repository.id
      )
        throw new Error('Read scope mismatch');
      client.setQueryData(['review-session', session.sessionId], read);
      refresh();
      setFreshRead(true);
    },
    onError: () => {
      setFreshRead(false);
      setError('Could not refresh the review. Decisions remain blocked until a successful read.');
      setConflict(true);
    },
  });
  const submit = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!ready || !allowed || !valid) throw new Error('Decision unavailable');
      const result =
        verdict === 'APPROVED'
          ? await api.approve(session.pullRequestId, reviewedHead, summary.trim() || undefined)
          : await api.requestChanges(
              session.pullRequestId,
              reviewedHead,
              summary.trim() || undefined,
            );
      if (
        result.review.headSha !== reviewedHead ||
        result.review.verdict !== verdict ||
        result.review.reviewer.id !== currentUserId ||
        (result.review.pullRequestId && result.review.pullRequestId !== session.pullRequestId)
      )
        throw new Error('Decision readback mismatch');
      return { headSha: result.review.headSha, verdict: result.review.verdict };
    },
  });
  const send = async () => {
    if (!confirmed || !ready || !allowed || !valid || !fence.acquire()) return;
    setError(null);
    setSuccess(null);
    try {
      const result = await submit.mutateAsync();
      setSuccess(
        `${verdictLabels[result.verdict]} recorded in CodeLens at ${shortSha(result.headSha)}. No GitHub review was submitted.`,
      );
      setSummary('');
      refresh();
      void client.invalidateQueries({ queryKey: ['pull-requests'] });
    } catch (caught) {
      setError(safeActionError(caught, 'Submit verdict'));
      setConflict(true);
      setFreshRead(false);
    } finally {
      setConfirmed(false);
      fence.release();
    }
  };
  const own = session.reviews.filter(
    (r) => r.reviewer?.id === currentUserId && currentVerdict(r, session),
  );
  return (
    <section aria-label="Human PR decision" className="decision-review">
      <header>
        <h2>Human PR decision</h2>
        <p>
          {session.repository.fullName} / #{session.pullRequest.number} /{' '}
          {session.pullRequest.title}
        </p>
      </header>
      <dl className="decision-identity">
        <div>
          <dt>Known persisted head</dt>
          <dd>
            <code>{session.pullRequest.headSha}</code>
          </dd>
        </div>
        <div>
          <dt>Reviewed decision target</dt>
          <dd>
            <code>{reviewedHead}</code>
          </dd>
        </div>
      </dl>
      <p>
        No live remote GitHub freshness is verified by this read. This verdict concerns the PR head,
        not the isolated candidate. Proposal acceptance or validation does not approve the PR.
      </p>
      {own.map((r) => (
        <p key={r.id}>
          Your recorded decision: {verdictLabels[r.verdict]} /{' '}
          {absoluteTime(r.updatedAt ?? r.createdAt)}
        </p>
      ))}
      {!ready && (
        <Alert tone="warning" title="Decision target unavailable or changed">
          Review the known head again before confirming a verdict. Server checks remain
          authoritative.
        </Alert>
      )}
      <Button
        size="sm"
        disabled={submit.isPending || reread.isPending}
        onClick={() => void reread.mutateAsync().catch(() => undefined)}
      >
        Refresh review read
      </Button>
      {target &&
        target.id === session.pullRequestId &&
        target.repositoryId === session.repository.id &&
        target.headSha === session.pullRequest.headSha &&
        !session.pullRequest.merged &&
        (!ready || conflict) && (
          <Button
            size="sm"
            disabled={submit.isPending || reread.isPending || (conflict && !freshRead)}
            onClick={() => {
              setReviewedHead(session.pullRequest.headSha);
              onReviewedHead?.(session.pullRequest.headSha);
              setConflict(false);
              setFreshRead(false);
              setSummary('');
              setError(null);
              setConfirmed(false);
            }}
          >
            I reviewed this persisted head
          </Button>
        )}
      <div className="decision-grid">
        <div>
          <DecisionEvidence session={session} />
          <section aria-label="Recorded CodeLens gate">
            <h3>Recorded CodeLens gate</h3>
            <p>
              {session.gate.readyToMerge
                ? 'Policy requirements satisfied in this read'
                : 'Policy requirements not satisfied'}{' '}
              / {session.gate.currentApprovals} of {session.gate.requiredApprovals} approvals
            </p>
            <ul>
              {session.gate.blockingReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
            <h4>Advisory warnings</h4>
            <ul>
              {session.gate.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
            <p>This gate does not merge or deploy code.</p>
          </section>
        </div>
        <div>
          <Label htmlFor="pr-verdict">CodeLens verdict</Label>
          <Select
            id="pr-verdict"
            value={verdict}
            disabled={submit.isPending}
            onChange={(e) => {
              setVerdict(e.target.value as WritableVerdict);
              setConfirmed(false);
              setSuccess(null);
            }}
          >
            <option value="CHANGES_REQUESTED" disabled={!session.permissions.canRequestChanges}>
              Request changes
            </option>
            <option value="APPROVED" disabled={!session.permissions.canApprove}>
              Approve in CodeLens
            </option>
          </Select>
          <p>
            {session.permissions.deniedReasons[
              verdict === 'APPROVED' ? 'canApprove' : 'canRequestChanges'
            ] ||
              (!currentUserId
                ? 'Authenticated reviewer identity unavailable.'
                : 'The server will recheck your permission and the expected head.')}
          </p>
          <Label htmlFor="verdict-summary">Verdict summary (optional)</Label>
          <Textarea
            id="verdict-summary"
            rows={4}
            value={summary}
            disabled={submit.isPending || !allowed}
            aria-invalid={!valid || undefined}
            aria-describedby="verdict-summary-limit"
            onChange={(e) => {
              setSummary(e.target.value);
              setConfirmed(false);
            }}
          />
          <p id="verdict-summary-limit">
            {summary.trim().length}/10000 characters.{' '}
            {valid ? '' : 'Summary exceeds the supported limit.'}
          </p>
          {error && <Alert>{error}</Alert>}
          {success && <Alert tone="success">{success}</Alert>}
          <Button
            variant="primary"
            disabled={!ready || !allowed || !valid || submit.isPending}
            onClick={() => {
              setError(null);
              setConfirmed(true);
            }}
          >
            Review verdict
          </Button>
          <p>
            Submitting records or revises your head-bound CodeLens verdict. It does not approve on
            GitHub, apply a patch, merge, deploy or guarantee safety.
          </p>
        </div>
      </div>
      <ReviewConfirmation
        open={confirmed && ready && allowed}
        title="Submit verdict"
        busy={submit.isPending}
        close={() => setConfirmed(false)}
        confirm={() => void send()}
      >
        <p>
          {verdict === 'APPROVED' ? 'Approve in CodeLens' : 'Request changes'} for{' '}
          {session.repository.fullName} #{session.pullRequest.number}.
        </p>
        <p>
          Expected persisted head <code>{reviewedHead}</code>
        </p>
        <p className="decision-rationale">{summary.trim() || 'No summary supplied.'}</p>
        <p>
          This may update your existing same-head verdict row. No GitHub review, repository write or
          merge occurs.
        </p>
      </ReviewConfirmation>
    </section>
  );
}
