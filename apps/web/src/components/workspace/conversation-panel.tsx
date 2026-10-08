'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Plus, Square, RotateCcw } from 'lucide-react';
import type {
  ConversationAnchor,
  CollaborationTurnView,
  EvidenceView,
  InvestigationResult,
} from '@codelens/shared';
import { Alert, Button, Input, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { shortSha } from '@/lib/format';
import { useSession } from '@/lib/providers';
import { conversationInScope } from '@/lib/investigation-context';
import { EvidenceViewer } from './evidence-viewer';
import { PatchProposals } from './patch-proposal-card';
import type { ReviewSession } from '@/lib/types';

export function ConversationPanel({
  sessionId,
  context,
  suggestedAnchor,
  controlledId,
  onSelectConversation,
  onNavigateEvidence,
  canNavigateEvidence,
  compact = false,
  evidenceOnly = false,
}: {
  sessionId: string;
  context?: ReviewSession;
  suggestedAnchor?: ConversationAnchor | null;
  controlledId?: string | null;
  onSelectConversation?: (id: string | null) => void;
  onNavigateEvidence?: (evidence: EvidenceView, call: InvestigationResult) => void;
  canNavigateEvidence?: (evidence: EvidenceView, call: InvestigationResult) => boolean;
  compact?: boolean;
  evidenceOnly?: boolean;
}) {
  const client = useQueryClient();
  const [localId, setLocalId] = React.useState<string | null>(null);
  const selectedId = controlledId === undefined ? localId : controlledId;
  const setSelectedId = (id: string | null) => {
    setLocalId(id);
    onSelectConversation?.(id);
  };
  const [inspectedTurnId, setInspectedTurnId] = React.useState<string | null>(null);
  const [showCandidates, setShowCandidates] = React.useState(false);
  const [afterId, setAfterId] = React.useState<string | undefined>();
  const [afterSequence, setAfterSequence] = React.useState(0);
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [origin, setOrigin] = React.useState('PR');
  const [chosenAnchor, setChosenAnchor] = React.useState<ConversationAnchor>({ kind: 'PR' });
  const [citation, setCitation] = React.useState<{ turnId: string; evidenceId: string } | null>(
    null,
  );
  const choices: Array<{ key: string; label: string; anchor: ConversationAnchor }> = [
    { key: 'PR', label: 'Pull request', anchor: { kind: 'PR' } },
    ...(suggestedAnchor
      ? [{ key: 'SELECTED', label: 'Selected finding (explicit binding)', anchor: suggestedAnchor }]
      : []),
    ...(context?.findings ?? []).slice(0, 20).map((f) => ({
      key: f.id,
      label: `Static: ${f.ruleId}`,
      anchor: { kind: 'STATIC_FINDING' as const, findingId: f.id },
    })),
    ...(context?.run ? (context.aiReview?.findings ?? []) : []).slice(0, 20).map((f, i) => ({
      key: `AI-${i}`,
      label: `AI: ${f.title}`,
      anchor: { kind: 'AI_FINDING' as const, reviewRunId: context!.run!.id, findingIndex: i },
    })),
    ...(context?.comments ?? []).slice(0, 20).map((c) => ({
      key: c.id,
      label: `Thread: ${c.path ?? 'PR'}`,
      anchor: { kind: 'COMMENT' as const, commentId: c.id },
    })),
  ];
  // Capture the explicit choice; subsequent finding selection must not silently retarget a draft.
  const choiceStillAvailable = choices.some(
    (c) => c.key === origin && JSON.stringify(c.anchor) === JSON.stringify(chosenAnchor),
  );
  const createRequest = React.useRef<{
    title: string;
    anchorKey: string;
    requestId: string;
  } | null>(null);
  const messageRequest = React.useRef<{ id: string; content: string; requestId: string } | null>(
    null,
  );
  const listKey = ['conversations', sessionId, afterId];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => api.conversations(sessionId, afterId),
  });
  const detail = useQuery({
    queryKey: ['conversation', selectedId, afterSequence],
    queryFn: () => api.conversation(selectedId!, afterSequence),
    enabled: selectedId !== null,
    refetchInterval: (query) =>
      query.state.data?.messages.some((m) => ['QUEUED', 'RUNNING'].includes(m.turn.status))
        ? 1000
        : false,
  });

  const create = useMutation({
    mutationFn: () => {
      if (!choiceStillAvailable) throw new Error('Choose the conversation context again');
      const text = title.trim();
      const anchorKey = JSON.stringify(chosenAnchor);
      if (createRequest.current?.title !== text || createRequest.current.anchorKey !== anchorKey)
        createRequest.current = { title: text, anchorKey, requestId: crypto.randomUUID() };
      return api.createConversation(sessionId, {
        title: text,
        requestId: createRequest.current.requestId,
        anchor: chosenAnchor,
      });
    },
    onMutate: () => setError(null),
    onSuccess: (row) => {
      createRequest.current = null;
      setTitle('');
      setSelectedId(row.id);
      setAfterSequence(0);
      void client.invalidateQueries({ queryKey: ['conversations', sessionId] });
    },
    onError: (caught) => setError(safeError(caught, 'Could not create the conversation')),
  });
  const send = useMutation({
    mutationFn: () => {
      if (!selectedId || !conversationInScope(detail.data, selectedId, sessionId))
        throw new Error('No scoped conversation selected');
      const text = content.trim();
      if (messageRequest.current?.content !== text || messageRequest.current.id !== selectedId)
        messageRequest.current = { id: selectedId, content: text, requestId: crypto.randomUUID() };
      return api.createConversationMessage(selectedId, {
        content: text,
        requestId: messageRequest.current.requestId,
      });
    },
    onMutate: () => setError(null),
    onSuccess: (result) => {
      messageRequest.current = null;
      setContent('');
      setAfterSequence(Math.max(0, result.message.sequence - 20));
      void client.invalidateQueries({ queryKey: ['conversation', result.message.conversationId] });
    },
    onError: (caught) => setError(safeError(caught, 'Could not save the message')),
  });
  const busy = create.isPending || send.isPending;
  const scoped = conversationInScope(detail.data, selectedId, sessionId);
  const inspectedTurn = scoped
    ? detail.data?.messages.find((m) => m.turn.id === (citation?.turnId ?? inspectedTurnId))?.turn
    : undefined;

  return (
    <section
      aria-label="Collaborate"
      className={compact ? 'investigation-assistant' : 'border-t border-surface-border pt-3'}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-content-primary">
          {evidenceOnly ? 'Recorded conversations' : 'Collaborate'}
        </h2>
      </div>
      {!evidenceOnly && (
        <p className="text-xs text-content-muted">
          Each question explicitly invokes the bounded collaborator. The current code selection is
          not automatically sent. New conversations use the context chosen below; existing
          conversations retain their recorded anchor.
        </p>
      )}
      {!evidenceOnly && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <select
            aria-label="Conversation context"
            value={choiceStillAvailable ? origin : 'UNAVAILABLE'}
            disabled={busy}
            className="max-w-full rounded border border-surface-border bg-white px-2 text-xs"
            onChange={(event) => {
              setOrigin(event.target.value);
              const choice = choices.find((c) => c.key === event.target.value);
              if (choice) setChosenAnchor(choice.anchor);
            }}
          >
            {!choiceStillAvailable && (
              <option value="UNAVAILABLE" disabled>
                Previously selected context; choose again
              </option>
            )}
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
          <Input
            aria-label="Conversation title"
            maxLength={160}
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Conversation title"
            className="min-w-0 flex-1 basis-48"
          />
          <Button
            type="submit"
            disabled={busy || !title.trim() || !choiceStillAvailable}
            loading={create.isPending}
          >
            <Plus size={14} aria-hidden="true" />
            New conversation
          </Button>
        </form>
      )}
      {!evidenceOnly && (
        <p className="text-xs text-content-muted">
          New conversation binding: {anchorLabel(chosenAnchor)}
          {!choiceStillAvailable && ' / selection changed; choose context again.'}
        </p>
      )}
      {error && (
        <Alert tone="danger" className="mt-2">
          {error}
        </Alert>
      )}
      {list.isPending ? (
        <p role="status" className="mt-3 text-xs">
          Loading conversations...
        </p>
      ) : list.isError ? (
        <Alert tone="danger" className="mt-3">
          Could not load conversations.{' '}
          <Button size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : (
        <div className="mt-3 space-y-2">
          {list.data.items.length === 0 && (
            <p className="text-xs text-slate-500">No conversations yet.</p>
          )}
          <ul className="space-y-1" aria-label="PR conversations">
            {list.data.items
              .filter((row) => row.pullRequestId === sessionId)
              .map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={selectedId === row.id}
                    className="w-full break-words border-b border-surface-border px-1 py-2 text-left text-sm hover:bg-surface-muted focus-visible:outline focus-visible:outline-2"
                    onClick={() => {
                      setSelectedId(row.id);
                      setAfterSequence(0);
                      setContent('');
                      setError(null);
                      setCitation(null);
                      setInspectedTurnId(null);
                      setShowCandidates(false);
                    }}
                  >
                    {row.title}
                    <span className="block text-xs text-content-muted">
                      {anchorLabel(row.anchor)} / {row.createdBy.name}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            {afterId && (
              <Button size="sm" disabled={busy} onClick={() => setAfterId(undefined)}>
                First conversations
              </Button>
            )}
            {list.data.nextAfterId && (
              <Button size="sm" disabled={busy} onClick={() => setAfterId(list.data.nextAfterId!)}>
                More conversations
              </Button>
            )}
          </div>
        </div>
      )}
      {selectedId && (
        <div className="mt-3 border-t border-surface-border pt-3">
          {detail.isPending ? (
            <p role="status" className="text-xs">
              Loading messages...
            </p>
          ) : detail.isError ? (
            <Alert tone="danger">
              Could not load the conversation.{' '}
              <Button size="sm" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            </Alert>
          ) : (
            detail.data &&
            scoped && (
              <>
                <h3 className="break-words text-sm font-medium">
                  {detail.data.conversation.title}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Context: {anchorLabel(detail.data.conversation.anchor)}
                </p>
                <p className="text-xs text-content-muted">
                  Submission uses this recorded conversation context and your question. The server
                  establishes exact turn revisions. Assistant output is advisory; there is no live
                  token stream.
                </p>
                {detail.data.messages.length === 0 && (
                  <p className="my-3 text-xs text-slate-500">No messages yet.</p>
                )}
                <ol className="my-3 space-y-3" aria-label="Conversation messages">
                  {detail.data.messages.map((message) => (
                    <li key={message.id} className="border-l-2 border-surface-border pl-3">
                      <p className="text-xs text-slate-500">
                        {message.kind === 'ASSISTANT' ? 'Assistant' : message.createdBy.name}{' '}
                        <span className="font-mono">
                          #{message.sequence} · {shortSha(message.turn.headSha)}
                        </span>
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
                        {message.content}
                      </p>
                      <p className="text-xs text-content-muted">{message.createdAt}</p>
                      {message.kind === 'ASSISTANT' && (
                        <p className="text-xs text-content-muted">
                          {message.provider ?? 'provider not recorded'} /{' '}
                          {message.model ?? 'model not recorded'} / advisory output
                        </p>
                      )}
                      {message.kind === 'HUMAN' && inspectedTurnId !== message.turn.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setCitation(null);
                            setInspectedTurnId(message.turn.id);
                          }}
                        >
                          Inspect recorded turn and evidence: {message.turn.status}
                        </Button>
                      )}
                      {message.kind === 'HUMAN' && inspectedTurnId === message.turn.id && (
                        <TurnExecution
                          turn={message.turn}
                          conversationId={selectedId}
                          currentHeadSha={context?.pullRequest.headSha}
                        />
                      )}
                      {!!message.citations?.length && (
                        <ul aria-label="Evidence citations" className="mt-2 space-y-1">
                          {message.citations.map((c) => (
                            <li key={c.evidenceId}>
                              <button
                                type="button"
                                className="break-words text-left text-xs text-blue-700 underline focus-visible:outline focus-visible:outline-2"
                                onClick={() => {
                                  setInspectedTurnId(message.turn.id);
                                  setCitation({
                                    turnId: message.turn.id,
                                    evidenceId: c.evidenceId,
                                  });
                                }}
                              >
                                {c.strength === 'OBSERVED' ? 'Observed' : 'Inferred'}: {c.claim}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
                {inspectedTurn && (
                  <EvidenceViewer
                    key={inspectedTurn.id}
                    turn={inspectedTurn}
                    conversation={detail.data.conversation}
                    selectedEvidenceId={citation?.evidenceId}
                    onNavigate={onNavigateEvidence}
                    canNavigate={canNavigateEvidence}
                    currentHeadSha={context?.pullRequest.headSha}
                  />
                )}
                <div className="flex gap-2">
                  {afterSequence > 0 && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setAfterSequence(Math.max(0, afterSequence - 20))}
                    >
                      Earlier messages
                    </Button>
                  )}
                  {detail.data.nextAfterSequence !== null && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setAfterSequence(detail.data.nextAfterSequence!)}
                    >
                      Next messages
                    </Button>
                  )}
                </div>
              </>
            )
          )}
          {detail.data && !scoped && (
            <Alert tone="warning">Conversation unavailable in this PR scope.</Alert>
          )}
          {!evidenceOnly && (
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                send.mutate();
              }}
            >
              <Textarea
                aria-label="Conversation message"
                rows={3}
                maxLength={8000}
                value={content}
                disabled={busy || !scoped || detail.isError}
                onChange={(event) => setContent(event.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={busy || !scoped || detail.isError || !content.trim()}
                  loading={send.isPending}
                >
                  <Send size={14} aria-hidden="true" />
                  Send message
                </Button>
              </div>
            </form>
          )}
          {!evidenceOnly && scoped && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showCandidates}
              onClick={() => setShowCandidates((v) => !v)}
            >
              Proposal and candidate actions
            </Button>
          )}
          {!evidenceOnly && scoped && showCandidates && (
            <PatchProposals key={selectedId} conversationId={selectedId} />
          )}
        </div>
      )}
    </section>
  );
}

