const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireApi = createRequire('/app/apps/api/package.json');
const Redis = requireApi('ioredis');
const { OAuthStateService } = require('/app/apps/api/dist/auth/oauth-state.service');
const { verifyOAuthState } = requireApi('@codelens/github');
const { TokenCryptoService } = require('/app/apps/api/dist/auth/token-crypto.service');

(async () => {
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0, enableOfflineQueue: false, commandTimeout: 1500 });
  redis.on('error', () => {});
  await new Promise(resolve => redis.once('ready', resolve));
  const config = { jwtSecret: process.env.JWT_SECRET };
  const state = new OAuthStateService({ client: redis }, config);
  const context = { linkToUserId: 'synthetic-a', organizationId: 'synthetic-org', tokenGeneration: 1 };
  const keys = [];
  async function issue() {
    const entry = await state.issue(context, 'C1_REFRESH_MARKER');
    const key = `oauth:github:${verifyOAuthState(entry.state, config.jwtSecret).nonce}`;
    keys.push(key); return { ...entry, key };
  }
  try {
    let entry = await issue();
    const ttl = await redis.ttl(entry.key); assert.ok(ttl > 590 && ttl <= 600);
    await assert.rejects(state.consume(entry.state, 'x'.repeat(43), 'C1_REFRESH_MARKER'));
    await assert.rejects(state.consume(entry.state, entry.browser, 'C1_WRONG_REFRESH_MARKER'));
    assert.equal(await redis.exists(entry.key), 1);
    assert.deepEqual(await state.consume(entry.state, entry.browser, 'C1_REFRESH_MARKER'), context);
    await assert.rejects(state.consume(entry.state, entry.browser, 'C1_REFRESH_MARKER'));
    entry = await issue();
    await assert.rejects(state.consume(entry.state + 'tampered', entry.browser, 'C1_REFRESH_MARKER'));
    await redis.del(entry.key);
    await assert.rejects(state.consume(entry.state, entry.browser, 'C1_REFRESH_MARKER'));
    entry = await issue();
    const now = Date.now; Date.now = () => now() + 601000;
    try { await assert.rejects(state.consume(entry.state, entry.browser, 'C1_REFRESH_MARKER')); } finally { Date.now = now; }
    entry = await issue();
    const results = await Promise.allSettled(Array.from({ length: 64 }, () => state.consume(entry.state, entry.browser, 'C1_REFRESH_MARKER')));
    const success = results.filter(result => result.status === 'fulfilled').length;
    assert.equal(success, 1); assert.equal(await redis.exists(entry.key), 0);
    const { PrismaClient } = requireApi('@codelens/database');
    const db = new PrismaClient();
    const crypto = new TokenCryptoService({ encryptionKey: process.env.ENCRYPTION_KEY });
    const rows = await db.account.findMany({ select: { id: true, userId: true, providerAccountId: true, accessTokenEncrypted: true, user: { select: { email: true } } } });
    assert.equal(rows.length, 2);
    assert.equal(await db.user.count(), 3);
    for (const row of rows) {
      const kind = row.providerAccountId === '901' ? 'new' : 'existing';
      assert.equal(row.user.email, kind === 'new' ? 'new-c1@example.invalid' : 'owner-c1@example.invalid');
      assert.ok(row.accessTokenEncrypted.startsWith('v1:'));
      const value = crypto.decrypt(row.accessTokenEncrypted);
      assert.equal(value, `C1_SYNTHETIC_${kind}_TOKEN_MARKER`);
      assert.notEqual(value, row.accessTokenEncrypted);
      const again = crypto.encrypt(value); assert.notEqual(again, row.accessTokenEncrypted);
      assert.notEqual(again.split(':')[1], row.accessTokenEncrypted.split(':')[1]);
    }
    await db.$disconnect();
    console.log(JSON.stringify({ realRedis: true, ttlSeconds: ttl, attempts: 64, successes: success, rejected: 64-success, nonceRemaining: false, ownershipReplayExpiryTampering: 'PASS', encryptedRows: rows.length, accountIds: rows.map(row => ({ id: row.id, userId: row.userId, providerAccountId: row.providerAccountId })), correctOwners: true, cryptoRoundTripDistinctIv: 'PASS' }));
  } finally { for (const key of keys) await redis.del(key); await redis.quit(); }
})().catch(() => { console.error('C1 real-Redis proof FAILED; details withheld'); process.exitCode = 1; });
