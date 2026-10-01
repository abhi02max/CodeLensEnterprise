import { HttpException, Logger } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { NestToolLogger } from './tool-logger';

afterEach(() => vi.restoreAllMocks());
it.each([false, true])('removes request credentials from client bodies and logs (production=%s)', (production) => {
  const markers = ['CODE', 'STATE', 'AUTH', 'COOKIE', 'ACCESS', 'API', 'KEY', 'BODY', 'PASSPHRASE'].map((label) => `SECRET_${label}_MARKER`);
  const calls: unknown[] = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args) => { calls.push(args); });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => { calls.push(args); });
  for (const exception of [new HttpException(`nested: ${markers.join(' ')}; ordinary validation failed`, 429), new Error(`provider failed: ${markers.join(' ')}`)]) {
    const request = { headers: { authorization: `Bearer ${markers[2]}`, 'x-share-passphrase': markers[8] }, cookies: { session: markers[3] }, body: { nested: { api_key: markers[7] } }, method: 'GET',
      originalUrl: `/api/v1/auth/github/callback?code=${markers[0]}&state=${markers[1]}&access_token=${markers[4]}&api_key=${markers[5]}&key=${markers[6]}` };
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn((body) => calls.push(body)) };
    const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
    new AllExceptionsFilter(production).catch(exception, host as never);
    expect(response.json.mock.calls[0]?.[0]).toMatchObject({ path: '/api/v1/auth/github/callback' });
  }
  for (const marker of markers) expect(JSON.stringify(calls)).not.toContain(marker);
  expect(JSON.stringify(calls)).toContain('ordinary validation failed');
});
it('sanitizes nested tool metadata and share URLs before logging/truncation', () => {
  const marker = 'SECRET_MARKER';
  const calls: unknown[] = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => { calls.push(args); });
  new NestToolLogger('synthetic').warn(`Bearer ${marker} /shared/${marker}`, { nested: { api_key: marker, authorization: marker }, note: `?state=${marker}` });
  expect(JSON.stringify(calls)).not.toContain(marker);
});
