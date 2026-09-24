import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@codelens/shared';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from '../../common/decorators';
import { UnauthorizedError } from '../../common/errors';
import { JwtTokenService } from '../jwt.service';

/**
 * Authentication guard, registered globally.
 *
 * Global-by-default is the important property: a new controller is protected unless
 * it explicitly opts out with `@Public()`. The opposite arrangement — opt in per
 * route — means a forgotten decorator silently ships an unauthenticated endpoint,
 * and that is a mistake nobody notices in review.
 *
 * Verification is pure JWT signature checking with no database lookup, so the hot
 * path costs no query. The `tokenGeneration` claim is validated against the database
 * only on refresh, which is the documented tradeoff: revocation takes effect within
 * one access-token TTL (15 minutes) rather than instantly.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedError('An Authorization: Bearer <token> header is required');
    }

    const payload = await this.jwt.verifyAccess(token);

    request.user = {
      userId: payload.sub,
      email: payload.email,
      organizationId: payload.orgId,
      role: payload.role as Role | null,
      tokenGeneration: payload.gen,
    };

    return true;
  }
}

/**
 * Extract a bearer token.
 *
 * The header is the only accepted source. A token in a query string would end up in
 * access logs, browser history and any `Referer` header the page emits, so that
 * convenience is not offered even though it would make debugging easier.
 */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  return value.trim() || null;
}
