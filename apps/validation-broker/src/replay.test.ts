import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReplayStore } from './replay';
describe.skipIf(process.platform === 'win32')('durable exclusive nonce ownership', () => {
  it('64 concurrent consumers have exactly one success and restart does not permit replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'validation-replay-'));
    try {
      const nonce = randomUUID(),
        expiresAt = Date.now() + 120000;
      const store = new ReplayStore(directory);
      const attempts = await Promise.allSettled(
        Array.from({ length: 64 }, () => store.consume(nonce, expiresAt)),
      );
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      await expect(new ReplayStore(directory).consume(nonce, expiresAt)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
