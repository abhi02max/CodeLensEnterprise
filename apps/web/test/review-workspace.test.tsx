import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PullRequestDetail,
  PullRequestFilesView,
  PullRequestFileView,
} from '@codelens/shared';
import {
  diffIdentity,
  findingAnchor,
  parseUnifiedPatch,
  patchState,
  workspaceFindings,
} from '../src/lib/review-workspace';
import type { ReviewSession } from '../src/lib/types';
import { ReviewDiff } from '../src/components/workspace/review-diff';
import { reviewsHref } from '../src/lib/review-inbox';
import { api } from '../src/lib/api';
import { setAccessToken } from '../src/lib/api-client';
import { ReviewWorkspace } from '../src/components/workspace/review-workspace';

const patch = '@@ -1,2 +1,3 @@\n const before = 1;\n-old();\n+newCall();\n+finish();';
function fixture() {
  const revision = {
    provenance: 'VERIFIED' as const,
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
    fileSet: 'COMPLETE' as const,
    patches: 'COMPLETE' as const,
  };
  const file = {
    id: 'f',
    filename: 'src/order.ts',
    previousFilename: null,
    status: 'MODIFIED',
    additions: 2,
    deletions: 1,
    changes: 3,
    language: 'typescript',
    patch,
    patchTruncated: false,
    patchAvailability: 'AVAILABLE',
    binary: false,
    findingCount: 1,
    flags: {},
  } as PullRequestFileView;
  const session = {
    pullRequestId: 'pr',
    repository: { id: 'repo' },
    pullRequest: { headSha: revision.headSha },
    run: { headSha: revision.headSha, stale: false },
    findings: [
      {
        id: 'finding',
        analyzer: 'STATIC',
        severity: 'HIGH',
        ruleId: 'rule',
        message: 'Check call',
        path: file.filename,
        line: 2,
        preexisting: false,
      },
    ],
    aiReview: null,
  } as unknown as ReviewSession;
  const detail = {
    id: 'pr',
    repository: { id: 'repo' },
    headSha: revision.headSha,
    baseSha: revision.baseSha,
    diffRevision: { ...revision },
  } as PullRequestDetail;
  const diff = {
    pullRequestId: 'pr',
    headSha: revision.headSha,
    baseSha: revision.baseSha,
    diffRevision: { ...revision },
    files: [file],
  } as PullRequestFilesView;
  return { session, detail, diff, file };
}
const render = (state: ReturnType<typeof fixture>, trusted = true, markers = new Map()) =>
  renderToStaticMarkup(
    <ReviewDiff
      file={state.file}
      identity={{ trusted, reason: 'UNVERIFIED identity' }}
      markers={markers}
      selectedKey={null}
      onSelect={() => {}}
    />,
  );

