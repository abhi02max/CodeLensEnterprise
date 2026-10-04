import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client construction and the tenant-scoping guard.
 *
 * The guard is the important part. Every tenant-scoped table carries
 * `organizationId`, but relying on developers to remember the filter on every
 * query is how multi-tenant systems leak. `forOrganization()` returns a client
 * that injects the filter automatically and rejects writes that target a
 * different tenant, so the safe path is also the default path.
 */

export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Models carrying a direct `organizationId` column.
 *
 * Deliberately explicit rather than derived from the DMMF: adding a tenant model
 * should require a conscious decision here, and a typo produces a missing-scope
 * error rather than silent global access.
 */
export const TENANT_SCOPED_MODELS = [
  'Repository',
  'PullRequest',
  'ReviewRun',
  'StaticFinding',
  'DismissedFinding',
  'MlPrediction',
  'AiReview',
  'RagChunk',
  'IndexRun',
  'Review',
  'Comment',
  'ShareLink',
  'AuditLog',
  'Membership',
  'Team',
  'Invite',
  'ApiKey',
  'ReviewPolicy',
  'AiSettings',
  'Conversation',
  'CollaborationTurn',
  'CollaborationAttempt',
  'ConversationMessage',
  'CollaborationToolCall',
  'EvidenceReference',
  'PatchProposal',
  'PatchProposalFile',
  'PatchProposalEvidence',
  'PatchApplication',
  'PatchApplicationAttempt',
  'PatchApplicationFileResult',
] as const;

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);

/** Operations whose `args.where` should gain the tenant filter. */
const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenantScopeViolationError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly expectedOrganizationId: string,
    readonly receivedOrganizationId: string,
  ) {
    super(
      `Tenant scope violation: ${model}.${operation} targeted organization ` +
        `${receivedOrganizationId} while scoped to ${expectedOrganizationId}`,
    );
    this.name = 'TenantScopeViolationError';
  }
}

function buildLogConfig(): Prisma.LogLevel[] {
  const level = process.env.LOG_LEVEL ?? 'info';
  // Prisma validation errors can serialize whole write arguments, including source/patch text.
  // Production domain handlers report bounded categories rather than raw ORM payloads.
  if (process.env.NODE_ENV === 'production') return ['warn'];
  if (level === 'debug' || level === 'trace') return ['query', 'info', 'warn', 'error'];
  return ['warn', 'error'];
}

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: buildLogConfig(),
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
}

/**
 * Process-wide singleton, constructed LAZILY.
 *
 * The laziness is not a micro-optimization, it is a correctness requirement. Module
 * imports are evaluated before any application bootstrap runs, so an eager
 * `createPrismaClient()` here executes before NestJS's ConfigModule (or any dotenv
 * loader) has populated `process.env`. The result is
 *
 *     PrismaClientConstructorValidationError: Invalid value undefined for datasource "db"
 *
 * at import time, and whether it happens depends on module import order — so it
 * appears to work until an unrelated import is added. A library must not require the
 * environment to be loaded merely to be imported.
 *
 * The Proxy defers construction to first property access, by which point the host
 * application has configured itself.
 *
 * The globalThis cache exists because Next.js dev and Nest watch mode re-evaluate
 * modules on reload; without it, connection pools accumulate until Postgres starts
 * refusing connections.
 */
const globalForPrisma = globalThis as unknown as { __codelensPrisma?: PrismaClient };

function getPrismaSingleton(): PrismaClient {
  if (!globalForPrisma.__codelensPrisma) {
    globalForPrisma.__codelensPrisma = createPrismaClient();
  }
  return globalForPrisma.__codelensPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrismaSingleton();
    const value = Reflect.get(client, property, receiver);

    // Methods must stay bound to the real client; returning an unbound function
    // would break `prisma.$transaction(...)` and every model delegate.
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, property) {
    return Reflect.has(getPrismaSingleton(), property);
  },
  set(_target, property, value) {
    return Reflect.set(getPrismaSingleton(), property, value);
  },
});

