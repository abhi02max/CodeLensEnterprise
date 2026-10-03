import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { NonceStore } from './nonce-store';
it('persists single-use consumption across broker reconstruction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'broker-nonce-test-'));
  try {
    const nonce = randomUUID(),
      store = new NonceStore(directory),
      now = 100000;
    await store.initialize(now);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => store.consume(nonce, now + 60000, now)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const restarted = new NonceStore(directory);
    await restarted.initialize(now);
    await expect(restarted.consume(nonce, now + 60000, now)).rejects.toThrow('REPLAY');
    await restarted.initialize(now + 60001);
    await restarted.consume(nonce, now + 120000, now + 60001);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
