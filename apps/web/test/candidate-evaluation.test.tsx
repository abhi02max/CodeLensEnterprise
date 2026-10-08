import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  PatchProposalView,
  PatchApplicationView,
  ValidationView,
  ValidationMlView,
  ValidationAiView,
} from '@codelens/shared';
import {
  applicationMatches,
  materializedAttempt,
  validationMatches,
  mlMatches,
  aiMatches,
  proposalPatch,
  executionActive,
} from '../src/lib/candidate-evaluation';
import {
  ProposalDiff,
  ProposalWorkspace,
  CandidateWorkspace,
} from '../src/components/workspace/candidate-workspace';
import {
  CandidateEvaluation,
  PairedChecks,
  MaterializationEvidence,
} from '../src/components/workspace/candidate-evaluation';
import { ValidationMlPanel } from '../src/components/workspace/validation-ml-panel';
import { ValidationAiPanel } from '../src/components/workspace/validation-ai-panel';
import { ValidationStaticPanel } from '../src/components/workspace/validation-static-panel';
import type { ReviewSession } from '../src/lib/types';

function fixture() {
  const proposal: PatchProposalView = {
    id: 'proposal',
    conversationId: 'conversation',
    turnId: 'turn',
    attemptId: null,
    parentId: null,
    revision: 1,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    authorType: 'AI',
    authorId: 'author',
    provider: 'provider',
    model: 'model',
    summary: 'Bound input',
    rationale: 'Review the input bound.',
    limitations: 'Not applied or tested.',
    digest: 'd'.repeat(64),
    fileCount: 1,
    changedLines: 2,
    status: 'ACCEPTED',
    createdAt: '2026-10-08T00:00:00Z',
    decidedAt: '2026-10-08T00:01:00Z',
    decidedById: 'human',
    stale: false,
    files: [
      {
        path: 'src/input.ts',
        operation: 'MODIFY',
        oldBlobSha: 'c'.repeat(40),
        oldContentHash: 'e'.repeat(64),
        newContentHash: 'f'.repeat(64),
        diff: '--- src/input.ts\n+++ src/input.ts\n@@ -1,2 +1,2 @@\n const input = read();\n-use(input);\n+use(bound(input));\n',
        edits: [
          {
            startLine: 2,
            endLine: 2,
            expectedText: 'use(input);',
            replacement: 'use(bound(input));',
          },
        ],
        evidenceIds: ['evidence'],
      },
    ],
  };
  const application: PatchApplicationView = {
    id: 'application',
    proposalId: proposal.id,
    proposalRevision: 1,
    proposalDigest: proposal.digest,
    headSha: proposal.headSha,
    baseSha: proposal.baseSha,
    requestedById: 'human',
    status: 'APPLIED',
    cleanup: 'DISPOSED',
    failureCategory: null,
    executorImage: 'image',
    policyVersion: 'policy',
    stale: false,
    createdAt: proposal.createdAt,
    deadlineAt: proposal.createdAt,
    completedAt: proposal.createdAt,
    limitations: 'Materialized only, not tested.',
    attempts: [
      {
        generation: 1,
        status: 'APPLIED',
        cleanup: 'DISPOSED',
        failureCategory: null,
        jobId: 'job',
        startedAt: proposal.createdAt,
        completedAt: proposal.createdAt,
        snapshotDigest: '1'.repeat(64),
        manifestDigest: '2'.repeat(64),
        files: [
          {
            path: proposal.files[0]!.path,
            oldBlobSha: proposal.files[0]!.oldBlobSha,
            oldContentHash: proposal.files[0]!.oldContentHash,
            contentHash: proposal.files[0]!.newContentHash,
            byteLength: 50,
          },
        ],
      },
    ],
  };
  const validation: ValidationView = {
    id: 'validation',
    applicationId: application.id,
    proposalId: proposal.id,
    proposalRevision: 1,
    proposalDigest: proposal.digest,
    headSha: proposal.headSha,
    snapshotDigest: '1'.repeat(64),
    candidateDigest: '2'.repeat(64),
    image: 'image',
    bundleDigest: '3'.repeat(64),
    configurationDigest: '4'.repeat(64),
    profiles: ['typescript-typecheck-v1'],
    state: 'COMPLETED',
    outcome: 'BOTH_PASS',
    cleanup: 'DISPOSED',
    failureCategory: null,
    stale: false,
    limitations: 'Not a safety certificate.',
    createdAt: proposal.createdAt,
    updatedAt: proposal.createdAt,
    deadlineAt: proposal.createdAt,
    completedAt: proposal.createdAt,
    steps: (['ORIGINAL', 'PATCHED'] as const).map((side, i) => ({
      id: `step-${i}`,
      profile: 'typescript-typecheck-v1',
      profileVersion: 1,
      side,
      inputDigest: '5'.repeat(64),
      resultDigest: '6'.repeat(64),
      outcome: 'PASS',
      status: 'COMPLETED',
      observed: {
        started: true,
        exitCode: 0,
        termination: 'EXITED',
        oom: false,
        durationMs: 100,
        cleanup: 'DISPOSED',
        stdout: { excerpt: '', digest: '7'.repeat(64), capturedBytes: 0, complete: true },
        stderr: { excerpt: '', digest: '8'.repeat(64), capturedBytes: 0, complete: true },
      },
      runnerReported: { trusted: false, status: 'AVAILABLE', reportDigest: null, report: null },
      startedAt: proposal.createdAt,
      completedAt: proposal.createdAt,
    })),
    comparisons: [{ profile: 'typescript-typecheck-v1', outcome: 'BOTH_PASS' }],
  };
  const ml: ValidationMlView = {
    id: 'ml',
    validationId: validation.id,
    applicationId: application.id,
    proposalId: proposal.id,
    proposalRevision: 1,
    proposalDigest: proposal.digest,
    baseSha: proposal.baseSha,
    headSha: proposal.headSha,
    snapshotDigest: validation.snapshotDigest,
    candidateDigest: validation.candidateDigest,
    baseSourceDigest: null,
    frozenMetadataDigest: null,
    metadataProvenance: 'Unavailable',
    featureSchemaVersion: 'codelens-risk-features-v1',
    extractorVersion: 'test',
    diffPolicyVersion: 'test',
    staticPolicyVersion: 'test',
    textNormalizationVersion: 'test',
    resultDigest: null,
    createdAt: proposal.createdAt,
    completedAt: proposal.createdAt,
    state: 'COMPLETED',
    outcome: 'UNAVAILABLE',
    deltaTenths: null,
    bandMovement: null,
    failureCategory: 'MODEL_UNAVAILABLE',
    assessments: [],
    stale: false,
    modelIdentity: null,
    limitations: 'Advisory.',
  };
  const ai: ValidationAiView = {
    id: 'ai',
    validationId: validation.id,
    state: 'FAILED',
    lineage: {
      organizationId: 'org',
      repositoryId: 'repo',
      pullRequestId: 'pr',
      validationId: validation.id,
      applicationId: application.id,
      proposalId: proposal.id,
      proposalRevision: 1,
      proposalDigest: proposal.digest,
      baseSha: proposal.baseSha,
      headSha: proposal.headSha,
      snapshotDigest: validation.snapshotDigest,
      candidateDigest: validation.candidateDigest,
      staticIds: ['static-a', 'static-b'],
      mlComparisonId: ml.id,
    },
    result: null,
    failureCategory: 'PROVIDER_UNAVAILABLE',
    requestedProvider: 'provider',
    requestedModel: 'model',
    reportedProvider: null,
    reportedModel: null,
    stale: false,
    coverage: null,
    evidence: [],
    accounting: null,
    packetDigest: null,
    packetVersion: 'validation-ai-evidence-v1',
    promptVersion: 'validation-ai-review-v1',
    schemaVersion: 'validation-ai-result-v1',
    createdAt: proposal.createdAt,
    completedAt: proposal.createdAt,
  };
  return { proposal, application, validation, ml, ai };
}
function render(
  node: React.ReactNode,
  entries: Array<[unknown[], unknown]> = [],
  failedKeys: unknown[][] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, data] of entries) client.setQueryData(key, data);
  for (const queryKey of failedKeys)
    client
      .getQueryCache()
      .find({ queryKey })
      ?.setState({ status: 'error', error: new Error('Read unavailable') });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  client.clear();
  return html;
}

