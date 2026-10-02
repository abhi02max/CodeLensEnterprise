'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Plus } from 'lucide-react';
import type { ConversationAnchor } from '@codelens/shared';
import { Alert, Button, Input, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { shortSha } from '@/lib/format';
import { EvidenceViewer } from './evidence-viewer';
import type { ReviewSession } from '@/lib/types';

export function ConversationPanel({
  sessionId,
  context,
}: {
  sessionId: string;
  context?: ReviewSession;
}) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [afterId, setAfterId] = React.useState<string | undefined>();
  const [afterSequence, setAfterSequence] = React.useState(0);
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [origin, setOrigin] = React.useState('PR');
  const choices: Array<{ key: string; label: string; anchor: ConversationAnchor }> = [
    { key: 'PR', label: 'Pull request', anchor: { kind: 'PR' } },
    { key: 'ML', label: 'Risk discussion', anchor: { kind: 'PR' } },
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
  const chosenAnchor = choices.find((c) => c.key === origin)?.anchor ?? { kind: 'PR' as const };
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
  });

  const create = useMutation({
    mutationFn: () => {
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
      if (!selectedId) throw new Error('No conversation selected');
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

  return (
    <section aria-label="Collaborate" className="border-t border-surface-border pt-3">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Collaborate</h2>
        <p className="text-xs text-slate-500">
          Human conversation only. AI execution is not available yet.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <select
          aria-label="Conversation context"
          value={origin}
          disabled={busy}
          className="max-w-full rounded border border-surface-border bg-white px-2 text-xs"
          onChange={(event) => setOrigin(event.target.value)}
        >
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
        <Button type="submit" disabled={busy || !title.trim()} loading={create.isPending}>
          <Plus size={14} aria-hidden="true" />
          New conversation
        </Button>
      </form>
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
            {list.data.items.map((row) => (
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
                  }}
                >
                  {row.title}
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
            detail.data && (
              <>
                <h3 className="break-words text-sm font-medium">
                  {detail.data.conversation.title}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Context: {anchorLabel(detail.data.conversation.anchor)}
                </p>
                {detail.data.messages.length === 0 && (
                  <p className="my-3 text-xs text-slate-500">No messages yet.</p>
                )}
                <ol className="my-3 space-y-3" aria-label="Conversation messages">
                  {detail.data.messages.map((message) => (
                    <li key={message.id} className="border-l-2 border-surface-border pl-3">
                      <p className="text-xs text-slate-500">
                        {message.createdBy.name}{' '}
                        <span className="font-mono">
                          #{message.sequence} · {shortSha(message.turn.headSha)}
                        </span>
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
                        {message.content}
                      </p>
                    </li>
                  ))}
                </ol>
                {detail.data.messages.length > 0 && (
                  <EvidenceViewer
                    key={detail.data.messages[detail.data.messages.length - 1]!.turn.id}
                    turn={detail.data.messages[detail.data.messages.length - 1]!.turn}
                    conversation={detail.data.conversation}
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
              disabled={busy || !detail.data || detail.isError}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={busy || !detail.data || detail.isError || !content.trim()}
                loading={send.isPending}
              >
                <Send size={14} aria-hidden="true" />
                Save message
              </Button>
            </div>
          </form>
        </div>
      )}
    </section>
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
