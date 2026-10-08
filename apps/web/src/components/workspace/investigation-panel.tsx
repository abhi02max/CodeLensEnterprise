'use client';

import * as React from 'react';
import type { EvidenceView, InvestigationResult } from '@codelens/shared';
import { Button } from '@/components/ui/primitives';
import { useSession } from '@/lib/providers';
import { shortSha } from '@/lib/format';
import { relatedReviewThreads, selectedConversationAnchor } from '@/lib/investigation-context';
import type { WorkspaceFinding } from '@/lib/review-workspace';
import type { ReviewSession } from '@/lib/types';
import { CommentsPanel } from './comments-panel';
import { ConversationPanel } from './conversation-panel';

export type InvestigationMode = 'Details' | 'Evidence' | 'Discussion' | 'Assistant';

export function InvestigationPanel({
  session,
  finding,
  path,
  mode,
  setMode,
  details,
  conversationId,
  selectConversation,
  canNavigate,
  navigate,
  returnToCode,
}: {
  session: ReviewSession;
  finding?: WorkspaceFinding;
  path?: string;
  mode: InvestigationMode;
  setMode: (mode: InvestigationMode) => void;
  details: React.ReactNode;
  conversationId: string | null;
  selectConversation: (id: string | null) => void;
  canNavigate: (evidence: EvidenceView, call: InvestigationResult) => boolean;
  navigate: (evidence: EvidenceView, call: InvestigationResult) => void;
  returnToCode: () => void;
}) {
  const { user, role } = useSession();
  const [allThreads, setAllThreads] = React.useState(false);
  const [draft, setDraft] = React.useState(false);
  const related = relatedReviewThreads(finding, session);
  const commentFinding = finding?.staticFinding;
  const hasCommentLocation = Boolean(
    commentFinding?.path && Number.isSafeInteger(commentFinding.line) && commentFinding.line! > 0,
  );
  const draftAnchor =
    draft && commentFinding && hasCommentLocation
      ? {
          path: commentFinding.path ?? '',
          line: commentFinding.line ?? 1,
          findingFingerprint: commentFinding.fingerprint,
          ruleId: commentFinding.ruleId,
        }
      : null;
  React.useEffect(() => {
    setDraft(false);
    setAllThreads(false);
  }, [finding?.key]);
  return (
    <section className="investigation-panel" aria-label="Contextual investigation">
      <p className="investigation-scope">
        {session.repository.fullName} / #{session.pullRequest.number} / recorded head{' '}
        {shortSha(session.pullRequest.headSha)}
      </p>
      <p className="investigation-scope">{finding?.title ?? path ?? 'Pull request context'}</p>
      {finding && (
        <p className="investigation-scope">
          Recorded analysis head {shortSha(session.run?.headSha)}
          {session.run?.stale ? ' / stale' : ''} / {related.length} linked review thread(s),{' '}
          {related.filter((c) => !c.resolvedAt).length} open. No independent finding resolution
          state is supplied.
        </p>
      )}
      <div role="group" aria-label="Context views" className="investigation-modes">
        {(['Details', 'Evidence', 'Discussion', 'Assistant'] as const).map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            aria-pressed={mode === name}
            onClick={() => setMode(name)}
          >
            {name}
          </Button>
        ))}
      </div>
      {mode === 'Details' && details}
      {mode === 'Evidence' && (
        <>
          <h2>Recorded analysis evidence</h2>
          <p>
            Analysis head {shortSha(session.run?.headSha)}
            {session.run?.stale ? ' / stale' : ''}. Recorded analysis is separate from conversation
            evidence.
          </p>
          {finding?.staticFinding?.snippet && (
            <pre className="review-context-snippet">
              <code>{finding.staticFinding.snippet}</code>
            </pre>
          )}
          <details>
            <summary>Indexed review context ({session.ragContext.chunkCount} chunks)</summary>
            <p>
              Similarity is not confidence. These summaries cannot establish exact source
              preconditions or citation entailment.
            </p>
            <ul>
              {session.ragContext.chunks.slice(0, 12).map((chunk, i) => (
                <li key={i}>
                  <p className="review-path">
                    {chunk.path} / {chunk.symbol ?? 'no symbol'}
                  </p>
                  <p>
                    {chunk.sources.join(', ')} / fused relevance {chunk.score.toFixed(2)}
                  </p>
                  {chunk.rationale && <p>{chunk.rationale}</p>}
                </li>
              ))}
            </ul>
            {session.ragContext.chunks.length > 12 && (
              <p>
                {session.ragContext.chunks.length - 12} further summaries available in Analysis.
              </p>
            )}
          </details>
          <h2>Conversation evidence</h2>
          <p>
            Select a recorded conversation and turn. No investigation runs when this view opens.
          </p>
        </>
      )}
      {mode === 'Discussion' && (
        <>
          <h2>Review threads</h2>
          <p>
            Review comments and collaborator conversations are separate records. Related threads use
            an exact finding fingerprint, not a guessed file or line match.
          </p>
          <div className="investigation-modes" role="group" aria-label="Thread scope">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={!allThreads}
              onClick={() => {
                setAllThreads(false);
                setDraft(false);
              }}
            >
              Finding-linked ({related.length})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={allThreads}
              onClick={() => {
                setAllThreads(true);
                setDraft(false);
              }}
            >
              All PR threads
            </Button>
          </div>
          {!allThreads && related.length === 0 && (
            <p>
              No authoritative thread relationship for this selected finding. PR-level discussion
              remains available.
            </p>
          )}
          {hasCommentLocation && session.permissions.canComment && !allThreads && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(true)}>
              Comment on selected finding
            </Button>
          )}
          <CommentsPanel
            key={`${finding?.key ?? 'pr'}-${allThreads}`}
            compact
            sessionId={session.pullRequestId}
            comments={allThreads ? session.comments : related}
            canComment={session.permissions.canComment}
            canModerate={session.permissions.canModerateComments}
            currentUserId={user?.id ?? null}
            draftAnchor={draftAnchor}
            onClearAnchor={() => setDraft(false)}
          />
          <Button size="sm" variant="ghost" onClick={() => setMode('Assistant')}>
            Recorded collaborator conversations
          </Button>
        </>
      )}
      {(mode === 'Assistant' || mode === 'Evidence') &&
        (role ? (
          <ConversationPanel
            compact
            evidenceOnly={mode === 'Evidence'}
            sessionId={session.pullRequestId}
            context={session}
            suggestedAnchor={selectedConversationAnchor(finding, session)}
            controlledId={conversationId}
            onSelectConversation={selectConversation}
            onNavigateEvidence={navigate}
            canNavigateEvidence={canNavigate}
          />
        ) : (
          <p>Collaboration is unavailable without current membership.</p>
        ))}
      <Button size="sm" variant="ghost" onClick={returnToCode}>
        Return to selected code context
      </Button>
    </section>
  );
}