/**
 * Derive a tenant-scoped client.
 *
 * Reads gain `organizationId` in their `where`. Creates gain it in `data`.
 * Updates and deletes are filtered *and* validated, so an attacker who controls
 * a record id still cannot reach another tenant's row.
 *
 * Note the deliberate gap: `findUnique` on a model whose unique key does not
 * include `organizationId` cannot be filtered by Prisma's types. Those calls are
 * converted to `findFirst` so the filter still applies.
 */
export function forOrganization(organizationId: string, client: PrismaClient = prisma) {
  if (!organizationId) {
    throw new Error('forOrganization requires a non-empty organizationId');
  }

  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODEL_SET.has(model)) {
            return query(args);
          }

          const typedArgs = args as Record<string, unknown>;

          if (READ_OPERATIONS.has(operation)) {
            // findUnique cannot express an extra filter, so widen it to findFirst.
            if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
              const where = { ...(typedArgs.where as object), organizationId };
              const nextOperation = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
              const delegate = (client as unknown as Record<string, Record<string, Function>>)[
                lowerFirst(model)
              ];
              const fn = delegate?.[nextOperation];
              if (typeof fn === 'function') {
                return fn.call(delegate, { ...typedArgs, where });
              }
            }

            return query({
              ...typedArgs,
              where: { ...(typedArgs.where as object), organizationId },
            });
          }

          if (UPDATE_OPERATIONS.has(operation)) {
            assertTenantMatch(model, operation, organizationId, typedArgs.data);
            assertTenantMatch(model, operation, organizationId, typedArgs.create);

            return query({
              ...typedArgs,
              where: { ...(typedArgs.where as object), organizationId },
            });
          }

          if (CREATE_OPERATIONS.has(operation)) {
            const data = typedArgs.data;

            if (Array.isArray(data)) {
              return query({
                ...typedArgs,
                data: data.map((row: Record<string, unknown>) => {
                  assertTenantMatch(model, operation, organizationId, row);
                  return { ...row, organizationId };
                }),
              });
            }

            assertTenantMatch(model, operation, organizationId, data);
            return query({
              ...typedArgs,
              data: { ...(data as object), organizationId },
            });
          }

          return query(args);
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof forOrganization>;

function assertTenantMatch(
  model: string,
  operation: string,
  organizationId: string,
  payload: unknown,
): void {
  if (!payload || typeof payload !== 'object') return;

  const provided = (payload as Record<string, unknown>).organizationId;
  if (typeof provided === 'string' && provided !== organizationId) {
    throw new TenantScopeViolationError(model, operation, organizationId, provided);
  }
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// ---------------------------------------------------------------- error mapping

/**
 * Translate Prisma error codes into something an HTTP layer can act on without
 * importing Prisma internals or string-matching error messages.
 */
export type DatabaseErrorKind =
  | 'UNIQUE_VIOLATION'
  | 'NOT_FOUND'
  | 'FOREIGN_KEY_VIOLATION'
  | 'TENANT_VIOLATION'
  | 'CONNECTION_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

export interface ClassifiedDatabaseError {
  kind: DatabaseErrorKind;
  message: string;
  /** Field(s) responsible, when Prisma reports them. */
  fields: string[];
}

export function classifyDatabaseError(error: unknown): ClassifiedDatabaseError {
  if (error instanceof TenantScopeViolationError) {
    return { kind: 'TENANT_VIOLATION', message: error.message, fields: ['organizationId'] };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : target ? [String(target)] : [];

    switch (error.code) {
      case 'P2002':
        return {
          kind: 'UNIQUE_VIOLATION',
          message: fields.length
            ? `A record with this ${fields.join(', ')} already exists`
            : 'A record with these values already exists',
          fields,
        };
      case 'P2025':
        return { kind: 'NOT_FOUND', message: 'Record not found', fields };
      case 'P2003':
      case 'P2014':
        return {
          kind: 'FOREIGN_KEY_VIOLATION',
          message: 'Referenced record does not exist',
          fields,
        };
      default:
        return { kind: 'UNKNOWN', message: error.message, fields };
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return { kind: 'VALIDATION_ERROR', message: 'Invalid query arguments', fields: [] };
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { kind: 'CONNECTION_ERROR', message: 'Could not connect to the database', fields: [] };
  }

  return {
    kind: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    fields: [],
  };
}