test('coherent verified detail/session/diff identity is trusted', () => {
  const s = fixture();
  assert.equal(diffIdentity(s.session, s.detail, s.diff).trusted, true);
});
test('incoherent file-set completeness is not silently combined', () => {
  const s = fixture();
  s.diff.diffRevision.fileSet = 'PARTIAL';
  assert.equal(diffIdentity(s.session, s.detail, s.diff).trusted, false);
});
test('incoherent aggregate patch completeness is not silently combined', () => {
  const s = fixture();
  s.diff.diffRevision.patches = 'PARTIAL';
  assert.equal(diffIdentity(s.session, s.detail, s.diff).trusted, false);
});
for (const [name, mutate] of [
  [
    'detail provenance',
    (s) => {
      s.detail.diffRevision.provenance = 'UNVERIFIED';
    },
  ],
  [
    'diff provenance',
    (s) => {
      s.diff.diffRevision.provenance = 'UNVERIFIED';
    },
  ],
  [
    'missing detail base',
    (s) => {
      s.detail.diffRevision.baseSha = null;
    },
  ],
  [
    'missing detail head',
    (s) => {
      s.detail.diffRevision.headSha = null;
    },
  ],
  [
    'missing merge base',
    (s) => {
      s.diff.diffRevision.mergeBaseSha = null;
    },
  ],
  [
    'foreign session PR',
    (s) => {
      s.session.pullRequestId = 'foreign';
    },
  ],
  [
    'foreign diff PR',
    (s) => {
      s.diff.pullRequestId = 'foreign';
    },
  ],
  [
    'foreign repository',
    (s) => {
      s.detail.repository.id = 'foreign';
    },
  ],
  [
    'session head mismatch',
    (s) => {
      s.session.pullRequest.headSha = 'new';
    },
  ],
  [
    'detail metadata head mismatch',
    (s) => {
      s.detail.headSha = 'new';
    },
  ],
  [
    'detail metadata base mismatch',
    (s) => {
      s.detail.baseSha = 'new';
    },
  ],
  [
    'diff top-level head mismatch',
    (s) => {
      s.diff.headSha = 'new';
    },
  ],
  [
    'diff top-level base mismatch',
    (s) => {
      s.diff.baseSha = 'new';
    },
  ],
  [
    'diff head mismatch',
    (s) => {
      s.diff.diffRevision.headSha = 'new';
      s.diff.headSha = 'new';
    },
  ],
  [
    'merge-base mismatch',
    (s) => {
      s.diff.diffRevision.mergeBaseSha = 'new';
    },
  ],
] as Array<[string, (s: ReturnType<typeof fixture>) => void]>)
  test(`fails closed: ${name}`, () => {
    const s = fixture();
    mutate(s);
    assert.equal(diffIdentity(s.session, s.detail, s.diff).trusted, false);
  });

test('static matching NEW-side line maps', () => {
  const s = fixture();
  assert.deepEqual(
    findingAnchor(
      workspaceFindings(s.session)[0]!,
      s.session,
      diffIdentity(s.session, s.detail, s.diff),
      s.diff,
    ),
    { mapped: true, path: 'src/order.ts', line: 2 },
  );
});
for (const [name, mutate] of [
  [
    'no run',
    (s) => {
      s.session.run = null;
    },
  ],
  [
    'stale run',
    (s) => {
      s.session.run!.stale = true;
    },
  ],
  [
    'wrong analysis head',
    (s) => {
      s.session.run!.headSha = 'wrong';
    },
  ],
  [
    'no path',
    (s) => {
      s.session.findings[0]!.path = null;
    },
  ],
  [
    'no line',
    (s) => {
      s.session.findings[0]!.line = null;
    },
  ],
  [
    'zero line',
    (s) => {
      s.session.findings[0]!.line = 0;
    },
  ],
  [
    'fractional line',
    (s) => {
      s.session.findings[0]!.line = 2.5;
    },
  ],
  [
    'out of hunk',
    (s) => {
      s.session.findings[0]!.line = 99;
    },
  ],
  [
    'absent path',
    (s) => {
      s.session.findings[0]!.path = 'other.ts';
    },
  ],
  [
    'duplicate path',
    (s) => {
      s.diff.files.push({ ...s.file, id: 'dup' });
    },
  ],
  [
    'partial patch',
    (s) => {
      s.file.patchAvailability = 'PARTIAL';
    },
  ],
  [
    'truncated patch',
    (s) => {
      s.file.patchTruncated = true;
    },
  ],
  [
    'unavailable patch',
    (s) => {
      s.file.patchAvailability = 'UNAVAILABLE';
    },
  ],
  [
    'unverified patch',
    (s) => {
      s.file.patchAvailability = 'UNVERIFIED';
    },
  ],
  [
    'null patch',
    (s) => {
      s.file.patch = null;
    },
  ],
  [
    'ambiguous NEW coordinate',
    (s) => {
      s.file.patch += '\n@@ -1 +2 @@\n+duplicate();';
    },
  ],
] as Array<[string, (s: ReturnType<typeof fixture>) => void]>)
  test(`static remains unmapped: ${name}`, () => {
    const s = fixture();
    mutate(s);
    assert.equal(
      findingAnchor(
        workspaceFindings(s.session)[0]!,
        s.session,
        diffIdentity(s.session, s.detail, s.diff),
        s.diff,
      ).mapped,
      false,
    );
  });

