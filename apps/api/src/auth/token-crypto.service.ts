import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Encryption for GitHub OAuth tokens at rest.
 *
 * A stored GitHub token with `repo` scope grants read access to every private
 * repository the user can see, so it is the highest-value secret in the system.
 * Storing it in plaintext would mean a single SQL injection or a leaked backup
 * exposes every connected customer's source code.
 *
 * AES-256-GCM rather than AES-CBC: GCM is authenticated, so a tampered ciphertext
 * fails to decrypt instead of producing garbage plaintext that gets sent to GitHub
 * as a bearer token.
 *
 * Ciphertext format is `v1:iv:authTag:payload`, all base64url. The version prefix
 * exists so a future key rotation or algorithm change can be rolled out by reading
 * both formats during the migration window rather than by a flag day.
 */
@Injectable()
export class TokenCryptoService {
  private readonly logger = new Logger(TokenCryptoService.name);
  private readonly key: Buffer;

  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly VERSION = 'v1';
  /** GCM's standard nonce length. 96 bits is what the spec recommends. */
  private static readonly IV_BYTES = 12;
  private static readonly AUTH_TAG_BYTES = 16;

  constructor(config: AppConfigService) {
    if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
    // Env validation already enforces 64 hex characters, so this cannot throw in a
    // booted application. Re-checked here because a silently wrong key length would
    // surface as an unrelated crypto error at the first GitHub connection.
    this.key = Buffer.from(config.encryptionKey, 'hex');

    if (this.key.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM, got ${this.key.length}`,
      );
    }
  }

  /**
   * Encrypt a token.
   *
   * A fresh random IV per call is mandatory, not an optimization: reusing a nonce
   * with GCM under the same key is a catastrophic failure that leaks the keystream
   * and allows forgery.
   */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error('Refusing to encrypt an empty value');
    }

    const iv = randomBytes(TokenCryptoService.IV_BYTES);
    const cipher = createCipheriv(TokenCryptoService.ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      TokenCryptoService.VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  /**
   * Decrypt a token.
   *
   * Returns null rather than throwing on any failure. A token that cannot be
   * decrypted — wrong key after a rotation, corrupted row, tampering — should be
   * treated as "no GitHub connection", which the caller already handles by asking
   * the user to reconnect. Throwing would turn a recoverable state into a 500.
   *
   * The failure is logged without the ciphertext: logging it would defeat the
   * encryption for anyone with log access.
   */
  decrypt(ciphertext: string | null | undefined): string | null {
    if (!ciphertext) return null;

    const parts = ciphertext.split(':');

    if (parts.length !== 4 || parts[0] !== TokenCryptoService.VERSION) {
      this.logger.warn(
        `Stored token has an unrecognised format or version; treating as disconnected`,
      );
      return null;
    }

    try {
      const [, ivPart, authTagPart, payloadPart] = parts as [string, string, string, string];

      const iv = Buffer.from(ivPart, 'base64url');
      const authTag = Buffer.from(authTagPart, 'base64url');
      const payload = Buffer.from(payloadPart, 'base64url');

      if (iv.length !== TokenCryptoService.IV_BYTES) return null;
      if (authTag.length !== TokenCryptoService.AUTH_TAG_BYTES) return null;

      const decipher = createDecipheriv(TokenCryptoService.ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    } catch {
      // Almost always an auth-tag mismatch, meaning the key changed or the row was
      // modified. Either way the token is unusable.
      this.logger.warn('Stored GitHub token failed authenticated decryption');
      return null;
    }
  }

  /**
   * Hash a value for storage where only equality matters: invite tokens, API keys,
   * share-link tokens.
   *
   * Plain SHA-256 rather than bcrypt is correct here, and the reason is worth being
   * precise about. Bcrypt exists to slow down brute force against *low-entropy*
   * human-chosen passwords. These tokens are 32 random bytes, so there is nothing to
   * brute force, and bcrypt's cost would only add latency to every share-link view.
   * Passwords still use bcrypt; see AuthService.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Generate a URL-safe random token plus its hash. The raw value is shown once. */
  generateToken(byteLength = 32): { token: string; hash: string } {
    const token = randomBytes(byteLength).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  /**
   * Constant-time comparison of a presented token against a stored hash.
   *
   * Hashes first so both operands are fixed length, then compares in constant time
   * to avoid leaking a prefix match through response timing.
   */
  verifyToken(presented: string, storedHash: string): boolean {
    const presentedHash = Buffer.from(this.hashToken(presented), 'hex');
    const expected = Buffer.from(storedHash, 'hex');

    if (presentedHash.length !== expected.length) return false;
    return timingSafeEqual(presentedHash, expected);
  }

  /**
   * Redact a token for display. Never returns enough to use.
   * `ghp_abc...xyz` lets a user identify which token is connected without exposing it.
   */
  static redact(token: string): string {
    if (token.length <= 12) return '***';
    return `${token.slice(0, 7)}…${token.slice(-4)}`;
  }
}
