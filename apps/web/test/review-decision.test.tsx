import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../src/lib/api-client';
import {
  actionFence,
  canDecide,
  currentAnalysis,
  currentVerdict,
  decisionReady,
  safeActionError,
  shareInputValid,
  shareStatus,
} from '../src/lib/review-decision';
import {
  DecisionEvidence,
  DecisionHistory,
  HumanVerdict,
} from '../src/components/workspace/decision-workspace';
import { SharePanel } from '../src/components/workspace/share-panel';
import { ReviewConfirmation } from '../src/components/workspace/review-confirmation';
import type { ReviewSession, ReviewView, ShareLinkView } from '../src/lib/types';

function fixture(): ReviewSession {
  return {
    sessionId: 'pr',
    pullRequestId: 'pr',
    repository: {
      id: 'repo',
      fullName: 'org/repo',
      private: true,
      defaultBranch: 'main',
      primaryLanguage: 'typescript',
      indexStatus: 'NOT_INDEXED',
    },
    pullRequest: {
      id: 'pr',
      number: 1,
      title: 'Controlled change',
      headSha: 'a'.repeat(40),
      merged: false,
      body: null,
      state: 'OPEN',
      draft: false,
      htmlUrl: '',
      author: { login: 'author', avatarUrl: null, userId: null },
      headRef: 'change',
      baseRef: 'main',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      commitCount: 1,
      labels: [],
      githubCreatedAt: null,
      firstReviewedAt: null,
    },
    analyzed: false,
    summary: null,
    metrics: null,
    toolRuns: [],
    comments: [],
    degradation: [],
    run: null,
    risk: null,
    findings: [],
    aiReview: null,
    aiReviewStatus: { state: 'NOT_RUN', reason: null, retryable: false },
    ragContext: { chunkCount: 0, totalTokens: 0, repositoryOverviewCount: 0, chunks: [] },
    reviews: [],
    shareLinks: [],
    gate: {
      readyToMerge: false,
      requiredApprovals: 1,
      currentApprovals: 0,
      blockingReasons: ['Approval required'],
      warnings: [],
      changesRequestedBy: [],
    },
    permissions: {
      canApprove: true,
      canRequestChanges: true,
      canCreateShareLink: true,
      canRevokeShareLink: true,
      canComment: false,
      canModerateComments: false,
      canTriggerAnalysis: false,
      canPostToGithub: false,
      deniedReasons: {},
    },
  };
}
function row(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    id: 'review',
    pullRequestId: 'pr',
    reviewer: { id: 'reviewer', name: 'Reviewer', avatarUrl: null },
    verdict: 'APPROVED',
    summary: 'Bound rationale',
    headSha: 'a'.repeat(40),
    stale: false,
    dismissedFindingCount: 0,
    createdAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}
