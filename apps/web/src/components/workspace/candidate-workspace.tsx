'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCode2, RefreshCw } from 'lucide-react';
import type { PatchProposalView } from '@codelens/shared';
import { Alert, Button, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { shortSha, relativeTime } from '@/lib/format';
import { proposalPatch } from '@/lib/candidate-evaluation';
import type { ReviewSession } from '@/lib/types';
import { PatchProposalCard } from './patch-proposal-card';
import { CandidateEvaluation } from './candidate-evaluation';

export function CandidateWorkspace({
  session,
  conversationId,
  selectConversation,
}: {
  session: ReviewSession;
  conversationId: string | null;
  selectConversation: (id: string | null) => void;
}) {
  const [cursor, setCursor] = React.useState<string>();
  const conversations = useQuery({
    queryKey: ['conversations', session.pullRequestId, cursor],
    queryFn: () => api.conversations(session.pullRequestId, cursor),
    refetchOnWindowFocus: false,
  });
  const selected = conversations.isError
    ? undefined
    : conversations.data?.items.find(
        (c) => c.id === conversationId && c.pullRequestId === session.pullRequestId,
      );
  return (
    <section className="candidate-workspace" aria-label="Candidate evaluation workspace">
      <header className="candidate-heading">
        <div>
          <h2>Candidates</h2>
          <p>Immutable proposals and isolated evaluation. The imported PR remains unchanged.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          title="Refresh conversation list"
          aria-label="Refresh conversation list"
          onClick={() => void conversations.refetch()}
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      <label className="candidate-picker">
        Originating conversation
        <Select
          value={selected?.id ?? ''}
          onChange={(e) => selectConversation(e.target.value || null)}
        >
          <option value="">Select a conversation</option>
          {conversations.data?.items
            .filter((c) => c.pullRequestId === session.pullRequestId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} / {c.anchor?.kind.replaceAll('_', ' ') ?? 'PR'}
              </option>
            ))}
        </Select>
      </label>
      <PageControls
        cursor={cursor}
        next={conversations.data?.nextAfterId}
        change={(next) => {
          setCursor(next);
          selectConversation(null);
        }}
        noun="conversations"
      />
      {conversations.isPending && <p role="status">Loading conversations...</p>}
      {conversations.isError && (
        <ReadError retry={() => void conversations.refetch()} label="Conversations" />
      )}
      {conversations.data?.items.length === 0 && (
        <p>No conversations available. Proposal creation remains in Discussion and Assistant.</p>
      )}
      {conversationId && !selected && conversations.data && (
        <Alert tone="warning">
          Selected conversation is unavailable on this page. Select an available conversation; no
          candidate results are retained.
        </Alert>
      )}
      {selected && (
        <ProposalSelection
          key={selected.id}
          conversationId={selected.id}
          currentHead={session.pullRequest.headSha}
        />
      )}
    </section>
  );
}

function ProposalSelection({
  conversationId,
  currentHead,
}: {
  conversationId: string;
  currentHead: string;
}) {
  const [cursor, setCursor] = React.useState<string>();
  const [id, setId] = React.useState<string>('');
  const query = useQuery({
    queryKey: ['patch-proposals', conversationId, cursor],
    queryFn: () => api.patchProposals(conversationId, cursor),
    refetchOnWindowFocus: false,
  });
  const p = query.isError
    ? undefined
    : query.data?.items.find((p) => p.id === id && p.conversationId === conversationId);
  return (
    <>
      <div className="candidate-revision-picker">
        <label className="candidate-picker">
          Proposal / immutable revision
          <Select value={p?.id ?? ''} onChange={(e) => setId(e.target.value)}>
            <option value="">Select a proposal revision</option>
            {query.data?.items
              .filter((p) => p.conversationId === conversationId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  Revision {p.revision} / {p.status} / {p.summary}
                </option>
              ))}
          </Select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          title="Refresh proposal decisions"
          aria-label="Refresh proposal decisions"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      <PageControls
        cursor={cursor}
        next={query.data?.nextAfterId}
        change={(next) => {
          setCursor(next);
          setId('');
        }}
        noun="proposals"
      />
      {query.isPending && <p role="status">Loading proposals...</p>}
      {query.isError && <ReadError retry={() => void query.refetch()} label="Proposals" />}
      {query.data?.items.length === 0 && (
        <p>
          No patch proposals in this conversation. No materialization or validation has been
          inferred.
        </p>
      )}
      {id && !p && query.data && (
        <Alert tone="warning">
          Proposal revision unavailable. Select a revision from this page.
        </Alert>
      )}
      {p && (
        <ProposalWorkspace key={`${p.id}:${p.digest}`} proposal={p} currentHead={currentHead} />
      )}
    </>
  );
}

