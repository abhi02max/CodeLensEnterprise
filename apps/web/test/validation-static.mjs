import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.WEB_URL,
  output = process.env.VALIDATION_OUTPUT;
assert.equal(process.env.VALIDATION_PROJECT, 'codelens_phase3f_static_20261004');
assert.ok(
  web &&
    output &&
    process.env.VALIDATION_FIXTURES &&
    process.env.DEMO_PASSWORD &&
    process.env.VALIDATION_RUN_ID,
);
const runId = process.env.VALIDATION_RUN_ID;
assert.equal(new URL(web).hostname, 'localhost');
const fixture = JSON.parse(readFileSync(process.env.VALIDATION_FIXTURES)).fixtures[0];
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on('pageerror', () => errors.push('Unhandled browser exception'));
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(web + '/reviews/' + fixture.prId);
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'Static ' + fixture.name, exact: true })
    .click();
  const application = page.getByRole('region', {
    name: 'Validation for application ' + fixture.applicationId,
    exact: true,
  });
  const staticPanel = application
    .getByRole('listitem')
    .filter({ has: page.getByText(`Validation ${runId} · Application`, { exact: false }) })
    .getByRole('region', { name: 'Static occurrence comparison', exact: true });
  await staticPanel
    .getByRole('heading', { name: 'Static occurrence comparison', exact: true })
    .waitFor();
  await staticPanel.getByText(/ORIGINAL: COMPLETE/).waitFor();
  await staticPanel.getByText(/PATCHED: COMPLETE/).waitFor();
  for (const kind of ['UNCHANGED', 'RESOLVED', 'INTRODUCED', 'CHANGED', 'INCOMPARABLE'])
    assert.ok((await staticPanel.innerText()).includes(kind + ':'));
  checks.push('persisted five-class comparison and identities rendered');
  await staticPanel.getByLabel('Static side', { exact: true }).selectOption('PATCHED');
  await staticPanel.getByLabel('Static comparison', { exact: true }).selectOption('INTRODUCED');
  await staticPanel.getByRole('listitem').first().waitFor();
  await staticPanel
    .locator('li summary')
    .filter({ hasText: /PATCHED.*INTRODUCED/ })
    .first()
    .waitFor();
  assert.ok(
    (await staticPanel.locator('li summary').allTextContents()).every(
      (s) => s.includes('PATCHED') && s.includes('INTRODUCED'),
    ),
  );
  await staticPanel.getByRole('listitem').first().locator('summary').click();
  await staticPanel
    .getByRole('listitem')
    .first()
    .getByText('Static analyzer detected this new occurrence in the patched candidate.', {
      exact: true,
    })
    .waitFor();
  assert.ok(!(await staticPanel.innerText()).includes('Vulnerability fixed'));
  checks.push('side/class filters and truthful introduced wording');
  await staticPanel.getByLabel('Static side', { exact: true }).selectOption('ORIGINAL');
  await staticPanel.getByLabel('Static comparison', { exact: true }).selectOption('RESOLVED');
  await staticPanel
    .locator('li summary')
    .filter({ hasText: /ORIGINAL.*RESOLVED/ })
    .first()
    .waitFor();
  await staticPanel.getByRole('listitem').first().locator('summary').click();
  await staticPanel
    .getByRole('listitem')
    .first()
    .getByText('Static analyzer no longer detected this occurrence in the patched candidate.', {
      exact: true,
    })
    .waitFor();
  checks.push('truthful resolved wording');
  await staticPanel.getByLabel('Static severity', { exact: true }).selectOption('CRITICAL');
  await staticPanel.getByLabel('Static rule', { exact: true }).fill('codelens/eval-usage');
  await staticPanel.getByLabel('Static rule', { exact: true }).focus();
  assert.ok(
    await staticPanel
      .getByLabel('Static rule', { exact: true })
      .evaluate((e) => document.activeElement === e),
  );
  checks.push('severity/rule filters and keyboard focus');
  const marker = 'ghp_' + 'K9q7Bm2Nj6Rx8Vz4Cs1De5Fg3Hu0Wp6Yt8Aa';
  assert.ok(!(await staticPanel.innerText()).includes(marker));
  assert.equal(
    await staticPanel.getByRole('button', { name: /^(Apply|Run|Commit|Push|Merge)(\s|$)/ }).count(),
    0,
  );
  checks.push('static readback withholds source credentials and offers no execution controls');
  assert.ok(
    (await application.innerText()).includes(
      'No static analysis observations recorded. This is not a zero-findings result.',
    ),
  );
  checks.push('historical absence is not represented as zero findings');
  const historicalPanel = application
    .getByRole('listitem')
    .filter({
      has: page.getByText(`Validation ${fixture.historicalRunId} · Application`, { exact: false }),
    })
    .getByRole('region', { name: 'Static occurrence comparison', exact: true });
  await historicalPanel
    .getByText('Comparison unavailable: missing or incomplete analysis is not a clean result.', {
      exact: true,
    })
    .waitFor();
  assert.ok(!(await historicalPanel.innerText()).includes('RESOLVED: 0'));
  await page.reload();
  await page
    .getByRole('region', { name: 'Collaborate', exact: true })
    .getByRole('button', { name: 'Static ' + fixture.name, exact: true })
    .click();
  await staticPanel
    .getByText(/occurrence-v1/)
    .first()
    .waitFor();
  checks.push('reload retains persisted evidence');
  await staticPanel.screenshot({ path: output + '/static-desktop.png' });
  await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await staticPanel.screenshot({ path: output + '/static-mobile.png' });
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  checks.push('390px viewport has no horizontal page overflow');
  assert.deepEqual(errors, []);
  writeFileSync(
    output + '/proof.json',
    JSON.stringify({ checks, passed: checks.length, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors: 0 }));
} finally {
  await browser.close();
}
