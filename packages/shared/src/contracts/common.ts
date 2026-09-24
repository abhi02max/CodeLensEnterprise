import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';

/** CUIDs are what Prisma generates for every primary key in this schema. */
export const IdSchema = z.string().min(1).max(64);
export type Id = z.infer<typeof IdSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export function paginate<T>(items: T[], total: number, query: PaginationQuery): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages,
    hasNext: query.page < totalPages,
    hasPrevious: query.page > 1,
  };
}

/**
 * Error shape returned by the API's global exception filter. Fixed contract so
 * the web client can render field-level validation errors without guesswork.
 */
export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  /** Field path -> messages, populated for 422 validation failures. */
  errors?: Record<string, string[]>;
  traceId?: string;
  timestamp: string;
  path?: string;
}

/**
 * Discriminated result type used inside packages where throwing would lose
 * context — notably tool execution, where a failure is data the orchestrator
 * records rather than an exception that aborts the pipeline.
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** JSON-serializable value. Used for tool inputs/outputs persisted to Postgres. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);
