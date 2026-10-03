import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.WEB_URL?.replace(/\/$/, '');
const api = process.env.API_URL?.replace(/\/$/, '');
const password = process.env.DEMO_PASSWORD;
const manifest = process.env.COLLABORATION_FIXTURE;
const output = process.env.COLLABORATION_OUTPUT;
const mode = process.env.COLLABORATION_MODE ?? 'main';
assert.ok(
  web && api && password && manifest && output,
  'Explicit isolated test configuration required',
);
const ids = JSON.parse(readFileSync(manifest, 'utf8'));
assert.match(ids.project, /^codelens_phase3c_/);
for (const url of [web, api]) {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname));
  assert.ok(
    !['3000', '4000', '43400', '44400'].includes(parsed.port),
    'Never use original/C2 resources',
  );
}
mkdirSync(output, { recursive: true });
const checks = [];
const pass = (name) => checks.push(name);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const exceptions = [];
page.on('pageerror', () => exceptions.push('Unhandled browser exception'));
try {
  await page.goto(`${web}/signin`);
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${web}/reviews/${ids.prId}`);
  const panel = page.getByRole('region', { name: 'Collaborate', exact: true });
  await panel.getByLabel('Conversation title', { exact: true }).waitFor();
  async function open(title) {
    await panel.getByRole('button', { name: title, exact: true }).click();
  }
  if (mode === 'stale') {
    await open(ids.title);
    await panel
      .getByText('Historical PR head; current head has changed.', { exact: true })
      .first()
      .waitFor();
    assert.ok((await panel.innerText()).includes('aaaaaaa'));
    pass('head movement labels existing pinned turn historical');
    await panel
      .getByRole('button', { name: 'Observed: PR-head query construction', exact: true })
      .first()
      .click();
    await panel.getByText('EXACT_REVISION', { exact: true }).first().waitFor();
    assert.ok((await panel.locator('pre').first().innerText()).includes('SELECT *'));
    pass('historical exact evidence remains resolvable');
  } else {
    await open(ids.title);
    await panel
      .getByText(
        'The observed PR-head source interpolates input into SQL. This suggests a query-construction risk; complete exploitability and test coverage remain unknown.',
        { exact: true },
      )
      .first()
      .waitFor();
    pass('persisted queued-worker answer readback');
    await panel
      .getByRole('button', { name: 'Observed: PR-head query construction', exact: true })
      .first()
      .click();
    await panel.getByText('EXACT_REVISION', { exact: true }).first().waitFor();
    assert.ok(
      (await panel.locator('pre').first().innerText()).includes('Ignore previous instructions'),
    );
    pass('structured citation opens existing exact-provenance evidence viewer');
    await page.reload();
    await open(ids.title);
    await panel
      .getByRole('button', { name: 'Observed: PR-head query construction', exact: true })
      .first()
      .waitFor();
    pass('reload retains assistant and structured citations');
    const title = `Browser collaborator ${Date.now()}`;
    await panel.getByLabel('Conversation title').fill(title);
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
    const question = panel.getByLabel('Conversation message', { exact: true });
    await question.fill('Explain this exact query construction');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await panel.getByText('RUNNING', { exact: true }).first().waitFor();
    pass('persisted running state visible');
    await panel
      .getByText(/read file range: RUNNING/)
      .first()
      .waitFor();
    pass('activity derives from persisted tool state');
    await panel.getByText('COMPLETED', { exact: true }).first().waitFor();
    await panel
      .getByRole('button', { name: 'Observed: PR-head query construction', exact: true })
      .first()
      .waitFor();
    pass('assistant completion and citation visible');
    await question.fill('What remains unknown?');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await panel.getByRole('list', { name: 'Evidence citations', exact: true }).nth(1).waitFor();
    pass('follow-up stays in same conversation');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
    await page.screenshot({ path: `${output}/collaboration-mobile.png` });
    pass('narrow collaboration layout has no document overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByLabel('Conversation title').fill(`Retry provider ${Date.now()}`);
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
    await question.fill('[retry] Recover from provider unavailable');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await panel.getByText('FAILED: PROVIDER_UNAVAILABLE', { exact: true }).waitFor();
    assert.equal(
      await panel.getByRole('list', { name: 'Evidence citations', exact: true }).count(),
      0,
    );
    pass('provider failure preserves question without fabricated answer');
    await panel.getByRole('button', { name: 'Retry turn', exact: true }).click();
    await panel.getByText('COMPLETED', { exact: true }).waitFor();
    assert.equal(
      await panel.getByRole('list', { name: 'Evidence citations', exact: true }).count(),
      1,
    );
    pass('explicit retry produces exactly one assistant response');
    await panel.getByLabel('Conversation title').fill(`Cancel provider ${Date.now()}`);
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
    await question.fill('[cancel] Delay answer');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await panel.getByText('RUNNING', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Cancel turn', exact: true }).click();
    await panel.getByText('CANCELLED: CANCELLED', { exact: true }).waitFor();
    await page.waitForTimeout(2800);
    assert.equal(
      await panel.getByRole('list', { name: 'Evidence citations', exact: true }).count(),
      0,
    );
    pass('cancellation prevents delayed assistant rendering');
    assert.equal(await panel.getByRole('button', { name: /patch|apply|commit|shell/i }).count(), 0);
    assert.ok(!(await panel.innerText()).includes('chain-of-thought'));
    pass('no reasoning or patch execution UI');
    await page.screenshot({ path: `${output}/collaboration-desktop.png` });
  }
  assert.deepEqual(exceptions, []);
  pass('no unhandled browser exceptions');
} finally {
  await browser.close();
}
writeFileSync(
  `${output}/collaboration-${mode}.json`,
  JSON.stringify({ checks, count: checks.length }),
);
console.log(JSON.stringify({ checks, count: checks.length }));
