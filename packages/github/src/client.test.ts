import { afterEach, expect, it, vi } from 'vitest';
import { GithubClient } from './client';

afterEach(() => vi.restoreAllMocks());
it('never uses an unverified/public profile email for identity creation', async () => {
  const client = new GithubClient({ accessToken: 'synthetic-only' });
  const request = vi.spyOn(client as unknown as { request: (label: string, fn: unknown) => Promise<unknown> }, 'request');
  request.mockImplementation(async (label) => label === 'getAuthenticatedUser'
    ? { data: { id: 1, login: 'fixture', email: 'unverified@example.invalid', avatar_url: '' } }
    : { data: [{ email: 'unverified@example.invalid', primary: true, verified: false }] });
  expect((await client.getAuthenticatedUser()).email).toBeNull();
  request.mockImplementation(async (label) => label === 'getAuthenticatedUser'
    ? { data: { id: 1, login: 'fixture', email: 'unverified@example.invalid', avatar_url: '' } }
    : { data: [{ email: 'unverified@example.invalid', primary: true, verified: false }, { email: 'verified@example.invalid', primary: false, verified: true }] });
  expect((await client.getAuthenticatedUser()).email).toBe('verified@example.invalid');
});
