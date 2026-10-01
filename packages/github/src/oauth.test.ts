import { afterEach, expect, it, vi } from 'vitest';
import { createOAuthState, verifyOAuthState } from './oauth';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('signs immutable nonce/time fields and rejects tampering and future/expired timestamps', () => {
  const secret = 'synthetic-signature-key';
  const state = createOAuthState(secret, { nonce: 'override', issuedAt: '0' });
  const parsed = verifyOAuthState(state, secret);
  expect(parsed.nonce).toMatch(/^[a-f0-9]{32}$/);
  expect(parsed.issuedAt).toBeGreaterThan(0);
  expect(() => verifyOAuthState(`${state}tamper`, secret)).toThrow();
  vi.spyOn(Date, 'now').mockReturnValue(parsed.issuedAt - 1);
  expect(() => verifyOAuthState(state, secret)).toThrow();
  vi.mocked(Date.now).mockReturnValue(parsed.issuedAt + 600_001);
  expect(() => verifyOAuthState(state, secret)).toThrow();
});
