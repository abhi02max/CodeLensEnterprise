import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityError } from '../src/components/workspace/activity-panel';
import { SignInField } from '../src/components/signin-field';
import { SignOutButton } from '../src/components/app-shell';
import { LoadingRegion } from '../src/components/ui/primitives';
import { ApiError } from '../src/lib/api-client';
import { metadata as dashboard } from '../src/app/(app)/dashboard/layout';
import { metadata as repositories } from '../src/app/(app)/repositories/layout';
import { metadata as prs } from '../src/app/(app)/pull-requests/layout';
import { metadata as activity } from '../src/app/(app)/activity/layout';
import { metadata as review } from '../src/app/(app)/reviews/layout';
import { metadata as signin } from '../src/app/signin/layout';
import { metadata as callback } from '../src/app/auth/callback/layout';
import { metadata as shared } from '../src/app/shared/layout';

const render = renderToStaticMarkup;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const [name, error, expected, retry] of [
  ['forbidden', new ApiError(403, 'FORBIDDEN', 'raw marker'), 'admins and owners', false],
  [
    'unauthorized',
    new ApiError(401, 'UNAUTHORIZED', 'raw marker'),
    'session could not be confirmed',
    false,
  ],
  ['network', new ApiError(0, 'NETWORK_ERROR', 'raw marker'), 'Check your connection', true],
  ['server', new ApiError(500, 'INTERNAL', 'raw marker'), 'service is unavailable', true],
  ['unknown response', new ApiError(422, 'VALIDATION', 'raw marker'), 'could not be loaded', true],
  ['unknown exception', new Error('raw marker'), 'could not be loaded', true],
] as const) {
  test(`activity ${name} is truthful and excludes raw diagnostics`, () => {
    const html = render(<ActivityError error={error} retry={() => {}} pending={false} />);
    assert.ok(html.includes(expected));
    assert.equal(html.includes('Retry activity'), retry);
    assert.ok(!html.includes('raw marker'));
    if (retry) assert.ok(!html.includes('admins and owners'));
  });
}
test('activity retry is disabled and busy while the GET refetch is pending', () => {
  const html = render(<ActivityError error={new Error()} retry={() => {}} pending />);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(
    read('../src/components/workspace/activity-panel.tsx'),
    /retry=\{\(\) => void logs\.refetch\(\)\}/,
  );
  assert.doesNotMatch(read('../src/components/workspace/activity-panel.tsx'), /refetchInterval/);
});
for (const id of ['email', 'password'] as const) {
  test(`${id} errors are attached to the input by a stable accessible ID`, () => {
    const html = render(
      <SignInField
        id={id}
        label={id}
        type={id === 'email' ? 'email' : 'password'}
        errors={['Safe field error', '<unsafe>']}
        required
        autoComplete={id === 'email' ? 'username' : 'current-password'}
      />,
    );
    assert.match(html, new RegExp(`aria-describedby="signin-${id}-errors"`));
    assert.match(html, new RegExp(`id="signin-${id}-errors"`));
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /&lt;unsafe&gt;/);
    assert.doesNotMatch(html, /name="/);
    const normal = render(<SignInField id={id} label={id} errors={[]} />);
    assert.doesNotMatch(normal, /aria-describedby|aria-invalid/);
  });
}
test('signout starts without fabricated success or session claims', () => {
  const html = render(<SignOutButton onSignOut={async () => {}} />);
  assert.match(html, /Sign out/);
  assert.doesNotMatch(html, /revoked|signed out|Sign-out not confirmed|disabled=""/);
  assert.match(read('../src/app/(app)/layout.tsx'), /onSignOut=\{signOut\}/);
});
test('route titles are fixed privacy-safe server metadata', () => {
  const titles = [dashboard, repositories, prs, activity, review, signin, callback, shared].map(
    (m) => m.title,
  );
  assert.deepEqual(titles, [
    'Reviews',
    'Repositories',
    'Pull requests',
    'Activity',
    'Review workspace',
    'Sign in',
    'GitHub connection',
    'Shared review',
  ]);
  for (const title of titles)
    assert.doesNotMatch(String(title), /token|passphrase|@|\bsha\b|cmup/i);
});
test('root uses one status announcement and preserves session redirects', () => {
  const html = render(<LoadingRegion label="Loading CodeLens" />);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /aria-busy="true"/);
  const source = read('../src/app/page.tsx');
  assert.match(source, /<LoadingRegion label="Loading CodeLens"/);
  assert.match(source, /status === 'authenticated'\) router\.replace\('\/dashboard'\)/);
  assert.match(source, /status === 'anonymous'\) router\.replace\('\/signin'\)/);
});
test('only the two confirmed metadata elements use the semantic muted token', () => {
  assert.match(read('../src/app/signin/page.tsx'), /text-content-muted">\s*API/);
  assert.match(
    read('../src/components/workspace/activity-panel.tsx'),
    /shrink-0 text-xs text-content-muted/,
  );
});
