import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '@codelens/shared';
import { ForbiddenError, UnauthorizedError } from './errors';
import { traceIdOf } from './trace-id.middleware';

/**
 * Authenticated principal attached to the request by JwtAuthGuard.
 *
 * `organizationId` and `role` come from the JWT rather than a database lookup, which
 * keeps the common authorization path free of a round trip. The tradeoff is that a
 * role change only takes effect when the access token is refreshed, which is why the
 * access TTL is 15 minutes.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  organizationId: string | null;
  role: Role | null;
  tokenGeneration: number;
}

export const IS_PUBLIC_KEY = 'codelens:isPublic';
export const REQUIRED_ROLE_KEY = 'codelens:requiredRole';

/** Marks a route as reachable without authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum role for a route.
 *
 * Compared by rank, not equality, so `@RequireRole('REVIEWER')` also admits ADMIN
 * and OWNER without every route enumerating them.
 */
export const RequireRole = (role: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLE_KEY, role);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user) {
      throw new UnauthorizedError('No authenticated user on this request');
    }
    return request.user;
  },
);

/**
 * The active organization id.
 *
 * Throws when the session has no active organization instead of returning null, so
 * a handler cannot accidentally run an unscoped query. Every tenant-scoped route
 * should take this parameter.
 */
export const OrgId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

  if (!request.user) {
    throw new UnauthorizedError('No authenticated user on this request');
  }
  if (!request.user.organizationId) {
    throw new ForbiddenError(
      'This request requires an active organization. Create or select one first.',
      { code: 'NO_ACTIVE_ORGANIZATION' },
    );
  }

  return request.user.organizationId;
});

export const TraceId = createParamDecorator((_: unknown, ctx: ExecutionContext): string =>
  traceIdOf(ctx.switchToHttp().getRequest<Request>()),
);

/** Client IP and user agent, recorded on audit entries. */
export const RequestMeta = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): { ipAddress: string | null; userAgent: string | null } => {
    const request = ctx.switchToHttp().getRequest<Request>();

    return {
      ipAddress: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    };
  },
);
