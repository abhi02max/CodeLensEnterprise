import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConversationDetail,
  EvidenceView,
  InvestigationResult,
  PullRequestFilesView,
} from '@codelens/shared';
import {
  conversationInScope,
  evidenceInTurn,
  evidenceCodeAnchor,
  relatedReviewThreads,
  selectedConversationAnchor,
  currentEvidenceTarget,
} from '../src/lib/investigation-context';
import { workspaceFindings, findingAnchor } from '../src/lib/review-workspace';
import type { ReviewSession } from '../src/lib/types';
import { EvidenceReferenceCard } from '../src/components/workspace/evidence-viewer';
import { ConversationPanel } from '../src/components/workspace/conversation-panel';
import { CommentsPanel } from '../src/components/workspace/comments-panel';
import { api } from '../src/lib/api';
import { setAccessToken } from '../src/lib/api-client';

function fixture() {
  const evidence = {
    id: 'e',
    toolCallId: 'tool',
    provenance: 'EXACT_REVISION',
    sourceType: 'FILE_RANGE',
    observedRevision: 'a'.repeat(40),
    path: 'src/orders.ts',
    side: 'HEAD',
    startLine: 2,
    endLine: 3,
    redacted: false,
    truncated: false,
    trust: 'UNTRUSTED_DATA',
    excerpt: 'newCall();\nfinish();',
    contentHash: 'digest',
    blobHash: 'blob',
    payloadHash: 'payload',
    indexRevision: null,
    sourceId: null,
    method: 'exact Git blob',
    metadata: {},
    observedAt: '2026-10-08T00:00:00Z',
  } as EvidenceView;
  const call = {
    id: 'tool',
    turnId: 'turn',
    tool: 'read_file_range',
    status: 'SUCCESS',
    evidence: [evidence],
  } as InvestigationResult;
  const diff = {
    headSha: evidence.observedRevision,
    files: [
      {
        filename: evidence.path,
        patchAvailability: 'AVAILABLE',
        patchTruncated: false,
        patch: '@@ -1,2 +1,3 @@\n before();\n-oldCall();\n+newCall();\n+finish();',
      },
    ],
  } as PullRequestFilesView;
  return { evidence, call, diff };
}
const trusted = { trusted: true, reason: 'verified snapshot' };
const anchor = (s: ReturnType<typeof fixture>) =>
  evidenceCodeAnchor(s.evidence, s.call, 'turn', trusted, s.diff);

