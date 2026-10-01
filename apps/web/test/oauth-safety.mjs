import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const { start } = require('../../api/test/oauth-safety-server.cjs');
const { sanitizeDiagnosticText } = require('../../../packages/shared/dist');

// Fixed synthetic mode: no storage dumps, screenshots, tracing, external navigation or credentials.
const web = 'http://localhost:23400', api = 'http://localhost:24400';
const markers = ['SECRET_PROVIDER_MARKER', 'SECRET_CODE_MARKER', 'SECRET_STATE_MARKER'];
const diagnostics = [];
let leaked = false;
function capture(text) {
  if (markers.some((marker) => text.includes(marker))) leaked = true;
  diagnostics.push(sanitizeDiagnosticText(text, markers));
}
assert.equal(sanitizeDiagnosticText(`?code=${markers[1]}&state=${markers[2]}`), '?code=[redacted]&state=[redacted]');
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error('Dedicated synthetic web port is occupied')));
  probe.listen(23400, '127.0.0.1', () => probe.close(resolve));
});
const server = await start(web, api);
const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--port', '23400', '--hostname', '127.0.0.1'], {
  cwd: new URL('../', import.meta.url), env: { ...process.env, NEXT_PUBLIC_API_URL: `${api}/api/v1`, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
next.stdout.on('data', (data) => capture(String(data)));
next.stderr.on('data', (data) => capture(String(data)));
let browser;
let page;
let stage = 'web-startup';
// The API server stubs process-global fetch; use the native Undici fetch for loopback readiness only.
const { request } = await import('playwright');
const http = await request.newContext();
try {
  for (let count = 0; count < 120; count++) {
    if (next.exitCode !== null || diagnostics.some((line) => /Port 23400 is in use/.test(line))) throw new Error('Owned synthetic web process failed');
    try { if ((await http.get(`${web}/signin`)).ok()) break; } catch { /* local server starting */ }
    if (count === 119) throw new Error('Synthetic web startup timed out');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stage = 'browser-startup';
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext();
  let mode = 'success', callbackUrl, initiation = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === api && url.pathname === '/api/v1/auth/github') {
      try {
      initiation++;
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      const headers = response.headers();
      const authorize = new URL(headers.location);
      assert.equal(authorize.origin, 'https://github.com');
      assert.equal(authorize.pathname, '/login/oauth/authorize');
      const state = authorize.searchParams.get('state'); assert.ok(state); markers.push(state);
      callbackUrl = `${api}/api/v1/auth/github/callback?state=${encodeURIComponent(state)}&${mode === 'denied' ? 'error=SECRET_PROVIDER_MARKER' : 'code=SECRET_CODE_MARKER'}`;
      return route.fulfill({ response, headers: { ...headers, location: callbackUrl }, body: '' });
      } catch {
        diagnostics.push('synthetic-initiation-interception-failed');
        return route.abort();
      }
    }
    if (![web, api].includes(url.origin)) return route.abort();
    return route.continue();
  });
  page = await context.newPage();
  page.on('console', (message) => capture(message.text()));
  page.on('pageerror', (error) => capture(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === api) diagnostics.push(`api ${url.pathname} status=${response.status()}`);
  });
  await page.goto(`${web}/signin`);
  stage = 'oauth-initiation';
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await page.getByText('Your GitHub account is connected.', { exact: true }).waitFor();
  stage = 'connected-repositories';
  assert.ok(initiation > 0);
  assert.equal(page.url(), `${web}/auth/callback`);
  assert.ok(server.credentials.length === 1);
  assert.ok(server.credentials[0].create.accessTokenEncrypted.startsWith('v1:'));
  assert.ok(!JSON.stringify(server.credentials).includes(markers[0]));
  await page.getByRole('link', { name: 'Continue to repositories' }).click();
  await page.getByRole('heading', { name: 'Repositories', exact: true }).waitFor();
  stage = 'replay';
  await page.goto(callbackUrl);
  await page.getByText('This GitHub connection expired or does not belong to this browser. Start again.', { exact: true }).waitFor();
  mode = 'denied';
  stage = 'denial';
  await page.getByRole('button', { name: 'Try GitHub again' }).click();
  await page.getByText('GitHub authorization was declined. Nothing was connected.', { exact: true }).waitFor();
  assert.equal(page.url(), `${web}/auth/callback`);
  stage = 'invalid-state';
  await page.goto(`${api}/api/v1/auth/github/callback?code=SECRET_CODE_MARKER&state=SECRET_STATE_MARKER`);
  await page.getByText('This GitHub connection expired or does not belong to this browser. Start again.', { exact: true }).waitFor();
  const rendered = await page.locator('body').innerText();
  assert.ok(!markers.some((marker) => rendered.includes(marker)));
  assert.ok(!leaked, 'Synthetic credential appeared in captured diagnostics');
  assert.ok(!markers.some((marker) => JSON.stringify(diagnostics).includes(marker)));
  assert.ok(!markers.some((marker) => JSON.stringify(server.logs).includes(marker)));
  console.log('Synthetic OAuth proof PASS: initiation, cookie recovery, encrypted storage, connected UI, denial, replay, invalid state; diagnostic marker occurrences=0');
} catch {
  // Do not emit Playwright call logs or assertion payloads: those can contain navigated URLs.
  console.error(`Synthetic OAuth proof FAILED at ${stage} (exception details withheld by credential-safe harness)`);
  console.error(diagnostics.slice(-5).map((line) => sanitizeDiagnosticText(line, markers)).join('\n'));
  if (page) console.error(sanitizeDiagnosticText((await page.locator('body').innerText().catch(() => '')).slice(0, 500), markers));
  process.exitCode = 1;
} finally {
  await browser?.close(); await http.dispose(); next.kill(); await server.close();
}
