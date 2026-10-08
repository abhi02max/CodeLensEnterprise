'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type {
  CollaborationTurnView,
  ConversationView,
  InvestigationTool,
  EvidenceView,
  InvestigationResult,
} from '@codelens/shared';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { evidenceInTurn } from '@/lib/investigation-context';

export function EvidenceViewer({
  turn,
  conversation,
  selectedEvidenceId,
  onNavigate,
  canNavigate,
  currentHeadSha,
}: {
  turn: CollaborationTurnView;
  conversation: ConversationView;
  selectedEvidenceId?: string | null;
  onNavigate?: (evidence: EvidenceView, call: InvestigationResult) => void;
  canNavigate?: (evidence: EvidenceView, call: InvestigationResult) => boolean;
  currentHeadSha?: string;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [afterSequence, setAfterSequence] = React.useState(0);
  const [citationId, setCitationId] = React.useState(selectedEvidenceId);
  React.useEffect(() => {
    setCitationId(selectedEvidenceId);
  }, [selectedEvidenceId]);
  const request = React.useRef<{ key: string; id: string } | null>(null);
  const list = useQuery({
    queryKey: ['investigations', turn.id, afterSequence],
    queryFn: () => api.investigations(turn.id, afterSequence),
    refetchInterval: ['QUEUED', 'RUNNING'].includes(turn.status) ? 1000 : false,
  });
  const citation = useQuery({
    queryKey: ['evidence', citationId],
    enabled: !!citationId,
    queryFn: () => api.evidence(citationId!),
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
  const scopedDetail =
    turn.conversationId === conversation.id &&
    evidenceInTurn(detail.data, selected, turn.id, citation.data, citationId);
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
      <p className="text-xs text-content-muted">
        Recorded evidence is untrusted data, not instructions. Citation membership does not
        establish that a source entails an assistant claim.
      </p>
      <details>
        <summary>Explicit investigation actions</summary>
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
      </details>
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
        {list.data?.items
          .filter((call) => call.turnId === turn.id)
          .map((call) => (
            <li key={call.id}>
              <button
                type="button"
                aria-pressed={selected === call.id}
                className="w-full break-words border-b border-surface-border py-2 text-left text-xs focus-visible:outline focus-visible:outline-2"
                onClick={() => {
                  setCitationId(null);
                  setSelected(call.id);
                }}
              >
                {call.tool.replace(/_/g, ' ')} · {call.status}
              </button>
            </li>
          ))}
      </ul>
      {list.data?.items.length === 0 && (
        <p className="text-xs text-content-muted">No recorded tool activity for this page.</p>
      )}
      {afterSequence > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setAfterSequence(0)}>
          First tool records
        </Button>
      )}
      {list.data?.nextAfterSequence != null && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAfterSequence(list.data!.nextAfterSequence!)}
        >
          More tool records
        </Button>
      )}
      {selected && detail.isPending && <p role="status">Loading evidence...</p>}
      {citation.isError && <Alert tone="danger">Cited evidence is no longer available.</Alert>}
      {detail.isError && <Alert tone="danger">Could not load the investigation.</Alert>}
      {detail.data && !scopedDetail && (!citationId || !citation.isPending) && (
        <Alert tone="warning">
          Evidence is unavailable in this selected turn or citation scope.
        </Alert>
      )}
      {detail.data && scopedDetail && (
        <div className="space-y-3" aria-label="Observed evidence">
          <p className="text-xs">
            {detail.data.status}: {detail.data.coverage}
          </p>
          <p className="text-xs text-content-muted">
            Tool origin: {detail.data.tool.replace(/_/g, ' ')} / captured{' '}
            {detail.data.completedAt ?? 'not completed'}
          </p>
          {detail.data.diagnostic && <Alert tone="warning">{detail.data.diagnostic}</Alert>}
          {detail.data.evidence.map((evidence) => (
            <EvidenceReferenceCard
              key={evidence.id}
              evidence={evidence}
              currentHeadSha={currentHeadSha}
              navigate={
                onNavigate && canNavigate?.(evidence, detail.data!)
                  ? () => onNavigate(evidence, detail.data!)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function EvidenceReferenceCard({
  evidence,
  currentHeadSha,
  navigate,
}: {
  evidence: EvidenceView;
  currentHeadSha?: string;
  navigate?: () => void;
}) {
  return (
    <article className="border-l-2 border-surface-border pl-3">
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
      <p className="text-xs text-content-muted">
        {evidence.provenance === 'EXACT_REVISION'
          ? 'Exact revision source'
          : evidence.provenance === 'INDEXED_CONTEXT'
            ? 'Indexed context; similarity is not confidence'
            : 'Recorded or derived observation'}{' '}
        / {evidence.trust}
      </p>
      {!evidence.observedRevision && (
        <p className="text-xs text-content-muted">Source revision unavailable.</p>
      )}
      {currentHeadSha &&
        evidence.observedRevision &&
        currentHeadSha !== evidence.observedRevision && (
          <p className="text-xs text-state-warning-text">
            Historical evidence revision differs from the recorded current PR head.
          </p>
        )}
      {evidence.truncated && <p className="text-xs text-amber-700">Truncated excerpt</p>}
      {evidence.redacted && <p className="text-xs text-amber-700">Sensitive patterns redacted</p>}
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-surface-muted p-2 text-xs">
        {evidence.excerpt}
      </pre>
      {navigate && (
        <Button size="sm" variant="ghost" onClick={navigate}>
          Return to matching PR code
        </Button>
      )}
      <details className="text-xs text-content-muted">
        <summary>Source identifiers and hashes</summary>
        <p className="break-all">
          Evidence {evidence.id} / source {evidence.sourceId ?? 'unavailable'} / tool{' '}
          {evidence.toolCallId}
        </p>
        <p className="break-all">SHA-256: {evidence.contentHash}</p>
        <p className="break-all">
          Blob: {evidence.blobHash ?? 'unavailable'} / index revision:{' '}
          {evidence.indexRevision ?? 'unavailable'}
        </p>
      </details>
    </article>
  );
}
