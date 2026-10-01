import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// Fixed, newly created C1 isolation only. No traces, screenshots or credential dumps.
const web = 'http://localhost:33400', api = 'http://localhost:34400';
const markers = ['C1_CODE_MARKER', 'C1_STATE_MARKER', 'C1_AUTH_MARKER', 'C1_PROVIDER_BODY_MARKER', 'C1_PROVIDER_CODE_MARKER'];
const diagnostics = [];
let browser, stage = 'startup', redisStopped = false;
const docker = `${process.env.LOCALAPPDATA}/Programs/DockerDesktop/resources/bin/docker.exe`;
function redisCommand(command) {
  const identity = spawnSync(docker, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', 'codelens-c1-redis'], { encoding: 'utf8' });
  assert.equal(identity.stdout.trim(), 'codelens_c1_20261001');
  const result = spawnSync(docker, [command, 'codelens-c1-redis'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
}
function capture(value) { diagnostics.push(String(value)); }
async function waitRedis() {
  for (let n = 0; n < 30; n++) {
    const result = spawnSync(docker, ['exec', 'codelens-c1-redis', 'redis-cli', 'ping'], { encoding: 'utf8' });
    if (result.stdout.trim() === 'PONG') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Isolated Redis did not recover');
}
function accountSnapshot() {
  const script = "const {PrismaClient}=require('@codelens/database');const db=new PrismaClient();db.account.findMany({orderBy:{id:'asc'},select:{id:true,userId:true,providerAccountId:true,accessTokenEncrypted:true}}).then(rows=>console.log(JSON.stringify(rows))).finally(()=>db.$disconnect());";
  const result = spawnSync(docker, ['exec', '-w', '/app/apps/api', 'codelens-c1-api', 'node', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout.trim());
}
async function outageProof(context) {
  const before = accountSnapshot(); assert.equal(before.length, 2);
  const pending = await context.request.get(`${api}/api/v1/auth/github?mode=link`, { maxRedirects: 0 });
  assert.equal(pending.status(), 302);
  const pendingState = new URL(pending.headers().location).searchParams.get('state'); markers.push(pendingState);
  redisCommand('stop'); redisStopped = true;
  const unavailable = await context.request.get(`${api}/api/v1/auth/github?mode=link`, { maxRedirects: 0, timeout: 20000 });
  assert.ok(unavailable.status() >= 500); capture(await unavailable.text());
  const rejected = await context.request.get(`${api}/api/v1/auth/github/callback?code=C1_CODE_MARKER_existing&state=${encodeURIComponent(pendingState)}`, { maxRedirects: 0, timeout: 20000 });
  assert.equal(rejected.status(), 302);
  assert.equal(rejected.headers().location, `${web}/auth/callback?oauth=invalid`);
  assert.deepEqual(accountSnapshot(), before);
  redisCommand('start'); redisStopped = false; await waitRedis();
  return unavailable.status();
}
try {
  browser = await chromium.launch({ channel: 'chrome' });
  if (process.argv.includes('--outage-only')) {
    stage = 'outage-account-snapshot';
    const context = await browser.newContext();
    const signedIn = await context.request.post(`${api}/api/v1/auth/signin`, { data: { email: 'owner-c1@example.invalid', password: 'SyntheticC1Only!2026' } });
    assert.ok(signedIn.ok());
    const status = await outageProof(context);
    assert.ok(!markers.some(marker => diagnostics.some(line => line.includes(marker))));
    console.log(JSON.stringify({ redisOutage: 'PASS', initiationStatus: status, completion: 'invalid', accountRowsUnchanged: true, accounts: 2, redisRestored: true, markers: 0 }));
  } else {
  assert.equal(accountSnapshot().length, 0, 'Full browser proof requires an unconnected C1 fixture; use --outage-only for repeat outage verification');
  async function client() {
    const context = await browser.newContext();
    const state = { kind: 'new', mode: 'success', callback: null };
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === api && url.pathname === '/api/v1/auth/github') {
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          assert.equal(response.status(), 302);
          const headers = response.headers();
          assert.ok(headers['set-cookie'].includes('HttpOnly'));
          assert.ok(headers['set-cookie'].includes('Secure'));
          assert.ok(headers['set-cookie'].includes('SameSite=Lax'));
          const authorize = new URL(headers.location);
          assert.equal(authorize.origin, 'https://github.com');
          const nonce = authorize.searchParams.get('state'); assert.ok(nonce); markers.push(nonce);
          state.callback = `${api}/api/v1/auth/github/callback?state=${encodeURIComponent(nonce)}&${state.mode === 'denied' ? 'error=C1_CODE_MARKER' : `code=C1_CODE_MARKER_${state.kind}`}`;
          return route.fulfill({ response, headers: { ...headers, location: state.callback }, body: '' });
        } catch { capture('initiation interception failed'); return route.abort(); }
      }
      if (![web, api].includes(url.origin)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('console', msg => capture(msg.text()));
    page.on('pageerror', err => capture(err.message));
    async function outcome(text) {
      await page.getByText(text, { exact: true }).waitFor();
      await page.waitForURL(`${web}/auth/callback`);
      assert.equal(new URL(page.url()).search, '');
      capture(await page.locator('body').innerText());
    }
    return { context, page, state, outcome };
  }
  async function signup(client, email, name) {
    let response = await client.context.request.post(`${api}/api/v1/auth/signup`, { data: { email, name, password: 'SyntheticC1Only!2026', organizationName: name } });
    if (response.status() === 409) response = await client.context.request.post(`${api}/api/v1/auth/signin`, { data: { email, password: 'SyntheticC1Only!2026' } });
    assert.ok(response.ok());
    return response.json();
  }
  const owner = await client(), other = await client();
  stage = 'local-signup';
  const ownerAuth = await signup(owner, 'owner-c1@example.invalid', 'C1 Owner');
  const otherAuth = await signup(other, 'other-c1@example.invalid', 'C1 Other');
  assert.ok(ownerAuth.tokens.accessToken); assert.ok(otherAuth.tokens.accessToken);
  const failedText = 'GitHub connection could not be completed. Please try again.';
  for (const kind of ['existing', 'unverified']) {
    stage = `${kind}-email-rejection`;
    const c = await client(); c.state.kind = kind;
    await c.page.goto(`${web}/signin`);
    await c.page.getByRole('button', { name: 'Sign in with GitHub' }).click();
    await c.outcome(failedText);
    await c.context.close();
  }
  stage = 'new-verified-identity';
  const fresh = await client();
  await fresh.page.goto(`${web}/signin`);
  await fresh.page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await fresh.outcome('Your GitHub account is connected.');
  await fresh.page.getByRole('link', { name: 'Continue to repositories' }).click();
  await fresh.page.getByRole('heading', { name: 'Repositories', exact: true }).waitFor();
  stage = 'replay';
  await fresh.page.goto(fresh.state.callback);
  const invalidText = 'This GitHub connection expired or does not belong to this browser. Start again.';
  await fresh.outcome(invalidText);
  stage = 'denial'; fresh.state.mode = 'denied';
  await fresh.page.getByRole('button', { name: 'Try GitHub again' }).click();
  await fresh.outcome('GitHub authorization was declined. Nothing was connected.');
  stage = 'invalid';
  await fresh.page.goto(`${api}/api/v1/auth/github/callback?code=C1_CODE_MARKER&state=C1_STATE_MARKER`);
  await fresh.outcome(invalidText);
  stage = 'owner-link'; owner.state.kind = 'existing';
  await owner.page.goto(`${web}/repositories`);
  await owner.page.getByRole('button', { name: 'Connect GitHub' }).click();
  await owner.outcome('Your GitHub account is connected.');
  stage = 'identity-mismatch';
  const mismatch = await owner.context.request.get(`${api}/api/v1/auth/github?mode=link`, { maxRedirects: 0, headers: { Authorization: `Bearer ${otherAuth.tokens.accessToken}` } });
  assert.equal(mismatch.status(), 401); capture(await mismatch.text());
  stage = 'authorization-diagnostics';
  const badAuth = await owner.context.request.get(`${api}/api/v1/auth/session`, { headers: { Authorization: 'Bearer C1_AUTH_MARKER' } });
  assert.equal(badAuth.status(), 401); capture(await badAuth.text());
  stage = 'redis-outage';
  const outageStatus = await outageProof(owner.context);
  stage = 'marker-scan';
  assert.ok(!markers.some(marker => diagnostics.some(line => line.includes(marker))));
  console.log(JSON.stringify({ containerBrowser: 'PASS', verifiedNewIdentity: 'PASS', existingEmailAutoLinkRejected: 'PASS', unverifiedEmailRejected: 'PASS', ownerLink: 'PASS', mismatchedIdentity: 'PASS', replayDenialInvalid: 'PASS', finalUrl: '/auth/callback', redisOutageInitiation: outageStatus, redisOutageCompletion: 'invalid', redisRestored: true, diagnosticMarkerOccurrences: 0 }));
  }
} catch {
  console.error(`C1 container browser FAILED at ${stage}; sensitive details withheld`);
  process.exitCode = 1;
} finally {
  if (redisStopped) { redisCommand('start'); await waitRedis(); }
  await browser?.close();
}
