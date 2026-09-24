import { Injectable, Logger } from '@nestjs/common';
import {
  paginate,
  type AuditAction,
  type AuditLogView,
  type JsonValue,
  type ListAuditLogsQuery,
  type Paginated,
} from '@codelens/shared';
import { ActorType, type Prisma } from '@codelens/database';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecordInput {
  organizationId: string;
  action: AuditAction | string;
  actorId?: string | null;
  actorType?: ActorType;
  resourceType: string;
  resourceId?: string | null;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
}

/**
 * Audit trail.
 *
 * Append-only: there is no update or delete path anywhere in the API, and retention
 * is handled by a scheduled archival job rather than by mutation. An audit log that
 * can be edited is not an audit log.
 *
 * {@link record} never throws. Failing a repository connection because the audit
 * write failed would be the wrong trade — the operation already succeeded, and losing
 * an audit row is bad but strictly less bad than rolling back user-visible work and
 * reporting an error for something that worked. Failures are logged at error level so
 * a broken audit pipeline is still visible.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.unscoped.auditLog.create({
        data: {
          organizationId: input.organizationId,
          action: input.action,
          actorType: input.actorType ?? (input.actorId ? ActorType.USER : ActorType.SYSTEM),
          actorId: input.actorId ?? null,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          description: input.description,
          metadata: sanitizeMetadata(input.metadata ?? {}),
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          traceId: input.traceId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry ${input.action} for org ${input.organizationId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Batch variant for pipeline stages that emit several entries at once. */
  async recordMany(inputs: AuditRecordInput[]): Promise<void> {
    if (inputs.length === 0) return;

    try {
      await this.prisma.unscoped.auditLog.createMany({
        data: inputs.map((input) => ({
          organizationId: input.organizationId,
          action: input.action,
          actorType: input.actorType ?? (input.actorId ? ActorType.USER : ActorType.SYSTEM),
          actorId: input.actorId ?? null,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          description: input.description,
          metadata: sanitizeMetadata(input.metadata ?? {}),
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          traceId: input.traceId ?? null,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Failed to write ${inputs.length} audit entries: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(
    organizationId: string,
    query: ListAuditLogsQuery,
  ): Promise<Paginated<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorId: query.actorUserId } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { description: { contains: query.search, mode: 'insensitive' } },
              { action: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.unscoped.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.unscoped.auditLog.count({ where }),
    ]);

    return paginate(rows.map(toAuditLogView), total, query);
  }

  async findOne(organizationId: string, id: string): Promise<AuditLogView> {
    const row = await this.prisma.unscoped.auditLog.findFirst({
      // organizationId in the filter, not just the id: without it, any authenticated
      // user could read any tenant's audit entry by guessing a cuid.
      where: { id, organizationId },
      include: { actor: { select: { id: true, name: true, email: true } } },
    });

    if (!row) throw new NotFoundError('Audit log entry', id);
    return toAuditLogView(row);
  }

  /** Distinct action values present for an organization, for the log filter UI. */
  async availableActions(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.unscoped.auditLog.findMany({
      where: { organizationId },
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
      take: 200,
    });

    return rows.map((row) => row.action);
  }
}

/**
 * Strip anything secret-shaped from audit metadata.
 *
 * Audit entries are broadly readable (any ADMIN in the organization) and are retained
 * far longer than operational logs, so they are the worst place for a token to land.
 * Callers are careful, but this is a backstop that does not rely on them being
 * careful — a new call site should not be able to leak a credential by accident.
 */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passphrase|apikey|api_key|authorization|credential|private_?key)/i;

/**
 * Returns `Prisma.InputJsonValue` rather than our `JsonValue`.
 *
 * Prisma distinguishes "JSON null" from "SQL NULL" and so excludes bare `null` from
 * its input type. The top level is always an object here because the input is a
 * Record, which satisfies it; nested nulls are permitted.
 */
function sanitizeMetadata(metadata: Record<string, unknown>): Prisma.InputJsonValue {
  const walk = (value: unknown, depth: number): JsonValue => {
    if (depth > 6) return '[max depth]';
    if (value === null || value === undefined) return null;

    if (typeof value === 'string') {
      return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value;

    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => walk(item, depth + 1));
    }

    if (typeof value === 'object') {
      const output: Record<string, JsonValue> = {};

      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : walk(nested, depth + 1);
      }
      return output;
    }

    return String(value);
  };

  return walk(metadata, 0) as Prisma.InputJsonValue;
}

function toAuditLogView(row: {
  id: string;
  action: string;
  actorType: ActorType;
  actor: { id: string; name: string; email: string } | null;
  resourceType: string;
  resourceId: string | null;
  description: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}): AuditLogView {
  return {
    id: row.id,
    action: row.action as AuditAction,
    actor: row.actor,
    actorType: row.actorType,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    description: row.description,
    metadata: (row.metadata ?? {}) as JsonValue,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
  };
}
