import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const {
  WEB_URL: web,
  VALIDATION_OUTPUT: output,
  VALIDATION_FIXTURES: fixtures,
  DEMO_PASSWORD: password,
  VALIDATION_MODE: mode = 'complete',
} = process.env;
assert.equal(process.env.VALIDATION_PROJECT, 'codelens_phase3f_ml_20261005');
assert.ok(web && output && fixtures && password);
assert.equal(new URL(web).hostname, 'localhost');
assert.ok(['queued', 'complete', 'unavailable', 'stale'].includes(mode));
const f = JSON.parse(readFileSync(fixtures));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [],
  checks = [];
const statuses = [];
page.on('response', (r) => {
  if (new URL(r.url()).pathname.includes('/ml-assessment')) statuses.push(r.status());
});
page.on('pageerror', () => errors.push('Unhandled browser exception'));
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(web + '/reviews/' + f.prId);
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'ML pair', exact: true })
    .click();
  const panel = page
    .getByRole('region', { name: 'Validation for application ' + f.applicationId, exact: true })
    .getByRole('region', { name: 'ML risk reassessment', exact: true });
  await panel.getByRole('heading', { name: 'ML risk reassessment', exact: true }).waitFor();
  assert.ok(
    (await panel.innerText()).includes(
      'ML risk movement is an advisory model signal and does not establish that the proposal is safe or correct.',
    ),
  );
  const button = panel.getByRole('button', { name: 'Request ML reassessment', exact: true });
  if (mode === 'queued') {
    await button.waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent.includes('Request ML reassessment') && !b.disabled,
      ),
    );
    await button.focus();
    assert.ok(await button.evaluate((e) => document.activeElement === e));
    await page.keyboard.press('Enter');
    await panel.getByRole('status').filter({ hasText: 'QUEUED' }).waitFor();
    assert.ok(await button.isDisabled());
    checks.push('keyboard request and real queued state');
  } else {
    await panel.getByRole('status').filter({ hasText: 'COMPLETED' }).waitFor();
    const text = await panel.innerText();
    if (mode === 'unavailable') {
      assert.ok(text.includes('UNAVAILABLE'));
      assert.ok(!/\d+\.\d+ \/ 100/.test(text));
      assert.ok(text.includes('SERVICE_UNAVAILABLE'));
    } else {
      assert.ok(/\d+\.\d+ \/ 100/.test(text));
      assert.ok(text.includes('PATCHED − ORIGINAL:'));
      assert.ok(text.includes('Band movement'));
    }
    if (mode === 'stale')
      await panel
        .getByText(
          'Historical ML observation: stale relative to current head. No recomputation or rebasing.',
          { exact: true },
        )
        .waitFor();
    await panel.getByText('ML identities and limitations', { exact: true }).click();
    assert.ok((await panel.innerText()).includes('Pinned BASE'));
    assert.ok((await panel.innerText()).includes('ASSESSMENT_START_PERSISTED_METADATA'));
    if (mode !== 'unavailable') {
      assert.ok((await panel.innerText()).includes('bootstrap-v1'));
      assert.ok((await panel.innerText()).includes('risk-band-policy-v1'));
    }
    await page.reload();
    await page
      .getByRole('region', { name: 'Collaborate', exact: true })
      .getByRole('button', { name: 'ML pair', exact: true })
      .click();
    await panel.getByRole('status').filter({ hasText: 'COMPLETED' }).waitFor();
    checks.push(mode + ' scores/status/identity and reload persistence');
  }
  assert.equal(
    await panel
      .getByRole('button', { name: /^(Apply|Run|Commit|Push|Merge|Accept|Reject)(\s|$)/ })
      .count(),
    0,
  );
  assert.ok(!(await panel.innerText()).includes('The patch is safer'));
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + '/' + mode + '.png' });
  assert.deepEqual(errors, []);
  checks.push('advisory wording, scoped absence of mutation controls, no unhandled browser errors');
  writeFileSync(output + '/' + mode + '.json', JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ mode, checks, passed: true }));
} catch (error) {
  await page.screenshot({ path: output + '/failure.png' });
  console.log(
    JSON.stringify({
      mlHttpStatuses: statuses,
      mlLoadFailure: await page
        .getByText('ML observations could not be loaded.', { exact: false })
        .count(),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
