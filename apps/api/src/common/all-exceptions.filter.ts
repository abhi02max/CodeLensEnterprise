import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { classifyDatabaseError } from '@codelens/database';
import { GithubError } from '@codelens/github';
import type { ApiErrorBody } from '@codelens/shared';
import { AppException } from './errors';
import { TRACE_ID_HEADER } from './trace.constants';

/**
 * Global exception filter.
 *
 * Every error leaves the API in the {@link ApiErrorBody} shape, so the web client
 * has one error contract to handle. Three things matter here beyond formatting:
 *
 *   - Errors from the packages (Prisma, GitHub) are translated into HTTP status
 *     codes at this single boundary, rather than each controller knowing how to
 *     interpret a Prisma error code.
 *
 *   - Internal details never reach the client in production. A Prisma error message
 *     can contain column names, table names and fragments of the failing query,
 *     which is both a leak and useless to the caller.
 *
 *   - Every response carries the traceId, so a user-reported failure can be found
 *     in the logs without guessing at timestamps.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId = (request.headers[TRACE_ID_HEADER] as string | undefined) ?? 'unknown';
    const mapped = this.map(exception);
    const path = redactSensitivePath(request.originalUrl);

    const body: ApiErrorBody = {
      statusCode: mapped.status,
      code: mapped.code,
      message: mapped.message,
      ...(mapped.errors ? { errors: mapped.errors } : {}),
      traceId,
      timestamp: new Date().toISOString(),
      path,
    };

    // 5xx is our fault and gets a stack trace; 4xx is the caller's and gets one line.
    if (mapped.status >= 500) {
      this.logger.error(
        `${request.method} ${path} -> ${mapped.status} ${mapped.code}: ${mapped.logMessage}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${path} -> ${mapped.status} ${mapped.code}: ${mapped.logMessage}`,
      );
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }

    response.status(mapped.status).json(body);
  }

  private map(exception: unknown): {
    status: number;
    code: string;
    message: string;
    logMessage: string;
    errors?: Record<string, string[]>;
    retryAfterSeconds?: number;
  } {
    // ---- our own domain exceptions
    if (exception instanceof AppException) {
      const payload = exception.getResponse() as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };

      const fieldErrors = payload.details?.fieldErrors as
        | Record<string, string[]>
        | undefined;
      const retryAfter = payload.details?.retryAfterSeconds as number | undefined;

      return {
        status: exception.getStatus(),
        code: payload.code,
        message: payload.message,
        logMessage: payload.message,
        ...(fieldErrors ? { errors: fieldErrors } : {}),
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      };
    }

    // ---- Zod, from a validation pipe or a service-level parse
    if (exception instanceof ZodError) {
      const errors: Record<string, string[]> = {};

      for (const issue of exception.issues) {
        const path = issue.path.join('.') || '(root)';
        (errors[path] ??= []).push(issue.message);
      }

      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        logMessage: `validation: ${exception.issues.map((i) => i.message).join('; ')}`,
        errors,
      };
    }

    // ---- GitHub
    if (exception instanceof GithubError) {
      const status = exception.requiresReauth
        ? HttpStatus.PRECONDITION_REQUIRED
        : exception.kind === 'NOT_FOUND'
          ? HttpStatus.NOT_FOUND
          : exception.kind === 'FORBIDDEN'
            ? HttpStatus.FORBIDDEN
            : exception.retryable
              ? HttpStatus.SERVICE_UNAVAILABLE
              : HttpStatus.BAD_GATEWAY;

      return {
        status,
        code: `GITHUB_${exception.kind}`,
        message: exception.message,
        logMessage: `github ${exception.kind}: ${exception.message}`,
        ...(exception.retryAfterSeconds !== null
          ? { retryAfterSeconds: exception.retryAfterSeconds }
          : {}),
      };
    }

    // ---- Nest's own HttpExceptions, including guard rejections
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status: exception.getStatus(),
        code: (payload as { code?: string }).code ?? httpStatusCode(exception.getStatus()),
        message: Array.isArray(message) ? message.join('; ') : message,
        logMessage: exception.message,
      };
    }

    // ---- Prisma
    const dbError = classifyDatabaseError(exception);

    if (dbError.kind !== 'UNKNOWN') {
      const statusByKind: Record<typeof dbError.kind, number> = {
        UNIQUE_VIOLATION: HttpStatus.CONFLICT,
        NOT_FOUND: HttpStatus.NOT_FOUND,
        FOREIGN_KEY_VIOLATION: HttpStatus.UNPROCESSABLE_ENTITY,
        // A tenant violation means a bug in our scoping, not a client error.
        // Reported as 500 and logged loudly: it must never happen.
        TENANT_VIOLATION: HttpStatus.INTERNAL_SERVER_ERROR,
        CONNECTION_ERROR: HttpStatus.SERVICE_UNAVAILABLE,
        VALIDATION_ERROR: HttpStatus.UNPROCESSABLE_ENTITY,
        // No UNKNOWN entry: the guard above narrows it out, and listing it would be
        // dead code that TypeScript correctly rejects.
      };

      const status = statusByKind[dbError.kind];

      return {
        status,
        code: `DB_${dbError.kind}`,
        // Prisma messages can contain schema internals and query fragments, so the
        // detail stays server-side in production.
        message:
          status >= 500 && this.isProduction
            ? 'An internal database error occurred'
            : dbError.message,
        logMessage: `prisma ${dbError.kind}: ${dbError.message}`,
        ...(dbError.fields.length > 0
          ? { errors: { [dbError.fields.join('.')]: [dbError.message] } }
          : {}),
      };
    }

    // ---- anything else
    const message = exception instanceof Error ? exception.message : String(exception);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: this.isProduction ? 'An unexpected error occurred' : message,
      logMessage: message,
    };
  }
}

/**
 * Path segments that are credentials, and must not be echoed or logged.
 *
 * The API refuses tokens in query strings precisely because they end up in access logs and
 * `Referer` headers — see `extractBearerToken`. A share link cannot follow that rule: the token
 * *is* the URL, because the whole point is a link somebody can send to a colleague.
 *
 * So the token is redacted at the two places it would otherwise escape: the error body returned
 * to the caller, and the log line written for every request that fails. Without this, every 404
 * on a dead share link records a live token at warn level, and anyone with log access could
 * replay it until the link expired — which is a wider audience than the database has.
 *
 * Declared as a list so adding the next credential-bearing route is one entry rather than
 * another ad-hoc replace.
 */
const SECRET_PATH_PREFIXES: readonly string[] = ['/review-sessions/share/'];

export function redactSensitivePath(originalUrl: string): string {
  for (const prefix of SECRET_PATH_PREFIXES) {
    const start = originalUrl.indexOf(prefix);
    if (start === -1) continue;

    const valueStart = start + prefix.length;
    // Stop at the next path or query boundary so anything after the secret survives.
    const boundary = originalUrl.slice(valueStart).search(/[/?#]/);
    const valueEnd = boundary === -1 ? originalUrl.length : valueStart + boundary;

    if (valueEnd === valueStart) continue;

    return `${originalUrl.slice(0, valueStart)}[redacted]${originalUrl.slice(valueEnd)}`;
  }

  return originalUrl;
}

function httpStatusCode(status: number): string {
  const known: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'RESOURCE_NOT_FOUND',
    409: 'CONFLICT',
    422: 'VALIDATION_FAILED',
    429: 'RATE_LIMITED',
    503: 'UPSTREAM_UNAVAILABLE',
  };
  return known[status] ?? 'HTTP_ERROR';
}
