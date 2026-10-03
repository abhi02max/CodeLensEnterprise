import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  ConversationAnchorSchema,
  CreateConversationSchema,
  CreateConversationMessageSchema,
  type ConversationAnchor,
  type ConversationView,
  type ConversationMessageView,
  type CreateConversationInput,
  type CreateConversationMessageInput,
  type ConversationDetail,
  type ConversationList,
  type CreateConversationMessageResponse,
  type GetConversationQuery,
  CollaborationCitationSchema,
  type ListConversationsQuery,
} from '@codelens/shared';
import { GithubClientFactory } from '../auth/github-client.factory';
import { ConflictError, NotFoundError, UpstreamUnavailableError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export interface ConversationActor {
  organizationId: string;
  userId: string;
  traceId: string;
}
const AUTHOR = { select: { id: true, name: true } } as const;
const CONVERSATION_INCLUDE = { createdBy: AUTHOR } as const;
const MESSAGE_INCLUDE = { createdBy: AUTHOR, turn: true } as const;
type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof CONVERSATION_INCLUDE }>;
type MessageRow = Prisma.ConversationMessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;

@Injectable()
export class CollaborationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    const [state] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."Conversation"') IS NOT NULL
        AND to_regclass('public."CollaborationTurn"') IS NOT NULL
        AND to_regclass('public."ConversationMessage"') IS NOT NULL AS ready
    `;
    if (!state?.ready)
      throw new Error(
        'Conversation schema is not ready. Run db-init migrations before starting the API.',
      );
  }

  private async requireMembership(db: PrismaTransactionClient, actor: ConversationActor) {
    const member = await db.membership.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    if (!member) throw new NotFoundError('Review session');
  }

  private async requirePr(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    await this.requireMembership(db, actor);
    const pr = await db.pullRequest.findFirst({
      where: {
        id,
        organizationId: actor.organizationId,
        repository: { organizationId: actor.organizationId },
      },
      include: { repository: { select: { fullName: true, organizationId: true } } },
    });
    if (!pr) throw new NotFoundError('Review session');
    return pr;
  }

  private async requireConversation(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    id: string,
  ) {
    await this.requireMembership(db, actor);
    const row = await db.conversation.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: CONVERSATION_INCLUDE,
    });
    if (!row) throw new NotFoundError('Conversation');
    await this.requirePr(db, actor, row.pullRequestId);
    return row;
  }

  async create(
    actor: ConversationActor,
    prId: string,
    raw: CreateConversationInput,
  ): Promise<ConversationView> {
    const input = CreateConversationSchema.parse(raw);
    const hash = digest({ title: input.title, anchor: input.anchor });
    return this.prisma.$transaction(async (db) => {
      await this.requirePr(db, actor, prId);
      // Serialize per PR, including concurrent duplicate conversation creation.
      await db.$queryRaw`SELECT id FROM "PullRequest" WHERE id = ${prId} AND "organizationId" = ${actor.organizationId} FOR UPDATE`;
      await this.requirePr(db, actor, prId);
      const existing = await db.conversation.findFirst({
        where: {
          organizationId: actor.organizationId,
          pullRequestId: prId,
          createdById: actor.userId,
          requestId: input.requestId,
        },
        include: CONVERSATION_INCLUDE,
      });
      if (existing) {
        assertReplay(existing.requestHash, hash);
        return conversationView(existing);
      }
      await this.validateAnchor(db, actor.organizationId, prId, input.anchor);
      const row = await db.conversation.create({
        data: {
          organizationId: actor.organizationId,
          pullRequestId: prId,
          createdById: actor.userId,
          title: input.title,
          anchor: input.anchor,
          requestId: input.requestId,
          requestHash: hash,
        },
        include: CONVERSATION_INCLUDE,
      });
      await this.audit(db, actor, 'collaboration.conversation.created', row.id, {
        pullRequestId: prId,
        contextKind: input.anchor.kind,
      });
      return conversationView(row);
    });
  }

  async list(
    actor: ConversationActor,
    prId: string,
    query: ListConversationsQuery,
  ): Promise<ConversationList> {
    await this.requirePr(this.prisma.unscoped, actor, prId);
    if (query.afterId) {
      const cursor = await this.prisma.unscoped.conversation.findFirst({
        where: { id: query.afterId, organizationId: actor.organizationId, pullRequestId: prId },
        select: { id: true },
      });
      if (!cursor) throw new NotFoundError('Conversation');
    }
    const rows = await this.prisma.unscoped.conversation.findMany({
      where: {
        organizationId: actor.organizationId,
        pullRequestId: prId,
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      include: CONVERSATION_INCLUDE,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map(conversationView),
      nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  }

  async get(
    actor: ConversationActor,
    id: string,
    query: GetConversationQuery,
  ): Promise<ConversationDetail> {
    const row = await this.requireConversation(this.prisma.unscoped, actor, id);
    const messages = await this.prisma.unscoped.conversationMessage.findMany({
      where: {
        conversationId: id,
        organizationId: actor.organizationId,
        sequence: { gt: query.afterSequence },
      },
      include: MESSAGE_INCLUDE,
      orderBy: { sequence: 'asc' },
      take: query.limit + 1,
    });
    return {
      conversation: conversationView(row),
      messages: messages.slice(0, query.limit).map(messageView),
      nextAfterSequence: messages.length > query.limit ? messages[query.limit - 1]!.sequence : null,
      aiExecutionAvailable: true,
    };
  }

  async message(
    actor: ConversationActor,
    id: string,
    raw: CreateConversationMessageInput,
  ): Promise<CreateConversationMessageResponse> {
    const input = CreateConversationMessageSchema.parse(raw);
    const hash = digest({ content: input.content });
    const conversation = await this.requireConversation(this.prisma.unscoped, actor, id);
    const existing = await this.replay(this.prisma.unscoped, actor, id, input.requestId, hash);
    if (existing) return { message: existing, aiExecutionAvailable: false };
    const pr = await this.requirePr(this.prisma.unscoped, actor, conversation.pullRequestId);
    let headSha: string;
    try {
      const client = await this.github.forUser(actor.userId);
      const current = await client.getPullRequest(pr.repository.fullName, pr.number);
      headSha = current.headSha;
      if (!/^[a-f0-9]{7,64}$/i.test(headSha)) throw new Error('Missing head');
    } catch {
      throw new UpstreamUnavailableError(
        'GitHub',
        'Cannot establish the current PR head. Connect GitHub and retry when it is available.',
      );
    }
    return this.prisma.$transaction(async (db) => {
      await this.requirePr(db, actor, pr.id);
      // Lock order is always PR then conversation; never hold locks during network IO.
      await db.$queryRaw`SELECT id FROM "PullRequest" WHERE id = ${pr.id} AND "organizationId" = ${actor.organizationId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} AND "organizationId" = ${actor.organizationId} FOR UPDATE`;
      const current = await this.requireConversation(db, actor, id);
      const replay = await this.replay(db, actor, id, input.requestId, hash);
      if (replay) return { message: replay, aiExecutionAvailable: false };
      const freshPr = await this.requirePr(db, actor, pr.id);
      if (freshPr.headSha !== headSha)
        throw new ConflictError(
          'The PR changed. Sync the pull request before sending this message.',
        );
      const run = await db.reviewRun.findFirst({
        where: { organizationId: actor.organizationId, pullRequestId: pr.id, headSha },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      const sequence = current.lastSequence + 1;
      const turn = await db.collaborationTurn.create({
        data: {
          organizationId: actor.organizationId,
          conversationId: id,
          pullRequestId: pr.id,
          initiatedById: actor.userId,
          headSha,
          reviewRunId: run?.id ?? null,
          sequence,
          requestId: input.requestId,
          requestHash: hash,
        },
      });
      const row = await db.conversationMessage.create({
        data: {
          organizationId: actor.organizationId,
          conversationId: id,
          turnId: turn.id,
          createdById: actor.userId,
          sequence,
          content: input.content,
        },
        include: MESSAGE_INCLUDE,
      });
      await db.conversation.update({
        where: { id, organizationId: actor.organizationId },
        data: { lastSequence: sequence },
      });
      await this.audit(db, actor, 'collaboration.message.created', id, {
        pullRequestId: pr.id,
        messageId: row.id,
        turnId: turn.id,
        sequence,
        contentLength: input.content.length,
      });
      return { message: messageView(row), aiExecutionAvailable: false };
    });
  }

  private async replay(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    id: string,
    requestId: string,
    hash: string,
  ) {
    const row = await db.conversationMessage.findFirst({
      where: {
        organizationId: actor.organizationId,
        conversationId: id,
        kind: 'HUMAN',
        turn: { initiatedById: actor.userId, requestId },
      },
      include: MESSAGE_INCLUDE,
    });
    if (!row) return null;
    assertReplay(row.turn.requestHash, hash);
    return messageView(row);
  }

  private async validateAnchor(
    db: PrismaTransactionClient,
    organizationId: string,
    prId: string,
    anchor: ConversationAnchor,
  ) {
    let found = true;
    switch (anchor.kind) {
      case 'PR':
        break;
      case 'FILE':
      case 'RANGE':
        found = !!(await db.pullRequestFile.findFirst({
          where: { pullRequestId: prId, filename: anchor.path },
          select: { id: true },
        }));
        break;
      case 'COMMENT':
        found = !!(await db.comment.findFirst({
          where: { id: anchor.commentId, organizationId, pullRequestId: prId },
          select: { id: true },
        }));
        break;
      case 'STATIC_FINDING':
        found = !!(await db.staticFinding.findFirst({
          where: {
            id: anchor.findingId,
            organizationId,
            reviewRun: { pullRequestId: prId, organizationId },
          },
          select: { id: true },
        }));
        break;
      case 'AI_FINDING': {
        const review = await db.aiReview.findFirst({
          where: {
            organizationId,
            reviewRunId: anchor.reviewRunId,
            reviewRun: { organizationId, pullRequestId: prId },
          },
          select: { findings: true },
        });
        found =
          !!review &&
          Array.isArray(review.findings) &&
          anchor.findingIndex < review.findings.length;
        break;
      }
    }
    if (!found) throw new NotFoundError('Conversation context');
  }

  private audit(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    action: string,
    id: string,
    metadata: Prisma.InputJsonObject,
  ) {
    // New collaboration events are atomic with their rows; existing best-effort audit is unchanged.
    return db.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action,
        resourceType: 'Conversation',
        resourceId: id,
        description:
          action === 'collaboration.message.created'
            ? 'Human message recorded'
            : 'PR conversation created',
        metadata,
        traceId: actor.traceId,
      },
    });
  }
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function assertReplay(expected: string, actual: string) {
  if (expected !== actual)
    throw new ConflictError('Request ID was already used with a different payload.');
}
function conversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    pullRequestId: row.pullRequestId,
    title: row.title,
    status: row.status,
    anchor: row.anchor === null ? null : ConversationAnchorSchema.parse(row.anchor),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function messageView(row: MessageRow): ConversationMessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sequence: row.sequence,
    kind: row.kind,
    content: row.content,
    citations: CollaborationCitationSchema.array().parse(row.citations ?? []),
    provider: row.provider ?? null,
    model: row.model ?? null,
    createdBy: row.createdBy,
    turn: {
      id: row.turn.id,
      conversationId: row.turn.conversationId,
      headSha: row.turn.headSha,
      reviewRunId: row.turn.reviewRunId,
      status: row.turn.status,
      sequence: row.turn.sequence,
      initiatedById: row.turn.initiatedById,
      createdAt: row.turn.createdAt.toISOString(),
    },
    createdAt: row.createdAt.toISOString(),
  };
}
