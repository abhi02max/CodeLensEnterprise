import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell, PrimaryNav } from '../src/components/app-shell';
import { ReviewInbox } from '../src/components/reviews/review-inbox';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { ListPagination } from '../src/components/list-pagination';
import {
  ListError,
  ReviewList,
  ReviewListLoading,
  ReviewsEmpty,
} from '../src/components/reviews/review-list';
import { api } from '../src/lib/api';
import { setAccessToken } from '../src/lib/api-client';
import {
  isDestinationActive,
  primaryDestinations,
  readReviewQuery,
  reviewEmptyKind,
  reviewsHref,
} from '../src/lib/review-inbox';
import type { PullRequestListItem } from '../src/lib/types';
import LegacyPage from '../src/app/(app)/pull-requests/page';

const render = (element: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
const read = (query = '') => readReviewQuery(new URLSearchParams(query));
const pr: PullRequestListItem = {
  id: 'review-one',
  repository: { id: 'repo-one', fullName: 'engineering/payments-api' },
  number: 412,
  title: 'Preserve exactly scoped refund handling',
  state: 'OPEN',
  author: { login: 'reviewer', avatarUrl: null, userId: null },
  headRef: 'refunds',
  baseRef: 'main',
  additions: 26,
  deletions: 5,
  changedFiles: 4,
  commitCount: 1,
  draft: false,
  htmlUrl: 'https://example.invalid/pr',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  risk: { score: 78, level: 'HIGH', modelVersion: 'fixture' },
  latestRun: { id: 'run', status: 'COMPLETED', stage: 'DONE', finishedAt: '2026-10-01T00:00:00Z' },
  humanReviewSummary: { approvals: 2, changesRequested: 1, needsDiscussion: 0 },
  unresolvedCommentCount: 3,
  flags: [],
};

test('authenticated destination keeps the existing dashboard route but only one inbox presentation', () => {
  assert.equal(reviewsHref(), '/dashboard');
  const dashboard = readFileSync(
    new URL('../src/app/(app)/dashboard/page.tsx', import.meta.url),
    'utf8',
  );
  const root = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  assert.match(root, /\/dashboard/);
  assert.match(dashboard, /<ReviewInbox/);
  assert.doesNotMatch(dashboard, /averageRisk|Metric|api\.pullRequests/);
});
test('legacy bookmarks retain repository filters and pagination through a fixed local redirect', async () => {
  await assert.rejects(
    LegacyPage({
      searchParams: Promise.resolve({ repositoryId: 'repo-one', page: '2', riskLevel: 'HIGH' }),
    }),
    (error: unknown) =>
      typeof (error as { digest?: string }).digest === 'string' &&
      (error as { digest: string }).digest.includes(
        '/dashboard?repositoryId=repo-one&riskLevel=HIGH&sortBy=updatedAt&sortOrder=desc&page=2',
      ),
  );
});
test('reviewer navigation has only Reviews and Repositories', () => {
  assert.deepEqual(
    primaryDestinations('REVIEWER').map((item) => item.label),
    ['Reviews', 'Repositories'],
  );
  assert.deepEqual(primaryDestinations('DEVELOPER'), primaryDestinations('REVIEWER'));
});
test('History is exposed only to supported audit roles', () => {
  for (const role of ['ADMIN', 'OWNER'] as const)
    assert.equal(primaryDestinations(role).at(-1)?.href, '/activity');
  assert.equal(primaryDestinations(null).length, 2);
});
test('review workspace and legacy list identify Reviews as current', () => {
  for (const path of ['/dashboard', '/pull-requests', '/reviews/review-one'])
    assert.equal(isDestinationActive('/dashboard', path), true);
  assert.equal(isDestinationActive('/dashboard', '/repositories'), false);
});
test('navigation uses native links, named landmark and programmatic current route', () => {
  const html = render(<PrimaryNav pathname="/repositories" role="REVIEWER" />);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /<a(?=[^>]*href="\/repositories")(?=[^>]*aria-current="page")[^>]*>/);
  assert.doesNotMatch(html, /role="menu"|History|Dashboard/);
});
test('URL query validates supported states and bounds without creating unsupported filters', () => {
  assert.deepEqual(read('state=SAFE&riskLevel=PASSED&page=-1&repositoryId='), read());
  assert.equal(read('page=1.5').page, 1);
  assert.equal(read('page=9007199254740992').page, 1);
  assert.equal(read('repositoryId=' + 'a'.repeat(65)).repositoryId, undefined);
  assert.equal(read('state=OPEN&riskLevel=HIGH').state, 'OPEN');
});
test('paging URLs preserve server scope, state, stored risk and order', () => {
  const query = read('repositoryId=repo-one&state=OPEN&riskLevel=HIGH&sortBy=riskScore&page=2');
  assert.equal(
    reviewsHref({ ...query, page: 3 }),
    '/dashboard?repositoryId=repo-one&state=OPEN&riskLevel=HIGH&sortBy=riskScore&sortOrder=desc&page=3',
  );
});