test('exact proposal/application/attempt/validation lineage composes', () => {
  const f = fixture();
  assert.ok(applicationMatches(f.proposal, f.application));
  assert.ok(materializedAttempt(f.proposal, f.application));
  assert.ok(validationMatches(f.proposal, f.application, f.validation));
  assert.ok(mlMatches(f.proposal, f.validation, f.ml));
  assert.ok(aiMatches(f.proposal, f.validation, f.ai));
});
for (const field of [
  'proposalId',
  'proposalRevision',
  'proposalDigest',
  'headSha',
  'baseSha',
] as const)
  test(`application rejects mismatched ${field}`, () => {
    const f = fixture();
    Object.assign(f.application, { [field]: 'foreign' });
    assert.equal(applicationMatches(f.proposal, f.application), false);
    assert.equal(materializedAttempt(f.proposal, f.application), null);
  });
for (const field of [
  'applicationId',
  'proposalId',
  'proposalRevision',
  'proposalDigest',
  'headSha',
  'snapshotDigest',
  'candidateDigest',
] as const)
  test(`validation rejects mismatched ${field}`, () => {
    const f = fixture();
    Object.assign(f.validation, { [field]: 'foreign' });
    assert.equal(validationMatches(f.proposal, f.application, f.validation), false);
  });