function link(overrides: Partial<ShareLinkView> = {}): ShareLinkView {
  return {
    id: 'link',
    url: '',
    scope: 'SUMMARY',
    redactCode: true,
    hasPassphrase: true,
    expiresAt: '2026-10-10T00:00:00Z',
    revokedAt: null,
    viewCount: 2,
    lastViewedAt: null,
    createdBy: { id: 'reviewer', name: 'Reviewer' },
    createdAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}
const target = { id: 'pr', repositoryId: 'repo', headSha: 'a'.repeat(40) };
test('coherent persisted PR and repository permit a decision', () =>
  assert.equal(decisionReady(fixture(), target, target.headSha), true));
for (const [label, change] of [
  ['missing read', undefined],
  ['foreign PR', { ...target, id: 'foreign' }],
  ['foreign repository', { ...target, repositoryId: 'foreign' }],
  ['head movement', { ...target, headSha: 'b'.repeat(40) }],
] as const)
  test(`decision rejects ${label}`, () =>
    assert.equal(decisionReady(fixture(), change, target.headSha), false));
test('draft does not migrate to a new head', () => {
  const s = fixture();
  s.pullRequest.headSha = 'b'.repeat(40);
  assert.equal(
    decisionReady(s, { ...target, headSha: s.pullRequest.headSha }, target.headSha),
    false,
  );
});
test('invalid SHA and merged target fail closed', () => {
  const s = fixture();
  assert.equal(decisionReady(s, target, 'short'), false);
  s.pullRequest.merged = true;
  assert.equal(decisionReady(s, target, target.headSha), false);
});
test('session identity mismatch fails closed', () => {
  const s = fixture();
  s.sessionId = 'foreign';
  assert.equal(decisionReady(s, target, target.headSha), false);
});
test('permissions distinguish approval from request changes', () => {
  const s = fixture();
  s.permissions.canApprove = false;
  assert.equal(canDecide(s, 'APPROVED'), false);
  assert.equal(canDecide(s, 'CHANGES_REQUESTED'), true);
});
test('analysis must be complete, nonstale and head bound', () => {
  const s = fixture();
  assert.equal(currentAnalysis(s), false);
  s.analyzed = true;
  s.run = { status: 'COMPLETED', headSha: target.headSha, stale: false } as ReviewSession['run'];
  assert.equal(currentAnalysis(s), true);
  s.run!.stale = true;
  assert.equal(currentAnalysis(s), false);
  s.run!.stale = false;
  s.run!.status = 'FAILED';
  assert.equal(currentAnalysis(s), false);
  s.run!.status = 'COMPLETED';
  s.run!.headSha = 'b'.repeat(40);
  assert.equal(currentAnalysis(s), false);
});
test('history rejects foreign association and preserves historical heads', () => {
  assert.equal(currentVerdict(row(), fixture()), true);
  assert.equal(currentVerdict(row({ pullRequestId: 'foreign' }), fixture()), false);
  assert.equal(currentVerdict(row({ headSha: 'b'.repeat(40) }), fixture()), false);
  assert.equal(currentVerdict(row({ stale: true }), fixture()), false);
});
test('synchronous fence rejects duplicate activations before a render', async () => {
  const f = actionFence();
  assert.equal(f.acquire(), true);
  await Promise.resolve();
  assert.equal(f.acquire(), false);
  f.release();
  assert.equal(f.acquire(), true);
  f.release();
});
for (const status of [400, 401, 403, 404, 409, 422, 500])
  test(`safe ${status} response does not expose server diagnostics`, () => {
    const text = safeActionError(
      new ApiError(status, 'error', 'sensitive-value'),
      'Submit verdict',
    );
    assert.ok(!text.includes('sensitive-value'));
    if (status === 409) assert.match(text, /Refresh and review/);
  });
test('unknown outcome does not fabricate success', () =>
  assert.match(
    safeActionError(new Error('secret'), 'Create share link'),
    /could not be confirmed/,
  ));
test('optional passphrase and bounds match supported input', () => {
  for (const p of ['', '12345678', 'x'.repeat(200)]) assert.equal(shareInputValid(p, 168), true);
  for (const p of ['short', 'x'.repeat(201)]) assert.equal(shareInputValid(p, 168), false);
  for (const h of [0, 2161, 1.5, NaN]) assert.equal(shareInputValid('', h), false);
});
test('revocation overrides local expiry; invalid timestamps are unavailable', () => {
  assert.equal(shareStatus(link({ revokedAt: '2026-10-08T00:00:00Z' }), 0), 'Revoked');
  assert.match(shareStatus(link(), Date.parse('2026-10-11')), /Past recorded expiry.*local clock/);
  assert.equal(shareStatus(link({ expiresAt: 'bad' }), 0), 'Expiry unavailable');
});
test('unavailable analysis is not a clean fabricated summary', () => {
  const html = render(<DecisionEvidence session={fixture()} />);
  assert.match(html, /Historical or partial analysis is not a clean result/);
  assert.ok(!html.includes('0/100'));
});
test('history renders NEEDS_DISCUSSION without a creation control', () => {
  const s = fixture();
  s.reviews = [row({ verdict: 'NEEDS_DISCUSSION' })];
  assert.match(render(<DecisionHistory session={s} />), /Needs discussion/);
  const html = render(
    <HumanVerdict session={s} target={target} currentUserId="reviewer" refresh={() => {}} />,
  );
  assert.ok(!html.includes('value="NEEDS_DISCUSSION"'));
  assert.match(html, /Review verdict/);
});
test('history escapes source and discloses overwrites and incomplete chronology', () => {
  const s = fixture();
  s.reviews = [
    row({ summary: '<script>unsafe()</script>' }),
    row({ id: 'foreign', pullRequestId: 'foreign', summary: 'hidden foreign' }),
  ];
  const html = render(<DecisionHistory session={s} />);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('hidden foreign'));
  assert.match(html, /Same-reviewer, same-head updates replace the row/);
  assert.match(html, /not a complete immutable audit trail/);
  assert.match(html, /Mismatched review records withheld/);
});
test('history reveals pagination limits rather than hiding returned rows', () => {
  const s = fixture();
  s.reviews = Array.from({ length: 12 }, (_, i) => row({ id: String(i) }));
  const html = render(<DecisionHistory session={s} />);
  assert.match(html, /10 of 12/);
  assert.match(html, /Show more recorded decisions/);
  assert.ok(!html.includes('href="/activity"'));
  assert.match(render(<DecisionHistory session={s} auditAllowed />), /href="\/activity"/);
});
test('decision distinguishes PR from proposal and does not submit on render', () => {
  const html = render(
    <HumanVerdict
      session={fixture()}
      target={target}
      currentUserId="reviewer"
      refresh={() => {
        throw Error('render mutation');
      }}
    />,
  );
  assert.match(html, /Proposal acceptance or validation does not approve the PR/);
  assert.match(html, /No live remote GitHub freshness/);
  assert.match(html, /Known persisted head/);
});
test('missing target prevents confirmation', () => {
  const html = render(
    <HumanVerdict
      session={fixture()}
      target={undefined}
      currentUserId="reviewer"
      refresh={() => {}}
    />,
  );
  assert.match(html, /Decision target unavailable or changed/);
  assert.match(html, /<button[^>]*disabled[^>]*>Review verdict<\/button>/);
});
test('sharing respects permissions and does not reveal historical URL fields', () => {
  const s = fixture();
  s.permissions.canCreateShareLink = false;
  s.permissions.canRevokeShareLink = false;
  const html = render(
    <SharePanel
      sessionId="pr"
      permissions={s.permissions}
      shareLinks={[link({ url: 'must-not-display' })]}
    />,
  );
  assert.ok(!html.includes('must-not-display'));
  assert.ok(!html.includes('Review new share link'));
  assert.ok(!html.includes('Review revocation'));
  assert.match(html, /Previously issued URLs and passphrases are not recoverable/);
});
test('sharing presents supported visibility and safe redaction boundaries', () => {
  const s = fixture();
  const html = render(
    <SharePanel
      sessionId="pr"
      permissions={s.permissions}
      shareLinks={[link({ scope: 'FULL' })]}
    />,
  );
  assert.match(html, /value="SUMMARY"/);
  assert.match(html, /value="FULL"/);
  assert.match(html, /type="password"/);
  assert.match(html, /not a frozen decision snapshot/);
  assert.match(html, /does not guarantee removal/);
  assert.match(html, /never appended to the URL/);
  assert.match(html, /Review revocation/);
});
test('share metadata does not silently truncate its returned count', () => {
  const s = fixture();
  const html = render(
    <SharePanel
      sessionId="pr"
      permissions={s.permissions}
      shareLinks={Array.from({ length: 12 }, (_, i) => link({ id: String(i) }))}
    />,
  );
  assert.match(html, /10 of 12/);
  assert.match(html, /Show more share records/);
});
test('confirmation exposes cancel and deliberate confirm, pending disables both', () => {
  const html = render(
    <ReviewConfirmation open title="Submit verdict" busy close={() => {}} confirm={() => {}}>
      Expected head
    </ReviewConfirmation>,
  );
  assert.match(html, /<dialog[^>]*aria-label="Submit verdict"/);
  assert.match(html, /<button[^>]*disabled[^>]*>Cancel<\/button>/);
  assert.match(html, /Confirm submit verdict/);
});

