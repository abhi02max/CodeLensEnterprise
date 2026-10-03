'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { CollaborationTurnView, ConversationView, InvestigationTool } from '@codelens/shared';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';

export function EvidenceViewer({
  turn,
  conversation,
  selectedEvidenceId,
}: {
  turn: CollaborationTurnView;
  conversation: ConversationView;
  selectedEvidenceId?: string | null;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = React.useState<string | null>(null);
  const request = React.useRef<{ key: string; id: string } | null>(null);
  const list = useQuery({
    queryKey: ['investigations', turn.id],
    queryFn: () => api.investigations(turn.id),
    refetchInterval: ['QUEUED', 'RUNNING'].includes(turn.status) ? 1000 : false,
  });
  const citation = useQuery({
    queryKey: ['evidence', selectedEvidenceId],
    enabled: !!selectedEvidenceId,
    queryFn: () => api.evidence(selectedEvidenceId!),
  });
  React.useEffect(() => {
    if (citation.data) setSelected(citation.data.toolCallId);
  }, [citation.data]);
  const detail = useQuery({
    queryKey: ['investigation', selected],
    enabled: !!selected,
    queryFn: () => api.investigation(selected!),
    refetchInterval: (query) => (query.state.data?.status === 'RUNNING' ? 1000 : false),
  });
  const run = useMutation({
    mutationFn: ({ tool, input }: { tool: InvestigationTool; input: unknown }) => {
      const key = JSON.stringify({ turn: turn.id, tool, input });
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      return api.investigate(turn.id, tool, request.current.id, input);
    },
    onSuccess: (result) => {
      request.current = null;
      setSelected(result.id);
      client.setQueryData(['investigation', result.id], result);
      void client.invalidateQueries({ queryKey: ['investigations', turn.id] });
    },
  });
  const anchor = conversation.anchor;
  const inspect = () => {
    if (anchor?.kind === 'COMMENT')
      return run.mutate({ tool: 'read_review_thread', input: { commentId: anchor.commentId } });
    if (anchor?.kind === 'STATIC_FINDING')
      return run.mutate({
        tool: 'read_analysis_evidence',
        input: { source: 'STATIC', findingId: anchor.findingId },
      });
    if (anchor?.kind === 'AI_FINDING')
      return run.mutate({
        tool: 'read_analysis_evidence',
        input: { source: 'AI', findingIndex: anchor.findingIndex },
      });
    if (anchor?.kind === 'FILE' || anchor?.kind === 'RANGE')
      return run.mutate({
        tool: 'read_file_range',
        input: {
          path: anchor.path,
          startLine: anchor.kind === 'RANGE' ? anchor.startLine : 1,
          endLine: anchor.kind === 'RANGE' ? anchor.endLine : 80,
          side: anchor.kind === 'RANGE' && anchor.side === 'LEFT' ? 'BASE' : 'HEAD',
        },
      });
    run.mutate({ tool: 'read_analysis_evidence', input: { source: 'REPORT' } });
  };
  return (
    <section
      aria-label="Investigation evidence"
      className="mt-3 border-t border-surface-border pt-3"
    >
      <h4 className="text-sm font-medium">Evidence for message #{turn.sequence}</h4>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={run.isPending || ['QUEUED', 'RUNNING'].includes(turn.status)}
          onClick={inspect}
        >
          <Search size={14} aria-hidden="true" />
          Inspect context
        </Button>
        <Button
          size="sm"
          disabled={run.isPending || ['QUEUED', 'RUNNING'].includes(turn.status)}
          onClick={() => run.mutate({ tool: 'read_pr_diff', input: {} })}
        >
          Inspect PR diff
        </Button>
        <Button
          size="sm"
          disabled={run.isPending || ['QUEUED', 'RUNNING'].includes(turn.status)}
          onClick={() => run.mutate({ tool: 'read_analysis_evidence', input: { source: 'ML' } })}
        >
          Inspect risk evidence
        </Button>
        <Button
          size="sm"
          disabled={run.isPending || ['QUEUED', 'RUNNING'].includes(turn.status)}
          onClick={() =>
            run.mutate({
              tool: 'retrieve_context',
              input: { query: conversation.title.slice(0, 500) },
            })
          }
        >
          Related indexed context
        </Button>
      </div>
      {run.isPending && (
        <p role="status" className="mt-2 text-xs">
          Investigating...
        </p>
      )}
      {run.isError && (
        <Alert tone="danger" className="mt-2">
          {run.error instanceof ApiError ? run.error.message : 'Investigation could not be saved'}
        </Alert>
      )}
      {list.isError && (
        <Alert tone="danger">
          Could not load evidence history.{' '}
          <Button size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </Alert>
      )}
      {list.isPending && (
        <p role="status" className="text-xs">
          Loading evidence history...
        </p>
      )}
      <ul className="my-2 space-y-1" aria-label="Investigation history">
        {list.data?.items.map((call) => (
          <li key={call.id}>
            <button
              type="button"
              aria-pressed={selected === call.id}
              className="w-full break-words border-b border-surface-border py-2 text-left text-xs focus-visible:outline focus-visible:outline-2"
              onClick={() => setSelected(call.id)}
            >
              {call.tool.replace(/_/g, ' ')} · {call.status}
            </button>
          </li>
        ))}
      </ul>
      {selected && detail.isPending && <p role="status">Loading evidence...</p>}
      {citation.isError && <Alert tone="danger">Cited evidence is no longer available.</Alert>}
      {detail.isError && <Alert tone="danger">Could not load the investigation.</Alert>}
      {detail.data && (
        <div className="space-y-3" aria-label="Observed evidence">
          <p className="text-xs">
            {detail.data.status}: {detail.data.coverage}
          </p>
          {detail.data.diagnostic && <Alert tone="warning">{detail.data.diagnostic}</Alert>}
          {detail.data.evidence.map((evidence) => (
            <article key={evidence.id} className="border-l-2 border-surface-border pl-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge tone="outline">{evidence.provenance}</Badge>
                <span>{evidence.sourceType}</span>
              </div>
              <p className="mt-1 break-all font-mono text-xs">
                {evidence.path ?? evidence.sourceId ?? 'Recorded observation'}
                {evidence.startLine !== null && `:${evidence.startLine}-${evidence.endLine}`}
              </p>
              <p className="break-all text-xs text-slate-500">
                Revision: {evidence.observedRevision ?? 'unknown'} · {evidence.method}
              </p>
              <p className="break-all font-mono text-xs text-slate-500">
                SHA-256: {evidence.contentHash}
              </p>
              {evidence.truncated && <p className="text-xs text-amber-700">Truncated excerpt</p>}
              {evidence.redacted && (
                <p className="text-xs text-amber-700">Sensitive patterns redacted</p>
              )}
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-surface-muted p-2 text-xs">
                {evidence.excerpt}
              </pre>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