for (const state of ['QUEUED', 'PREPARING', 'APPLYING', 'FAILED', 'CANCELLED'] as const)
  test(`materialization ${state} never establishes candidate content`, () => {
    const f = fixture();
    f.application.status = state;
    assert.equal(materializedAttempt(f.proposal, f.application), null);
  });
for (const cleanup of ['NOT_STARTED', 'UNCERTAIN'] as const)
  test(`cleanup ${cleanup} blocks paired validation`, () => {
    const f = fixture();
    f.application.cleanup = cleanup;
    assert.equal(validationMatches(f.proposal, f.application, f.validation), false);
  });
for (const field of ['oldBlobSha', 'oldContentHash', 'contentHash'] as const)
  test(`candidate file ${field} must match proposal`, () => {
    const f = fixture();
    f.application.attempts[0]!.files[0]![field] = 'wrong';
    assert.equal(materializedAttempt(f.proposal, f.application), null);
  });
test('duplicate candidate file paths fail closed', () => {
  const f = fixture();
  f.application.attempts[0]!.files.push(f.application.attempts[0]!.files[0]!);
  assert.equal(materializedAttempt(f.proposal, f.application), null);
});
test('unchanged manifest files are allowed without fabricating proposal files', () => {
  const f = fixture();
  f.application.attempts[0]!.files.push({
    path: 'src/other.ts',
    oldBlobSha: 'c'.repeat(40),
    oldContentHash: '9'.repeat(64),
    contentHash: '9'.repeat(64),
    byteLength: 10,
  });
  assert.ok(materializedAttempt(f.proposal, f.application));
});
test('ML cross-candidate output withheld', () => {
  const f = fixture();
  f.ml.candidateDigest = 'foreign';
  assert.equal(mlMatches(f.proposal, f.validation, f.ml), false);
  const html = render(
    <ValidationMlPanel validationId={f.validation.id} eligible association={f} />,
    [[['validation-ml', f.validation.id], f.ml]],
  );
  assert.match(html, /association mismatch/);
  assert.doesNotMatch(html, /MODEL_UNAVAILABLE/);
});
test('AI cross-revision claims withheld', () => {
  const f = fixture();
  f.ai.lineage.proposalRevision = 2;
  const html = render(
    <ValidationAiPanel validationId={f.validation.id} eligible association={f} />,
    [
      [['validation-ai', f.validation.id], f.ai],
      [['validation-ml', f.validation.id], f.ml],
    ],
  );
  assert.match(html, /association mismatch/);
  assert.doesNotMatch(html, /PROVIDER_UNAVAILABLE/);
});
test('missing patch is unavailable rather than binary or reconstructed code', () => {
  assert.equal(proposalPatch('').state, 'UNAVAILABLE');
});
test('canonical patch count completeness excludes transport terminal newline', () => {
  assert.equal(proposalPatch(fixture().proposal.files[0]!.diff).state, 'AVAILABLE');
});
test('incomplete canonical hunk is visibly partial', () => {
  assert.equal(proposalPatch('@@ -1,3 +1,3 @@\n one\n-old\n+new').state, 'PARTIAL');
});
test('patch preserves addition deletion and context coordinates', () => {
  const lines = proposalPatch(fixture().proposal.files[0]!.diff).hunks[0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.type, l.oldLineNumber, l.newLineNumber]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
    ],
  );
});
test('proposal code comparison is not imported PR or full candidate blobs', () => {
  const f = fixture();
  const html = render(<ProposalDiff proposal={f.proposal} />);
  assert.match(html, /Original pinned HEAD/);
  assert.match(html, /Canonical server-generated hunks/);
  assert.match(html, /not the imported PR diff or full file blobs/);
  assert.match(html, /aria-label="Added"/);
  assert.match(html, /aria-label="Removed"/);
  assert.match(html, /aria-label="Context"/);
});
test('proposal file selection is named and keyboard-native', () => {
  const html = render(<ProposalDiff proposal={fixture().proposal} />);
  assert.match(html, /aria-label="Proposal files"/);
  assert.match(html, /<button type="button" aria-current="true"/);
  assert.match(html, /horizontal scrolling available/);
  assert.match(html, /tabindex="0"/);
});
test('source is escaped not interpreted as HTML', () => {
  const f = fixture();
  f.proposal.files[0]!.diff = '@@ -1 +1 @@\n-old\n+<script>alert(1)</script>';
  const html = render(<ProposalDiff proposal={f.proposal} />);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
test('proposal revision is explicit and default comparison mounts no execution panel', () => {
  const f = fixture();
  const html = render(<ProposalWorkspace proposal={f.proposal} currentHead={f.proposal.headSha} />);
  assert.match(html, /Revision 1/);
  assert.match(html, /Original versus proposed patch/);
  assert.doesNotMatch(html, /Prepare isolated application|Request AI re-review|Accept proposal/);
});
test('stale proposal remains historical without implied rebase', () => {
  const f = fixture();
  const html = render(<ProposalWorkspace proposal={f.proposal} currentHead={'9'.repeat(40)} />);
  assert.match(html, /Stale relative/);
  assert.match(html, /No rebase or remote freshness check/);
});
test('superseded revision is never labeled latest accepted', () => {
  const f = fixture();
  f.proposal.status = 'SUPERSEDED';
  const html = render(<ProposalWorkspace proposal={f.proposal} currentHead={f.proposal.headSha} />);
  assert.match(html, /Superseded historical revision/);
});
test('candidate evidence presents hashes without full blob claim', () => {
  const f = fixture();
  const html = render(
    <MaterializationEvidence proposal={f.proposal} application={f.application} />,
  );
  assert.match(html, /Full candidate blobs are not exposed/);
  assert.match(html, /Modified-file hashes match/);
});
test('missing candidate evidence does not establish materialization', () => {
  const f = fixture();
  f.application.attempts = [];
  assert.match(
    render(<MaterializationEvidence proposal={f.proposal} application={f.application} />),
    /Matching successful candidate file evidence unavailable/,
  );
});
test('paired profile table distinguishes pinned original from patched candidate', () => {
  const html = render(<PairedChecks validation={fixture().validation} />);
  assert.match(html, /Original HEAD/);
  assert.match(html, /Patched candidate/);
  assert.match(html, /BOTH_PASS/);
  assert.match(html, /untrusted runner-reported/);
});
test('missing original step is not a pass', () => {
  const f = fixture();
  f.validation.steps.splice(0, 1);
  assert.match(render(<PairedChecks validation={f.validation} />), /Missing or ambiguous/);
});
test('ambiguous duplicate step is not a pass', () => {
  const f = fixture();
  f.validation.steps.push({ ...f.validation.steps[0]!, id: 'duplicate' });
  assert.match(render(<PairedChecks validation={f.validation} />), /Missing or ambiguous/);
});
test('truncated diagnostic capture has explicit omission wording', () => {
  const f = fixture();
  f.validation.steps[0]!.observed.stdout.complete = false;
  f.validation.steps[0]!.observed.stdout.excerpt = 'bounded output';
  assert.match(
    render(<PairedChecks validation={f.validation} />),
    /Partial capture; omitted output unavailable/,
  );
});
test('empty logs do not infer outcome', () => {
  assert.match(
    render(<PairedChecks validation={fixture().validation} />),
    /No stdout excerpt recorded. No outcome inferred from absence/,
  );
});
test('missing ML remains unavailable without zero delta', () => {
  const f = fixture();
  const html = render(<ValidationMlPanel validationId={f.validation.id} eligible />, [
    [['validation-ml', f.validation.id], null],
  ]);
  assert.match(html, /No ML assessment recorded/);
  assert.doesNotMatch(html, /0\.0 \/ 100/);
});
test('pending materialization read disables execution and names loading', () => {
  const f = fixture();
  const html = render(
    <CandidateEvaluation proposal={f.proposal} currentHead={f.proposal.headSha} />,
  );
  assert.match(html, /Loading materializations/);
  assert.match(html, /disabled=""/);
});
test('failed refresh with cached materialization withholds validation evidence', () => {
  const f = fixture(),
    key = ['patch-applications', f.proposal.id, undefined];
  const html = render(
    <CandidateEvaluation proposal={f.proposal} currentHead={f.proposal.headSha} />,
    [[key, { items: [f.application], nextAfterId: null }]],
    [key],
  );
  assert.match(html, /Materializations unavailable/);
  assert.match(html, /Retry read/);
  assert.doesNotMatch(html, /Matching successful|Validate original/);
});
test('failed ML refresh withholds cached assessment scores', () => {
  const f = fixture(),
    key = ['validation-ml', f.validation.id];
  f.ml.outcome = 'LOWER';
  f.ml.deltaTenths = -100;
  const html = render(
    <ValidationMlPanel validationId={f.validation.id} eligible association={f} />,
    [[key, f.ml]],
    [key],
  );
  assert.match(html, /ML observations could not be loaded/);
  assert.doesNotMatch(html, /PATCHED − ORIGINAL|The model assigned/);
});
test('failed AI refresh withholds cached failure or response', () => {
  const f = fixture(),
    key = ['validation-ai', f.validation.id];
  const html = render(
    <ValidationAiPanel validationId={f.validation.id} eligible association={f} />,
    [
      [key, f.ai],
      [['validation-ml', f.validation.id], f.ml],
    ],
    [key],
  );
  assert.match(html, /AI re-review could not be loaded/);
  assert.doesNotMatch(html, /PROVIDER_UNAVAILABLE/);
});
test('ML feature absence and recorded warnings remain explicit', () => {
  const f = fixture();
  f.ml.assessments = [
    {
      side: 'ORIGINAL',
      featureDigest: null,
      features: null,
      staticResultDigest: null,
      availability: 'UNAVAILABLE',
      scoreTenths: null,
      band: null,
      probabilityMicros: null,
      confidenceMillis: null,
      warnings: ['Recorded limitation'],
      failureCategory: 'SERVICE_UNAVAILABLE',
    },
  ];
  const html = render(
    <ValidationMlPanel validationId={f.validation.id} eligible association={f} />,
    [[['validation-ml', f.validation.id], f.ml]],
  );
  assert.match(html, /ORIGINAL recorded features and warnings/);
  assert.match(html, /Feature inputs unavailable/);
  assert.match(html, /Recorded limitation/);
});
test('failed AI displays no assessment and real recorded failure category', () => {
  const f = fixture();
  const html = render(
    <ValidationAiPanel validationId={f.validation.id} eligible association={f} />,
    [
      [['validation-ai', f.validation.id], f.ai],
      [['validation-ml', f.validation.id], f.ml],
    ],
  );
  assert.match(html, /No assessment/);
  assert.match(html, /PROVIDER_UNAVAILABLE/);
});
test('missing AI does not fabricate a recommendation', () => {
  const f = fixture();
  const html = render(<ValidationAiPanel validationId={f.validation.id} eligible />, [
    [['validation-ai', f.validation.id], null],
    [['validation-ml', f.validation.id], null],
  ]);
  assert.match(html, /No AI re-review recorded/);
});
test('materialization not started retains explicit user action only', () => {
  const f = fixture();
  f.proposal.status = 'PROPOSED';
  const html = render(
    <CandidateEvaluation proposal={f.proposal} currentHead={f.proposal.headSha} />,
    [[['patch-applications', f.proposal.id, undefined], { items: [], nextAfterId: null }]],
  );
  assert.match(html, /No materialization recorded/);
  assert.match(html, /accepted immutable proposal is required/);
  assert.match(html, /disabled=""/);
});
test('real empty conversation list cannot infer candidate data', () => {
  const s = { pullRequestId: 'pr', pullRequest: { headSha: 'a'.repeat(40) } } as ReviewSession;
  const html = render(
    <CandidateWorkspace session={s} conversationId={null} selectConversation={() => {}} />,
    [[['conversations', 'pr', undefined], { items: [], nextAfterId: null }]],
  );
  assert.match(html, /No conversations available/);
  assert.doesNotMatch(html, /Prepare isolated application/);
});
test('foreign conversation does not compose proposal reads', () => {
  const s = { pullRequestId: 'pr', pullRequest: { headSha: 'a'.repeat(40) } } as ReviewSession;
  const html = render(
    <CandidateWorkspace session={s} conversationId="foreign" selectConversation={() => {}} />,
    [
      [
        ['conversations', 'pr', undefined],
        {
          items: [{ id: 'foreign', pullRequestId: 'other-pr', title: 'Foreign secret' }],
          nextAfterId: null,
        },
      ],
    ],
  );
  assert.match(html, /Selected conversation is unavailable/);
  assert.doesNotMatch(html, /Foreign secret/);
});
test('incomplete static coverage never renders zero findings as clean', () => {
  const html = render(<ValidationStaticPanel validationId="validation" active={false} />, [
    [
      ['validation-static', 'validation', {}, undefined],
      {
        analyses: [],
        items: [],
        summary: {},
        nextAfterId: null,
        limitations: 'No complete coverage.',
      },
    ],
  ]);
  assert.match(html, /not a zero-findings result/);
  assert.match(html, /Comparison unavailable/);
});
test('duplicate ORIGINAL static observations cannot establish an authoritative pair', () => {
  const a = {
    side: 'ORIGINAL',
    status: 'COMPLETE',
    reason: null,
    rulesetVersion: 'rules',
    rulesetDigest: 'a',
    configurationDigest: 'b',
    fingerprintVersion: 'v1',
    sourceDigest: 'c',
    inputDigest: 'd',
    resultDigest: 'e',
    findingCount: 0,
    durationMs: 1,
  };
  const html = render(<ValidationStaticPanel validationId="validation" active={false} />, [
    [
      ['validation-static', 'validation', {}, undefined],
      {
        analyses: [a, a],
        items: [],
        summary: { RESOLVED: 0 },
        nextAfterId: null,
        limitations: 'Partial pair.',
      },
    ],
  ]);
  assert.match(html, /Comparison unavailable/);
  assert.match(html, /Static source and analyzer identities/);
  assert.doesNotMatch(html, /RESOLVED: 0/);
});
for (const state of ['QUEUED', 'PREPARING', 'APPLYING', 'RUNNING'])
  test(`${state} is active for selected polling`, () => assert.equal(executionActive(state), true));
for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'APPLIED'])
  test(`${state} never requires terminal polling`, () =>
    assert.equal(executionActive(state), false));