test('unsupported ascending risk URL cannot contradict the highest-risk order label', () => {
  assert.equal(read('sortBy=riskScore&sortOrder=asc').sortOrder, 'desc');
  assert.equal(read('sortBy=updatedAt&sortOrder=asc').sortOrder, 'asc');
});
test('repository identity comes directly from each authoritative list item', () => {
  const html = render(<ReviewList items={[pr]} />);
  assert.match(html, /engineering\/payments-api/);
  assert.match(html, /href="\/dashboard\?repositoryId=repo-one"/);
  assert.match(html, /#412/);
});
test('stored risk is separate from completed analysis and never calls the review safe', () => {
  const html = render(<ReviewList items={[pr]} />);
  assert.match(html, /Stored risk/);
  assert.match(html, /78 HIGH/);
  assert.match(html, /Analysis/);
  assert.match(html, /COMPLETED/);
  assert.doesNotMatch(html, /Latest analysis risk|Current analysis risk|safe|Passed|Approved/i);
});
test('unavailable risk and absent runs are truthful rather than fabricated zero risk', () => {
  const html = render(<ReviewList items={[{ ...pr, risk: null, latestRun: null }]} />);
  assert.match(html, /Unavailable/);
  assert.match(html, /Not analyzed/);
  assert.doesNotMatch(html, /0 LOW|0%|78 HIGH/);
});
test('LOW risk is not green safety or human approval', () => {
  const html = render(
    <ReviewList
      items={[
        { ...pr, latestRun: null, risk: { score: 12, level: 'LOW', modelVersion: 'fixture' } },
      ]}
    />,
  );
  assert.match(html, /12 LOW/);
  assert.doesNotMatch(html, /state-success|safe|approved/i);
});
test('misnamed comment count and incomplete verdict counts are deliberately omitted', () => {
  const html = render(<ReviewList items={[pr]} />);
  assert.doesNotMatch(
    html,
    /unresolved|outstanding|open comments|3 comments|2 approvals|changes requested/i,
  );
});
test('unsupported assignment, gate, findings and unread state are not fabricated', () => {
  assert.doesNotMatch(
    render(<ReviewList items={[pr]} />),
    /assigned|needs my review|unread|gate|finding count/i,
  );
});
test('open review remains an explicitly named primary link with no nested controls', () => {
  const html = render(<ReviewList items={[pr]} />);
  assert.match(html, /aria-label="Open review #412: Preserve exactly scoped refund handling"/);
  assert.match(html, /href="\/reviews\/review-one"/);
  assert.match(html, /bg-interactive/);
  assert.doesNotMatch(html, /<a[^>]*>[^<]*<button/);
});
test('Analyze remains an independent subordinate command', () => {
  const html = render(<ReviewList items={[pr]} />);
  const analyze = html.match(/<button[^>]*>Analyze<\/button>/)?.[0];
  assert.ok(analyze);
  assert.doesNotMatch(analyze, /bg-interactive/);
});
test('row identity wraps and signals remain present on narrow viewports', () => {
  const html = render(<ReviewList items={[pr]} />);
  assert.match(html, /break-words text-panel/);
  assert.doesNotMatch(html, /truncate|hidden[^\"]*78 HIGH/);
  assert.match(html, /aria-label="26 additions"/);
  assert.match(html, /aria-label="5 deletions"/);
});
test('source titles are escaped, not interpreted as repository HTML', () => {
  const html = render(<ReviewList items={[{ ...pr, title: '<script>alert(1)</script>' }]} />);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
test('pagination displays server totals and bounds previous/next navigation', () => {
  const html = render(
    <ListPagination page={2} pageSize={25} total={63} totalPages={3} onPage={() => {}} />,
  );
  assert.match(html, /26-50/);
  assert.match(html, /of 63/);
  assert.match(html, /Page 2 of 3/);
  const last = render(
    <ListPagination page={3} pageSize={25} total={63} totalPages={3} onPage={() => {}} />,
  );
  assert.match(last, /<button(?=[^>]*aria-label="Next page")(?=[^>]*disabled="")[^>]*>/);
});
test('empty and out-of-range pages never fabricate a displayed range', () => {
  for (const [page, total] of [
    [1, 0],
    [3, 2],
  ]) {
    const html = render(
      <ListPagination page={page!} pageSize={25} total={total!} totalPages={1} onPage={() => {}} />,
    );
    assert.match(html, /0 shown/);
  }
});
test('no repositories, no reviews and filter-empty are different states', () => {
  assert.equal(reviewEmptyKind(0, read()), 'repositories');
  assert.equal(reviewEmptyKind(1, read()), 'reviews');
  assert.equal(reviewEmptyKind(1, read('state=CLOSED')), 'filtered');
  assert.equal(reviewEmptyKind(0, read('repositoryId=missing')), 'filtered');
  assert.equal(reviewEmptyKind(1, read('page=3')), 'page');
  assert.equal(reviewEmptyKind(1, read('page=3&state=CLOSED')), 'page');
  for (const [kind, text] of [
    ['repositories', 'No repositories connected'],
    ['reviews', 'No reviews yet'],
    ['filtered', 'No reviews match these filters'],
  ] as const)
    assert.match(render(<ReviewsEmpty kind={kind} onReset={() => {}} />), new RegExp(text));
});
test('loading announces truthful state and preserves four skeleton row geometries', () => {
  const html = render(<ReviewListLoading />);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Loading reviews/);
  assert.equal((html.match(/space-y-3 py-4/g) ?? []).length, 4);
  assert.doesNotMatch(html, /\d+%/);
});
test('error is persistent and retry is an accessible native command', () => {
  const html = render(<ListError subject="reviews" onRetry={() => {}} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load reviews/);
  assert.match(html, /<button[^>]*>Retry<\/button>/);
  assert.doesNotMatch(html, /stack|traceId|permission/i);
});
test('typed API sends repository and supported filters before pagination, without detail composition', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ items: [pr], total: 1, page: 2, pageSize: 25, totalPages: 1 }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  setAccessToken('frontend-test-only');
  try {
    const result = await api.pullRequests(
      read('repositoryId=repo-one&state=OPEN&riskLevel=HIGH&page=2'),
    );
    assert.equal(result.items[0]?.repository.fullName, pr.repository.fullName);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!);
    assert.equal(url.pathname.endsWith('/pull-requests'), true);
    for (const [key, value] of [
      ['repositoryId', 'repo-one'],
      ['state', 'OPEN'],
      ['riskLevel', 'HIGH'],
      ['page', '2'],
      ['pageSize', '25'],
      ['sortBy', 'updatedAt'],
      ['sortOrder', 'desc'],
    ])
      assert.equal(url.searchParams.get(key!), value);
  } finally {
    globalThis.fetch = original;
    setAccessToken(null);
  }
});

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  async prefetch() {},
  hmrRefresh() {},
};
function renderInbox(queryString: string, items: PullRequestListItem[]) {
  const params = new URLSearchParams(queryString);
  const client = new QueryClient();
  client.setQueryData(['repositories', 'review-filter'], {
    pages: [
      {
        items: [{ id: pr.repository.id, fullName: pr.repository.fullName }],
        total: 1,
        page: 1,
        totalPages: 1,
      },
    ],
    pageParams: [1],
  });
  client.setQueryData(['pull-requests', readReviewQuery(params)], {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    totalPages: 1,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppRouterContext.Provider value={router}>
        <SearchParamsContext.Provider value={params}>
          <ReviewInbox />
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>
    </QueryClientProvider>,
  );
}
test('active repository scope is visible and native filter controls match the server query', () => {
  const html = renderInbox('repositoryId=repo-one&state=OPEN&riskLevel=HIGH', [pr]);
  assert.match(html, /Repository: engineering\/payments-api/);
  assert.match(html, /<option value="repo-one" selected="">engineering\/payments-api/);
  assert.match(html, /<option value="OPEN" selected="">Open/);
  assert.match(html, /<option selected="">HIGH/);
  assert.doesNotMatch(html, /unresolved|assigned|Latest analysis risk/);
});
test('filtered empty repository does not expose foreign identity or falsely claim no repositories exist', () => {
  const html = renderInbox('repositoryId=unknown', []);
  assert.match(html, /Repository: Selected repository/);
  assert.match(html, /No reviews match these filters/);
  assert.doesNotMatch(html, /No repositories connected/);
});
test('mobile disclosure is a named native toggle linked to hidden navigation and a focusable main', () => {
  const html = render(
    <PathnameContext.Provider value="/dashboard">
      <AppShell role="REVIEWER" organization="Demo" onSignOut={() => {}}>
        <h1>Reviews</h1>
      </AppShell>
    </PathnameContext.Provider>,
  );
  assert.match(
    html,
    /aria-label="Open navigation" aria-expanded="false" aria-controls="mobile-navigation"/,
  );
  assert.match(html, /id="mobile-navigation" hidden=""/);
  assert.match(html, /<main id="main-content" tabindex="-1"/);
  assert.match(html, /href="#main-content"/);
  assert.doesNotMatch(html, /History|role="dialog"/);
});