test('AI location is advisory even with matching path and line', () => {
  const s = fixture();
  const finding = { ...workspaceFindings(s.session)[0]!, source: 'AI' as const };
  assert.equal(
    findingAnchor(finding, s.session, diffIdentity(s.session, s.detail, s.diff), s.diff).mapped,
    false,
  );
});
test('unverified identity cannot map static finding', () => {
  const s = fixture();
  assert.equal(
    findingAnchor(
      workspaceFindings(s.session)[0]!,
      s.session,
      { trusted: false, reason: 'unverified' },
      s.diff,
    ).mapped,
    false,
  );
});
test('shared parser preserves addition, deletion and context coordinates', () => {
  const lines = parseUnifiedPatch(patch)[0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.type, l.oldLineNumber, l.newLineNumber]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
    ],
  );
});
test('shared parser distinguishes separated hunks', () => {
  assert.equal(parseUnifiedPatch(`${patch}\n@@ -99 +99 @@\n context`).length, 2);
});
test('no-newline metadata is not source content', () => {
  assert.equal(parseUnifiedPatch(`${patch}\n\\ No newline at end of file`)[0]!.lines.length, 4);
});
test('code text is escaped rather than interpreted as HTML', () => {
  const s = fixture();
  s.file.patch = '@@ -0,0 +1 @@\n+<script>bad()</script>';
  const html = render(s);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
test('unverified identity hides supplied source', () => {
  assert.doesNotMatch(render(fixture(), false), /newCall/);
});
test('unverified patch hides supplied source', () => {
  const s = fixture();
  s.file.patchAvailability = 'UNVERIFIED';
  assert.doesNotMatch(render(s), /newCall/);
});
test('unavailable patch does not claim binary content', () => {
  const s = fixture();
  s.file.patchAvailability = 'UNAVAILABLE';
  s.file.patch = null;
  assert.match(render(s), /does not establish that the file is binary/);
});
test('partial patch warns about omitted content', () => {
  const s = fixture();
  s.file.patchAvailability = 'PARTIAL';
  assert.match(render(s), /omitted content/);
  assert.match(render(s), /newCall/);
});
test('rename displays previous and current paths', () => {
  const s = fixture();
  s.file.previousFilename = 'src/previous.ts';
  s.file.status = 'RENAMED';
  assert.match(render(s), /Previously src\/previous.ts/);
});
test('multiple findings show count and accessible NEW-side label', () => {
  const s = fixture();
  const f = workspaceFindings(s.session)[0]!;
  assert.match(
    render(s, true, new Map([[2, [f, { ...f, key: 'second' }]]])),
    /2 findings on NEW line 2/,
  );
});
test('patch-null state never fabricates hunks', () => {
  const s = fixture();
  s.file.patch = null;
  assert.doesNotMatch(render(s), /<table/);
});
test('no-newline metadata remains visible', () => {
  const s = fixture();
  s.file.patch += '\n\\ No newline at end of file';
  assert.match(render(s), /patch metadata/);
});
test('file availability is independent from inferred binary flag', () => {
  const s = fixture();
  s.file.binary = true;
  assert.equal(patchState(s.file), 'Available patch');
});
test('repository-scoped back link is encoded and local', () => {
  assert.equal(
    reviewsHref({ repositoryId: 'repo&evil=1' }),
    '/dashboard?repositoryId=repo%26evil%3D1',
  );
});
test('diff representation contains no proposal execution controls', () => {
  assert.doesNotMatch(render(fixture()), />(Apply|Run|Commit|Push|Merge)</);
});
test('typed detail and diff wrappers make GET requests with encoded identifiers', async () => {
  const old = globalThis.fetch;
  const requests: Array<[string, string]> = [];
  setAccessToken('test-only-access');
  globalThis.fetch = async (input, init) => {
    requests.push([String(input), init?.method ?? 'GET']);
    return new Response(JSON.stringify({ pullRequestId: 'transport-proof' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await api.pullRequest('pr/id');
    assert.equal((await api.pullRequestDiff('pr/id')).pullRequestId, 'transport-proof');
    assert.deepEqual(
      requests.map(([url, method]) => [new URL(url).pathname, method]),
      [
        ['/api/v1/pull-requests/pr%2Fid', 'GET'],
        ['/api/v1/pull-requests/pr%2Fid/diff', 'GET'],
      ],
    );
  } finally {
    globalThis.fetch = old;
    setAccessToken(null);
  }
});

function workspaceMarkup(state: 'normal' | 'loading' | 'error' | 'empty' | 'unverified') {
  const s = fixture();
  Object.assign(s.session.repository, { fullName: 'engineering/orders-api' });
  Object.assign(s.session.pullRequest, {
    title: 'Prevent duplicate orders',
    number: 412,
    author: { login: 'review-author' },
    state: 'OPEN',
    headRef: 'review',
    baseRef: 'main',
    additions: 2,
    deletions: 1,
    changedFiles: 1,
  });
  s.session.permissions = {
    canTriggerAnalysis: false,
    canComment: false,
  } as ReviewSession['permissions'];
  s.session.gate = { readyToMerge: false } as ReviewSession['gate'];
  s.session.risk = null;
  s.session.analyzed = true;
  if (state === 'empty') s.diff.files = [];
  if (state === 'unverified') s.diff.diffRevision.provenance = 'UNVERIFIED';
  return renderToStaticMarkup(
    <ReviewWorkspace
      session={s.session}
      detail={s.detail}
      diff={s.diff}
      diffLoading={state === 'loading'}
      diffError={state === 'error'}
      refresh={() => {}}
      discuss={() => {}}
      support={() => null}
    />,
  );
}
test('compact header retains PR identity, author, branch and recorded head', () => {
  const html = workspaceMarkup('normal');
  for (const value of [
    'engineering/orders-api',
    '#412',
    'Prevent duplicate orders',
    'review-author',
    'Recorded head',
  ])
    assert.ok(html.includes(value));
});
test('missing risk is unavailable, never fabricated zero', () => {
  assert.match(workspaceMarkup('normal'), /ML risk unavailable/);
});
test('loading is named and does not render premature source', () => {
  const html = workspaceMarkup('loading');
  assert.match(html, /Loading PR diff/);
  assert.doesNotMatch(html, /<table/);
});
test('diff error provides safe read retry and retains secondary views', () => {
  const html = workspaceMarkup('error');
  for (const value of ['Retry diff reads', 'Discussion', 'Analysis', 'Decision'])
    assert.ok(html.includes(value));
  assert.doesNotMatch(html, /<table/);
});
test('verified zero-file response reports empty returned file set', () => {
  assert.match(workspaceMarkup('empty'), /No changed files in the returned complete file set/);
});
test('unverified workspace retains navigation without showing code', () => {
  const html = workspaceMarkup('unverified');
  assert.match(html, /src\/order.ts/);
  assert.match(html, /UNVERIFIED diff provenance/);
  assert.doesNotMatch(html, /newCall/);
});
test('mobile controls and dialogs have accessible navigation/context names', () => {
  const html = workspaceMarkup('normal');
  for (const value of ['Files &amp; findings', 'Selection context', 'Close panel'])
    assert.ok(html.includes(value));
});
test('default workspace is PR changes, not proposal or candidate source', () => {
  const html = workspaceMarkup('normal');
  assert.match(html, /aria-label="PR changes"/);
  assert.doesNotMatch(html, /Apply proposal|candidate hash|proposal digest/i);
});
