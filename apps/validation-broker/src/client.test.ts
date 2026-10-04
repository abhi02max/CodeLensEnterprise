import { createServer, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeFrame, hash, LIMITS, readFrame, validateInput } from '@codelens/validation-executor';
import { authenticate, signResult } from './protocol';
import { requestValidation } from './client';

const input = {
  version: 1 as const,
  profile: 'vitest-unit-v1' as const,
  files: [{ path: 'package.json', content: '{}' }],
};
async function channel(handle: (socket: Socket) => void) {
  const path =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\validation-' + randomUUID()
      : join(tmpdir(), 'validation-' + randomUUID() + '.sock');
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => sockets.delete(s));
    handle(s);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    path,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
it.each([false, true])(
  'accepts only authenticated correlated broker results (tampered=%s)',
  async (tampered) => {
    const key = randomBytes(32),
      nonce = randomUUID();
    const server = await channel((s) => {
      void (async () => {
        const request = authenticate(key, await readFrame(s, LIMITS.frameBytes));
        expect(request.nonce).toBe(nonce);
        const empty = { digest: hash(''), capturedBytes: 0, excerpt: '', complete: true };
        const result = {
          version: 1,
          profile: input.profile,
          profileVersion: 1,
          policyVersion: 'validation-local-v1',
          image: 'sha256:' + 'a'.repeat(64),
          bundleDigest: 'b'.repeat(64),
          configurationDigest: 'c'.repeat(64),
          correlation: nonce,
          inputDigest: validateInput(input).digest,
          status: 'UNSUPPORTED',
          observed: {
            started: false,
            exitCode: null,
            termination: 'EXITED',
            oom: false,
            durationMs: 0,
            cleanup: 'DISPOSED',
            stdout: empty,
            stderr: empty,
          },
          runnerReported: { trusted: false, status: 'MISSING', reportDigest: null, report: null },
        };
        const signed = signResult(key, tampered ? randomUUID() : nonce, result);
        s.end(encodeFrame(signed, LIMITS.resultBytes));
      })().catch(() => s.destroy());
    });
    try {
      const response = requestValidation(
        server.path,
        key,
        input,
        nonce,
        new AbortController().signal,
        Date.now() + 1000,
      );
      if (tampered) await expect(response).rejects.toThrow('RESPONSE_REJECTED');
      else expect((await response).status).toBe('UNSUPPORTED');
    } finally {
      await server.close();
    }
  },
);
it('abort rejects an active owned request without claiming a cleanup receipt', async () => {
  const key = randomBytes(32),
    abort = new AbortController();
  let accepted!: () => void;
  const ready = new Promise<void>((r) => {
    accepted = r;
  });
  const server = await channel((s) => {
    void readFrame(s, LIMITS.frameBytes)
      .then(() => accepted())
      .catch(() => undefined);
  });
  try {
    const request = requestValidation(
      server.path,
      key,
      input,
      randomUUID(),
      abort.signal,
      Date.now() + 1000,
    );
    const rejection = expect(request).rejects.toThrow();
    await ready;
    abort.abort();
    await rejection;
  } finally {
    await server.close();
  }
});
it('expired or pre-cancelled requests never open a channel', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    requestValidation(
      'absent',
      randomBytes(32),
      input,
      randomUUID(),
      abort.signal,
      Date.now() + 1000,
    ),
  ).rejects.toThrow();
  await expect(
    requestValidation(
      'absent',
      randomBytes(32),
      input,
      randomUUID(),
      new AbortController().signal,
      Date.now() - 1,
    ),
  ).rejects.toThrow('VALIDATION_DEADLINE');
});
