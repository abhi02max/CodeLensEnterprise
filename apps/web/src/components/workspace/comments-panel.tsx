'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Textarea,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { relativeTime } from '@/lib/format';
import type { CommentView, FindingView } from '@/lib/types';

export interface DraftAnchor {
  path: string;
  line: number;
  findingFingerprint: string;
  ruleId: string;
}

/**
 * Review discussion.
 *
 * Three kinds of comment in one panel, because they are one conversation: general, inline, and
 * finding-linked. A finding-linked thread is marked, because resolving it changes the merge gate
 * and a reviewer should know that before they click resolve rather than after.
 */
export function CommentsPanel({
  sessionId,
  comments,
  canComment,
  canModerate,
  currentUserId,
  draftAnchor,
  onClearAnchor,
}: {
  sessionId: string;
  comments: CommentView[];
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string | null;
  draftAnchor: DraftAnchor | null;
  onClearAnchor: () => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = React.useState('');
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus the composer when a finding's Discuss button sets an anchor, so the click lands the user
  // where they can type instead of leaving them to find the box.
  React.useEffect(() => {
    if (draftAnchor) textareaRef.current?.focus();
  }, [draftAnchor]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createComment(sessionId, {
        body: body.trim(),
        ...(replyTo ? { parentId: replyTo } : {}),
        ...(draftAnchor && !replyTo
          ? {
              path: draftAnchor.path,
              line: draftAnchor.line,
              findingFingerprint: draftAnchor.findingFingerprint,
            }
          : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: () => {
      setBody('');
      setReplyTo(null);
      onClearAnchor();
      refresh();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not post the comment'),
  });

  const resolve = useMutation({
    mutationFn: (commentId: string) => api.resolveComment(commentId),
    onSuccess: refresh,
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not resolve the thread'),
  });

  const reopen = useMutation({
    mutationFn: (commentId: string) => api.reopenComment(commentId),
    onSuccess: refresh,
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not reopen the thread'),
  });

  const unresolved = comments.filter((comment) => !comment.resolvedAt).length;

  return (
    <Card>
      <CardHeader
        title="Discussion"
        subtitle={`${comments.length} thread${comments.length === 1 ? '' : 's'}, ${unresolved} open`}
      />

      {comments.length === 0 ? (
        <EmptyState title="No comments yet" description="Start the discussion below." />
      ) : (
        <ul className="divide-y divide-surface-border">
          {comments.map((thread) => (
            <li key={thread.id} className="px-4 py-2.5">
              <Thread
                comment={thread}
                canModerate={canModerate}
                currentUserId={currentUserId}
                onResolve={() => resolve.mutate(thread.id)}
                onReopen={() => reopen.mutate(thread.id)}
                onReply={canComment ? () => setReplyTo(thread.id) : undefined}
                busy={resolve.isPending || reopen.isPending}
              />

              {thread.replies.length > 0 && (
                <ul className="mt-2 space-y-2 border-l-2 border-surface-border pl-3">
                  {thread.replies.map((reply) => (
                    <li key={reply.id}>
                      <CommentBody comment={reply} />
                    </li>
                  ))}
                </ul>
              )}

              {replyTo === thread.id && (
                <p className="mt-1.5 text-xs text-slate-500">
                  Replying to this thread.{' '}
                  <button
                    type="button"
                    className="underline hover:text-slate-800"
                    onClick={() => setReplyTo(null)}
                  >
                    Cancel
                  </button>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {canComment ? (
        <div className="border-t border-surface-border px-4 py-3">
          {draftAnchor && !replyTo && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
              <span className="truncate">
                Commenting on <code className="font-mono">{draftAnchor.ruleId}</code> at{' '}
                {draftAnchor.path}:{draftAnchor.line}
              </span>
              <button type="button" className="underline" onClick={onClearAnchor}>
                Clear
              </button>
            </div>
          )}

          <Textarea
            ref={textareaRef}
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={
              replyTo ? 'Write a reply…' : draftAnchor ? 'Explain the problem…' : 'Comment on this pull request…'
            }
            aria-label="Comment body"
          />

          {error && (
            <Alert tone="danger" className="mt-2">
              {error}
            </Alert>
          )}

          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {replyTo ? 'Reply' : draftAnchor ? 'Finding comment' : 'General comment'}
            </span>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={body.trim().length === 0}
              onClick={() => create.mutate()}
            >
              Comment
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-surface-border px-4 py-3">
          <p className="text-xs text-slate-500">
            Your role does not allow commenting on this pull request.
          </p>
        </div>
      )}
    </Card>
  );
}

function Thread({
  comment,
  canModerate,
  currentUserId,
  onResolve,
  onReopen,
  onReply,
  busy,
}: {
  comment: CommentView;
  canModerate: boolean;
  currentUserId: string | null;
  onResolve: () => void;
  onReopen: () => void;
  onReply?: () => void;
  busy: boolean;
}) {
  // Mirrors the server rule: the author of a thread can always settle it, otherwise REVIEWER+.
  const mayModerate = canModerate || comment.author?.id === currentUserId;

  return (
    <div>
      <CommentBody comment={comment} />

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {comment.resolvedAt ? (
          <>
            <Badge tone="success">
              resolved by {comment.resolvedBy?.name ?? 'someone'} {relativeTime(comment.resolvedAt)}
            </Badge>
            {mayModerate && (
              <Button size="sm" variant="ghost" loading={busy} onClick={onReopen}>
                Reopen
              </Button>
            )}
          </>
        ) : (
          mayModerate && (
            <Button size="sm" variant="ghost" loading={busy} onClick={onResolve}>
              Resolve
            </Button>
          )
        )}

        {onReply && (
          <Button size="sm" variant="ghost" onClick={onReply}>
            Reply
          </Button>
        )}
      </div>
    </div>
  );
}

function CommentBody({ comment }: { comment: CommentView }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs font-semibold text-slate-800">
          {comment.author?.name ?? (comment.origin === 'AI' ? 'CodeLens AI' : 'Removed user')}
        </span>
        {comment.origin === 'AI' && <Badge tone="info">ai</Badge>}
        <span className="text-xs text-slate-400">{relativeTime(comment.createdAt)}</span>
        {comment.editedAt && <span className="text-xs text-slate-400">· edited</span>}
        {comment.findingFingerprint && (
          <Badge tone="outline" title="Resolving this thread clears the finding from the merge gate">
            finding
          </Badge>
        )}
        {comment.outdated && <Badge tone="warning">outdated</Badge>}
      </div>

      {comment.path && (
        <p className="mt-0.5 font-mono text-xs text-slate-500">
          {comment.path}
          {comment.line ? `:${comment.line}` : ''}
        </p>
      )}

      <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{comment.body}</p>
    </div>
  );
}
