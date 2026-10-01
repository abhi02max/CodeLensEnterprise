import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';

function fixture() {
  const auth = { completeGithubFlow: vi.fn(async () => ({ tokens: { refreshToken: 'synthetic-refresh', accessToken: 'SECRET_ACCESS_MARKER' } })), startGithubFlow: vi.fn(async () => ({ url: 'https://github.com/login/oauth/authorize?state=synthetic', browser: 'synthetic-browser' })) };
  const state = { consume: vi.fn(async () => ({ linkToUserId: 'user-a' })) };
  const response = { setHeader: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() };
  const controller = new AuthController(auth as never, { refreshCookieOptions: () => ({ httpOnly: true }) } as never,
    { webUrl: 'http://localhost:23000', isProduction: false } as never, state as never);
  const callback = (error?: string, code: string | undefined = 'SECRET_CODE_MARKER') => controller.githubCallback(
    { cookies: {} } as never, code, 'SECRET_STATE_MARKER', error, { ipAddress: null, userAgent: null }, 'trace', response as never);
  return { controller, auth, state, response, callback };
}
describe('OAuth callback redirects', () => {
  it('sets only an HttpOnly session cookie and redirects without any tokens', async () => {
    const f = fixture(); await f.callback();
    expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:23000/auth/callback?oauth=connected');
    expect(JSON.stringify(f.response.redirect.mock.calls)).not.toMatch(/SECRET_/);
  });
  it('consumes denial state and withholds upstream descriptions', async () => {
    const f = fixture(); await f.callback('SECRET_PROVIDER_MARKER');
    expect(f.state.consume).toHaveBeenCalledOnce();
    expect(f.auth.completeGithubFlow).not.toHaveBeenCalled();
    expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:23000/auth/callback?oauth=denied');
  });
  it('rejects invalid/replayed state before exchange', async () => {
    const f = fixture(); f.state.consume.mockRejectedValue(new Error('SECRET_STATE_MARKER'));
    await f.callback();
    expect(f.auth.completeGithubFlow).not.toHaveBeenCalled();
    expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:23000/auth/callback?oauth=invalid');
  });
  it('withholds provider failure details', async () => {
    const f = fixture(); f.auth.completeGithubFlow.mockRejectedValue(new Error('SECRET_PROVIDER_MARKER'));
    await f.callback();
    expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:23000/auth/callback?oauth=failed');
  });
});