test('exact current-head file range maps uniquely to NEW code coordinates', () => {
  assert.deepEqual(anchor(fixture()), { path: 'src/orders.ts', line: 2 });
});
for (const [name, change] of [
  [
    'indexed context',
    (s) => {
      s.evidence.provenance = 'INDEXED_CONTEXT';
    },
  ],
  [
    'derived evidence',
    (s) => {
      s.evidence.provenance = 'DERIVED';
    },
  ],
  [
    'snapshot evidence',
    (s) => {
      s.evidence.provenance = 'SNAPSHOT';
    },
  ],
  [
    'wrong source type',
    (s) => {
      s.evidence.sourceType = 'RAG_CONTEXT';
    },
  ],
  [
    'wrong revision',
    (s) => {
      s.evidence.observedRevision = 'b'.repeat(40);
    },
  ],
  [
    'missing revision',
    (s) => {
      s.evidence.observedRevision = null;
    },
  ],
  [
    'BASE side',
    (s) => {
      s.evidence.side = 'BASE';
    },
  ],
  [
    'unknown side',
    (s) => {
      s.evidence.side = null;
    },
  ],
  [
    'redacted excerpt',
    (s) => {
      s.evidence.redacted = true;
    },
  ],
  [
    'truncated excerpt',
    (s) => {
      s.evidence.truncated = true;
    },
  ],
  [
    'missing path',
    (s) => {
      s.evidence.path = null;
    },
  ],
  [
    'case mismatch',
    (s) => {
      s.evidence.path = 'Src/orders.ts';
    },
  ],
  [
    'missing start',
    (s) => {
      s.evidence.startLine = null;
    },
  ],
  [
    'fractional line',
    (s) => {
      s.evidence.startLine = 1.5;
    },
  ],
  [
    'invalid range',
    (s) => {
      s.evidence.endLine = 1;
    },
  ],
  [
    'out-of-hunk range',
    (s) => {
      s.evidence.endLine = 4;
    },
  ],
  [
    'over-limit range',
    (s) => {
      s.evidence.endLine = 202;
    },
  ],
  [
    'wrong turn',
    (s) => {
      s.call.turnId = 'foreign';
    },
  ],
  [
    'wrong tool membership',
    (s) => {
      s.evidence.toolCallId = 'foreign';
    },
  ],
  [
    'missing call evidence',
    (s) => {
      s.call.evidence = [];
    },
  ],
  [
    'running tool',
    (s) => {
      s.call.status = 'RUNNING';
    },
  ],
  [
    'failed tool',
    (s) => {
      s.call.status = 'UNAVAILABLE';
    },
  ],
  [
    'timed-out tool',
    (s) => {
      s.call.status = 'TIMEOUT';
    },
  ],
  [
    'cancelled tool',
    (s) => {
      s.call.status = 'CANCELLED';
    },
  ],
  [
    'duplicate file',
    (s) => {
      s.diff.files.push({ ...s.diff.files[0]! });
    },
  ],
  [
    'partial patch',
    (s) => {
      s.diff.files[0]!.patchAvailability = 'PARTIAL';
    },
  ],
  [
    'truncated patch',
    (s) => {
      s.diff.files[0]!.patchTruncated = true;
    },
  ],
  [
    'missing patch',
    (s) => {
      s.diff.files[0]!.patch = null;
    },
  ],
  [
    'ambiguous coordinate',
    (s) => {
      s.diff.files[0]!.patch += '\n@@ -2 +2 @@\n duplicated();';
    },
  ],
] as Array<[string, (s: ReturnType<typeof fixture>) => void]>) {
  test(`${name} cannot offer exact evidence navigation`, () => {
    const s = fixture();
    change(s);
    assert.equal(anchor(s), null);
  });
}
test('unverified diff and absent diff cannot map evidence', () => {
  const s = fixture();
  assert.equal(
    evidenceCodeAnchor(
      s.evidence,
      s.call,
      'turn',
      { trusted: false, reason: 'unverified' },
      s.diff,
    ),
    null,
  );
  assert.equal(evidenceCodeAnchor(s.evidence, s.call, 'turn', trusted), null);
});
test('partial tool outcome can contain a usable exact, untruncated observation', () => {
  const s = fixture();
  s.call.status = 'PARTIAL';
  assert.ok(anchor(s));
});
test('citation membership is checked against the selected turn and tool, not semantic entailment', () => {
  const s = fixture();
  assert.equal(evidenceInTurn(s.call, 'tool', 'turn', s.evidence, 'e'), true);
  assert.equal(evidenceInTurn(s.call, 'tool', 'foreign', s.evidence, 'e'), false);
  assert.equal(
    evidenceInTurn(s.call, 'tool', 'turn', { ...s.evidence, toolCallId: 'foreign' }, 'e'),
    false,
  );
  assert.equal(evidenceInTurn(s.call, 'tool', 'turn', s.evidence, 'fabricated'), false);
});
const session = () =>
  ({
    pullRequestId: 'pr',
    run: { id: 'run', headSha: 'a'.repeat(40), stale: false },
    findings: [
      {
        id: 'finding',
        fingerprint: 'fingerprint',
        message: 'Static finding',
        ruleId: 'rule',
        path: 'src/orders.ts',
        line: 2,
      },
    ],
    aiReview: { findings: [{ title: 'AI advice', path: 'src/orders.ts', line: 2, evidence: [] }] },
    comments: [
      { id: 'linked', findingFingerprint: 'fingerprint' },
      { id: 'same-path', path: 'src/orders.ts', line: 2, findingFingerprint: null },
    ],
  }) as unknown as ReviewSession;
