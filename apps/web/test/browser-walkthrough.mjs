/**
 * Browser walkthrough of the demo flow, with screenshots and layout QA.
 *
 * Drives the system Chrome via Playwright's `channel` option rather than a downloaded Chromium
 * build, because the bundled-browser download is a large network fetch that is not worth making a
 * prerequisite for running this.
 *
 * Beyond asserting that each step works, it collects three things a status code cannot tell you:
 * console errors, horizontal overflow, and clipped text. Those are the failures that make a demo
 * look broken while every request returns 200.
 *
 * Usage:
 *   node apps/web/test/browser-walkthrough.mjs
 *   node apps/web/test/browser-walkthrough.mjs --headed
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const EMAIL = process.env.DEMO_EMAIL ?? 'owner@acme.dev';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'CodeLensDemo2026';
const HEADED = process.argv.includes('--headed');

const results = [];
const consoleErrors = [];
const layoutIssues = [];

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

/**
 * Layout audit run inside the page.
 *
 * `documentOverflow` catches the classic dense-table failure where a panel pushes the body wider
 * than the viewport and the whole page scrolls sideways.
 *
 * `clipped` looks for elements whose text is cut off. Deliberately narrow: only elements that are
 * *not* intentionally truncated, since `truncate` with a `title` is a legitimate choice in a dense
 * table, and flagging those would bury the real problems.
 */
async function auditLayout(page, label) {
  const audit = await page.evaluate(() => {
    const overflowing = [];
    const clipped = [];

    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const intentional =
        el.classList.contains('truncate') ||
        style.textOverflow === 'ellipsis' ||
        style.overflowX === 'auto' ||
        style.overflowX === 'scroll' ||
        style.overflow === 'auto' ||
        style.overflow === 'scroll' ||
        el.tagName === 'PRE' ||
        el.closest('pre') !== null;

      if (intentional) continue;

      // Horizontal: content wider than the box with no way to reach it.
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        overflowing.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString().slice(0, 80) ?? '',
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          text: (el.textContent ?? '').trim().slice(0, 60),
        });
      }

      // Vertical clipping on a fixed-height box.
      if (
        el.scrollHeight > el.clientHeight + 2 &&
        el.clientHeight > 0 &&
        style.overflowY === 'hidden'
      ) {
        clipped.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString().slice(0, 80) ?? '',
          text: (el.textContent ?? '').trim().slice(0, 60),
        });
      }
    }

    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      bodyHeight: document.body.scrollHeight,
      overflowing: overflowing.slice(0, 10),
      clipped: clipped.slice(0, 10),
    };
  });

  if (audit.documentOverflow > 2) {
    layoutIssues.push({ page: label, kind: 'document-overflow', px: audit.documentOverflow });
  }
  for (const item of audit.overflowing) {
    layoutIssues.push({ page: label, kind: 'element-overflow', ...item });
  }
  for (const item of audit.clipped) {
    layoutIssues.push({ page: label, kind: 'text-clipped', ...item });
  }

  return audit;
}

async function shoot(page, name, { fullPage = true } = {}) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
  console.log(`         shot: ${name}.png`);
}

/**
 * Wait for rendered data, not for the network to go quiet.
 *
 * `networkidle` is the wrong signal for this app and produced two false failures: queries only
 * start once the access token is in memory, so the network is briefly idle *before* any data
 * request has been made. Waiting for the absence of skeletons is the honest condition.
 */
async function waitForData(page, label) {
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main');
      if (!main) return false;
      if (main.querySelector('.animate-pulse')) return false;
      return (main.textContent ?? '').trim().length > 0;
    },
    undefined,
    { timeout: 30000 },
  ).catch(() => {
    console.log(`         (${label}: still showing a loading state after 30s)`);
  });
}

/** Nav links share their label with dashboard stat cards, so nav clicks are scoped to the header. */
function nav(page, name) {
  return page.locator('nav[aria-label="Main"]').getByRole('link', { name, exact: true });
}

const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push({ url: page.url(), text: message.text().slice(0, 300) });
  }
});
page.on('pageerror', (error) => {
  consoleErrors.push({ url: page.url(), text: `pageerror: ${error.message}`.slice(0, 300) });
});

