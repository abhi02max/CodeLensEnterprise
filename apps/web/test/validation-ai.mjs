import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const {
  WEB_URL: web,
  VALIDATION_FIXTURES: fixtures,
  VALIDATION_OUTPUT: output,
  DEMO_PASSWORD: password,
  VALIDATION_MODE: mode = 'complete',
} = process.env;
assert.equal(process.env.VALIDATION_PROJECT, 'codelens_phase3f_ai_rereview_20261005');
assert.ok(web && fixtures && output && password);
assert.equal(new URL(web).hostname, 'localhost');
assert.ok(['complete', 'failure', 'stale', 'queued'].includes(mode));
const ids = JSON.parse(readFileSync(fixtures)),
  checks = [];
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL ?? 'chrome',
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(web + '/reviews/' + ids.prId);
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'AI evidence', exact: true })
    .click();
  const panel = page
    .getByRole('region', { name: 'Validation for application ' + ids.applicationId, exact: true })
    .getByRole('region', { name: 'AI re-review', exact: true });
  await panel.getByRole('heading', { name: 'AI re-review', exact: true }).waitFor();
  assert.ok(
    (await panel.innerText()).includes(
      'AI re-review is an advisory assessment grounded in the persisted validation evidence. It does not approve, merge, or certify the patch.',
    ),
  );
  checks.push('advisory disclaimer');
  if (mode === 'queued') {
    const button = panel.getByRole('button', { name: 'Request AI re-review', exact: true });
    await button.waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent.includes('Request AI re-review') && !b.disabled,
      ),
    );
    await button.focus();
    assert.ok(await button.evaluate((e) => document.activeElement === e));
    await page.keyboard.press('Enter');
    await panel.getByRole('status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 60000 });
    checks.push('keyboard initiation and completion');
  }
  if (mode === 'failure') {
    await panel.getByRole('status').filter({ hasText: 'FAILED' }).waitFor();
    assert.ok((await panel.innerText()).includes('No assessment'));
    assert.ok((await panel.innerText()).includes('Deterministic evidence remains unchanged'));
    checks.push('truthful failure');
  } else {
    await panel.getByRole('status').filter({ hasText: 'COMPLETED' }).waitFor();
    assert.ok((await panel.innerText()).includes('INCONCLUSIVE'));
    await panel.getByRole('heading', { name: 'Summary', exact: true }).waitFor();
    await panel.getByText('Evidence, coverage and identities', { exact: true }).click();
    const evidence = panel.getByRole('link', { name: /^Evidence / }).first();
    await evidence.click();
    const target = await evidence.getAttribute('href');
    assert.ok(target?.startsWith('#ai-evidence-'));
    await page.locator(target).waitFor({ state: 'visible' });
    assert.ok((await panel.innerText()).includes('ORIGINAL_AI'));
    assert.ok((await panel.innerText()).includes('RAG'));
    checks.push('assessment, summary, citation navigation and coverage');
  }
  if (mode === 'stale') {
    assert.ok((await panel.innerText()).includes('stale relative to current head'));
    checks.push('stale indication');
  }
  assert.equal(
    await panel.getByRole('button', { name: /^(Apply|Run|Commit|Push|Merge|Approve)$/ }).count(),
    0,
  );
  checks.push('no mutation controls');
  const status = await panel.getByRole('status').innerText();
  await page.reload();
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'AI evidence', exact: true })
    .click();
  await panel.getByRole('status').filter({ hasText: status }).waitFor();
  checks.push('reload persistence');
  await page.screenshot({ path: output + '/' + mode + '.png', fullPage: true });
  writeFileSync(
    output + '/' + mode + '.json',
    JSON.stringify({ mode, checks, passed: true }, null, 2),
  );
  console.log(JSON.stringify({ mode, checks: checks.length, passed: true }));
} finally {
  await browser.close();
}
