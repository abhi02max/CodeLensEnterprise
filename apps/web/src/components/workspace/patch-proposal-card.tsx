'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Pencil, MessageSquare, Send } from 'lucide-react';
import type { PatchProposalView, PatchIntent } from '@codelens/shared';
import { Button, Alert, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { EvidenceReferenceCard } from './evidence-viewer';
import { PatchApplicationPanel } from './patch-application-panel';

export function PatchProposals({ conversationId }: { conversationId: string }) {
  const [afterId, setAfterId] = React.useState<string | undefined>();
  const query = useQuery({
    queryKey: ['patch-proposals', conversationId, afterId],
    queryFn: () => api.patchProposals(conversationId, afterId),
    refetchInterval: 2000,
  });
  return (
    <section aria-label="Patch proposals" className="my-3 space-y-3">
      {query.isError && (
        <Alert tone="danger">
          Could not load proposals. <Button onClick={() => void query.refetch()}>Retry</Button>
        </Alert>
      )}
      {query.data?.items.map((proposal) => (
        <PatchProposalCard key={proposal.id} proposal={proposal} />
      ))}
      <div className="flex gap-2">
        {afterId && (
          <Button size="sm" onClick={() => setAfterId(undefined)}>
            First proposals
          </Button>
        )}
        {query.data?.nextAfterId && (
          <Button size="sm" onClick={() => setAfterId(query.data!.nextAfterId!)}>
            More proposals
          </Button>
        )}
      </div>
    </section>
  );
}

function intentFrom(proposal: PatchProposalView): PatchIntent {
  return {
    summary: proposal.summary,
    rationale: proposal.rationale,
    limitations: proposal.limitations,
    files: proposal.files.map((f) => ({
      operation: 'MODIFY',
      path: f.path,
      expectedBlobSha: f.oldBlobSha,
      edits: f.edits.map((e) => ({ ...e })),
      evidenceIds: f.evidenceIds,
    })),
  };
}
export function PatchProposalCard({
  proposal: p,
  decisionOnly = false,
}: {
  proposal: PatchProposalView;
  decisionOnly?: boolean;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const [requesting, setRequesting] = React.useState(false);
  const [intent, setIntent] = React.useState(() => intentFrom(p));
  const [notice, setNotice] = React.useState('');
  const [evidenceId, setEvidenceId] = React.useState<string | null>(null);
  const evidence = useQuery({
    queryKey: ['proposal-evidence', evidenceId],
    queryFn: () => api.evidence(evidenceId!),
    enabled: !!evidenceId,
  });
  const request = React.useRef<{ payload: string; id: string } | null>(null);
  const change = useMutation({
    mutationFn: async (action: 'ACCEPTED' | 'REJECTED' | 'EDIT' | 'FEEDBACK') => {
      const payload = JSON.stringify({
        action,
        ...(action === 'EDIT' ? { intent } : action === 'FEEDBACK' ? { feedback } : {}),
      });
      if (request.current?.payload !== payload)
        request.current = { payload, id: crypto.randomUUID() };
      const id = request.current.id;
      if (action === 'EDIT') return api.patchRevision(p.id, id, intent);
      if (action === 'FEEDBACK') return api.patchFeedback(p.id, id, feedback.trim());
      return api.patchDecision(p.id, id, action);
    },
    onSuccess: (_result, action) => {
      request.current = null;
      setEditing(false);
      setRequesting(false);
      setNotice(
        action === 'ACCEPTED'
          ? 'Proposal accepted for a future application step.'
          : action === 'EDIT'
            ? 'New unaccepted revision recorded.'
            : action === 'FEEDBACK'
              ? 'Revision feedback recorded.'
              : 'Proposal rejected.',
      );
      void client.invalidateQueries({ queryKey: ['patch-proposals', p.conversationId] });
      void client.invalidateQueries({ queryKey: ['conversation', p.conversationId] });
    },
  });
  return (
    <article
      id={`patch-proposal-${p.id}`}
      aria-label={`Patch proposal revision ${p.revision}`}
      className={
        decisionOnly
          ? 'candidate-decision'
          : 'rounded border border-surface-border bg-white p-3 text-sm'
      }
    >
      <h3 className="break-words font-semibold">{p.summary}</h3>
      <p className="mt-1 break-words text-xs">
        {p.authorType === 'AI'
          ? `Assistant · ${p.provider} / ${p.model}`
          : `Human revision · ${p.authorId}`}{' '}
        · Revision {p.revision} · {p.status}
      </p>
      <p className="mt-1 break-all font-mono text-xs">
        Head {p.headSha} · Base {p.baseSha}
      </p>
      <p className={p.stale ? 'mt-1 text-amber-700' : 'mt-1 text-slate-500'}>
        {p.stale
          ? 'Stale relative to current head. Acceptance does not establish current applicability.'
          : 'Pinned to the current recorded PR head.'}
      </p>
      <p className="mt-1 text-xs">
        {p.fileCount} files · {p.changedLines} changed lines
      </p>
      <p className="mt-2 whitespace-pre-wrap break-words">{p.rationale}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">
        Limitations: {p.limitations}
      </p>
      <p className="mt-2 text-xs">
        Accepting approves this proposal for a future application step. No repository files are
        changed.
      </p>
      {!decisionOnly &&
        p.files.map((f) => (
          <details key={f.path} open className="mt-3">
            <summary className="break-all font-medium">{f.path}</summary>
            <pre
              aria-label={`Canonical diff for ${f.path}`}
              className="my-2 max-h-96 overflow-auto border-y border-surface-border py-2 text-xs"
            >
              {f.diff}
            </pre>
            <div className="flex flex-wrap gap-2">
              {f.evidenceIds.map((id) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => setEvidenceId(id)}
                  className="break-all text-xs text-blue-700 underline focus-visible:outline focus-visible:outline-2"
                >
                  Evidence {id}
                </button>
              ))}
            </div>
          </details>
        ))}
      {decisionOnly && (
        <div className="flex flex-wrap gap-2">
          {Array.from(new Set(p.files.flatMap((f) => f.evidenceIds))).map((id, i) => (
            <Button key={id} size="sm" variant="ghost" onClick={() => setEvidenceId(id)}>
              Supporting evidence {i + 1}
            </Button>
          ))}
        </div>
      )}
      {evidenceId && evidence.isPending && <p role="status">Loading evidence...</p>}
      {evidence.isError && (
        <Alert tone="danger">
          Proposal evidence is unavailable.{' '}
          <Button onClick={() => void evidence.refetch()}>Retry</Button>
        </Alert>
      )}
      {evidence.data && <EvidenceReferenceCard evidence={evidence.data} />}
      <p className="mt-2 break-all font-mono text-xs">Digest: {p.digest}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={change.isPending || p.status !== 'PROPOSED'}
          onClick={() => change.mutate('ACCEPTED')}
        >
          <Check size={14} />
          Accept proposal
        </Button>
        <Button
          disabled={change.isPending || p.status !== 'PROPOSED'}
          onClick={() => change.mutate('REJECTED')}
        >
          <X size={14} />
          Reject
        </Button>
        <Button
          disabled={change.isPending || p.status === 'SUPERSEDED'}
          onClick={() => {
            setIntent(intentFrom(p));
            setEditing(!editing);
            setRequesting(false);
          }}
        >
          <Pencil size={14} />
          Edit as new revision
        </Button>
        <Button
          disabled={change.isPending || p.status === 'SUPERSEDED'}
          onClick={() => {
            setRequesting(!requesting);
            setEditing(false);
          }}
        >
          <MessageSquare size={14} />
          Request revision
        </Button>
      </div>
      {editing && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate('EDIT');
          }}
        >
          {intent.files.flatMap((f, fi) =>
            f.edits.map((edit, ei) => (
              <label key={`${fi}-${ei}`} className="block text-xs">
                {f.path}:{edit.startLine}-{edit.endLine} replacement
                <Textarea
                  rows={4}
                  maxLength={8192}
                  value={edit.replacement}
                  disabled={change.isPending}
                  onChange={(e) =>
                    setIntent({
                      ...intent,
                      files: intent.files.map((file, i) =>
                        i === fi
                          ? {
                              ...file,
                              edits: file.edits.map((op, j) =>
                                j === ei ? { ...op, replacement: e.target.value } : op,
                              ),
                            }
                          : file,
                      ),
                    })
                  }
                />
              </label>
            )),
          )}
          <Button type="submit" disabled={change.isPending}>
            <Pencil size={14} />
            Save new revision
          </Button>
        </form>
      )}
      {requesting && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate('FEEDBACK');
          }}
        >
          <p className="text-xs">
            Sending feedback records a human message and requests a bounded assistant turn using the
            existing configured provider.
          </p>
          <Textarea
            aria-label="Proposal revision feedback"
            rows={3}
            maxLength={8000}
            value={feedback}
            disabled={change.isPending}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <Button type="submit" disabled={change.isPending || !feedback.trim()}>
            <Send size={14} />
            Send revision feedback
          </Button>
        </form>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs">
          {notice}
        </p>
      )}
      {change.isError && (
        <Alert tone="danger" className="mt-2">
          {change.error instanceof ApiError
            ? change.error.message
            : 'Proposal command failed. No repository files changed.'}
        </Alert>
      )}
      {!decisionOnly && <PatchApplicationPanel proposal={p} />}
    </article>
  );
}