test('selection derives explicit static/AI bindings without inventing exact AI anchors', () => {
  const s = session(),
    findings = workspaceFindings(s);
  assert.deepEqual(selectedConversationAnchor(findings[0], s), {
    kind: 'STATIC_FINDING',
    findingId: 'finding',
  });
  assert.deepEqual(selectedConversationAnchor(findings[1], s), {
    kind: 'AI_FINDING',
    reviewRunId: 'run',
    findingIndex: 0,
  });
  assert.equal(findingAnchor(findings[1]!, s, trusted, fixture().diff).mapped, false);
  assert.equal(selectedConversationAnchor(undefined, s), null);
});
test('related review threads require exact finding fingerprint, never guessed coordinates', () => {
  const s = session(),
    findings = workspaceFindings(s);
  assert.deepEqual(
    relatedReviewThreads(findings[0], s).map((c) => c.id),
    ['linked'],
  );
  assert.deepEqual(relatedReviewThreads(findings[1], s), []);
});
test('conversation read composition rejects foreign PR, conversation and message turn', () => {
  const detail = {
    conversation: { id: 'conversation', pullRequestId: 'pr' },
    messages: [{ conversationId: 'conversation', turn: { conversationId: 'conversation' } }],
  } as ConversationDetail;
  assert.equal(conversationInScope(detail, 'conversation', 'pr'), true);
  assert.equal(conversationInScope(detail, 'foreign', 'pr'), false);
  assert.equal(conversationInScope(detail, 'conversation', 'foreign'), false);
  detail.messages[0]!.turn.conversationId = 'foreign';
  assert.equal(conversationInScope(detail, 'conversation', 'pr'), false);
});
test('evidence rendering labels trust, missing revision, truncation and redaction without HTML execution', () => {
  const s = fixture();
  s.evidence.observedRevision = null;
  s.evidence.redacted = true;
  s.evidence.truncated = true;
  s.evidence.excerpt = '<script>execute()</script>';
  const html = renderToStaticMarkup(<EvidenceReferenceCard evidence={s.evidence} />);
  for (const text of [
    'UNTRUSTED_DATA',
    'Source revision unavailable',
    'Truncated excerpt',
    'Sensitive patterns redacted',
    '&lt;script&gt;',
  ])
    assert.ok(html.includes(text));
  assert.doesNotMatch(html, /<script>|Return to matching PR code/);
});
test('historical indexed evidence never equates similarity to confidence', () => {
  const s = fixture();
  s.evidence.provenance = 'INDEXED_CONTEXT';
  const html = renderToStaticMarkup(
    <EvidenceReferenceCard evidence={s.evidence} currentHeadSha={'b'.repeat(40)} />,
  );
  assert.match(html, /similarity is not confidence/);
  assert.match(html, /Historical evidence revision/);
});
test('opening collaborator loads no tool detail, creates no conversation and submits no question', () => {
  const client = new QueryClient();
  client.setQueryData(['conversations', 'pr', undefined], { items: [], nextAfterId: null });
  const calls: string[] = [],
    original = api.createConversation;
  api.createConversation = (async () => {
    calls.push('create');
    throw new Error();
  }) as typeof original;
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConversationPanel compact sessionId="pr" />
      </QueryClientProvider>,
    );
    assert.match(html, /No conversations yet/);
    assert.match(html, /not automatically sent/);
    assert.match(html, /New conversation binding: Pull request/);
    assert.doesNotMatch(html, /Turn execution|Observed evidence/);
    assert.deepEqual(calls, []);
  } finally {
    api.createConversation = original;
    client.clear();
  }
});
test('existing recorded conversation shows roles and citations separately from review comments', () => {
  const client = new QueryClient();
  client.setQueryData(['conversations', 'pr', undefined], { items: [], nextAfterId: null });
  client.setQueryData(['conversation', 'conversation', 0], {
    conversation: {
      id: 'conversation',
      pullRequestId: 'pr',
      title: 'Recorded discussion',
      anchor: { kind: 'PR' },
    },
    messages: [
      {
        id: 'message',
        conversationId: 'conversation',
        kind: 'ASSISTANT',
        sequence: 2,
        content: 'Advisory answer',
        createdAt: '2026-10-08',
        turn: { id: 'turn', conversationId: 'conversation', headSha: 'a'.repeat(40) },
        citations: [{ evidenceId: 'e', strength: 'INFERRED', claim: 'Limited inference' }],
      },
    ],
    nextAfterSequence: null,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConversationPanel sessionId="pr" controlledId="conversation" />
    </QueryClientProvider>,
  );
  assert.match(html, /Assistant/);
  assert.match(html, /Inferred: Limited inference/);
  assert.match(html, /no live token stream/);
  assert.match(html, /Proposal and candidate actions/);
  assert.doesNotMatch(html, /Observed evidence|Apply proposal/);
  client.clear();
});
test('read-only comment permission hides composer while preserving readable thread state', () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CommentsPanel
        compact
        sessionId="pr"
        comments={[]}
        canComment={false}
        canModerate={false}
        currentUserId={null}
        draftAnchor={null}
        onClearAnchor={() => {}}
      />
    </QueryClientProvider>,
  );
  assert.match(html, /does not allow commenting/);
  assert.doesNotMatch(html, /<textarea|>Comment<|>Resolve</);
  client.clear();
});

test('tool history pagination uses the existing bounded GET contract and encoded turn identity', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  setAccessToken('synthetic-local-test-token');
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ items: [], nextAfterSequence: null }), { status: 200 });
  }) as typeof fetch;
  try {
    await api.investigations('turn/with space', 12);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, 'GET');
    assert.ok(
      requests[0]!.url.endsWith(
        '/collaboration-turns/turn%2Fwith%20space/evidence?afterSequence=12',
      ),
    );
  } finally {
    globalThis.fetch = original;
    setAccessToken(null);
  }
});

test('an evidence navigation highlight cannot silently retarget a different or unverified refreshed head', () => {
  const target = { path: 'src/orders.ts', line: 12, headSha: 'a'.repeat(40) };
  assert.equal(currentEvidenceTarget(target, trusted, target.headSha), target);
  assert.equal(currentEvidenceTarget(target, trusted, 'b'.repeat(40)), null);
  assert.equal(
    currentEvidenceTarget(target, { trusted: false, reason: 'incoherent refresh' }, target.headSha),
    null,
  );
  assert.equal(currentEvidenceTarget(target, trusted), null);
  assert.equal(currentEvidenceTarget(null, trusted, target.headSha), null);
});
