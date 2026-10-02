import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const web = process.env.WEB_URL?.replace(/\/$/, '');
const api = process.env.API_URL?.replace(/\/$/, '');
const password = process.env.DEMO_PASSWORD;
const fixture = process.env.INVESTIGATION_FIXTURE;
const output = process.env.INVESTIGATION_OUTPUT;
if (
  !web ||
  !api ||
  !password ||
  !fixture ||
  !output ||
  /localhost:(3000|4000)(?:\/|$)/.test(`${web}/ ${api}`)
) {
  throw new Error(
    'Explicit isolated WEB_URL/API_URL/DEMO_PASSWORD, fixture manifest and output directory required',
  );
}
for (const endpoint of [web, api]) {
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname),
    'The investigation proof is restricted to explicitly configured loopback resources',
  );
}
const ids = JSON.parse(readFileSync(fixture, 'utf8'));
const checks = [];
const passed = (name) => checks.push(name);
mkdirSync(output, { recursive: true });
async function login(email) {
  const response = await fetch(`${api}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  const token = (json.data ?? json).tokens.accessToken;
  assert.ok(token);
  return async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(api + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, expected, `${method} ${path}: unexpected status`);
    const json = await response.json();
    return json.data ?? json;
  };
}
const owner = await login('owner@acme.dev');
const other = await login(ids.otherEmail);
const call = await owner(`/collaboration-tools/${ids.rangeCallId}`);
assert.equal(call.evidence[0].provenance, 'EXACT_REVISION');
assert.equal(call.evidence[0].trust, 'UNTRUSTED_DATA');
assert.equal(
  (await owner(`/evidence-references/${ids.rangeEvidenceId}`)).contentHash,
  call.evidence[0].contentHash,
);
passed('authenticated persisted call/evidence readback');
await other(`/collaboration-tools/${ids.rangeCallId}`, 'GET', undefined, 404);
await other(`/evidence-references/${ids.rangeEvidenceId}`, 'GET', undefined, 404);
await other(`/collaboration-turns/${ids.exactTurnId}/evidence`, 'GET', undefined, 404);
await other(
  `/collaboration-turns/${ids.exactTurnId}/tools/read_repository_metadata`,
  'POST',
  { requestId: crypto.randomUUID(), input: {} },
  404,
);
await other(`/conversations/${ids.exactConversationId}`, 'GET', undefined, 404);
passed('foreign conversation/turn/call/evidence scoped 404');
for (const [tool, input] of [
  ['exec_shell', {}],
  ['read_file_range', { path: '../secret', startLine: 1, endLine: 1 }],
  ['read_repository_metadata', { organizationId: ids.otherActor.organizationId }],
  ['retrieve_context', { query: 'refund', topK: 9 }],
])
  await owner(
    `/collaboration-turns/${ids.evidenceTurnId}/tools/${tool}`,
    'POST',
    { requestId: crypto.randomUUID(), input },
    422,
  );
passed('invalid tools, paths, scope and limits rejected');
const securityConversation = await owner(
  `/review-sessions/${ids.prId}/conversations`,
  'POST',
  { requestId: crypto.randomUUID(), title: 'API authorization proof', anchor: { kind: 'PR' } },
  201,
);
const securityMessage = await owner(
  `/conversations/${securityConversation.id}/messages`,
  'POST',
  { requestId: crypto.randomUUID(), content: 'Scoped evidence references' },
  201,
);
const securityTurn = securityMessage.message.turn.id;
const foreignFinding = await owner(
  `/collaboration-turns/${securityTurn}/tools/read_analysis_evidence`,
  'POST',
  { requestId: crypto.randomUUID(), input: { source: 'STATIC', findingId: 'foreign-finding' } },
  404,
);
assert.ok(foreignFinding);
passed('foreign finding scoped 404');
await owner(
  `/collaboration-turns/${securityTurn}/tools/read_review_thread`,
  'POST',
  { requestId: crypto.randomUUID(), input: { commentId: 'foreign-comment' } },
  404,
);
passed('foreign comment scoped 404');
const seededTurn = await owner(`/collaboration-turns/${ids.evidenceTurnId}/evidence`);
assert.ok(seededTurn.items.length <= 10);
const session = await owner(`/review-sessions/${ids.prId}`);
assert.equal(session.risk.score, 78);
assert.equal(session.findings.length, 4);
passed('unchanged seeded review risk/static readback');
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', () => errors.push('Unhandled browser JavaScript exception'));
try {
  await page.goto(`${web}/signin`);
  await page.getByLabel('Email', { exact: true }).fill('owner@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${web}/reviews/${ids.exactPrId}`);
  const panel = page.getByRole('region', { name: 'Collaborate', exact: true });
  const open = async (title) => {
    await panel.getByRole('list', { name: 'PR conversations', exact: true }).waitFor();
    for (let i = 0; i < 12; i++) {
      const button = panel.getByRole('button', { name: title, exact: true }).first();
      if (await button.count()) {
        await button.click();
        return;
      }
      const more = panel.getByRole('button', { name: 'More conversations', exact: true });
      if (!(await more.count())) break;
      await more.click();
      await page.waitForTimeout(150);
    }
    throw Error('Conversation not found in bounded pages');
  };
  await open('refund exact file');
  const evidence = panel.getByRole('region', { name: 'Investigation evidence', exact: true });
  await evidence
    .getByRole('button', { name: /^read file range · SUCCESS/ })
    .first()
    .click();
  await evidence.getByText('EXACT_REVISION', { exact: true }).waitFor();
  assert.ok(
    (await evidence.locator('pre').innerText()).includes('<script>window.injected=true</script>'),
  );
  assert.equal(await page.evaluate(() => window.injected), undefined);
  passed('exact provenance, source hash and untrusted literal rendering');
  await page.screenshot({ path: `${output}/evidence-desktop.png` });
  await page.reload();
  await open('refund exact file');
  await evidence
    .getByRole('button', { name: /^read file range · SUCCESS/ })
    .first()
    .click();
  await evidence.getByText('EXACT_REVISION', { exact: true }).waitFor();
  passed('persisted evidence survives browser reload');
  await page.goto(`${web}/reviews/${ids.prId}`);
  await panel.getByLabel('Conversation context', { exact: true }).waitFor();
  const options = await panel
    .getByLabel('Conversation context')
    .locator('option')
    .allTextContents();
  for (const prefix of ['Pull request', 'Risk discussion', 'Static:', 'AI:', 'Thread:'])
    assert.ok(options.some((x) => x.startsWith(prefix)));
  passed('PR/risk/static/AI/thread contextual entry points');
  await panel.getByLabel('Conversation context').selectOption({ label: 'Risk discussion' });
  const title = `refund browser proof ${Date.now()}`;
  await panel.getByLabel('Conversation title').fill(title);
  await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await panel.getByLabel('Conversation message').fill('Inspect risk without a new model call');
  await panel.getByRole('button', { name: 'Save message', exact: true }).click();
  const inspect = panel.getByRole('region', { name: 'Investigation evidence', exact: true });
  await inspect.getByRole('button', { name: 'Inspect risk evidence', exact: true }).click();
  await inspect.getByText('DERIVED', { exact: true }).waitFor();
  assert.ok((await inspect.locator('pre').innerText()).includes('78'));
  passed('create conversation/message and inspect persisted ML evidence');
  await inspect.getByRole('button', { name: 'Related indexed context', exact: true }).click();
  await inspect.getByText('INDEXED_CONTEXT', { exact: true }).first().waitFor();
  assert.ok((await inspect.innerText()).includes('unknown per-chunk revision'));
  passed('provider-free RAG limitations visible');
  await page.setViewportSize({ width: 390, height: 844 });
  await inspect.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
  await page.screenshot({ path: `${output}/evidence-mobile.png` });
  passed('narrow evidence layout without document overflow');
  assert.deepEqual(errors, []);
  passed('no unhandled browser exceptions');
} finally {
  await browser.close();
}
writeFileSync(`${output}/browser-results.json`, JSON.stringify({ checks, count: checks.length }));
console.log(JSON.stringify({ checks, count: checks.length }));
