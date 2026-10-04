import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export class ReplayStore {
  private pending = Promise.resolve();
  constructor(private readonly directory: string) {}
  consume(nonce: string, expiresAt: number, now = Date.now()) {
    const operation = this.pending.then(() => this.consumeExclusive(nonce, expiresAt, now));
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  private async consumeExclusive(nonce: string, expiresAt: number, now: number) {
    if (!/^[a-f0-9-]{36}$/.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new Error('REPLAY_REJECTED');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    if (names.length > 1024) throw new Error('REPLAY_CAPACITY');
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name)) throw new Error('REPLAY_STORE_REJECTED');
      const bytes = await readFile(join(this.directory, name));
      const expiry = Number(bytes.toString());
      if (bytes.length > 32 || !Number.isSafeInteger(expiry))
        throw new Error('REPLAY_STORE_REJECTED');
      if (expiry < now) await unlink(join(this.directory, name));
    }
    if ((await readdir(this.directory)).length >= 1024) throw new Error('REPLAY_CAPACITY');
    const handle = await open(join(this.directory, nonce), 'wx', 0o600);
    try {
      await handle.writeFile(String(expiresAt));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
