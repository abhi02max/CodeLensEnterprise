import { Injectable, Logger } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import type { AuthTokens, JwtPayload, Role } from '@codelens/shared';
import { UnauthorizedError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';

/**
 * Access and refresh token issuance and verification.
 *
 * Design choices worth stating:
 *
 * - `orgId` and `role` are embedded in the access token so the common authorization
 *   path needs no database round trip. The cost is that a role change is not visible
 *   until the token expires, which is why the access TTL is 15 minutes rather than
 *   hours.
 *
 * - `gen` (token generation) is the revocation mechanism. Incrementing
 *   `User.tokenGeneration` invalidates every outstanding token for that user, which
 *   gives us password-change and "sign out everywhere" without maintaining a
 *   distributed denylist.
 *
 * - Access and refresh tokens are signed with *different* secrets, enforced at config
 *   validation. With a shared secret, a leaked access token could be replayed as a
 *   refresh token, which would defeat the entire point of a short access TTL.
 */
@Injectable()
export class JwtTokenService {
  private readonly logger = new Logger(JwtTokenService.name);

  constructor(
    private readonly jwt: NestJwtService,
    private readonly config: AppConfigService,
  ) {}

  async issue(params: {
    userId: string;
    email: string;
    organizationId: string | null;
    role: Role | null;
    tokenGeneration: number;
  }): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: params.userId,
      email: params.email,
      orgId: params.organizationId,
      role: params.role,
      gen: params.tokenGeneration,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.jwtSecret,
        // Seconds rather than a "15m" string. jsonwebtoken v9 types `expiresIn` as a
        // template-literal union, so an arbitrary string does not satisfy it, and
        // converting here keeps the config human-readable without a type assertion.
        expiresIn: parseTtlSeconds(this.config.jwtAccessTtl),
      }),
      // The refresh token deliberately carries only identity, not org or role.
      // Authorization claims are re-derived from the database on refresh, so a
      // revoked membership cannot be resurrected by refreshing an old token.
      this.jwt.signAsync(
        { sub: params.userId, email: params.email, gen: params.tokenGeneration },
        {
          secret: this.config.jwtRefreshSecret,
          expiresIn: parseTtlSeconds(this.config.jwtRefreshTtl),
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: parseTtlSeconds(this.config.jwtAccessTtl),
    };
  }

  async verifyAccess(token: string): Promise<JwtPayload> {
    try {
      return await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.jwtSecret,
      });
    } catch (error) {
      // Expiry is the overwhelmingly common case and is not worth logging; a
      // malformed or badly-signed token is worth a debug line.
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes('expired')) {
        this.logger.debug('Access token rejected: invalid signature or format');
      }

      throw new UnauthorizedError(
        message.includes('expired')
          ? 'Access token has expired'
          : 'Access token is invalid',
      );
    }
  }

  async verifyRefresh(token: string): Promise<{ sub: string; email: string; gen: number }> {
    try {
      return await this.jwt.verifyAsync<{ sub: string; email: string; gen: number }>(token, {
        secret: this.config.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedError('Refresh token is invalid or has expired');
    }
  }

  /** Refresh cookie options. httpOnly so JavaScript cannot read the token at all. */
  refreshCookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      // 'lax' rather than 'strict': the GitHub OAuth callback is a cross-site
      // top-level navigation, and 'strict' would drop the cookie on return.
      sameSite: this.config.isProduction ? 'lax' : 'lax',
      path: '/',
      maxAge: parseTtlSeconds(this.config.jwtRefreshTtl) * 1000,
    };
  }
}

/** Convert a jsonwebtoken-style TTL ("15m", "30d", "3600") to seconds. */
export function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)\s*([smhdw]?)$/i.exec(ttl.trim());
  if (!match) return 900;

  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86_400,
    w: 604_800,
    '': 1,
  };

  return value * (multipliers[unit] ?? 1);
}
