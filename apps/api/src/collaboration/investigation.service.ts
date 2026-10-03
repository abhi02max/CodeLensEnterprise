import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  InvestigationInputSchemas,
  InvestigationToolSchema,
  InvestigationRequestSchema,
  InvestigationStatusSchema,
  EvidenceProvenanceSchema,
  type InvestigationResult,
  type EvidenceView,
  type InvestigationTool,
  type InvestigationPage,
  type Role,
  roleAtLeast,
} from '@codelens/shared';
import { ConflictError, NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { ConversationActor } from './collaboration.service';
import { InvestigationToolsService, type InvestigationScope } from './investigation-tools.service';
import { hash, InvestigationFailure, type ToolObservation } from './investigation-support';

const INCLUDE = { evidence: { orderBy: { ordinal: 'asc' as const } } } as const;
type CallRow = Prisma.CollaborationToolCallGetPayload<{ include: typeof INCLUDE }>;
type EvidenceRow = Prisma.EvidenceReferenceGetPayload<Record<string, never>>;
const DEADLINE_MS = 20_000;

@Injectable()
export class InvestigationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: InvestigationToolsService,
  ) {}

  async onModuleInit() {
    const [row] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."CollaborationToolCall"') IS NOT NULL
        AND to_regclass('public."EvidenceReference"') IS NOT NULL AS ready`;
    if (!row?.ready) throw new Error('Investigation schema is not ready. Run db-init migrations.');
  }

  private async scope(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turnId: string,
  ): Promise<InvestigationScope> {
    const member = await db.membership.findFirst({
      where: { userId: actor.userId, organizationId: actor.organizationId },
    });
    if (!member || !roleAtLeast(member.role as Role, 'DEVELOPER' as Role))
      throw new NotFoundError('Investigation');
    const turn = await db.collaborationTurn.findFirst({
      where: { id: turnId, organizationId: actor.organizationId },
      include: { conversation: { include: { pullRequest: { include: { repository: true } } } } },
    });
    if (
      !turn ||
      turn.conversation.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.repository.organizationId !== actor.organizationId ||
      turn.pullRequestId !== turn.conversation.pullRequestId
    )
      throw new NotFoundError('Investigation');
    return { ...turn, actorId: actor.userId };
  }

  async execute(
    actor: ConversationActor,
    turnId: string,
    name: string,
    requestId: string,
    raw: unknown,
    execution?: { signal: AbortSignal; attemptId: string; fence: string },
  ): Promise<InvestigationResult> {
    const tool = InvestigationToolSchema.parse(name);
    InvestigationRequestSchema.parse({ requestId, input: raw });
    const input = InvestigationInputSchemas[tool].parse(raw);
    const inputHash = hash(JSON.stringify({ tool, input }));
    await this.scope(this.prisma.unscoped, actor, turnId);
    const reserved = await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "CollaborationTurn" WHERE id=${turnId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      const scope = await this.scope(db, actor, turnId);
      if (execution) await this.requireExecution(db, actor, turnId, execution);
      else if (scope.status === 'RUNNING' || scope.status === 'QUEUED')
        throw new ConflictError('AI investigation is active; manual reads must wait.');
      // Fenced expired reservations are never rerun automatically: outcome may have been interrupted.
      await this.expire(db, actor, turnId);
      const existing = await db.collaborationToolCall.findFirst({
        where: {
          turnId,
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId,
        },
        include: INCLUDE,
      });
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new ConflictError('Request ID was used with different tool input.');
        return { row: existing, execute: false, scope };
      }
      const count = await db.collaborationToolCall.count({
        where: { turnId, organizationId: actor.organizationId },
      });
      const active = await db.collaborationToolCall.count({
        where: { turnId, organizationId: actor.organizationId, status: 'RUNNING' },
      });
      if (count >= 8) throw new ConflictError('Turn investigation budget exhausted (8 calls).');
      if (active >= 2)
        throw new ConflictError('Two investigations are already running for this turn.');
      const row = await db.collaborationToolCall.create({
        data: {
          organizationId: actor.organizationId,
          turnId,
          pullRequestId: scope.pullRequestId,
          repositoryId: scope.conversation.pullRequest.repositoryId,
          requestedById: actor.userId,
          tool,
          sequence: count + 1,
          requestId,
          inputHash,
          fence: randomUUID(),
          traceId: actor.traceId.slice(0, 128),
          deadlineAt: new Date(Date.now() + DEADLINE_MS),
        },
        include: INCLUDE,
      });
      await this.audit(db, actor, 'collaboration.tool.requested', row.id, turnId, tool);
      return { row, execute: true, scope };
    });
    if (!reserved.execute) return this.view(reserved.row);
    const call = reserved.row;
    const abort = new AbortController();
    let rejectAbort: ((error: Error) => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      abort.abort();
      rejectAbort?.(new InvestigationFailure('CANCELLED'));
    };
    execution?.signal.addEventListener('abort', onAbort, { once: true });
    if (execution?.signal.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, call.deadlineAt.getTime() - Date.now());
    let outcome: ToolObservation;
    try {
      outcome = await Promise.race([
        this.tools.execute(reserved.scope, tool, input, abort.signal),
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new InvestigationFailure('TIMEOUT'));
          }, remaining);
        }),
      ]);
    } catch (error) {
      const category = error instanceof InvestigationFailure ? error.category : 'UNAVAILABLE';
      outcome = {
        status:
          category === 'TIMEOUT'
            ? 'TIMEOUT'
            : category === 'CANCELLED'
              ? 'CANCELLED'
              : 'UNAVAILABLE',
        coverage: 'Investigation did not establish evidence',
        evidence: [],
        nextCursor: null,
        failureCategory: category,
      };
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
      execution?.signal.removeEventListener('abort', onAbort);
    }
    // Slow reads occur outside transactions; late settlements cannot write evidence.
    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "CollaborationTurn" WHERE id=${turnId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      await this.scope(db, actor, turnId);
      const current = await db.collaborationToolCall.findFirstOrThrow({
        where: { id: call.id, organizationId: actor.organizationId },
        include: INCLUDE,
      });
      if (current.status !== 'RUNNING' || current.fence !== call.fence) return this.view(current);
      if (execution) await this.requireExecution(db, actor, turnId, execution);
      if (Date.now() > call.deadlineAt.getTime() && outcome.status !== 'TIMEOUT') {
        outcome = {
          status: 'TIMEOUT',
          failureCategory: 'TIMEOUT',
          evidence: [],
          nextCursor: null,
          coverage: 'Deadline exceeded before evidence finalization',
        };
      }
      const completedAt = new Date();
      const changed = await db.collaborationToolCall.updateMany({
        where: {
          id: call.id,
          organizationId: actor.organizationId,
          fence: call.fence,
          status: 'RUNNING',
        },
        data: {
          status: outcome.status,
          coverage: outcome.coverage,
          nextCursor: outcome.nextCursor,
          failureCategory: outcome.failureCategory ?? null,
          diagnostic: outcome.failureCategory
            ? `Investigation unavailable (${outcome.failureCategory})`
            : null,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - call.startedAt.getTime()),
        },
      });
      if (changed.count !== 1) throw new ConflictError('Investigation reservation changed.');
      for (const [index, evidence] of outcome.evidence.entries()) {
        await db.evidenceReference.create({
          data: {
            ...evidence,
            metadata: evidence.metadata as Prisma.InputJsonObject,
            organizationId: actor.organizationId,
            turnId,
            toolCallId: call.id,
            ordinal: index + 1,
          },
        });
      }
      await this.audit(
        db,
        actor,
        outcome.failureCategory ? 'collaboration.tool.failed' : 'collaboration.tool.completed',
        call.id,
        turnId,
        tool,
      );
      return this.view(
        await db.collaborationToolCall.findFirstOrThrow({
          where: { id: call.id, organizationId: actor.organizationId },
          include: INCLUDE,
        }),
      );
    });
  }

  private async requireExecution(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turnId: string,
    execution: { signal: AbortSignal; attemptId: string; fence: string },
  ) {
    if (execution.signal.aborted) throw new InvestigationFailure('CANCELLED');
    const attempt = await db.collaborationAttempt.findFirst({
      where: {
        id: execution.attemptId,
        organizationId: actor.organizationId,
        turnId,
        fence: execution.fence,
        status: 'RUNNING',
        deadlineAt: { gt: new Date() },
        turn: { status: 'RUNNING' },
      },
    });
    if (!attempt) throw new InvestigationFailure('CANCELLED');
  }

  private async expire(db: PrismaTransactionClient, actor: ConversationActor, turnId: string) {
    const expired = await db.collaborationToolCall.findMany({
      where: {
        turnId,
        organizationId: actor.organizationId,
        status: 'RUNNING',
        deadlineAt: { lt: new Date() },
      },
      take: 8,
    });
    for (const call of expired) {
      const completedAt = new Date();
      const update = await db.collaborationToolCall.updateMany({
        where: {
          id: call.id,
          organizationId: actor.organizationId,
          fence: call.fence,
          status: 'RUNNING',
        },
        data: {
          status: 'CANCELLED',
          failureCategory: 'CANCELLED',
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - call.startedAt.getTime()),
          diagnostic: 'Expired reservation; execution outcome unknown',
          coverage: 'Interrupted or expired; no verified evidence',
        },
      });
      if (update.count)
        await this.audit(
          db,
          actor,
          'collaboration.tool.failed',
          call.id,
          turnId,
          InvestigationToolSchema.parse(call.tool),
        );
    }
  }

  async getCall(actor: ConversationActor, id: string): Promise<InvestigationResult> {
    const call = await this.prisma.unscoped.collaborationToolCall.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { turnId: true },
    });
    if (!call) throw new NotFoundError('Investigation');
    await this.scope(this.prisma.unscoped, actor, call.turnId);
    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "CollaborationTurn" WHERE id=${call.turnId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      await this.scope(db, actor, call.turnId);
      await this.expire(db, actor, call.turnId);
      return this.view(
        await db.collaborationToolCall.findFirstOrThrow({
          where: { id, organizationId: actor.organizationId },
          include: INCLUDE,
        }),
      );
    });
  }

  async getEvidence(actor: ConversationActor, id: string): Promise<EvidenceView> {
    const row = await this.prisma.unscoped.evidenceReference.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!row) throw new NotFoundError('Investigation');
    await this.scope(this.prisma.unscoped, actor, row.turnId);
    return evidenceView(row);
  }

  async list(actor: ConversationActor, turnId: string, page: InvestigationPage) {
    await this.scope(this.prisma.unscoped, actor, turnId);
    const calls = await this.prisma.unscoped.collaborationToolCall.findMany({
      where: { turnId, organizationId: actor.organizationId, sequence: { gt: page.afterSequence } },
      orderBy: { sequence: 'asc' },
      take: page.limit + 1,
    });
    return {
      items: calls.slice(0, page.limit).map((row) => this.view({ ...row, evidence: [] })),
      nextAfterSequence: calls.length > page.limit ? calls[page.limit - 1]!.sequence : null,
    };
  }

  private audit(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    action: string,
    id: string,
    turnId: string,
    tool: InvestigationTool,
  ) {
    return db.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action,
        resourceType: 'CollaborationToolCall',
        resourceId: id,
        traceId: actor.traceId,
        description: 'Conversation investigation recorded',
        metadata: { turnId, tool },
      },
    });
  }
  private view(row: CallRow): InvestigationResult {
    return {
      id: row.id,
      turnId: row.turnId,
      tool: InvestigationToolSchema.parse(row.tool),
      version: row.version,
      sequence: row.sequence,
      status: InvestigationStatusSchema.parse(row.status),
      coverage: row.coverage,
      evidence: row.evidence.map(evidenceView),
      nextCursor: row.nextCursor,
      failureCategory: row.failureCategory,
      diagnostic: row.diagnostic,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
    };
  }
}

function evidenceView(row: EvidenceRow): EvidenceView {
  return {
    id: row.id,
    toolCallId: row.toolCallId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    provenance: EvidenceProvenanceSchema.parse(row.provenance),
    observedRevision: row.observedRevision,
    indexRevision: row.indexRevision,
    path: row.path,
    side: row.side,
    startLine: row.startLine,
    endLine: row.endLine,
    contentHash: row.contentHash,
    blobHash: row.blobHash,
    payloadHash: row.payloadHash,
    excerpt: row.excerpt,
    truncated: row.truncated,
    redacted: row.redacted,
    method: row.method,
    metadata: row.metadata as Record<string, unknown>,
    trust: 'UNTRUSTED_DATA',
    observedAt: row.observedAt.toISOString(),
  };
}
