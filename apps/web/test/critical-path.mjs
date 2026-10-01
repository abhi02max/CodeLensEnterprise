import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

if (process.argv.includes('--evidence-closure')) {
  await import('./evidence-closure.mjs');
  process.exit(process.exitCode || 0);
}

const web = process.env.WEB_URL?.replace(/\/$/, '');
const api = process.env.API_URL?.replace(/\/$/, '');
const password = process.env.DEMO_PASSWORD;
if (!web || !api || !password || /localhost:(3000|4000)(?:\/|$)/.test(`${web}/ ${api}`)) {
  throw new Error('Set isolated WEB_URL, API_URL and DEMO_PASSWORD explicitly; default CodeLens ports are refused.');
}

const shots = join(dirname(fileURLToPath(import.meta.url)), 'screenshots', 'critical-path');
mkdirSync(shots, { recursive: true });
const errors = [];
const aborted = [];
const requests = [];
let expectedJobFailure = 0;
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

function diagnosticText(value) {
  return String(value).replace(/\/(share|shared)\/[^/?#\s"'<>]+/g, '/$1/[redacted]').split(password).join('[redacted]');
}

function audit(target) {
  target.on('pageerror', (error) => errors.push(`JS: ${diagnosticText(error.message)}`));
  target.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname.replace(/\/(share|shared)\/[^/]+/, '/$1/[redacted]');
    const failure = `Network: ${request.method()} ${path} ${request.failure()?.errorText}`;
    if (request.failure()?.errorText === 'net::ERR_ABORTED') aborted.push(failure);
    else errors.push(failure);
  });
  target.on('request', (request) => {
    if (request.url().includes('/api/v1/')) {
      if (!request.url().startsWith(`${api}/`)) errors.push(`Unexpected API origin: ${new URL(request.url()).origin}`);
      requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  target.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const path = new URL(response.url()).pathname;
    if (status === 503 && path.includes('/jobs/') && expectedJobFailure > 0) {
      expectedJobFailure -= 1;
      return;
    }
    const expectedAuth = status === 401 && (path.endsWith('/auth/signin') || path.endsWith('/auth/refresh'));
    const expectedShare = (status === 401 || status === 404) && path.includes('/review-sessions/share/');
    const expectedTenant = status === 404 && /\/review-sessions\/[^/]+$/.test(path);
    if (!expectedAuth && !expectedShare && !expectedTenant) {
      errors.push(`HTTP ${status}: ${response.request().method()} ${path.replace(/\/(share|shared)\/[^/]+/, '/$1/[redacted]')}`);
    }
  });
}

async function shot(name, target = page) {
  await target.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
}

async function noOverflow(target) {
  const overflow = await target.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 2) {
    const offenders = await target.evaluate(() => [...document.querySelectorAll('main *')]
      .map((element) => ({
        tag: element.tagName,
        className: typeof element.className === 'string' ? element.className.slice(0, 90) : '',
        right: Math.round(element.getBoundingClientRect().right),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
      .filter((element) => element.right > innerWidth + 2)
      .slice(0, 12));
    console.log(`Overflow offenders: ${JSON.stringify(offenders)}`);
    await shot(`overflow-${await target.evaluate(() => innerWidth)}`, target);
  }
  assert.ok(overflow <= 2, `Horizontal overflow: ${overflow}px at ${new URL(target.url()).pathname.replace(/\/(share|shared)\/[^/]+/, '/$1/[redacted]')}`);
}

async function signIn(email = 'owner@acme.dev') {
  await page.goto(`${web}/signin`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

audit(page);
try {
  console.log('Browser critical path: auth, dashboard, PR navigation');
  await page.goto(`${web}/dashboard`);
  await page.waitForURL('**/signin');
  await page.getByLabel('Email').fill('owner@acme.dev');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Could not sign in').waitFor();
  assert.equal(new URL(page.url()).pathname, '/signin');
  await signIn();
  const dashboardResponse = page.waitForResponse((response) => response.url().startsWith(`${api}/pull-requests?`) && response.ok());
  await page.reload();
  const dashboard = await (await dashboardResponse).json();
  await page.getByRole('heading', { name: 'Risk summary' }).waitFor();
  assert.equal(await page.getByText('Pull requests', { exact: true }).count() > 0, true);
  assert.equal(dashboard.total >= 2, true);
  await shot('dashboard-1440');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Repositories' }).click();
  await page.getByRole('link', { name: 'acme-engineering/payments-api' }).click();
  await page.waitForURL('**/pull-requests?repositoryId=*');
  await page.getByText('#412').waitFor();
  const sessionResponse = page.waitForResponse((response) => response.url().includes('/review-sessions/') && response.request().method() === 'GET' && response.ok());
  await page.getByRole('link', { name: /#412/ }).first().click();
  const session = await (await sessionResponse).json();
  assert.equal(session.pullRequest.number, 412);
  assert.equal(session.pullRequest.changedFiles, 4);
  assert.equal(session.pullRequest.additions, 26);
  assert.equal(session.pullRequest.deletions, 5);
  assert.ok(Number.isFinite(session.risk.score));
  assert.ok(session.run?.id);
  await page.getByRole('heading', { name: 'Static findings' }).waitFor();
  for (const line of [58, 59, 69]) {
    assert.ok(session.findings.some((finding) => finding.line === line), `Missing line ${line} from API`);
    assert.ok((await page.getByText(new RegExp(`:${line}$`)).count()) > 0, `Missing line ${line} in UI`);
  }
  const sameLine = session.findings.filter((finding) => finding.line === 69);
  assert.equal(sameLine.length, 2);
  for (const finding of sameLine) {
    assert.ok((await page.getByText(finding.ruleId, { exact: true }).count()) > 0);
  }
  assert.ok((await page.getByText('Blocked', { exact: true }).count()) > 0);
  assert.ok((await page.getByText(String(session.risk.score), { exact: true }).count()) > 0);
  assert.ok(session.ragContext.chunkCount > 0);
  assert.ok((await page.getByRole('heading', { name: 'Repository context' }).count()) > 0);
  assert.ok((await page.getByRole('heading', { name: 'AI review' }).count()) > 0);
  await shot('review-1440');

  console.log('Browser critical path: queued analysis and current review');
  let injectStatusFailure = true;
  await page.route('**/jobs/*', async (route) => {
    if (injectStatusFailure) {
      injectStatusFailure = false;
      expectedJobFailure += 1;
      await route.fulfill({ status: 503, body: 'Temporary status outage' });
    } else {
      await route.continue();
    }
  });
  const analyzeResponse = page.waitForResponse((response) => response.url().endsWith(`/pull-requests/${session.pullRequest.id}/analyze`) && response.request().method() === 'POST');
  const jobResponse = page.waitForResponse((response) => response.url().includes('/jobs/') && response.ok()).catch(() => null);
  const refreshedSessionResponse = page.waitForResponse((response) => response.url().endsWith(`/review-sessions/${session.pullRequest.id}`) && response.request().method() === 'GET' && response.ok(), { timeout: 120000 }).catch(() => null);
  await page.getByRole('button', { name: 'Analyze' }).first().click();
  await page.locator('button[title="Analysis in progress"]').first().waitFor({ state: 'visible' });
  const analyzeHttp = await analyzeResponse;
  const analyze = await analyzeHttp.json();
  console.log(`Analyze HTTP ${analyzeHttp.status()}, mode=${analyze.mode}, reused=${analyze.reused}`);
  assert.equal(analyze.mode, 'queued');
  assert.ok(analyze.job?.id);
  await page.getByRole('button', { name: 'Check status' }).first().waitFor();
  assert.equal(requests.filter((request) => request.path.endsWith('/analyze')).length, 1);
  await page.getByRole('button', { name: 'Check status' }).first().click();
  const polled = await jobResponse;
  assert.ok(polled?.url().endsWith(`/jobs/${encodeURIComponent(analyze.job.id)}`));
  const refreshHttp = await refreshedSessionResponse;
  assert.ok(refreshHttp);
  const refreshedSession = await refreshHttp.json();
  assert.notEqual(refreshedSession.run.id, session.run.id);
  if (process.env.EXPECT_AI_STATUS) {
    assert.equal(refreshedSession.aiReviewStatus.state, process.env.EXPECT_AI_STATUS);
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Static findings' }).waitFor();
  assert.ok((await page.getByText(String(refreshedSession.risk.score), { exact: true }).count()) > 0);

  console.log('Browser critical path: discussion, verdict, share');
  const unique = Date.now().toString(36);
  const comment = `Phase 2E browser comment ${unique}`;
  await page.getByLabel('Comment body').fill(comment);
  const commentRefresh = page.waitForResponse((response) => response.url().endsWith(`/review-sessions/${session.pullRequest.id}`) && response.request().method() === 'GET' && response.ok());
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await commentRefresh;
  await page.getByText(comment, { exact: true }).waitFor({ state: 'visible' });
  const thread = page.locator('li', { hasText: comment }).first();
  await thread.getByRole('button', { name: 'Reply' }).click();
  const reply = `Phase 2E reply ${unique}`;
  await page.getByLabel('Comment body').fill(reply);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText(reply, { exact: true }).waitFor();
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('button', { name: /Show \d+ resolved/ }).click();
  await thread.getByRole('button', { name: 'Reopen' }).waitFor();
  await thread.getByRole('button', { name: 'Reopen' }).click();
  await thread.getByRole('button', { name: 'Resolve' }).waitFor();
  const discuss = page.getByRole('button', { name: 'Discuss' }).first();
  if (await discuss.count()) {
    await discuss.click();
    await page.getByText('Commenting on', { exact: false }).waitFor();
    const linkedComment = `Phase 2E finding discussion ${unique}`;
    await page.getByLabel('Comment body').fill(linkedComment);
    const linkedRefresh = page.waitForResponse((response) => response.url().endsWith(`/review-sessions/${session.pullRequest.id}`) && response.request().method() === 'GET' && response.ok());
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    const linkedSession = await (await linkedRefresh).json();
    assert.ok(linkedSession.comments.some((item) => item.body === linkedComment && item.findingFingerprint));
    await page.getByText(linkedComment, { exact: true }).waitFor({ state: 'visible' });
  }
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Blocked', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'New link' }).click();
  await page.getByLabel('Passphrase (optional, min 8 characters)').fill('short');
  assert.equal(await page.getByRole('button', { name: 'Create link' }).isDisabled(), true);
  await page.getByLabel('Passphrase (optional, min 8 characters)').fill('        ');
  assert.equal(await page.getByRole('button', { name: 'Create link' }).isDisabled(), true);
  const phrase = `Phase2e-${unique}-passphrase`;
  await page.getByLabel('Passphrase (optional, min 8 characters)').fill(phrase);
  await page.getByLabel('Scope').selectOption('SUMMARY');
  const createLinkResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/review-sessions/${session.pullRequest.id}/share-link`) && response.ok());
  const linksRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith(`/review-sessions/${session.pullRequest.id}`) && response.ok());
  await page.getByRole('button', { name: 'Create link' }).click();
  const createdLink = await (await createLinkResponse).json();
  assert.ok(createdLink.id);
  const sessionWithLink = await (await linksRefresh).json();
  assert.equal(sessionWithLink.shareLinks.find((link) => !link.revokedAt)?.id, createdLink.id);
  await page.getByText('Copy this now', { exact: false }).waitFor();
  const sharedPath = await page.getByRole('link', { name: 'Open the shared view' }).getAttribute('href');
  assert.ok(sharedPath?.startsWith('/shared/'));
  const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const shared = await anonymous.newPage();
  audit(shared);
  await shared.goto(`${web}${sharedPath}`);
  await shared.getByRole('heading', { name: 'Passphrase required' }).waitFor();
  await shared.getByLabel('Passphrase', { exact: true }).fill('wrong-passphrase');
  await shared.getByRole('button', { name: 'Open review' }).click();
  await shared.getByText('That passphrase is not correct.').waitFor();
  await shared.getByLabel('Passphrase', { exact: true }).fill(phrase);
  await shared.getByRole('button', { name: 'Open review' }).click();
  await shared.getByRole('heading', { name: 'Findings' }).waitFor();
  assert.ok((await shared.getByText('summary view').count()) > 0);
  assert.ok((await shared.getByText('Individual findings are not included.').count()) > 0);
  await shared.reload();
  await shared.getByRole('heading', { name: 'Passphrase required' }).waitFor();
  await shot('shared-390', shared);
  const createdLinkRow = page.locator('li', { has: page.getByRole('button', { name: 'Revoke' }) }).first();
  await createdLinkRow.getByRole('button', { name: 'Revoke' }).click();
  await shared.reload();
  await shared.getByText('This link does not work').waitFor();
  await anonymous.close();

  console.log('Browser critical path: responsive and logout');
  for (const [width, height] of [[1280, 720], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${web}/dashboard`);
    await page.getByRole('heading', { name: 'Risk summary' }).waitFor();
    await noOverflow(page);
    await shot(`dashboard-${width}`);
    await page.goto(`${web}/pull-requests`);
    await page.getByText('#412').waitFor();
    await noOverflow(page);
    await shot(`prs-${width}`);
    await page.goto(`${web}/reviews/${session.pullRequest.id}`);
    await page.getByRole('heading', { name: 'Static findings' }).waitFor();
    await noOverflow(page);
    await shot(`review-${width}`);
    await page.getByRole('button', { name: 'New link' }).click();
    await noOverflow(page);
    await shot(`share-form-${width}`);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/signin');
  await page.goto(`${web}/reviews/${session.pullRequest.id}`);
  await page.waitForURL('**/signin');
  const outsiderEmail = `browser-outsider-${unique}@example.test`;
  const signup = await fetch(`${api}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: outsiderEmail,
      password,
      name: 'Browser outsider',
      organizationName: `Browser isolation ${unique}`,
    }),
  });
  assert.ok(signup.ok, `Outsider setup returned HTTP ${signup.status}`);
  await signIn(outsiderEmail);
  await page.goto(`${web}/reviews/${session.pullRequest.id}`);
  await page.getByText('Review session not found').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Static findings' }).count(), 0);
  assert.ok(requests.some((request) => request.path.endsWith('/analyze')));
  assert.ok(requests.some((request) => request.path.includes('/jobs/')));
  assert.deepEqual(errors, []);
  console.log(`PASS: ${requests.length} API requests, no JS/network errors; ${aborted.length} navigation cancellations`);
} finally {
  await browser.close();
}