function TurnExecution({
  turn,
  conversationId,
  currentHeadSha,
}: {
  turn: CollaborationTurnView;
  conversationId: string;
  currentHeadSha?: string;
}) {
  const client = useQueryClient();
  const { user } = useSession();
  const state = useQuery({
    queryKey: ['collaboration-turn', turn.id],
    queryFn: async () => {
      const result = await api.collaborationTurn(turn.id);
      if (result.turnId !== turn.id) throw new Error('Turn scope mismatch');
      return result;
    },
    refetchInterval: (query) =>
      ['QUEUED', 'RUNNING'].includes(query.state.data?.status ?? turn.status) ? 1000 : false,
  });
  const calls = useQuery({
    queryKey: ['investigations', turn.id, 0],
    queryFn: () => api.investigations(turn.id),
    enabled: state.data?.status === 'RUNNING',
    refetchInterval: state.data?.status === 'RUNNING' ? 1000 : false,
  });
  React.useEffect(() => {
    if (state.data && state.data.status !== turn.status)
      void client.invalidateQueries({ queryKey: ['conversation', conversationId] });
  }, [state.data?.status, turn.status, client, conversationId]);
  const change = useMutation({
    mutationFn: (command: 'cancel' | 'retry') =>
      command === 'cancel'
        ? api.cancelCollaboration(turn.id)
        : api.retryCollaboration(turn.id, state.data!.attempt),
    onSuccess: () => {
      void state.refetch();
      void client.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });
  const status = state.data?.status ?? turn.status;
  return (
    <div className="mt-2 space-y-1 text-xs" aria-label="Turn execution">
      <p role="status">
        {status}
        {state.data?.failureCategory && `: ${state.data.failureCategory}`}
      </p>
      {(state.data?.stale || (currentHeadSha && currentHeadSha !== turn.headSha)) && (
        <p className="text-amber-700">Historical PR head; current head has changed.</p>
      )}
      {calls.data?.items
        .filter((call) => call.turnId === turn.id)
        .map((call) => (
          <p key={call.id}>
            {call.tool.replace(/_/g, ' ')}: {call.status} - {call.coverage}
          </p>
        ))}
      {turn.initiatedById === user?.id && ['QUEUED', 'RUNNING'].includes(status) && (
        <Button size="sm" disabled={change.isPending} onClick={() => change.mutate('cancel')}>
          <Square size={12} aria-hidden="true" /> Cancel turn
        </Button>
      )}
      {turn.initiatedById === user?.id &&
        state.data &&
        ['RECORDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status) && (
          <Button size="sm" disabled={change.isPending} onClick={() => change.mutate('retry')}>
            <RotateCcw size={12} aria-hidden="true" /> Retry turn
          </Button>
        )}
      {(state.isError || change.isError) && (
        <Alert tone="danger">Turn status or command unavailable.</Alert>
      )}
      {status === 'CANCELLED' && (
        <p>Local turn cancelled. Remote provider termination or cost refund is not guaranteed.</p>
      )}
      {state.data && (
        <details>
          <summary>Execution accounting</summary>
          <p>
            {state.data.provider ?? 'provider unavailable'} /{' '}
            {state.data.model ?? 'model unavailable'} / attempt {state.data.attempt}
          </p>
          <p>
            Requests {state.data.providerRequests}, retries {state.data.providerRetries}, repairs{' '}
            {state.data.repairs}, tool calls {state.data.toolCalls}
          </p>
        </details>
      )}
    </div>
  );
}

function safeError(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

function anchorLabel(anchor: ConversationAnchor | null): string {
  if (!anchor || anchor.kind === 'PR') return 'Pull request';
  switch (anchor.kind) {
    case 'FILE':
      return anchor.path;
    case 'RANGE':
      return `${anchor.path}:${anchor.startLine}-${anchor.endLine} (${anchor.side.toLowerCase()})`;
    case 'COMMENT':
      return `Comment ${anchor.commentId}`;
    case 'STATIC_FINDING':
      return `Static finding ${anchor.findingId}`;
    case 'AI_FINDING':
      return `AI finding ${anchor.findingIndex + 1} in run ${anchor.reviewRunId}`;
  }
}
