import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import HistoricalSharedReviewPage from '../src/app/shared/review/[token]/page';

test('historical share URL redirects to the canonical reader', async () => {
  await assert.rejects(
    HistoricalSharedReviewPage({
      params: Promise.resolve({ token: 'deterministic-unit-fixture' }),
    }),
    (error: unknown) =>
      (error as { digest?: string }).digest ===
      'NEXT_REDIRECT;replace;/shared/deterministic-unit-fixture;307;',
  );
});

test('opaque parameters cannot select another origin or introduce query/fragment data', async () => {
  const token = '//outside.example/path?secret=value#fragment';
  await assert.rejects(
    HistoricalSharedReviewPage({ params: Promise.resolve({ token }) }),
    (error: unknown) =>
      (error as { digest?: string }).digest ===
      `NEXT_REDIRECT;replace;/shared/${encodeURIComponent(token)};307;`,
  );
});

test('compatibility route delegates navigation only, with no reader, API or logging duplication', () => {
  const source = readFileSync(
    new URL('../src/app/shared/review/[token]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /fetch\(|api\.|console\.|searchParams|localStorage|sessionStorage/);
});

test('canonical reader keeps the existing allowlisted API and passphrase header boundary', () => {
  const reader = readFileSync(
    new URL('../src/app/shared/[token]/page.tsx', import.meta.url),
    'utf8',
  );
  const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  assert.match(reader, /api\.sharedReview\(token, submitted\)/);
  assert.doesNotMatch(reader, /api\.(?:session_|pullRequest|conversation|patchProposal)\(/);
  assert.match(
    api,
    /sharedReview:[\s\S]*?authenticated: false,[\s\S]*?'X-Share-Passphrase': passphrase/,
  );
});