test('preserved page pin prevents remount from adopting a changed head', () => {
  const html = render(
    <HumanVerdict
      session={fixture()}
      target={target}
      initialReviewedHead={'b'.repeat(40)}
      currentUserId="reviewer"
      refresh={() => {}}
    />,
  );
  assert.match(html, /Decision target unavailable or changed/);
  assert.match(html, /I reviewed this persisted head/);
  assert.match(html, /<button[^>]*disabled[^>]*>Review verdict<\/button>/);
});
test('readonly permissions prevent verdict activation', () => {
  const s = fixture();
  s.permissions.canApprove = false;
  s.permissions.canRequestChanges = false;
  const html = render(
    <HumanVerdict session={s} target={target} currentUserId="reader" refresh={() => {}} />,
  );
  assert.match(html, /<button[^>]*disabled[^>]*>Review verdict<\/button>/);
});
test('missing authenticated identity prevents verdict activation', () => {
  const html = render(
    <HumanVerdict session={fixture()} target={target} currentUserId={null} refresh={() => {}} />,
  );
  assert.match(html, /Authenticated reviewer identity unavailable/);
  assert.match(html, /<button[^>]*disabled[^>]*>Review verdict<\/button>/);
});
test('legacy empty revision is not a current-head verdict', () => {
  const s = fixture();
  s.pullRequest.headSha = '';
  assert.equal(currentVerdict(row({ headSha: '' }), s), false);
});
test('missing reviewer and rationale are disclosed rather than fabricated', () => {
  const s = fixture();
  s.reviews = [row({ reviewer: null as unknown as ReviewView['reviewer'], summary: null })];
  const html = render(<DecisionHistory session={s} />);
  assert.match(html, /Reviewer unavailable/);
  assert.match(html, /No rationale recorded/);
});
test('recorded complete analysis distinguishes unavailable ML and AI from zero/agreement', () => {
  const s = fixture();
  s.analyzed = true;
  s.run = { status: 'COMPLETED', headSha: target.headSha, stale: false } as ReviewSession['run'];
  const html = render(<DecisionEvidence session={s} />);
  assert.match(html, /Unavailable; no score inferred/);
  assert.match(html, /NOT_RUN; no AI agreement inferred/);
  assert.match(html, /does not prove exact/);
  assert.ok(!html.includes('0/100'));
});
