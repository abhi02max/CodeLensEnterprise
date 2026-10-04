import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.WEB_URL,
  output = process.env.VALIDATION_OUTPUT;
assert.equal(process.env.VALIDATION_PROJECT, 'codelens_phase3f_validation_20261004');
assert.ok(web && output && process.env.VALIDATION_FIXTURES && process.env.DEMO_PASSWORD);
assert.equal(new URL(web).hostname, 'localhost');
const fixtures = JSON.parse(readFileSync(process.env.VALIDATION_FIXTURES)).fixtures;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks = [],
  errors = [];
page.on('pageerror', () => errors.push('Unhandled browser exception'));
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  for (const f of fixtures) {
    await page.goto(web + '/reviews/' + f.prId);
    const collaboration = page.getByRole('region', { name: 'Collaborate', exact: true });
    await collaboration.getByRole('button', { name: 'Validation ' + f.name, exact: true }).click();
    const panel = page.getByRole('region', {
      name: 'Validation for application ' + f.applicationId,
      exact: true,
    });
    await panel
      .getByText('Passing these checks does not establish that the proposal is safe.', {
        exact: true,
      })
      .waitFor();
    const expected = {
      pp: 'BOTH_PASS',
      pf: 'ORIGINAL_PASS_PATCHED_FAIL',
      fp: 'ORIGINAL_FAIL_PATCHED_PASS',
      ff: 'BOTH_FAIL',
      unsupported: 'UNSUPPORTED',
      cancel: 'INCONCLUSIVE',
    }[f.name];
    await panel.getByRole('status').filter({ hasText: expected }).first().waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: /^(Commit|Push|Merge|Apply|Run shell)(\s|$)/ })
        .count(),
      0,
    );
    checks.push(f.name + ': persisted comparison, limitations and no arbitrary execution controls');
    if (f.name === 'pp') {
      const historical = panel.getByText(/Historical validation: stale relative to current head/);
      await historical.first().waitFor();
      assert.ok((await historical.count()) >= 2);
      const detail = panel
        .locator('summary')
        .filter({ hasText: 'typescript-typecheck-v1 v1' })
        .first();
      await detail.click();
      await panel
        .getByText(/Broker observation:/)
        .first()
        .waitFor();
      await panel
        .getByText(/Untrusted runner report:/)
        .first()
        .waitFor();
      assert.ok(!(await panel.innerText()).includes('synthetic-validation-marker'));
      await page.reload();
      await collaboration.getByRole('button', { name: 'Validation pp', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: 'BOTH_PASS' }).first().waitFor();
      const request = panel.getByRole('button', {
        name: 'Validate original and patched candidate',
        exact: true,
      });
      await request.focus();
      assert.equal(await request.evaluate((e) => e === document.activeElement), true);
      checks.push('reload, stale indication, separated trust labels and keyboard focus');
      await page.screenshot({ path: output + '/validation-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
      await page.screenshot({ path: output + '/validation-mobile.png' });
      checks.push('390px viewport has no horizontal page overflow');
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    if (f.name === 'cancel') {
      await panel.getByRole('status').filter({ hasText: 'CANCELLED' }).waitFor();
      await panel.getByRole('status').filter({ hasText: 'UNCERTAIN' }).waitFor();
      assert.equal(
        await panel
          .getByRole('button', { name: 'Validate original and patched candidate', exact: true })
          .isDisabled(),
        true,
      );
      checks.push('cancelled cleanup uncertainty blocks another launch');
    }
  }
  const first = fixtures.find((f) => f.name === 'pp');
  await page.goto(web + '/reviews/' + first.prId);
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'Validation pp', exact: true })
    .click();
  const actions = page.getByRole('region', {
    name: 'Validation for application ' + first.applicationId,
    exact: true,
  });
  const launch = actions.getByRole('button', {
    name: 'Validate original and patched candidate',
    exact: true,
  });
  await launch.focus();
  await page.keyboard.press('Enter');
  const cancel = actions.getByRole('button', { name: 'Cancel validation', exact: true });
  await cancel.waitFor();
  await cancel.click();
  await actions.getByRole('status').filter({ hasText: 'CANCELLED' }).waitFor();
  checks.push('keyboard creation reaches real queue; browser cancellation persists terminal state');
  await page.reload();
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'Validation pp', exact: true })
    .click();
  await actions.getByRole('status').filter({ hasText: 'CANCELLED' }).waitFor();
  assert.ok((await actions.getByRole('status').filter({ hasText: 'BOTH_PASS' }).count()) >= 2);
  checks.push('cancel reload retains terminal decision and previous completed observations');
  assert.deepEqual(errors, []);
  writeFileSync(output + '/browser-proof.json', JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length }));
} finally {
  await browser.close();
}
