import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const web = process.env.WEB_URL,
  api = process.env.API_URL,
  password = process.env.DEMO_PASSWORD,
  prId = process.env.PATCH_PR_ID,
  output = process.env.PATCH_OUTPUT;
assert.equal(process.env.PATCH_PROJECT, 'codelens_phase3d_20261003');
assert.ok(web && api && password && prId && output, 'Explicit isolated configuration required');
assert.equal(new URL(web).origin, 'http://localhost:53404');
assert.equal(new URL(api).origin, 'http://localhost:54404');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  errors = [];
page.on('pageerror', () => errors.push('Unhandled browser exception'));
const pass = (name) => checks.push(name);
try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(web + '/reviews/' + prId);
  const panel = page.getByRole('region', { name: 'Collaborate', exact: true });
  const title = 'Browser immutable proposal ' + Date.now();
  await panel.getByLabel('Conversation title').fill(title);
  await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await panel.getByLabel('Conversation message').fill('Prepare a proposed change for review only.');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  const v1 = panel.getByRole('article', { name: 'Patch proposal revision 1', exact: true });
  await v1.waitFor();
  await v1.getByRole('button', { name: 'Accept proposal', exact: true }).waitFor();
  const oldDiff = await v1.getByLabel('Canonical diff for src/query.ts').innerText();
  assert.ok(oldDiff.includes('-  return `SELECT *'));
  assert.ok((await v1.innerText()).includes('No repository files are changed.'));
  pass('queued proposal renders canonical diff and future-only acceptance language');
  await v1.getByRole('button', { name: /^Evidence / }).click();
  await panel.getByText('EXACT_REVISION', { exact: true }).first().waitFor();
  pass('evidence resolves through existing viewer');
  await page.reload();
  await panel.getByRole('button', { name: title, exact: true }).click();
  await v1.waitFor();
  assert.equal(await v1.getByLabel('Canonical diff for src/query.ts').innerText(), oldDiff);
  pass('reload preserves immutable proposal');
  await v1.getByRole('button', { name: 'Accept proposal', exact: true }).click();
  await v1.getByText('Proposal accepted for a future application step.', { exact: true }).waitFor();
  assert.equal(await v1.getByLabel('Canonical diff for src/query.ts').innerText(), oldDiff);
  pass('acceptance changes decision only');
  await v1.getByRole('button', { name: 'Edit as new revision', exact: true }).click();
  await v1
    .getByRole('textbox')
    .fill('  return { sql: "SELECT * FROM orders WHERE id=?", params: [input] }; // human review');
  await v1.getByRole('button', { name: 'Save new revision', exact: true }).click();
  const v2 = panel.getByRole('article', { name: 'Patch proposal revision 2', exact: true });
  await v2.waitFor();
  assert.ok((await v2.innerText()).includes('PROPOSED'));
  assert.ok((await v1.innerText()).includes('SUPERSEDED'));
  assert.equal(await v1.getByLabel('Canonical diff for src/query.ts').innerText(), oldDiff);
  pass('human revision creates unaccepted v2 while v1 content survives');
  await v2.getByRole('button', { name: 'Reject', exact: true }).click();
  await v2.getByText('Proposal rejected.', { exact: true }).waitFor();
  pass('human rejection is persisted');
  await v2.getByRole('button', { name: 'Request revision', exact: true }).click();
  await v2
    .getByLabel('Proposal revision feedback')
    .fill('Please prepare a new proposal using the same pinned source.');
  await v2.getByRole('button', { name: 'Send revision feedback', exact: true }).click();
  const v3 = panel.getByRole('article', { name: 'Patch proposal revision 3', exact: true });
  await v3.waitFor();
  assert.ok((await v3.innerText()).includes('PROPOSED'));
  assert.ok((await v3.innerText()).includes('Assistant'));
  pass('normal persisted feedback produces new AI revision without self-approval');
  assert.equal(
    await panel.getByRole('button', { name: /^(Apply|Run|Commit|Push|Merge)(\s|$)/ }).count(),
    0,
  );
  pass('no execution controls');
  await page.screenshot({ path: output + '/patch-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
  await page.screenshot({ path: output + '/patch-mobile.png' });
  pass('narrow layout has no page overflow');
  assert.deepEqual(errors, []);
  pass('no unhandled browser errors');
  writeFileSync(output + '/result.json', JSON.stringify({ checks, passed: true }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, passed: true }));
} finally {
  await browser.close();
}
