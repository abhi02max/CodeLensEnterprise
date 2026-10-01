import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Focused mode of critical-path.mjs, not a second full product walkthrough.
const web = process.env.WEB_URL;
const api = process.env.API_URL;
const password = process.env.DEMO_PASSWORD;
if (web !== 'http://localhost:23000' || api !== 'http://localhost:24000/api/v1' || !password) {
  throw new Error('Explicit isolated Phase 2 URLs and demo password required');
}
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  window.clipboardWrites = [];
  window.clipboardFails = false;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => {
    if (window.clipboardFails) throw new Error('Controlled clipboard denial');
    window.clipboardWrites.push(value);
  } } });
});
const page = await context.newPage();
const errors = [];
await page.route('**/api/v1/**', async (route) => {
  if (!route.request().url().startsWith(`${api}/`)) {
    errors.push('refused-off-target-api');
    await route.abort();
    return;
  }
  await route.continue();
});
const created = [];
let bearer;
let stage = 'signin';
page.on('request', (request) => {
  if (request.url().startsWith(`${api}/`)) bearer ||= request.headers().authorization;
});
page.on('pageerror', () => errors.push('uncaught-js-error'));
page.on('requestfailed', (request) => {
  if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push('failed-network-request');
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/auth/refresh')) errors.push(`HTTP ${response.status()}`);
});
let sessionId;
const focusEvidence = [];
async function tabTo(locator, name) {
  for (let i = 0; i < 250; i++) {
    if (await locator.evaluate((element) => element === document.activeElement)) {
      const visible = await locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none';
      });
      assert.ok(visible, `Missing visible focus: ${name}`);
      focusEvidence.push(name);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard unreachable: ${name}`);
}
async function activate(locator, name, key = 'Enter') {
  await tabTo(locator, name);
  await page.keyboard.press(key);
}
try {
  await page.goto(`${web}/signin`);
  await tabTo(page.getByLabel('Email'), 'email');
  await page.keyboard.type('owner@acme.dev');
  await tabTo(page.getByLabel('Password'), 'password');
  await page.keyboard.type(password);
  await activate(page.getByRole('button', { name: 'Sign in' }), 'sign-in');
  await page.waitForURL('**/dashboard');
  stage = 'keyboard-navigation';
  await activate(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pull requests', exact: true }), 'PR-navigation');
  await page.getByText('#412').waitFor();
  const sessionHttp = page.waitForResponse((r) => r.url().includes('/review-sessions/') && r.ok());
  await activate(page.getByRole('link', { name: /#412/ }).first(), 'review-workspace');
  const previous = await (await sessionHttp).json();
  sessionId = previous.pullRequest.id;
  await page.getByRole('heading', { name: 'Static findings' }).waitFor();
  if (!process.argv.includes('--probe-clipboard-failure')) {
    stage = 'fresh-analysis';
    const nextHttp = page.waitForResponse((r) => r.url().endsWith(`/review-sessions/${sessionId}`) && r.request().method() === 'GET' && r.ok(), { timeout: 150000 });
    await activate(page.getByRole('button', { name: 'Analyze', exact: true }).first(), 'analyze', 'Space');
    const current = await (await nextHttp).json();
    assert.notEqual(current.run.id, previous.run.id);
    assert.ok(current.findings.length > 0);
    assert.ok(current.ragContext.chunkCount > 0);
    if (process.env.EXPECT_ML_OUTAGE === 'true') {
      assert.ok(Number.isFinite(previous.risk?.score), 'Outage must replace an older real risk score');
      assert.equal(current.risk, null);
      await page.getByText('No risk prediction', { exact: true }).waitFor();
      await page.getByText('The ML service did not produce a score for this run.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'ML risk', exact: true }).count(), 0);
      assert.equal(current.aiReviewStatus.state, 'SKIPPED');
      await page.getByText('AI review skipped', { exact: true }).waitFor();
      assert.ok(current.gate.blockingReasons.length > 0);
      assert.ok(!current.gate.warnings.some((warning) => warning.includes('Risk score')));
      console.log(JSON.stringify({ proof: 'ML-outage', previousRun: previous.run.id, run: current.run.id,
        previousRisk: previous.risk?.score, risk: current.risk, findings: current.findings.length,
        context: current.ragContext.chunkCount, aiState: current.aiReviewStatus.state,
        readyToMerge: current.gate.readyToMerge, runStatus: current.run.status }));
    }
    await tabTo(page.getByRole('button', { name: 'Analyze', exact: true }).first(), 'analyze-again');
    stage = 'keyboard-collaboration';
    await tabTo(page.getByLabel('Comment body'), 'comment-body');
    await page.keyboard.type(`Keyboard sanity ${Date.now().toString(36)}`);
    await activate(page.getByRole('button', { name: 'Comment', exact: true }), 'comment-submit');
    await activate(page.getByRole('button', { name: 'Request changes', exact: true }), 'request-changes');
    await activate(page.getByRole('button', { name: 'Approve', exact: true }), 'approve', 'Space');
  }
  stage = 'clipboard';
  await activate(page.getByRole('button', { name: 'New link', exact: true }), 'new-link');
  for (const scope of process.argv.includes('--probe-clipboard-failure') ? ['FULL'] : ['FULL', 'SUMMARY', 'FULL']) {
    await tabTo(page.getByLabel('Scope', { exact: true }), 'share-scope');
    await page.keyboard.press(scope === 'SUMMARY' ? 'Home' : 'End');
    const phrase = 'Controlled-test-passphrase';
    await tabTo(page.getByLabel('Passphrase (optional, min 8 characters)'), 'share-passphrase');
    await page.keyboard.type(phrase);
    const linkHttp = page.waitForResponse((r) => r.url().endsWith('/share-link') && r.request().method() === 'POST' && r.ok());
    await activate(page.getByRole('button', { name: 'Create link', exact: true }), 'create-link');
    const link = await (await linkHttp).json();
    created.push(link.id);
    await page.getByRole('link', { name: 'Open the shared view' }).waitFor();
    await page.waitForFunction((token) => document.querySelector(`a[href="/shared/${token}"]`) !== null, link.token);
    assert.ok(link.scope === scope, 'Created scope must match selection');
    assert.ok(!link.url.includes(phrase) && !new URL(link.url).search, 'Passphrase must not enter URL');
    await activate(page.getByRole('button', { name: 'Copy', exact: true }), 'copy');
    await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    const exact = await page.evaluate((expected) => window.clipboardWrites.at(-1) === expected, link.url);
    assert.ok(exact, 'Clipboard must contain the new link, never stale link');
    await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();
  }
  await page.evaluate(() => { window.clipboardFails = true; });
  await activate(page.getByRole('button', { name: 'Copy', exact: true }), 'copy-denied');
  await page.waitForTimeout(250);
  if (process.argv.includes('--probe-clipboard-failure')) {
    console.log(JSON.stringify({ proof: 'clipboard-denial-observation', uncaught: errors.length,
      feedback: await page.getByText('Could not copy the link. Copy it manually.', { exact: true }).count() }));
  } else {
    await page.getByText('Could not copy the link. Copy it manually.', { exact: true }).waitFor();
    await activate(page.getByRole('button', { name: 'Close', exact: true }), 'close-share');
    assert.equal(await page.getByLabel('Scope', { exact: true }).count(), 0);
    const unnamedIcons = await page.locator('button:visible').evaluateAll((buttons) => buttons.filter((b) =>
      !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length);
    assert.equal(unnamedIcons, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ proof: 'clipboard-keyboard', scopes: ['FULL', 'SUMMARY', 'FULL'],
      exactNewUrls: true, rejectionHandled: true, keyboardOnly: true, focusEvidence, unnamedIcons }));
  }
} catch (error) {
  // Assertion diffs can contain secret URL/password values; never print them.
  console.error(JSON.stringify({ proof: 'failed', stage, errorType: error.name }));
  process.exitCode = 1;
} finally {
  if (sessionId && bearer) for (const id of created) {
    const response = await context.request.delete(`${api}/review-sessions/${sessionId}/share-link/${id}`, {
      headers: { Authorization: bearer } });
    if (!response.ok()) { console.error(`Share cleanup HTTP ${response.status()}`); process.exitCode = 1; }
  }
  await browser.close();
}
