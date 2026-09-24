import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { roleAtLeast, type Role } from '@codelens/shared';
import {
  IS_PUBLIC_KEY,
  REQUIRED_ROLE_KEY,
  type AuthenticatedUser,
} from '../../common/decorators';
import { ForbiddenError } from '../../common/errors';

/**
 * Role authorization guard, registered globally after JwtAuthGuard.
 *
 * Comparison is by rank rather than equality, so `@RequireRole(REVIEWER)` admits
 * ADMIN and OWNER too. Exact-match role checks are how privilege systems end up with
 * an admin who cannot perform a reviewer action, and then with every route listing
 * every role that should be allowed.
 *
 * Routes with no `@RequireRole` are allowed for any authenticated member. Authorization
 * beyond membership — "is this pull request in your organization" — is enforced by
 * tenant scoping at the data layer, not here, because a guard cannot know which
 * records a request will touch.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    // Method-level metadata overrides class-level, so a controller can set a baseline
    // and an individual route can require more.
    const requiredRole = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRole) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      // Means the guard order is wrong, not that the caller did anything wrong.
      throw new ForbiddenError('Authorization ran before authentication');
    }

    if (!user.role) {
      throw new ForbiddenError(
        'This action requires an active organization membership. Select an organization first.',
        { requiredRole },
      );
    }

    if (!roleAtLeast(user.role, requiredRole)) {
      throw new ForbiddenError(
        `This action requires the ${requiredRole} role or higher; your role is ${user.role}.`,
        { requiredRole, actualRole: user.role },
      );
    }

    return true;
  }
}
