import { Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from './errors';

/**
 * Zod validation pipe.
 *
 * Used instead of class-validator so request validation reuses the exact schemas in
 * `packages/shared/src/contracts`. Those schemas already define the API contract and
 * are shared with the web client; duplicating them as decorated DTO classes would
 * guarantee the two drift apart, and a drift between client and server validation is
 * invisible until a request starts failing in production.
 *
 * Also returns the *parsed* value, so defaults and coercions declared in the schema
 * actually apply rather than being validated and discarded.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const fieldErrors: Record<string, string[]> = {};

        for (const issue of error.issues) {
          const path = issue.path.join('.') || '(root)';
          (fieldErrors[path] ??= []).push(issue.message);
        }

        throw new ValidationError('Request validation failed', fieldErrors);
      }
      throw error;
    }
  }
}

/** Terser construction at the call site: `@Body(zodBody(CreateCommentSchema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

export function zodQuery<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
