import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubClient } from '@codelens/github';
import { AuthService } from './auth.service';
import { TokenCryptoService } from './token-crypto.service';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const prisma = { unscoped: {
    user: { findUnique: vi.fn(async () => ({ id: 'local-a', tokenGeneration: 1 })) },
    membership: { findFirst: vi.fn(async () => ({ organizationId: 'org-a' })), findUnique: vi.fn(async () => ({ organizationId: 'org-a' })) },
    account: { findUnique: vi.fn(async () => null), upsert: vi.fn(), deleteMany: vi.fn() },
  } };
  const jwt = { verifyRefresh: vi.fn(async () => ({ sub: 'local-a', gen: 1 })), verifyAccess: vi.fn(async () => ({ sub: 'local-a', gen: 1, orgId: 'org-a' })) };
  const state = { issue: vi.fn(async () => ({ state: 'synthetic', browser: 'synthetic-browser' })) };
  const config = { github: { configured: true, clientId: 'synthetic', clientSecret: 'synthetic', callbackUrl: 'http://localhost/callback', scopes: ['user:email'] }, encryptionKey: 'a'.repeat(64) };
  const auth = new AuthService(prisma as never, jwt as never, new TokenCryptoService(config as never), config as never, { record: vi.fn() } as never, state as never);
  return { auth, prisma, jwt, state };
}
describe('local identity binding', () => {
  it('disconnect removes only the authenticated user\'s local GitHub credential rows', async () => {
    const f = fixture();
    await f.auth.disconnectGithub('local-a', null);
    expect(f.prisma.unscoped.account.deleteMany).toHaveBeenCalledWith({ where: { userId: 'local-a', provider: 'github' } });
  });
  it('requires the local refresh session and matching access identity for linking', async () => {
    const f = fixture();
    await expect(f.auth.startGithubFlow({ link: true })).rejects.toThrow('Sign in');
    f.jwt.verifyAccess.mockResolvedValue({ sub: 'local-b', gen: 1, orgId: 'org-a' });
    await expect(f.auth.startGithubFlow({ link: true, refreshToken: 'session', accessToken: 'other' })).rejects.toThrow('mismatch');
    expect(f.state.issue).not.toHaveBeenCalled();
  });
  it('retains initiating user/tenant and rejects revoked sessions before exchange', async () => {
    const f = fixture();
    await f.auth.startGithubFlow({ link: true, refreshToken: 'session', accessToken: 'access' });
    expect(f.state.issue).toHaveBeenCalledWith({ linkToUserId: 'local-a', organizationId: 'org-a', tokenGeneration: 1 }, 'session');
    f.prisma.unscoped.user.findUnique.mockResolvedValue({ id: 'local-a', tokenGeneration: 2 });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(f.auth.completeGithubFlow({ code: 'synthetic', context: { linkToUserId: 'local-a', organizationId: 'org-a', tokenGeneration: 1 } }, { ipAddress: null, userAgent: null, traceId: 'trace' })).rejects.toThrow('revoked');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not auto-link another GitHub identity by matching a local email', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'synthetic-provider-token', scope: 'read:user,user:email,repo' }))));
    vi.spyOn(GithubClient.prototype, 'getAuthenticatedUser').mockResolvedValue({ githubId: 1, login: 'synthetic', name: 'Synthetic', email: 'existing@example.invalid', avatarUrl: '' });
    await expect(f.auth.completeGithubFlow({ code: 'synthetic', context: { linkToUserId: null, organizationId: null, tokenGeneration: null } }, { ipAddress: null, userAgent: null, traceId: 'trace' })).rejects.toThrow('Sign in to your existing');
    expect(f.prisma.unscoped.account.upsert).not.toHaveBeenCalled();
  });
});
