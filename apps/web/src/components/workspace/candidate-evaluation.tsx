'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, CheckSquare, X, RefreshCw } from 'lucide-react';
import type { PatchProposalView, PatchApplicationView, ValidationView } from '@codelens/shared';
import { Alert, Button, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import {
  applicationMatches,
  executionActive,
  materializedAttempt,
  validationMatches,
} from '@/lib/candidate-evaluation';
import { ValidationStaticPanel } from './validation-static-panel';
import { ValidationMlPanel } from './validation-ml-panel';
import { ValidationAiPanel } from './validation-ai-panel';

export function CandidateEvaluation({
  proposal,
  currentHead,
}: {
  proposal: PatchProposalView;
  currentHead: string;
}) {
  const client = useQueryClient();
  const requestId = React.useRef<string | null>(null);
  const [cursor, setCursor] = React.useState<string>();
  const [id, setId] = React.useState('');
  const query = useQuery({
    queryKey: ['patch-applications', proposal.id, cursor],
    queryFn: () => api.patchApplications(proposal.id, cursor),
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data?.items.some((a) => a.id === id && executionActive(a.status)) ? 1500 : false,
  });
  const raw = query.data?.items.find((a) => a.id === id);
  const a = !query.isError && raw && applicationMatches(proposal, raw) ? raw : null;
  const blocked = query.data?.items.some(
    (a) => executionActive(a.status) || a.cleanup === 'UNCERTAIN',
  );
  const mutation = useMutation({
    mutationFn: (cancelId?: string) => {
      if (cancelId) return api.cancelPatchApplication(cancelId, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestPatchApplication(proposal.id, {
        requestId: requestId.current,
        expectedProposalRevision: proposal.revision,
        expectedProposalDigest: proposal.digest,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      setCursor(undefined);
      void client.invalidateQueries({ queryKey: ['patch-applications', proposal.id] });
    },
  });
  return (
    <section aria-label="Materialization and evaluation">
      <div className="candidate-heading">
        <div>
          <h4>Isolated materialization</h4>
          <p>
            Materialization records a restricted candidate snapshot, not a change to the PR or a
            test pass.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          title="Refresh materializations"
          aria-label="Refresh materializations"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      <Button
        size="sm"
        disabled={
          proposal.status !== 'ACCEPTED' ||
          mutation.isPending ||
          query.isPending ||
          query.isError ||
          blocked ||
          !!cursor
        }
        onClick={() => mutation.mutate(undefined)}
      >
        <Box size={14} />
        Prepare isolated application
      </Button>
      {proposal.status !== 'ACCEPTED' && (
        <p>
          An accepted immutable proposal is required. Acceptance itself does not execute anything.
        </p>
      )}
      {mutation.isError && (
        <Alert tone="danger">
          Materialization request was not confirmed. Read the recorded state before retrying; no
          success is inferred.
        </Alert>
      )}
      {query.isPending && <p role="status">Loading materializations...</p>}
      {query.isError && (
        <Alert tone="danger">
          Materializations unavailable.{' '}
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry read
          </Button>
        </Alert>
      )}
      <label className="candidate-picker">
        Materialization
        <Select aria-label="Materialization" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Select a materialization</option>
          {query.data?.items.map((item, i) => (
            <option key={item.id} value={item.id}>
              Materialization {i + 1} / {item.status} / {new Date(item.createdAt).toLocaleString()}
            </option>
          ))}
        </Select>
      </label>
      <Paging
        cursor={cursor}
        next={query.data?.nextAfterId}
        change={(c) => {
          setCursor(c);
          setId('');
        }}
        noun="materializations"
      />
      {query.data?.items.length === 0 && (
        <p>No materialization recorded for this proposal revision.</p>
      )}
      {id && !a && query.data && (
        <Alert tone="warning">
          Materialization unavailable or revision identity mismatch. Its results cannot be
          associated with this proposal.
        </Alert>
      )}
      {a && (
        <div key={a.id}>
          <p role="status">
            {a.status} / Cleanup {a.cleanup}
          </p>
          {(a.stale || a.headSha !== currentHead) && (
            <Alert tone="warning">
              Historical candidate: stale relative to the recorded head. No automatic rebase or
              execution.
            </Alert>
          )}
          {a.failureCategory && (
            <Alert tone="warning">Materialization category: {a.failureCategory}</Alert>
          )}
          <p>{a.limitations}</p>
          <MaterializationEvidence proposal={proposal} application={a} />
          {executionActive(a.status) && (
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(a.id)}>
              <X size={14} />
              Cancel isolated application
            </Button>
          )}
          {materializedAttempt(proposal, a) ? (
            <SelectedValidation
              key={a.id}
              proposal={proposal}
              application={a}
              currentHead={currentHead}
            />
          ) : (
            <p>
              Paired validation unavailable until matching materialization results and disposal are
              recorded.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function MaterializationEvidence({
  proposal,
  application,
}: {
  proposal: PatchProposalView;
  application: PatchApplicationView;
}) {
  const attempt = materializedAttempt(proposal, application);
  return (
    <details>
      <summary>Materialized candidate identity and file results</summary>
      <p>
        Full candidate blobs are not exposed. These are recorded file hashes, not a reconstructed
        repository or a second imported PR diff.
      </p>
      <dl>
        <dt>Application</dt>
        <dd>{application.id}</dd>
        <dt>Proposal revision</dt>
        <dd>{application.proposalRevision}</dd>
        <dt>Executor / policy</dt>
        <dd>
          {application.executorImage} / {application.policyVersion}
        </dd>
      </dl>
      {application.attempts.map((a) => (
        <div key={a.generation}>
          <p>
            Attempt {a.generation}: {a.status} / {a.cleanup}
          </p>
          <dl>
            <dt>Snapshot</dt>
            <dd>{a.snapshotDigest ?? 'Not recorded'}</dd>
            <dt>Manifest</dt>
            <dd>{a.manifestDigest ?? 'Not recorded'}</dd>
          </dl>
        </div>
      ))}
      {attempt ? (
        <>
          <p>
            Modified-file hashes match this immutable proposal. The Patch section is its canonical
            proposed change, not full candidate source.
          </p>
          <ul>
            {proposal.files.map((f) => {
              const result = attempt.files.find((r) => r.path === f.path)!;
              return (
                <li key={f.path}>
                  <strong>{f.path}</strong> / {result.byteLength} bytes
                  <code className="block">{result.contentHash}</code>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p>
          Matching successful candidate file evidence unavailable. No candidate code comparison has
          been inferred.
        </p>
      )}
    </details>
  );
}

function SelectedValidation({
  proposal,
  application,
  currentHead,
}: {
  proposal: PatchProposalView;
  application: PatchApplicationView;
  currentHead: string;
}) {
  const client = useQueryClient();
  const requestId = React.useRef<string | null>(null);
  const [cursor, setCursor] = React.useState<string>();
  const [id, setId] = React.useState('');
  const query = useQuery({
    queryKey: ['validations', application.id, cursor],
    queryFn: () => api.validations(application.id, cursor),
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data?.items.some((v) => v.id === id && executionActive(v.state)) ? 1500 : false,
  });
  const raw = query.data?.items.find((v) => v.id === id);
  const v = !query.isError && raw && validationMatches(proposal, application, raw) ? raw : null;
  const blocked = query.data?.items.some(
    (v) => executionActive(v.state) || v.cleanup === 'UNCERTAIN',
  );
  const mutation = useMutation({
    mutationFn: (cancelId?: string) => {
      if (cancelId) return api.cancelValidation(cancelId, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestValidation(application.id, {
        requestId: requestId.current,
        profiles: ['typescript-typecheck-v1', 'vitest-unit-v1'],
      });
    },
    onSuccess: () => {
      requestId.current = null;
      setCursor(undefined);
      void client.invalidateQueries({ queryKey: ['validations', application.id] });
    },
  });
  return (
    <section className="candidate-validation" aria-label="Selected candidate validation">
      <div className="candidate-heading">
        <div>
          <h4>Paired validation</h4>
          <p>
            Original means pinned PR HEAD, not BASE. Patched means this materialized candidate.
            Fixed-profile observations are not proof of safety.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh validations"
          title="Refresh validations"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} />
        </Button>
      </div>
      <Button
        size="sm"
        disabled={
          proposal.status !== 'ACCEPTED' ||
          mutation.isPending ||
          query.isPending ||
          query.isError ||
          blocked ||
          !!cursor
        }
        onClick={() => mutation.mutate(undefined)}
      >
        <CheckSquare size={14} />
        Validate original and patched candidate
      </Button>
      {mutation.isError && (
        <Alert tone="danger">
          Validation request was not confirmed. No pass or remote termination has been inferred.
        </Alert>
      )}
      {query.isPending && <p role="status">Loading validations...</p>}
      {query.isError && (
        <Alert tone="danger">
          Validation observations unavailable.{' '}
          <Button onClick={() => void query.refetch()}>Retry read</Button>
        </Alert>
      )}
      <label className="candidate-picker">
        Validation run
        <Select aria-label="Validation run" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Select a validation run</option>
          {query.data?.items.map((item, i) => (
            <option key={item.id} value={item.id}>
              Run {i + 1} / {item.state} / {item.outcome ?? 'Not compared'} /{' '}
              {new Date(item.createdAt).toLocaleString()}
            </option>
          ))}
        </Select>
      </label>
      <Paging
        cursor={cursor}
        next={query.data?.nextAfterId}
        change={(c) => {
          setCursor(c);
          setId('');
        }}
        noun="validations"
      />
      {query.data?.items.length === 0 && (
        <p>No paired validation recorded. Missing observations are neither a pass nor a failure.</p>
      )}
      {id && !v && query.data && (
        <Alert tone="warning">
          Validation association mismatch or unavailable run. Static, ML and AI evidence is
          withheld.
        </Alert>
      )}
      {v && (
        <div key={v.id}>
          <p role="status">
            {v.state} / {v.outcome ?? 'Not compared'} / Cleanup {v.cleanup}
          </p>
          {(v.stale || v.headSha !== currentHead) && (
            <Alert tone="warning">
              Historical validation: stale relative to the recorded PR head.
            </Alert>
          )}
          {v.failureCategory && (
            <Alert tone="warning">Infrastructure category: {v.failureCategory}</Alert>
          )}
          <ValidationResults proposal={proposal} validation={v} />
          {executionActive(v.state) && (
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(v.id)}>
              <X size={14} />
              Cancel validation
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function ValidationResults({
  proposal,
  validation: v,
}: {
  proposal: PatchProposalView;
  validation: ValidationView;
}) {
  const [section, setSection] = React.useState<'Checks' | 'Static' | 'ML' | 'AI'>('Checks');
  const eligible = v.state === 'COMPLETED' && v.cleanup === 'DISPOSED';
  return (
    <>
      <div className="candidate-tabs" role="group" aria-label="Evaluation evidence">
        {(['Checks', 'Static', 'ML', 'AI'] as const).map((name) => (
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
      {section === 'Checks' && <PairedChecks validation={v} />}
      {section === 'Static' && (
        <ValidationStaticPanel key={v.id} validationId={v.id} active={executionActive(v.state)} />
      )}
      {section === 'ML' && (
        <ValidationMlPanel
          key={v.id}
          validationId={v.id}
          eligible={eligible}
          association={{ proposal, validation: v }}
        />
      )}
      {section === 'AI' && (
        <ValidationAiPanel
          key={v.id}
          validationId={v.id}
          eligible={eligible}
          association={{ proposal, validation: v }}
        />
      )}
      <details>
        <summary>Comparison identity and scope</summary>
        <dl>
          <dt>Validation</dt>
          <dd>{v.id}</dd>
          <dt>Application</dt>
          <dd>{v.applicationId}</dd>
          <dt>Original HEAD</dt>
          <dd>{v.headSha}</dd>
          <dt>Candidate manifest</dt>
          <dd>{v.candidateDigest}</dd>
          <dt>Snapshot</dt>
          <dd>{v.snapshotDigest}</dd>
          <dt>Profiles</dt>
          <dd>{v.profiles.join(', ')}</dd>
          <dt>Image / bundle / configuration</dt>
          <dd>
            {v.image} / {v.bundleDigest} / {v.configurationDigest}
          </dd>
        </dl>
        <p>{v.limitations}</p>
      </details>
    </>
  );
}

export function PairedChecks({ validation: v }: { validation: ValidationView }) {
  return (
    <section aria-label="Original and candidate checks">
      <div className="candidate-table-scroll">
        <table className="candidate-checks">
          <thead>
            <tr>
              <th>Recorded profile</th>
              <th>Original HEAD</th>
              <th>Patched candidate</th>
              <th>Recorded comparison</th>
            </tr>
          </thead>
          <tbody>
            {v.profiles.map((profile) => (
              <tr key={profile}>
                <th>{profile}</th>
                {(['ORIGINAL', 'PATCHED'] as const).map((side) => {
                  const steps = v.steps.filter((s) => s.profile === profile && s.side === side);
                  return (
                    <td key={side}>
                      {steps.length === 1 ? steps[0]!.outcome : 'Missing or ambiguous'}
                    </td>
                  );
                })}
                <td>
                  {v.comparisons.find((c) => c.profile === profile)?.outcome ?? 'Not compared'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Broker observations and untrusted runner-reported summaries are distinct. Only these fixed
        profiles are represented; no coverage percentage is inferred.
      </p>
      {v.steps.map((s) => (
        <details key={s.id}>
          <summary>
            {s.side === 'ORIGINAL' ? 'Original HEAD' : 'Patched candidate'} / {s.profile} /{' '}
            {s.outcome} / diagnostics
          </summary>
          <p>
            Observed: {s.observed.started ? 'Started' : 'Not started'} / exit{' '}
            {s.observed.exitCode ?? 'Unavailable'} / {s.observed.termination} /{' '}
            {s.observed.durationMs} ms / cleanup {s.observed.cleanup} / OOM{' '}
            {s.observed.oom ? 'Yes' : 'No'}
          </p>
          <p>
            Untrusted runner report: {s.runnerReported.status}
            {s.runnerReported.report
              ? ` / ${s.runnerReported.report.passed} passed, ${s.runnerReported.report.failed} failed, ${s.runnerReported.report.total} total`
              : ''}
          </p>
          {(['stdout', 'stderr'] as const).map((stream) => (
            <div key={stream}>
              <p>
                {stream}:{' '}
                {s.observed[stream].complete
                  ? 'Capture complete; displayed excerpt remains bounded'
                  : 'Partial capture; omitted output unavailable'}{' '}
                / captured {s.observed[stream].capturedBytes} bytes
              </p>
              {s.observed[stream].excerpt ? (
                <pre
                  className="candidate-log"
                  tabIndex={0}
                  aria-label={`${s.side} ${s.profile} ${stream} excerpt`}
                >
                  {s.observed[stream].excerpt}
                </pre>
              ) : (
                <p>No {stream} excerpt recorded. No outcome inferred from absence.</p>
              )}
            </div>
          ))}
          <details>
            <summary>Step identities</summary>
            <dl>
              <dt>Input</dt>
              <dd>{s.inputDigest}</dd>
              <dt>Result</dt>
              <dd>{s.resultDigest}</dd>
            </dl>
          </details>
        </details>
      ))}
      {v.steps.length === 0 && <p>No step observations recorded.</p>}
    </section>
  );
}

function Paging({
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
