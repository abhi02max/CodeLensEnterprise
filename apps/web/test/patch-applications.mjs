import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.WEB_URL,
  pr = process.env.APPLICATION_PR_ID,
  conversation = process.env.APPLICATION_CONVERSATION_TITLE,
  proposal = process.env.APPLICATION_PROPOSAL_ID,
  output = process.env.APPLICATION_OUTPUT;
assert.equal(process.env.APPLICATION_PROJECT, 'codelens_phase3e_application_20261003');
assert.ok(web && pr && conversation && proposal && output && process.env.DEMO_PASSWORD);
assert.equal(new URL(web).hostname, 'localhost');
assert.match(proposal, /^[a-zA-Z0-9-]+$/);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks = [],
  errors = [],
  diagnostics = [];
page.on('pageerror', () => errors.push('Unhandled browser exception'));
page.on('response', (r) => {
  if (r.status() >= 400) diagnostics.push({ status: r.status(), category: 'http-error' });
});
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(web + '/reviews/' + pr);
  const panel = page.getByRole('region', { name: 'Collaborate', exact: true });
  await panel.getByRole('button', { name: conversation, exact: true }).click();
  const card = panel.locator('#patch-proposal-' + proposal);
  await card.waitFor();
  const before = await card.getByLabel('Canonical diff for src/query.ts').innerText();
  const applications = card.getByRole('region', {
    name: 'Isolated patch applications',
    exact: true,
  });
  await applications
    .getByText(/Applied in isolated workspace/)
    .first()
    .waitFor();
  await applications
    .getByText(
      'The accepted proposal was materialized against its pinned revision inside an isolated ephemeral workspace. No tests, builds, commits, pushes or repository changes were performed.',
      { exact: true },
    )
    .first()
    .waitFor();
  checks.push('persisted APPLIED/DISPOSED has explicit materialization-only semantics');
  await applications
    .getByText(/Stale relative to current head/)
    .first()
    .waitFor();
  checks.push('historical stale indication is visible');
  const start = applications.getByRole('button', {
    name: 'Prepare isolated application',
    exact: true,
  });
  await start.focus();
  await page.keyboard.press('Enter');
  await applications
    .getByText(/Preparing exact snapshot|Materializing in isolation|Queued/)
    .first()
    .waitFor();
  await page.waitForFunction(
    (id) => {
      const statuses = [
        ...document
          .getElementById('patch-proposal-' + id)
          .querySelectorAll('li > p[role="status"]'),
      ];
      return (
        statuses.length >= 2 &&
        statuses.every((p) => p.textContent.startsWith('Applied in isolated workspace'))
      );
    },
    proposal,
    { timeout: 60000 },
  );
  assert.equal(await card.getByLabel('Canonical diff for src/query.ts').innerText(), before);
  checks.push('keyboard request creates application without modifying proposal diff');
  assert.equal(
    await card.getByRole('button', { name: /^(Apply|Run|Commit|Push|Merge)(\s|$)/ }).count(),
    0,
  );
  checks.push('no candidate execution/repository mutation controls');
  await page.reload();
  await panel.getByRole('button', { name: conversation, exact: true }).click();
  await card.waitFor();
  await applications
    .getByText(/Applied in isolated workspace/)
    .first()
    .waitFor();
  checks.push('reload preserves application metadata');
  await applications.locator('summary').first().click();
  await applications
    .getByText(/Manifest:/)
    .first()
    .waitFor();
  checks.push('bounded result hash and deployment metadata readable');
  await page.screenshot({ path: output + '/application-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
  await page.screenshot({ path: output + '/application-mobile.png' });
  checks.push('narrow page has no horizontal overflow');
  assert.deepEqual(errors, []);
  writeFileSync(
    output + '/result.json',
    JSON.stringify({ checks, diagnostics, passed: true }, null, 2),
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      passed: true,
      diagnosticStatuses: diagnostics.map((d) => d.status),
    }),
  );
} finally {
  await browser.close();
}
