import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TRACE_ID_HEADER, TRACE_ID_RESPONSE_HEADER } from './trace.constants';

/**
 * Assigns a trace id to every request.
 *
 * An inbound `x-request-id` is honoured so a load balancer or upstream gateway can
 * own the id, but it is length-capped and sanitised first: the value ends up in log
 * lines and database rows, and an unbounded attacker-controlled string there is
 * both a log-injection vector and a storage problem.
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.headers[TRACE_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    const traceId =
      candidate && typeof candidate === 'string'
        ? candidate.replace(/[^\w.-]/g, '').slice(0, 64) || randomUUID()
        : randomUUID();

    request.headers[TRACE_ID_HEADER] = traceId;
    response.setHeader(TRACE_ID_RESPONSE_HEADER, traceId);

    next();
  }
}

/** Read the trace id off a request. */
export function traceIdOf(request: Request): string {
  return (request.headers[TRACE_ID_HEADER] as string | undefined) ?? 'unknown';
}
