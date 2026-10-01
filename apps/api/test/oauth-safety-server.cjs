// Test-only loopback server. This directory is excluded from Docker build contexts.
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const cookieParser = require('cookie-parser');
const { GithubClient } = require('@codelens/github');
const { AuthController } = require('../dist/auth/auth.controller');
const { AuthService } = require('../dist/auth/auth.service');
const { OAuthStateService } = require('../dist/auth/oauth-state.service');
const { JwtTokenService } = require('../dist/auth/jwt.service');
const { TokenCryptoService } = require('../dist/auth/token-crypto.service');
const { AppConfigService } = require('../dist/config/app-config.service');
const { AllExceptionsFilter } = require('../dist/common/all-exceptions.filter');

async function start(webUrl, apiOrigin) {
  if (![webUrl, apiOrigin].every((value) => /^http:\/\/localhost:\d+$/.test(value)) ||
      [3000, 4000, 23000, 24000].includes(Number(new URL(apiOrigin).port))) throw new Error('Dedicated loopback ports required');
  const records = new Map();
  const redis = { client: {
    set: async (key, value) => { records.set(key, value); return 'OK'; },
    eval: async (_lua, _n, key, binding) => {
      const raw = records.get(key);
      if (!raw || JSON.parse(raw).binding !== binding) return null;
      records.delete(key); return raw;
    },
  } };
  let connected = false;
  const credentials = [];
  const org = { id: 'synthetic-org', name: 'Synthetic workspace', slug: 'synthetic', role: 'OWNER' };
  const user = () => ({ id: 'synthetic-user', email: 'synthetic@example.invalid', name: 'Synthetic', avatarUrl: null,
    tokenGeneration: 1, createdAt: new Date(), accounts: connected ? [{ providerLogin: 'synthetic' }] : [],
    memberships: [{ organization: org, organizationId: org.id, role: 'OWNER' }],
  });
  const prisma = { unscoped: {
    user: { findUnique: async () => user() },
    membership: { findFirst: async () => ({ organizationId: org.id, role: 'OWNER' }), findUnique: async () => ({ organizationId: org.id }) },
    account: { findUnique: async () => ({ userId: 'synthetic-user' }), upsert: async (args) => { credentials.push(args); connected = true; }, deleteMany: async () => { connected = false; } },
  } };
  const config = { webUrl, isProduction: false, encryptionKey: 'a'.repeat(64), jwtSecret: 'synthetic-access-signing-key',
    jwtRefreshSecret: 'synthetic-refresh-signing-key', jwtAccessTtl: '15m', jwtRefreshTtl: '1h',
    github: { configured: true, clientId: 'synthetic-only', clientSecret: 'synthetic-only', scopes: ['read:user', 'user:email', 'repo'], callbackUrl: `${apiOrigin}/api/v1/auth/github/callback` },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) !== 'https://github.com/login/oauth/access_token') throw new Error('External requests forbidden in synthetic server');
    return new Response(JSON.stringify({ access_token: 'SECRET_PROVIDER_MARKER', scope: 'read:user,user:email,repo' }));
  };
  const originalProfile = GithubClient.prototype.getAuthenticatedUser;
  GithubClient.prototype.getAuthenticatedUser = async () => ({ githubId: 1, login: 'synthetic', email: 'synthetic@example.invalid', name: 'Synthetic', avatarUrl: '' });
  const jwt = new JwtTokenService(new JwtService(), config);
  const state = new OAuthStateService(redis, config);
  const auth = new AuthService(prisma, jwt, new TokenCryptoService(config), config, { record: async () => {} }, state);
  const module = await Test.createTestingModule({ controllers: [AuthController], providers: [
    { provide: AuthService, useValue: auth }, { provide: JwtTokenService, useValue: jwt },
    { provide: OAuthStateService, useValue: state }, { provide: AppConfigService, useValue: config },
  ] }).compile();
  const app = module.createNestApplication({ logger: false });
  const logs = [];
  app.useLogger(Object.fromEntries(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'].map((level) => [level, (...args) => { logs.push(args); }])));
  app.use(cookieParser());
  app.enableCors({ origin: webUrl, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter(false));
  app.use(async (request, response, next) => {
    if (request.headers.authorization) {
      try { const token = await jwt.verifyAccess(request.headers.authorization.slice(7)); request.user = { userId: token.sub, organizationId: token.orgId }; } catch { /* endpoint handles rejection */ }
    }
    if (request.path === '/api/v1/repositories') return response.json({ items: [], total: 0, page: 1, pageSize: 100 });
    if (request.path.startsWith('/api/v1/health')) return response.json({ status: 'healthy', checks: [] });
    next();
  });
  await app.listen(Number(new URL(apiOrigin).port), '127.0.0.1');
  return { credentials, logs, close: async () => { await app.close(); global.fetch = originalFetch; GithubClient.prototype.getAuthenticatedUser = originalProfile; } };
}
module.exports = { start };
