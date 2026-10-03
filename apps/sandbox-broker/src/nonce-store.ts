import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Persist only nonce expiry; restart must not make a consumed request usable again. */
export class NonceStore {
  constructor(private readonly directory: string) {}
  async initialize(now = Date.now()) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.expire(now);
  }
  private async expire(now: number) {
    const files = await readdir(this.directory);
    if (files.length > 1024) throw new Error('BROKER_NONCE_CAPACITY');
    for (const file of files) {
      if (!/^[a-f0-9-]{36}$/.test(file)) throw new Error('BROKER_NONCE_STORE_INVALID');
      const bytes = await readFile(join(this.directory, file));
      if (bytes.length > 32) throw new Error('BROKER_NONCE_STORE_INVALID');
      const expiry = Number(bytes.toString());
      if (!Number.isSafeInteger(expiry)) throw new Error('BROKER_NONCE_STORE_INVALID');
      if (expiry < now) await unlink(join(this.directory, file));
    }
  }
  async consume(nonce: string, expiry: number, now = Date.now()) {
    if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('BROKER_NONCE_STORE_INVALID');
    await this.expire(now);
    if ((await readdir(this.directory)).length >= 1024) throw new Error('BROKER_NONCE_CAPACITY');
    try {
      await writeFile(join(this.directory, nonce), String(expiry), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
    } catch {
      throw new Error('BROKER_NONCE_STORE_FAILED_OR_REPLAY');
    }
  }
}
