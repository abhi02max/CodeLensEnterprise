import { Logger } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { TokenCryptoService } from './token-crypto.service';

it('uses independent 96-bit IVs and rejects ciphertext/tag/key tampering without logging tokens', () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  try {
    const crypto = new TokenCryptoService({ encryptionKey: 'a'.repeat(64) } as never);
    const marker = 'SECRET_TOKEN_MARKER';
    const first = crypto.encrypt(marker), second = crypto.encrypt(marker);
    expect(first).not.toContain(marker);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
    expect(Buffer.from(first.split(':')[1]!, 'base64url')).toHaveLength(12);
    expect(crypto.decrypt(first)).toBe(marker);
    const parts = first.split(':'); parts[2] = Buffer.alloc(16).toString('base64url');
    expect(crypto.decrypt(parts.join(':'))).toBeNull();
    expect(new TokenCryptoService({ encryptionKey: 'b'.repeat(64) } as never).decrypt(first)).toBeNull();
    expect(() => new TokenCryptoService({ encryptionKey: 'a'.repeat(64) + 'invalid' } as never)).toThrow();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(first);
  } finally { warn.mockRestore(); }
});
