import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain exceptions.
 *
 * Each carries a stable machine-readable `code` alongside the HTTP status. The web
 * client branches on `code`, never on the message, so wording can be improved
 * without breaking the frontend.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

export class NotFoundError extends AppException {
  constructor(resource: string, id?: string) {
    super(
      HttpStatus.NOT_FOUND,
      'RESOURCE_NOT_FOUND',
      id ? `${resource} ${id} was not found` : `${resource} was not found`,
      { resource, id },
    );
  }
}

export class ValidationError extends AppException {
  constructor(message: string, fieldErrors: Record<string, string[]> = {}) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message, { fieldErrors });
  }
}

export class ConflictError extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(HttpStatus.CONFLICT, 'CONFLICT', message, details);
  }
}

export class ForbiddenError extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(HttpStatus.FORBIDDEN, 'FORBIDDEN', message, details);
  }
}

export class UnauthorizedError extends AppException {
  constructor(message = 'Authentication is required') {
    super(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }
}

/** Raised when a GitHub token is missing, revoked or expired. */
export class GithubNotConnectedError extends AppException {
  constructor(message = 'No usable GitHub connection for this account') {
    super(HttpStatus.PRECONDITION_REQUIRED, 'GITHUB_NOT_CONNECTED', message);
  }
}

/**
 * Raised when an upstream dependency is unavailable.
 *
 * Distinguished from a generic 500 because it tells the caller the request may
 * succeed on retry and that nothing is wrong with their input.
 */
export class UpstreamUnavailableError extends AppException {
  constructor(service: string, message: string) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'UPSTREAM_UNAVAILABLE', message, { service });
  }
}

export class RateLimitedError extends AppException {
  constructor(message: string, retryAfterSeconds: number) {
    super(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message, { retryAfterSeconds });
  }
}

/**
 * Raised when a policy rule blocks an operation, e.g. posting to GitHub while the
 * organization has not opted in. Distinct from FORBIDDEN, which is about identity:
 * this is about configuration the admin can change.
 */
export class PolicyViolationError extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(HttpStatus.FORBIDDEN, 'POLICY_VIOLATION', message, details);
  }
}