try {
  // ------------------------------------------------------------------ sign in
  section('Sign in');
  await page.goto(`${WEB}/signin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email');

  check('signin heading renders', await page.locator('text=CodeLens Enterprise').first().isVisible());
  check('email + password fields present', (await page.locator('#email').count()) === 1 && (await page.locator('#password').count()) === 1);

  // The button label flips from "Loading…" to "Sign in" only once React has hydrated, so this is
  // both the hydration gate and the assertion that the gate works. Interacting earlier is what
  // triggered a native GET submission and put the password in the URL.
  await page.waitForSelector('button:not([disabled]):has-text("Sign in")', { timeout: 20000 });
  check('submit enables only after hydration', await page.getByRole('button', { name: 'Sign in' }).isEnabled());
  check('credential fields carry no name attribute', (await page.locator('#password[name]').count()) === 0);

  await auditLayout(page, 'signin');
  await shoot(page, '01-signin');

  // An error state is part of the screen, so it gets looked at too.
  await page.fill('#email', 'owner@acme.dev');
  await page.fill('#password', 'wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check('bad credentials show an inline error', await page.locator('[role="alert"]').isVisible());
  check('credentials never reach the URL', !page.url().includes('password'), page.url());
  await shoot(page, '02-signin-error');

  // ------------------------------------------------------------------ login
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard', { timeout: 30000 });
  await page.waitForLoadState('networkidle');

  check('login lands on the dashboard', page.url().includes('/dashboard'));

  // ------------------------------------------------------------------ dashboard
  section('Dashboard');
  await page.waitForSelector('text=Risk summary', { timeout: 20000 });
  await waitForData(page, 'dashboard');

  const orgHeading = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('organization name rendered', orgHeading.length > 0, `"${orgHeading}"`);
  check('risk summary card present', await page.locator('text=Risk summary').isVisible());
  check('recent review runs present', await page.locator('text=Recent review runs').isVisible());

  const statValues = await page.locator('main .numeric').allTextContents();
  check('stat cards show numbers', statValues.some((value) => /\d/.test(value)), statValues.slice(0, 6).join(' | '));

  const dash = await auditLayout(page, 'dashboard');
  check('dashboard has no horizontal overflow', dash.documentOverflow <= 2, `overflow=${dash.documentOverflow}px`);
  await shoot(page, '03-dashboard');

  // ------------------------------------------------------------------ repositories
  section('Repositories');
  await nav(page, 'Repositories').click();
  await page.waitForURL('**/repositories');
  await page.waitForSelector('table', { timeout: 20000 });
  await waitForData(page, 'repositories');

  check('repository table renders', (await page.locator('table tbody tr').count()) >= 1);
  check('sync button present', await page.getByRole('button', { name: /Sync from GitHub/ }).isVisible());
  const repoHeaders = await page.locator('table thead th').allTextContents();
  check('table has the expected columns', repoHeaders.length >= 6, repoHeaders.join(' | '));

  const repos = await auditLayout(page, 'repositories');
  check('repositories has no horizontal overflow', repos.documentOverflow <= 2, `overflow=${repos.documentOverflow}px`);
  await shoot(page, '04-repositories');

  // ------------------------------------------------------------------ pull requests
  section('Pull requests');
  await nav(page, 'Pull requests').click();
  await page.waitForURL('**/pull-requests');
  await page.waitForSelector('table', { timeout: 20000 });
  await waitForData(page, 'pull-requests');

  const prRows = await page.locator('table tbody tr').count();
  check('pull request rows render', prRows >= 1, `rows=${prRows}`);
  check('PR #412 listed', await page.locator('text=#412').first().isVisible());
  check('risk badge visible in the list', (await page.locator('table').locator('text=CRITICAL').count()) >= 1);
  check('analyze button present per row', (await page.getByRole('button', { name: 'Analyze' }).count()) >= 1);

  const prs = await auditLayout(page, 'pull-requests');
  check('pull requests has no horizontal overflow', prs.documentOverflow <= 2, `overflow=${prs.documentOverflow}px`);
  check('un-analysed PR reads as un-analysed', await page.locator('text=not analysed').first().isVisible());
  await shoot(page, '05-pull-requests');

  // ------------------------------------------------------------------ un-analysed workspace
  //
  // PR #415 is seeded without a run so this state is demonstrable, and it is one click from the
  // main path. It used to show the "Not analysed yet" call-out followed by four more cards each
  // saying, in their own words, that there was nothing to show.
  section('Un-analysed pull request');
  await page.locator('a', { hasText: 'Add structured logging' }).first().click();
  await page.waitForURL('**/reviews/**', { timeout: 20000 });
  await page.waitForSelector('text=Not analysed yet', { timeout: 30000 });
  await waitForData(page, 'unanalysed-workspace');

  check('empty state explains the state', await page.locator('text=Not analysed yet').first().isVisible());
  check('empty state offers the action', (await page.getByRole('button', { name: 'Analyze' }).count()) >= 1);

  for (const hollow of ['AI review', 'Static findings', 'ML risk', 'Pipeline', 'Repository context']) {
    check(
      `no hollow panel: ${hollow}`,
      (await page.getByRole('heading', { name: hollow, exact: true }).count()) === 0,
    );
  }

  for (const useful of ['Merge gate', 'Your verdict', 'Discussion']) {
    check(`still usable without a run: ${useful}`, await page.getByRole('heading', { name: useful, exact: true }).first().isVisible());
  }

  check(
    'no "Degraded in this run" panel without a run',
    (await page.getByRole('heading', { name: 'Degraded in this run', exact: true }).count()) === 0,
  );

  const unanalysed = await auditLayout(page, 'unanalysed-workspace');
  check('un-analysed workspace has no horizontal overflow', unanalysed.documentOverflow <= 2, `overflow=${unanalysed.documentOverflow}px`);
  await shoot(page, '05b-unanalysed-workspace');

  await nav(page, 'Pull requests').click();
  await page.waitForURL('**/pull-requests');
  await page.waitForSelector('table', { timeout: 20000 });
  await waitForData(page, 'pull-requests-return');

  // ------------------------------------------------------------------ review workspace
  section('Review workspace');
  await page.locator('a', { hasText: 'Allow partial refunds' }).first().click();
  await page.waitForURL('**/reviews/**', { timeout: 20000 });
  await page.waitForSelector('text=Merge gate', { timeout: 30000 });
  await waitForData(page, 'review-workspace');

  check('PR title in the header', await page.locator('h1', { hasText: 'Allow partial refunds' }).isVisible());

  // Panel presence is asserted on headings, not on text. Audit descriptions in the activity panel
  // legitimately contain phrases like "merge gate", and substring matching collided with them.
  const panel = (name) => page.getByRole('heading', { name, exact: true });

  for (const name of [
    'Merge gate',
    'ML risk',
    'Static findings',
    'Repository context',
    'Pipeline',
    'Discussion',
    'Your verdict',
    'Change metrics',
    'Share',
    'AI review',
  ]) {
    check(`panel renders: ${name}`, (await panel(name).count()) > 0 && (await panel(name).first().isVisible()));
  }

  check('risk score 91 shown', (await page.getByText('91', { exact: true }).count()) > 0);
  check('attributions listed', await page.getByRole('heading', { name: 'Why this score' }).isVisible());

  const aiGenerated = (await page.getByRole('heading', { name: 'Why this recommendation' }).count()) > 0;
  console.log(`         AI state: ${aiGenerated ? 'GENERATED narrative visible' : 'degraded/unavailable state visible'}`);

  const severityBadges = await page.getByText(/^(CRITICAL|HIGH|MEDIUM|LOW|INFO)$/).count();
  check('severity badges render', severityBadges >= 2, `count=${severityBadges}`);

  const gateState = (await page.getByText(/^(Ready to merge|Blocked)$/).first().textContent())?.trim();
  check('gate state is stated in words', gateState === 'Blocked' || gateState === 'Ready to merge', `"${gateState}"`);

  const ws = await auditLayout(page, 'review-workspace');
  check('review workspace has no horizontal overflow', ws.documentOverflow <= 2, `overflow=${ws.documentOverflow}px`);
  console.log(`         page height: ${ws.bodyHeight}px`);
  await shoot(page, '06-review-workspace');
  await shoot(page, '06b-review-workspace-viewport', { fullPage: false });

  // ------------------------------------------------------------------ comment
  section('Comment');
  const composer = page.getByLabel('Comment body');
  await composer.scrollIntoViewIfNeeded();
  const commentText = `Browser QA pass ${new Date().toISOString()}`;
  await composer.fill(commentText);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.waitForSelector(`text=${commentText.slice(0, 30)}`, { timeout: 20000 });

  check('comment appears in the thread list', await page.locator(`text=${commentText.slice(0, 30)}`).first().isVisible());
  await shoot(page, '07-comment-created');

  // Finding-linked comment via the Discuss affordance.
  const discuss = page.getByRole('button', { name: 'Discuss' }).first();
  if (await discuss.count()) {
    await discuss.click();
    check('discuss sets a finding anchor', await page.locator('text=Commenting on').isVisible());
    await shoot(page, '08-finding-anchor');
    await page.locator('text=Clear').last().click();
  } else {
    console.log('         all findings already have threads; skipping the anchor check');
  }

  // ------------------------------------------------------------------ verdict
  section('Verdict');
  const gateBefore = (await page.getByText(/^(Ready to merge|Blocked)$/).first().textContent())?.trim();
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.waitForTimeout(3000);
  const gateAfter = (await page.getByText(/^(Ready to merge|Blocked)$/).first().textContent())?.trim();

  check('request changes updates the gate', gateAfter === 'Blocked', `before=${gateBefore} after=${gateAfter}`);
  check('verdict appears in the reviewer list', (await page.locator('text=changes requested').count()) >= 1);
  await shoot(page, '09-verdict-blocked');

  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(2500);
  check('approve records a verdict', (await page.locator('text=approved').count()) >= 1);
  await shoot(page, '10-verdict-approved');

  // ------------------------------------------------------------------ share link
  section('Share link');
  await page.getByRole('button', { name: 'New link' }).click();
  await page.waitForSelector('#share-scope');
  check('share form opens', await page.locator('#share-scope').isVisible());

  await page.getByRole('button', { name: 'Create link' }).click();
  await page.waitForSelector('text=Copy this now', { timeout: 20000 });
  check('one-time URL is shown after creation', await page.locator('text=Copy this now').isVisible());
  await shoot(page, '11-share-link-created');

  const sharedHref = await page.getByRole('link', { name: 'Open the shared view' }).getAttribute('href');
  check('shared view link produced', Boolean(sharedHref), sharedHref ?? '');

  // ------------------------------------------------------------------ shared view
  section('Shared review (unauthenticated)');
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonPage = await anon.newPage();
  anonPage.on('pageerror', (error) => consoleErrors.push({ url: anonPage.url(), text: `pageerror: ${error.message}` }));

  await anonPage.goto(`${WEB}${sharedHref}`, { waitUntil: 'networkidle' });
  await anonPage.waitForSelector('text=Shared review', { timeout: 20000 });

  check('shared page renders with no session', await anonPage.getByText('Shared review', { exact: true }).isVisible());
  check('shared page shows the PR title', await anonPage.locator('text=Allow partial refunds').first().isVisible());
  check('shared page shows findings', await anonPage.locator('text=Findings').first().isVisible());
  check('shared page shows read-only notice', await anonPage.locator('text=Read-only shared review').isVisible());

  // The safety properties, asserted against what is actually in the DOM.
  const anonBody = (await anonPage.locator('body').textContent()) ?? '';
  check('shared page has no sign-out control', (await anonPage.getByRole('button', { name: 'Sign out' }).count()) === 0);
  check('shared page shows no pipeline panel', !anonBody.includes('Pipeline'));
  check('shared page shows no discussion panel', !anonBody.includes('Discussion'));
  check('shared page shows no share management', !anonBody.includes('New link'));
  check('shared page shows no verdict controls', (await anonPage.getByRole('button', { name: 'Approve' }).count()) === 0);

  const sharedAudit = await anonPage.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  check('shared page has no horizontal overflow', sharedAudit.documentOverflow <= 2, `overflow=${sharedAudit.documentOverflow}px`);
  await anonPage.screenshot({ path: join(SHOTS, '12-shared-review.png'), fullPage: true });
  console.log('         shot: 12-shared-review.png');
  await anon.close();

  // ------------------------------------------------------------------ activity
  section('Activity');
  await nav(page, 'Activity').click();
  await page.waitForURL('**/activity');
  await waitForData(page, 'activity');

  check('activity page renders', await page.locator('h1', { hasText: 'Activity' }).isVisible());
  const activityRows = await page.locator('main li').count();
  check('activity events listed', activityRows >= 1, `rows=${activityRows}`);

  // Asserted per row rather than over the whole <main>, whose textContent also picks up the
  // framework's inlined payload script and made the original check meaningless.
  const rowTexts = await page.locator('main li').allTextContents();
  const leaky = rowTexts.filter((text) => /[{}]/.test(text) || /fingerprint/i.test(text));
  check('no audit row renders a metadata blob', leaky.length === 0, leaky.slice(0, 2).join(' | '));
  check('audit rows show a human description', rowTexts.every((text) => text.trim().length > 10));

  await auditLayout(page, 'activity');
  await shoot(page, '13-activity');

  // ------------------------------------------------------------------ responsive
  section('Responsive');
  for (const [name, size] of [
    ['tablet', { width: 834, height: 1112 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(size);

    await page.goto(`${WEB}/dashboard`);
    await page.waitForSelector('text=Risk summary', { timeout: 20000 });
    await waitForData(page, `dashboard-${name}`);
    const dashAudit = await auditLayout(page, `dashboard-${name}`);
    check(`${name} dashboard has no horizontal overflow`, dashAudit.documentOverflow <= 2, `overflow=${dashAudit.documentOverflow}px`);
    await shoot(page, `14-dashboard-${name}`);

    await page.goto(`${WEB}/pull-requests`);
    await page.waitForSelector('table', { timeout: 20000 });
    await waitForData(page, `pull-requests-${name}`);
    const prAudit = await auditLayout(page, `pull-requests-${name}`);
    check(`${name} pull requests has no horizontal overflow`, prAudit.documentOverflow <= 2, `overflow=${prAudit.documentOverflow}px`);

    // "No document overflow" was not enough. The table sat inside `overflow-x-auto`, so it could be
    // wider than its container with Risk and the Review link parked off-screen and the document
    // still reported zero overflow. This asserts the two things a phone actually needs are inside
    // the viewport, by measured position.
    const riskCell = page.locator('table tbody tr').first().locator('td').filter({ hasText: /CRITICAL|HIGH|MEDIUM|LOW|not analysed/ }).first();
    const reviewLink = page.locator('table tbody tr').first().getByRole('link', { name: 'Review' });

    for (const [what, locator] of [['risk', riskCell], ['the Review link', reviewLink]]) {
      const box = await locator.boundingBox();
      check(
        `${name}: ${what} is inside the viewport`,
        Boolean(box) && box.x >= 0 && box.x + box.width <= size.width + 2,
        box ? `right edge ${Math.round(box.x + box.width)}px of ${size.width}px` : 'not rendered',
      );
    }

    await shoot(page, `15-pull-requests-${name}`);
  }
} catch (error) {
  check('walkthrough completed without throwing', false, error.message);
  await page.screenshot({ path: join(SHOTS, 'ZZ-failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  // ------------------------------------------------------------------ report
  section('Console errors');
  if (consoleErrors.length === 0) {
    console.log('  none');
  } else {
    for (const entry of consoleErrors.slice(0, 20)) {
      console.log(`  ${entry.url}\n    ${entry.text}`);
    }
  }

  section('Layout issues');
  if (layoutIssues.length === 0) {
    console.log('  none');
  } else {
    for (const issue of layoutIssues.slice(0, 30)) {
      console.log(`  [${issue.page}] ${issue.kind} ${issue.px ? `${issue.px}px` : ''} ${issue.tag ?? ''} ${issue.cls ?? ''} ${issue.text ? `"${issue.text}"` : ''}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  writeFileSync(
    join(SHOTS, 'report.json'),
    JSON.stringify({ results, consoleErrors, layoutIssues, passed, failed }, null, 2),
  );

  console.log(`\n================ ${passed} passed, ${failed} failed ================`);
  console.log(`console errors: ${consoleErrors.length}   layout issues: ${layoutIssues.length}`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}
