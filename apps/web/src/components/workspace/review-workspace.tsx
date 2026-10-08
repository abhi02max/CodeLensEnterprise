'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, FileCode2, ListFilter, PanelRight, RefreshCw, X } from 'lucide-react';
import type { PullRequestFilesView } from '@codelens/shared';
import { Button, Alert, Skeleton } from '@/components/ui/primitives';
import { RiskBadge, RunStatusBadge, SeverityBadge } from '@/components/risk';
import { AnalyzeButton } from '@/components/analyze-button';
import { reviewsHref } from '@/lib/review-inbox';
import { shortSha } from '@/lib/format';
import {
  diffIdentity,
  findingAnchor,
  workspaceFindings,
  type WorkspaceFinding,
  type PrDiffIdentity,
} from '@/lib/review-workspace';
import type { ReviewSession } from '@/lib/types';
import { ReviewDiff } from './review-diff';

export type ReviewMode = 'Changes' | 'Discussion' | 'Analysis' | 'Decision';
export function ReviewWorkspace({
  session,
  detail,
  diff,
  diffLoading,
  diffError,
  refresh,
  support,
  discuss,
}: {
  session: ReviewSession;
  detail?: PrDiffIdentity;
  diff?: PullRequestFilesView;
  diffLoading: boolean;
  diffError: boolean;
  refresh: () => void;
  support: (mode: ReviewMode) => React.ReactNode;
  discuss: (finding: WorkspaceFinding) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const center = React.useRef<HTMLDivElement>(null);
  const [mode, setMode] = React.useState<ReviewMode>('Changes');
  const [navMode, setNavMode] = React.useState<'Files' | 'Findings'>('Files');
  const [path, setPath] = React.useState<string | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [drawer, setDrawer] = React.useState<'navigation' | 'context' | null>(null);
  const [wideContext, setWideContext] = React.useState(true);
  const [filter, setFilter] = React.useState('');
  const findings = React.useMemo(() => workspaceFindings(session), [session]);
  const identity =
    detail && diff
      ? diffIdentity(session, detail, diff)
      : { trusted: false, reason: 'Diff not loaded.' };
  const file = diff?.files.find((f) => f.filename === path) ?? diff?.files[0];
  const selected = findings.find((f) => f.key === selectedKey);
  const fileExplanation = session.aiReview?.fileExplanations.find((f) => f.path === file?.filename);
  const anchors = React.useMemo(() => {
    const coordinates = new Map<string, Map<number, number>>();
    return new Map(
      findings.map((f) => [
        f.key,
        diff
          ? findingAnchor(f, session, identity, diff, coordinates)
          : { mapped: false as const, reason: 'Diff not loaded.' },
      ]),
    );
  }, [findings, session, diff, identity.trusted, identity.reason]);
  const markers = new Map<number, WorkspaceFinding[]>();
  for (const f of findings) {
    const anchor = anchors.get(f.key);
    if (anchor?.mapped && anchor.path === file?.filename)
      markers.set(anchor.line, [...(markers.get(anchor.line) ?? []), f]);
  }
  React.useEffect(() => {
    let frame = 0;
    const measure = () =>
      root.current?.style.setProperty(
        '--review-height',
        `${Math.max(320, window.innerHeight - root.current.getBoundingClientRect().top)}px`,
      );
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    if (root.current?.parentElement) observer.observe(root.current.parentElement);
    observer.observe(document.body);
    const shellHeader = document.querySelector('header');
    if (shellHeader) observer.observe(shellHeader);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  React.useEffect(() => {
    if (!selected) return;
    const anchor = anchors.get(selected.key);
    if (anchor?.mapped)
      center.current
        ?.querySelector(`[data-new-line="${anchor.line}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, file?.filename, anchors]);
  const chooseFinding = (finding: WorkspaceFinding) => {
    setSelectedKey(finding.key);
    if (diff?.files.some((f) => f.filename === finding.path)) setPath(finding.path);
    if (window.innerWidth < 1440 || !wideContext) setDrawer('context');
    else setDrawer(null);
  };
  const navigation = (
    <>
      <div className="review-nav-tabs" role="group" aria-label="Review navigation">
        {(['Files', 'Findings'] as const).map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            aria-pressed={navMode === name}
            onClick={() => setNavMode(name)}
          >
            {name} ({name === 'Files' ? (diff?.files.length ?? 0) : findings.length})
          </Button>
        ))}
      </div>
      {navMode === 'Files' ? (
        <>
          <label className="review-file-filter">
            Filter files
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <ul className="review-nav-list">
            {diff?.files
              .filter((f) => f.filename.toLowerCase().includes(filter.toLowerCase()))
              .map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-current={file?.filename === f.filename ? 'true' : undefined}
                    onClick={() => {
                      setPath(f.filename);
                      setSelectedKey(null);
                      setDrawer(null);
                      center.current?.scrollTo(0, 0);
                    }}
                  >
                    <span className="review-path">
                      <FileCode2 size={14} aria-hidden="true" />
                      {f.filename}
                    </span>
                    <span className="review-file-meta">
                      {f.status} / +{f.additions} -{f.deletions}
                      <br />
                      {f.patchAvailability}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {diff && diff.files.length === 0 && (
            <p className="review-muted">No changed files in this response.</p>
          )}
          {diff &&
            diff.files.length > 0 &&
            !diff.files.some((f) => f.filename.toLowerCase().includes(filter.toLowerCase())) && (
              <p className="review-muted">No files match this filter.</p>
            )}
          {!diff && (
            <p className="review-muted">File list {diffLoading ? 'loading' : 'unavailable'}.</p>
          )}
        </>
      ) : (
        <>
          {!session.analyzed && <p className="review-muted">Not analysed yet.</p>}
          {session.analyzed && findings.length === 0 && (
            <p className="review-muted">
              No findings in this analysis scope. This is not a safety verdict.
            </p>
          )}
          <ul className="review-nav-list">
            {findings.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  aria-current={selectedKey === f.key ? 'true' : undefined}
                  onClick={() => chooseFinding(f)}
                >
                  <span className="review-finding-label">
                    <SeverityBadge severity={f.severity as FindingSeverity} />
                    <span>{f.source === 'AI' ? 'AI advisory' : 'Static'}</span>
                  </span>
                  <span>{f.title}</span>
                  <span className="review-file-meta">
                    {f.path ?? 'No path'}
                    {f.line ? `:${f.line}` : ''} / {anchors.get(f.key)?.mapped ? 'NEW' : 'UNMAPPED'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
  const context = (
    <>
      <h2>{selected ? 'Finding context' : file ? 'File context' : 'Review context'}</h2>
      {selected ? (
        <>
          <div className="review-finding-label">
            <SeverityBadge severity={selected.severity as FindingSeverity} />
            <span>{selected.source === 'AI' ? 'AI advisory' : 'Static analysis'}</span>
          </div>
          <h3>{selected.title}</h3>
          <p>{selected.explanation}</p>
          <p className="review-path">
            {selected.path ?? 'No path'}
            {selected.line ? `:${selected.line}` : ''}
          </p>
          <p className="review-anchor-state">
            {anchors.get(selected.key)?.mapped
              ? 'Mapped to NEW-side line in this verified diff.'
              : `UNMAPPED: ${(anchors.get(selected.key) as { reason?: string })?.reason}`}
          </p>
          {selected.staticFinding?.snippet && (
            <>
              <h3>Recorded finding snippet (not the PR diff)</h3>
              <pre className="review-context-snippet">
                <code>{selected.staticFinding.snippet}</code>
              </pre>
            </>
          )}
          {selected.suggestion && (
            <>
              <h3>Advisory suggestion</h3>
              <pre className="review-context-snippet">
                <code>{selected.suggestion}</code>
              </pre>
            </>
          )}
          {selected.path &&
            selected.line &&
            findings.filter((f) => f.path === selected.path && f.line === selected.line).length >
              1 && (
              <details>
                <summary>Other findings at this reported location</summary>
                {findings
                  .filter(
                    (f) =>
                      f.key !== selected.key &&
                      f.path === selected.path &&
                      f.line === selected.line,
                  )
                  .map((f) => (
                    <Button key={f.key} size="sm" variant="ghost" onClick={() => chooseFinding(f)}>
                      {f.source}: {f.title}
                    </Button>
                  ))}
              </details>
            )}
          {selected.evidence.length > 0 && (
            <details>
              <summary>Referenced tool runs ({selected.evidence.length})</summary>
              <ul>
                {selected.evidence.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
              <p>Model-provided references, not exact-source anchors.</p>
            </details>
          )}
          {selected.staticFinding && session.permissions.canComment && (
            <Button
              size="sm"
              onClick={() => {
                discuss(selected);
                setMode('Discussion');
                setDrawer(null);
              }}
            >
              Discuss finding
            </Button>
          )}
        </>
      ) : (
        <>
          {file && (
            <>
              <p className="review-path">{file.filename}</p>
              <p>
                {file.status} / {file.patchAvailability}
              </p>
              <p>
                Recorded change: +{file.additions} / -{file.deletions}
              </p>
            </>
          )}
          <p>{identity.reason}</p>
          {fileExplanation && (
            <details>
              <summary>Recorded AI file explanation (advisory)</summary>
              <p>{fileExplanation.whatChanged}</p>
              <p>{fileExplanation.whyItMatters}</p>
              <ul>
                {fileExplanation.concerns.map((concern) => (
                  <li key={concern}>{concern}</li>
                ))}
              </ul>
            </details>
          )}
          {session.run && (
            <p>
              Analysis head {shortSha(session.run.headSha)}
              {session.run.stale ? ' / stale' : ''}
            </p>
          )}
        </>
      )}
      <details>
        <summary>Recorded risk and policy</summary>
        {session.risk ? (
          <>
            <RiskBadge level={session.risk.level} score={session.risk.score} />
            <p>Stored ML risk; see Analysis for model evidence. Not a code safety verdict.</p>
          </>
        ) : (
          <p>Risk unavailable. No zero score has been inferred.</p>
        )}
        <p>
          CodeLens policy gate: {session.gate.readyToMerge ? 'Ready' : 'Blocked'} (not GitHub merge
          authority).
        </p>
      </details>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setMode('Analysis');
          setDrawer(null);
        }}
      >
        Analysis evidence
      </Button>
    </>
  );
  return (
    <div
      className="review-workspace -mx-4 -my-6 sm:-mx-6"
      ref={root}
      data-context={wideContext ? 'open' : 'closed'}
    >
      <header className="review-workspace-header">
        <div className="review-header-top">
          <Link
            aria-label="Back to Reviews"
            href={reviewsHref({ repositoryId: session.repository.id })}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Reviews
          </Link>
          <span>
            {session.repository.fullName} #{session.pullRequest.number}
          </span>
          <span>
            {session.pullRequest.state}
            {session.pullRequest.draft ? ' / draft' : ''}
          </span>
        </div>
        <div className="review-title-row">
          <h1>{session.pullRequest.title}</h1>
          {session.permissions.canTriggerAnalysis && (
            <AnalyzeButton
              pullRequestId={session.pullRequestId}
              size="sm"
              variant="ghost"
              onComplete={refresh}
            />
          )}
        </div>
        <div className="review-header-meta">
          <span>{session.pullRequest.author.login}</span>
          <span>
            {session.pullRequest.headRef} &rarr; {session.pullRequest.baseRef}
          </span>
          <span title={session.pullRequest.headSha}>
            Recorded head {shortSha(session.pullRequest.headSha)}
          </span>
          <span className="review-counts">
            +{session.pullRequest.additions} / -{session.pullRequest.deletions} /{' '}
            {session.pullRequest.changedFiles} files
          </span>
          {session.run ? <RunStatusBadge status={session.run.status} /> : <span>Not analysed</span>}
          {session.risk ? (
            <span>
              Stored ML <RiskBadge score={session.risk.score} level={session.risk.level} />
            </span>
          ) : (
            <span>ML risk unavailable</span>
          )}
        </div>
      </header>
      <div className="review-mode-bar">
        <div role="group" aria-label="Review views">
          {(['Changes', 'Discussion', 'Analysis', 'Decision'] as const).map((name) => (
            <Button
              key={name}
              size="sm"
              variant="ghost"
              aria-pressed={mode === name}
              onClick={() => {
                setMode(name);
                setDrawer(null);
              }}
            >
              {name}
            </Button>
          ))}
        </div>
        <div className="review-tools">
          <Button
            size="sm"
            variant="ghost"
            title="Refresh stored review and diff"
            aria-label="Refresh stored review and diff"
            onClick={refresh}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>
      {mode === 'Changes' ? (
        <>
          <div className="review-mobile-tools">
            <Button size="sm" variant="ghost" onClick={() => setDrawer('navigation')}>
              <ListFilter size={16} />
              Files &amp; findings
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDrawer('context')}>
              <PanelRight size={16} />
              Context
            </Button>
          </div>
          <div className="review-desktop-tools">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={wideContext}
              onClick={() => {
                if (window.innerWidth >= 1440) setWideContext((v) => !v);
                else setDrawer('context');
              }}
            >
              <PanelRight size={16} />
              Context
            </Button>
          </div>
          <div className="review-workspace-body">
            <nav className="review-navigation" aria-label="Files and findings">
              {navigation}
            </nav>
            <div
              className="review-code-center"
              ref={center}
              role="region"
              aria-label="PR changes"
              tabIndex={0}
            >
              {diffLoading ? (
                <div aria-label="Loading PR diff" role="status" className="review-loading">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-64 w-full" />
                </div>
              ) : diffError || !detail || !diff ? (
                <div className="review-message">
                  <Alert tone="warning" title="Could not load PR diff">
                    Review discussion and decisions remain accessible. Retry reads without importing
                    or analysing.
                  </Alert>
                  <Button size="sm" onClick={refresh}>
                    Retry diff reads
                  </Button>
                </div>
              ) : (
                <>
                  <div className="review-snapshot-state" role="status">
                    {identity.trusted
                      ? `VERIFIED snapshot / files ${diff.diffRevision.fileSet} / patches ${diff.diffRevision.patches} / base ${shortSha(diff.baseSha)} / merge base ${shortSha(diff.diffRevision.mergeBaseSha)}`
                      : identity.reason}
                    {session.run?.stale && ' / Analysis is out of date.'}
                  </div>
                  {file ? (
                    <ReviewDiff
                      file={file}
                      identity={identity}
                      markers={markers}
                      selectedKey={selectedKey}
                      onSelect={chooseFinding}
                    />
                  ) : (
                    <p className="review-message">
                      No changed files in the returned {diff.diffRevision.fileSet.toLowerCase()}{' '}
                      file set.
                    </p>
                  )}
                </>
              )}
            </div>
            {wideContext && (
              <aside className="review-context" aria-label="Selection context">
                {context}
              </aside>
            )}
          </div>
          <ReviewDrawer
            open={drawer !== null}
            title={drawer === 'navigation' ? 'Files and findings' : 'Selection context'}
            onClose={() => setDrawer(null)}
          >
            {drawer === 'navigation' ? navigation : context}
          </ReviewDrawer>
        </>
      ) : (
        <div
          className="review-support-scroll"
          role="region"
          aria-label={`${mode} view`}
          tabIndex={0}
        >
          {support(mode)}
        </div>
      )}
    </div>
  );
}

type FindingSeverity = React.ComponentProps<typeof SeverityBadge>['severity'];

function ReviewDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const origin = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (open && !ref.current?.open) {
      origin.current = document.activeElement as HTMLElement;
      ref.current?.showModal();
    } else if (!open && ref.current?.open) {
      ref.current.close();
      if (origin.current?.isConnected) origin.current.focus();
    }
  }, [open]);
  React.useEffect(
    () => () => {
      if (origin.current?.isConnected) origin.current.focus();
    },
    [],
  );
  return (
    <dialog
      ref={ref}
      className="review-drawer"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Close panel"
          title="Close panel"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
      </header>
      <div className="review-drawer-content">{children}</div>
    </dialog>
  );
}