export function ProposalWorkspace({
  proposal: p,
  currentHead,
}: {
  proposal: PatchProposalView;
  currentHead: string;
}) {
  const [section, setSection] = React.useState<'Patch' | 'Evaluation' | 'Human decision'>('Patch');
  const stale = p.stale || p.headSha !== currentHead;
  return (
    <>
      <header className="candidate-proposal-heading">
        <h3>{p.summary}</h3>
        <p>
          Revision {p.revision} / {p.status} /{' '}
          {p.authorType === 'AI' ? `Assistant: ${p.provider} / ${p.model}` : 'Human revision'} /{' '}
          {relativeTime(p.createdAt)}
        </p>
        <p>
          Original: pinned PR HEAD <code title={p.headSha}>{shortSha(p.headSha)}</code> /{' '}
          {p.fileCount} modified files / {p.changedLines} changed lines
        </p>
        {stale && (
          <Alert tone="warning">
            Stale relative to the recorded PR head. Historical content is retained; acceptance does
            not establish current applicability. No rebase or remote freshness check.
          </Alert>
        )}
        {p.status === 'SUPERSEDED' && (
          <p>Superseded historical revision; not the latest accepted proposal.</p>
        )}
        <details>
          <summary>Proposal provenance and limitations</summary>
          <dl>
            <dt>Proposal identity</dt>
            <dd>{p.id}</dd>
            <dt>Originating turn</dt>
            <dd>{p.turnId}</dd>
            <dt>Parent revision identity</dt>
            <dd>{p.parentId ?? 'None'}</dd>
            <dt>Base</dt>
            <dd>{p.baseSha}</dd>
            <dt>Digest</dt>
            <dd>{p.digest}</dd>
            <dt>Recorded decision</dt>
            <dd>{p.decidedAt ? `${p.status} / ${p.decidedAt}` : 'Not decided'}</dd>
          </dl>
          <p>{p.rationale}</p>
          <p>{p.limitations}</p>
        </details>
      </header>
      <div className="candidate-tabs" role="group" aria-label="Proposal sections">
        {(['Patch', 'Evaluation', 'Human decision'] as const).map((name) => (
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
      </div>
      {section === 'Patch' && <ProposalDiff key={p.id} proposal={p} />}
      {section === 'Evaluation' && (
        <CandidateEvaluation key={p.id} proposal={p} currentHead={currentHead} />
      )}
      {section === 'Human decision' && <PatchProposalCard key={p.id} proposal={p} decisionOnly />}
    </>
  );
}

export function ProposalDiff({ proposal: p }: { proposal: PatchProposalView }) {
  const [path, setPath] = React.useState(p.files[0]?.path ?? '');
  const file = p.files.find((f) => f.path === path);
  const patch = React.useMemo(() => proposalPatch(file?.diff), [file?.diff]);
  return (
    <div className="candidate-code-layout">
      <nav aria-label="Proposal files">
        <h4>Modified files ({p.fileCount})</h4>
        <ul>
          {p.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                aria-current={f.path === path ? 'true' : undefined}
                onClick={() => setPath(f.path)}
              >
                <FileCode2 size={14} aria-hidden="true" />
                <span>{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="candidate-patch" aria-label="Original versus proposed patch">
        <header>
          <h4>{file?.path ?? 'No file available'}</h4>
          <p>
            Original pinned HEAD &rarr; proposed revision {p.revision}. Canonical server-generated
            hunks, not the imported PR diff or full file blobs.
          </p>
        </header>
        <p role="status">
          {patch.state === 'AVAILABLE'
            ? 'Available canonical patch hunks. Unchanged regions outside hunks are omitted.'
            : patch.state === 'PARTIAL'
              ? 'Partial or inconsistent patch hunks. Omitted content is not inferred.'
              : 'Patch unavailable. No code has been reconstructed.'}
        </p>
        {patch.hunks.length > 0 && (
          <div
            className="review-code-scroll"
            tabIndex={0}
            aria-label="Proposal unified diff, horizontal scrolling available"
          >
            <table className="review-code-table">
              <thead>
                <tr>
                  <th>Original</th>
                  <th>Proposed</th>
                  <th>Change</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {patch.hunks.map((h, i) => (
                  <React.Fragment key={i}>
                    <tr className="review-hunk">
                      <td colSpan={4}>{h.header}</td>
                    </tr>
                    {h.lines.map((l, j) => (
                      <tr key={j} className={`review-code-${l.type}`}>
                        <td className="review-coordinate">{l.oldLineNumber}</td>
                        <td className="review-coordinate">{l.newLineNumber}</td>
                        <td
                          aria-label={
                            l.type === 'add' ? 'Added' : l.type === 'del' ? 'Removed' : 'Context'
                          }
                        >
                          {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
                        </td>
                        <td>
                          <code>{l.content || ' '}</code>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {file && (
          <details>
            <summary>File preconditions and supporting evidence</summary>
            <dl>
              <dt>Expected blob</dt>
              <dd>{file.oldBlobSha}</dd>
              <dt>Original content hash</dt>
              <dd>{file.oldContentHash}</dd>
              <dt>Proposed content hash</dt>
              <dd>{file.newContentHash}</dd>
            </dl>
            <p>
              Persisted evidence references: {file.evidenceIds.length}. Open Human decision for the
              existing evidence viewer.
            </p>
          </details>
        )}
      </section>
    </div>
  );
}

export function PageControls({
  cursor,
  next,
  change,
  noun,
}: {
  cursor?: string;
  next?: string | null;
  change: (cursor?: string) => void;
  noun: string;
}) {
  return (
    <div className="candidate-pages">
      {cursor && (
        <Button size="sm" variant="ghost" onClick={() => change()}>
          First {noun}
        </Button>
      )}
      {next && (
        <Button size="sm" variant="ghost" onClick={() => change(next)}>
          More {noun}
        </Button>
      )}
    </div>
  );
}
export function ReadError({ label, retry }: { label: string; retry: () => void }) {
  return (
    <Alert tone="danger">
      {label} could not be loaded. No outcome has been inferred.{' '}
      <Button size="sm" onClick={retry}>
        Retry read
      </Button>
    </Alert>
  );
}
