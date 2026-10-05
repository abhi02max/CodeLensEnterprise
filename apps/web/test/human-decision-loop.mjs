import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const project = 'codelens_phase3g_human_loop_20261005';
assert.equal(process.env.PHASE3G_PROJECT, project);
const web = process.env.WEB_URL,
  api = process.env.API_URL,
  output = process.env.PHASE3G_OUTPUT;
assert.equal(new URL(web).origin, 'http://localhost:53410');
assert.equal(new URL(api).origin, 'http://localhost:55410');
assert.ok(process.env.DEMO_PASSWORD && output);
assert.ok(resolve(output).startsWith(resolve('.codelens-tmp/phase3g') + sep));
const ids = JSON.parse(readFileSync('.codelens-tmp/phase3g/ids.json'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(90000);
const checks = [],
  errors = [],
  observed = {};
page.on('pageerror', () => errors.push('Unhandled browser exception'));
const watchdog = setTimeout(
  () => {
    void browser.close();
  },
  30 * 60 * 1000,
);
const unwrap = async (r) => {
  assert.ok(r.ok(), `Unexpected API status ${r.status()}`);
  const j = await r.json();
  return j.data ?? j;
};
async function clickPost(button, path, keyboard = false) {
  const readyDeadline = Date.now() + 90000;
  while (!(await button.isEnabled()) && Date.now() < readyDeadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await button.isEnabled(), 'The requested human action must be enabled');
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1' + path && r.request().method() === 'POST',
  );
  void response.catch(() => {});
  if (keyboard) {
    await button.focus();
    assert.ok(await button.evaluate((e) => e === document.activeElement));
    await button.press('Enter');
  } else await button.click();
  return unwrap(await response);
}
let token;
async function read(path) {
  const r = await fetch(api + path, { headers: { Authorization: 'Bearer ' + token } });
  assert.ok(r.ok, `Readback status ${r.status}`);
  const j = await r.json();
  return j.data ?? j;
}
async function terminal(path, field, expected, budget = 180000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const row = await read(path);
    if (row[field] === expected) return row;
    assert.ok(
      !['FAILED', 'CANCELLED'].includes(row[field]),
      `Stage failed: ${row.failureCategory ?? row[field]}`,
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Stage proof deadline exceeded');
}
const dockerDb = (mode) =>
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.codelens-tmp/phase3g/runtime.env',
      '-f',
      '.codelens-tmp/phase3g/compose.yml',
      'run',
      '--rm',
      'tools',
      '/verification/db.cjs',
      mode,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

try {
  await page.goto(web + '/signin');
  await page.getByLabel('Email', { exact: true }).fill('reviewer@acme.dev');
  await page.getByLabel('Password', { exact: true }).fill(process.env.DEMO_PASSWORD);
  const signin = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/auth/signin') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  token = (await unwrap(await signin)).tokens.accessToken;
  await page.waitForURL('**/dashboard');
  await page.getByRole('link', { name: 'Repositories', exact: true }).first().click();
  await page.waitForURL('**/repositories');
  await page.getByRole('link', { name: 'Pull requests', exact: true }).first().click();
  await page.waitForURL('**/pull-requests');
  await page.getByRole('link', { name: /Human loop: treat input as data/ }).click();
  await page.waitForURL('**/reviews/' + ids.prId);
  await page
    .getByText('Controlled original observation: eval processes supplied input.', { exact: true })
    .waitFor();
  checks.push('login and visible repository/PR/workspace navigation; original anchored finding');
  const initial = await read('/review-sessions/' + ids.prId);
  assert.equal(initial.pullRequest.headSha, ids.headSha);
  assert.equal(initial.run.id, ids.reviewRunId);
  assert.ok(initial.findings.some((f) => f.path === 'src/value.ts' && f.line === 2));
  const priorReviews = initial.reviews;
  const panel = page.getByRole('region', { name: 'Collaborate', exact: true });
  await panel.getByLabel('Conversation context').selectOption(ids.findingId);
  const title = 'Human decision-loop ' + Date.now();
  await panel.getByLabel('Conversation title').fill(title);
  const conversation = await clickPost(
    panel.getByRole('button', { name: 'New conversation', exact: true }),
    `/review-sessions/${ids.prId}/conversations`,
  );
  observed.conversationId = conversation.id;
  await panel
    .getByLabel('Conversation message')
    .fill(
      'Explain the eval finding and prepare a proposed change for human review; do not modify the PR.',
    );
  const message = await clickPost(
    panel.getByRole('button', { name: 'Send message', exact: true }),
    `/conversations/${conversation.id}/messages`,
    true,
  );
  observed.turnId = message.message.turn.id;
  await terminal('/collaboration-turns/' + observed.turnId, 'status', 'COMPLETED');
  const proposal = (await read(`/conversations/${conversation.id}/patch-proposals`)).items[0];
  assert.equal(proposal.status, 'PROPOSED');
  assert.equal(proposal.headSha, ids.headSha);
  assert.equal(proposal.baseSha, ids.baseSha);
  assert.equal(proposal.files[0].path, 'src/value.ts');
  observed.proposalId = proposal.id;
  observed.proposalDigest = proposal.digest;
  const card = panel.getByRole('article', { name: 'Patch proposal revision 1', exact: true });
  await card.waitFor();
  const diff = await card.getByLabel('Canonical diff for src/value.ts').innerText();
  assert.ok(diff.includes('eval(input)') && diff.includes('return input'));
  await card
    .getByRole('button', { name: /^Evidence / })
    .first()
    .click();
  await card.getByText('EXACT_REVISION', { exact: true }).waitFor();
  const evidence = await read('/evidence-references/' + proposal.files[0].evidenceIds[0]);
  assert.equal(evidence.observedRevision, ids.headSha);
  checks.push(
    'real queued collaborator REQUEST_TOOLS and PROPOSE_PATCH; exact evidence and canonical diff',
  );
  await clickPost(
    card.getByRole('button', { name: 'Accept proposal', exact: true }),
    `/patch-proposals/${proposal.id}/decision`,
    true,
  );
  await card
    .getByText('Proposal accepted for a future application step.', { exact: true })
    .waitFor();
  assert.deepEqual((await read('/review-sessions/' + ids.prId)).reviews, priorReviews);
  const app = await clickPost(
    card.getByRole('button', { name: 'Prepare isolated application', exact: true }),
    `/patch-proposals/${proposal.id}/applications`,
  );
  observed.applicationId = app.id;
  const applied = await terminal('/patch-applications/' + app.id, 'status', 'APPLIED');
  assert.equal(applied.cleanup, 'DISPOSED');
  observed.snapshotDigest = applied.snapshotDigest;
  const validation = await clickPost(
    card.getByRole('button', { name: 'Validate original and patched candidate', exact: true }),
    `/patch-applications/${app.id}/validations`,
  );
  observed.validationId = validation.id;
  const validated = await terminal('/validations/' + validation.id, 'state', 'COMPLETED', 720000);
  assert.equal(validated.cleanup, 'DISPOSED');
  assert.equal(validated.steps.length, 4);
  assert.ok(validated.comparisons.some((c) => c.outcome === 'ORIGINAL_FAIL_PATCHED_PASS'));
  observed.candidateDigest = validated.candidateDigest;
  const staticResult = await read(`/validations/${validation.id}/static-findings`);
  assert.equal(staticResult.analyses.length, 2);
  assert.ok(staticResult.analyses.every((a) => a.status === 'COMPLETE'));
  assert.ok(staticResult.summary.RESOLVED > 0 || staticResult.summary.resolved > 0);
  await card.getByRole('heading', { name: 'Static occurrence comparison', exact: true }).waitFor();
  checks.push(
    'explicit acceptance/materialization/paired validation; real brokers; original-fail patched-pass and static comparison',
  );
  const ml = await clickPost(
    card.getByRole('button', { name: 'Request ML reassessment', exact: true }),
    `/validations/${validation.id}/ml-assessment`,
  );
  observed.mlId = ml.id;
  const assessed = await terminal(
    `/validations/${validation.id}/ml-assessment?comparisonId=${ml.id}`,
    'state',
    'COMPLETED',
    360000,
  );
  assert.equal(assessed.assessments.length, 2);
  assert.ok(assessed.assessments.every((a) => a.availability === 'AVAILABLE'));
  assert.equal(assessed.headSha, ids.headSha);
  assert.equal(assessed.candidateDigest, validated.candidateDigest);
  await card.getByRole('button', { name: 'Request AI re-review', exact: true }).waitFor();
  const ai = await clickPost(
    card.getByRole('button', { name: 'Request AI re-review', exact: true }),
    `/validations/${validation.id}/ai-rereview`,
    true,
  );
  observed.aiId = ai.id;
  const reviewed = await terminal(
    `/validations/${validation.id}/ai-rereview?reviewId=${ai.id}`,
    'state',
    'COMPLETED',
    60000,
  );
  assert.equal(reviewed.result.assessment, 'INCONCLUSIVE');
  assert.ok(reviewed.accounting.requests <= 2);
  assert.ok(
    reviewed.result.summary.evidenceIds.every((id) => reviewed.evidence.some((e) => e.id === id)),
  );
  const aiPanel = card.getByRole('region', { name: 'AI re-review', exact: true });
  await aiPanel.getByText(reviewed.result.summary.text, { exact: true }).waitFor();
  await aiPanel
    .getByRole('link', { name: /^Evidence / })
    .first()
    .click();
  assert.ok(new URL(page.url()).hash.startsWith('#ai-evidence-'));
  observed.packetDigest = reviewed.packetDigest;
  assert.deepEqual((await read('/review-sessions/' + ids.prId)).reviews, priorReviews);
  checks.push(
    'real local Python ML and sealed deterministic AI evidence/citation readback; no automatic verdict',
  );
  await page
    .getByLabel('Verdict summary', { exact: true })
    .fill(
      'Request changes: the accepted candidate was materialized and compared only in isolation. The actual PR branch has not changed.',
    );
  const verdict = await clickPost(
    page.getByRole('button', { name: 'Request changes', exact: true }),
    `/review-sessions/${ids.prId}/request-changes`,
    true,
  );
  assert.equal(verdict.review.headSha, ids.headSha);
  assert.equal(verdict.review.verdict, 'CHANGES_REQUESTED');
  observed.reviewId = verdict.review.id;
  await page.reload();
  await panel.getByRole('button', { name: title, exact: true }).click();
  await card.waitFor();
  assert.equal(await card.getByLabel('Canonical diff for src/value.ts').innerText(), diff);
  assert.ok(
    (await read('/review-sessions/' + ids.prId)).reviews.some(
      (r) => r.id === verdict.review.id && r.verdict === 'CHANGES_REQUESTED',
    ),
  );
  checks.push(
    'human final PR verdict is independent, displayed-head bound and survives reload with proposal',
  );
  await page.screenshot({ path: output + '/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
  await page.screenshot({ path: output + '/narrow.png' });
  checks.push('tested keyboard controls and narrow page-overflow sanity');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByLabel('Verdict summary', { exact: true })
    .fill('Old-head draft must not be automatically retried.');
  dockerDb('stale');
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/review-sessions/${ids.prId}/request-changes`) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Request changes', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText(
      'The pull request changed after this review was loaded. Refresh the review before submitting a verdict.',
      { exact: true },
    )
    .waitFor();
  assert.ok(await page.getByRole('button', { name: 'Request changes', exact: true }).isDisabled());
  dockerDb('stale-check');
  let submissions = 0;
  page.on('request', (r) => {
    if (/\/(approve|request-changes)$/.test(new URL(r.url()).pathname) && r.method() === 'POST')
      submissions++;
  });
  const reviewRead = '**/api/v1/review-sessions/' + ids.prId;
  await page.route(reviewRead, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Controlled unavailable readback' },
      }),
    });
  });
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByText('Could not load the review', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Request changes', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Verdict summary', { exact: true }).count(), 0);
  assert.equal(submissions, 0);
  await page.unroute(reviewRead);
  await page.reload();
  await page.getByText('Applies to fffffff', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Verdict summary', { exact: true }).inputValue(), '');
  assert.equal(submissions, 0);
  dockerDb('restore');
  checks.push(
    'authoritative head movement causes 409 with no writes; explicit refresh clears draft and never resubmits',
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    output + '/result.json',
    JSON.stringify({ checks, observed, passed: true, externalProviderCalls: 0 }, null, 2),
  );
  writeFileSync('.codelens-tmp/phase3g/browser-ids.json', JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({ checks: checks.length, passed: true }));
} catch (error) {
  await page.screenshot({ path: output + '/failure.png' }).catch(() => {});
  writeFileSync(output + '/progress.json', JSON.stringify({ checks, observed }, null, 2));
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
