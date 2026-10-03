import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  COLLABORATION_EVIDENCE_TYPES,
  PatchStatusSchema,
  PatchOperationSchema,
  Role,
  roleAtLeast,
  type PatchIntent,
  type PatchProposalView,
} from '@codelens/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import type { ConversationActor } from './collaboration.service';
import { canonicalPatch, constructPatchFile, normalizePatch, patchHash } from './patch-content';

const INCLUDE = { files: { orderBy: { path: 'asc' as const } } } as const;
type Row = Prisma.PatchProposalGetPayload<{ include: typeof INCLUDE }>;
type Prepared = Awaited<ReturnType<PatchProposalService['prepare']>>;

@Injectable()
export class PatchProposalService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
  ) {}

  async onModuleInit() {
    const [state] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."PatchProposal"') IS NOT NULL
        AND to_regclass('public."PatchProposalFile"') IS NOT NULL
        AND to_regclass('public."PatchProposalEvidence"') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
          AND tgname IN ('protect_proposal','protect_proposal_file','protect_proposal_evidence','verify_proposal_scope'))=4 AS ready`;
    if (!state?.ready)
      throw new Error('Patch proposal schema is not ready. Run db-init migrations.');
  }

  private async membership(db: PrismaTransactionClient, actor: ConversationActor) {
    const member = await db.membership.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    if (!member || !roleAtLeast(member.role as Role, Role.DEVELOPER))
      throw new NotFoundError('Patch proposal');
  }
  private async turn(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    await this.membership(db, actor);
    const turn = await db.collaborationTurn.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { conversation: { include: { pullRequest: { include: { repository: true } } } } },
    });
    if (
      !turn ||
      turn.conversation.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.repository.organizationId !== actor.organizationId ||
      turn.pullRequestId !== turn.conversation.pullRequestId
    )
      throw new NotFoundError('Patch proposal');
    return turn;
  }
  private async row(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    await this.membership(db, actor);
    const row = await db.patchProposal.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Patch proposal');
    await this.turn(db, actor, row.turnId);
    return row;
  }
  private async evidence(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turnId: string,
    repoId: string,
    prId: string,
    ids: string[],
  ) {
    const count = await db.evidenceReference.count({
      where: {
        id: { in: ids },
        organizationId: actor.organizationId,
        turnId,
        sourceType: { in: [...COLLABORATION_EVIDENCE_TYPES] },
        toolCall: {
          organizationId: actor.organizationId,
          repositoryId: repoId,
          pullRequestId: prId,
          status: { in: ['SUCCESS', 'PARTIAL', 'LIMITED'] },
        },
      },
    });
    if (count !== ids.length)
      throw new ValidationError('Proposal evidence is missing, unusable or outside this turn.');
  }
  async prepare(
    actor: ConversationActor,
    turnId: string,
    raw: PatchIntent,
    options: {
      requestId: string;
      authorType: 'AI' | 'HUMAN';
      attemptId?: string;
      parentId?: string;
      signal?: AbortSignal;
    },
  ) {
    const intent = normalizePatch(raw);
    const turn = await this.turn(this.prisma.unscoped, actor, turnId);
    if (
      !/^[a-f0-9]{40}$/.test(turn.headSha) ||
      !turn.baseSha ||
      !/^[a-f0-9]{40}$/.test(turn.baseSha)
    )
      throw new ValidationError(
        'This historical turn lacks the exact base/head pins required for a proposal.',
      );
    const pr = turn.conversation.pullRequest;
    const parentId =
      options.authorType === 'AI' ? (turn.revisionOfProposalId ?? undefined) : options.parentId;
    const parent = parentId ? await this.row(this.prisma.unscoped, actor, parentId) : null;
    if (
      parent &&
      (parent.conversationId !== turn.conversationId ||
        parent.repositoryId !== pr.repositoryId ||
        parent.pullRequestId !== pr.id ||
        parent.headSha !== turn.headSha ||
        parent.baseSha !== turn.baseSha ||
        parent.status === 'SUPERSEDED')
    )
      throw new ConflictError(
        'Revision target changed or has different pinned source. No automatic rebase is performed.',
      );
    const ids = [...new Set(intent.files.flatMap((f) => f.evidenceIds))].sort();
    await this.evidence(this.prisma.unscoped, actor, turn.id, pr.repositoryId, pr.id, ids);
    const client = await this.github.forUser(actor.userId);
    const files = [];
    for (const file of intent.files) {
      options.signal?.throwIfAborted();
      const source = await client.verifyExactFile(pr.repository.fullName, file.path, turn.headSha, {
        signal: options.signal,
      });
      if (source.revision !== turn.headSha)
        throw new ValidationError('Exact source revision mismatch.');
      files.push(constructPatchFile(file, source));
    }
    options.signal?.throwIfAborted();
    const canonical = canonicalPatch(
      { headSha: turn.headSha, baseSha: turn.baseSha },
      intent,
      files,
    );
    return {
      ...options,
      intent,
      files,
      ids,
      canonical,
      turnId,
      conversationId: turn.conversationId,
      repositoryId: pr.repositoryId,
      pullRequestId: pr.id,
      headSha: turn.headSha,
      baseSha: turn.baseSha,
      parentId: parent?.id ?? null,
      parentStatus: parent?.status ?? null,
      revision: parent ? parent.revision + 1 : 1,
      requestHash: patchHash(JSON.stringify({ intent, parentId: parent?.id ?? null })),
    };
  }
  async persist(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    data: Prepared,
    provider?: string | null,
    model?: string | null,
  ) {
    const turn = await this.turn(db, actor, data.turnId);
    if (turn.headSha !== data.headSha || turn.baseSha !== data.baseSha)
      throw new ConflictError('Pinned turn changed.');
    const existing = await db.patchProposal.findFirst({
      where: {
        turnId: data.turnId,
        organizationId: actor.organizationId,
        authorId: actor.userId,
        requestId: data.requestId,
      },
      include: INCLUDE,
    });
    if (existing) {
      if (existing.requestHash !== data.requestHash)
        throw new ConflictError('Proposal action was reused with different content.');
      return existing;
    }
    await this.evidence(db, actor, data.turnId, data.repositoryId, data.pullRequestId, data.ids);
    if (data.parentId) {
      await db.$queryRaw`SELECT id FROM "PatchProposal" WHERE id=${data.parentId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      const parent = await this.row(db, actor, data.parentId);
      if (parent.status !== data.parentStatus || parent.status === 'SUPERSEDED')
        throw new ConflictError('Proposal decision changed during revision.');
      await db.patchProposal.update({ where: { id: parent.id }, data: { status: 'SUPERSEDED' } });
      await this.audit(db, actor, { ...parent, status: 'SUPERSEDED' }, 'superseded');
    }
    const row = await db.patchProposal.create({
      data: {
        organizationId: actor.organizationId,
        repositoryId: data.repositoryId,
        pullRequestId: data.pullRequestId,
        conversationId: data.conversationId,
        turnId: data.turnId,
        attemptId: data.attemptId ?? null,
        parentId: data.parentId,
        authorId: actor.userId,
        authorType: data.authorType,
        provider: provider ?? null,
        model: model ?? null,
        requestId: data.requestId,
        requestHash: data.requestHash,
        headSha: data.headSha,
        baseSha: data.baseSha,
        revision: data.revision,
        summary: data.intent.summary,
        rationale: data.intent.rationale,
        limitations: data.intent.limitations,
        digest: data.canonical.digest,
        fileCount: data.files.length,
        changedLines: data.canonical.changedLines,
        files: {
          create: data.files.map(({ changedLines: _, ...file }) => ({
            ...file,
            edits: file.edits as Prisma.InputJsonValue,
          })),
        },
        evidence: {
          create: data.ids.map((evidenceId) => ({
            evidenceId,
          })),
        },
      },
      include: INCLUDE,
    });
    await this.audit(db, actor, row, 'proposed');
    return row;
  }
  async get(actor: ConversationActor, id: string): Promise<PatchProposalView> {
    const row = await this.row(this.prisma.unscoped, actor, id);
    const turn = await this.turn(this.prisma.unscoped, actor, row.turnId);
    return this.view(row, turn.conversation.pullRequest.headSha);
  }
  async list(
    actor: ConversationActor,
    conversationId: string,
    query: { afterId?: string; limit: number } = { limit: 25 },
    turnId?: string,
  ) {
    await this.membership(this.prisma.unscoped, actor);
    const conversation = await this.prisma.unscoped.conversation.findFirst({
      where: { id: conversationId, organizationId: actor.organizationId },
    });
    if (!conversation) throw new NotFoundError('Conversation');
    const pr = await this.prisma.unscoped.pullRequest.findFirst({
      where: {
        id: conversation.pullRequestId,
        organizationId: actor.organizationId,
        repository: { organizationId: actor.organizationId },
      },
    });
    if (!pr) throw new NotFoundError('Conversation');
    if (
      query.afterId &&
      !(await this.prisma.unscoped.patchProposal.findFirst({
        where: {
          id: query.afterId,
          organizationId: actor.organizationId,
          conversationId,
          ...(turnId ? { turnId } : {}),
        },
      }))
    )
      throw new NotFoundError('Patch proposal');
    const rows = await this.prisma.unscoped.patchProposal.findMany({
      where: {
        organizationId: actor.organizationId,
        conversationId,
        ...(turnId ? { turnId } : {}),
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      include: INCLUDE,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.view(r, pr.headSha)),
      nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  }
  async listTurn(actor: ConversationActor, id: string, query: { afterId?: string; limit: number }) {
    const turn = await this.turn(this.prisma.unscoped, actor, id);
    return this.list(actor, turn.conversationId, query, id);
  }
  async decide(
    actor: ConversationActor,
    id: string,
    input: { requestId: string; decision: 'ACCEPTED' | 'REJECTED' },
  ) {
    await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "PatchProposal" WHERE id=${id} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      const row = await this.row(db, actor, id);
      if (row.status === input.decision) return;
      if (
        row.status === 'SUPERSEDED' &&
        row.decisionRequestId === input.requestId &&
        row.decidedAt
      ) {
        const recorded = await db.auditLog.findFirst({
          where: {
            organizationId: actor.organizationId,
            resourceType: 'PatchProposal',
            resourceId: id,
            action:
              input.decision === 'ACCEPTED'
                ? 'collaboration.patch.accepted'
                : 'collaboration.patch.rejected',
          },
        });
        if (recorded) return;
      }
      if (row.status !== 'PROPOSED')
        throw new ConflictError('Proposal already has a different decision or revision.');
      const changed = await db.patchProposal.update({
        where: { id },
        data: {
          status: input.decision,
          decidedAt: new Date(),
          decidedById: actor.userId,
          decisionRequestId: input.requestId,
        },
        include: INCLUDE,
      });
      await this.audit(db, actor, changed, input.decision === 'ACCEPTED' ? 'accepted' : 'rejected');
    });
    return this.get(actor, id);
  }
  async revise(
    actor: ConversationActor,
    id: string,
    input: { requestId: string; proposal: PatchIntent },
  ) {
    const parent = await this.row(this.prisma.unscoped, actor, id);
    // Lost-response replay must not re-read Git or reject an already superseded parent.
    const hash = patchHash(
      JSON.stringify({ intent: normalizePatch(input.proposal), parentId: id }),
    );
    const existing = await this.prisma.unscoped.patchProposal.findFirst({
      where: {
        turnId: parent.turnId,
        organizationId: actor.organizationId,
        authorId: actor.userId,
        requestId: input.requestId,
      },
    });
    if (existing) {
      if (existing.requestHash !== hash)
        throw new ConflictError('Revision request was reused with different content.');
      return this.get(actor, existing.id);
    }
    let prepared: Prepared;
    try {
      prepared = await this.prepare(actor, parent.turnId, input.proposal, {
        requestId: input.requestId,
        authorType: 'HUMAN',
        parentId: id,
      });
    } catch (error) {
      // A concurrent identical revision may commit between the replay check and source preparation.
      if (error instanceof ConflictError) {
        const replay = await this.prisma.unscoped.patchProposal.findFirst({
          where: {
            turnId: parent.turnId,
            organizationId: actor.organizationId,
            authorId: actor.userId,
            requestId: input.requestId,
          },
        });
        if (replay && replay.requestHash === hash) return this.get(actor, replay.id);
      }
      throw error;
    }
    const row = await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT id FROM "CollaborationTurn" WHERE id=${parent.turnId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      return this.persist(db, actor, prepared);
    });
    return this.get(actor, row.id);
  }
  private view(row: Row, currentHead: string): PatchProposalView {
    return {
      id: row.id,
      conversationId: row.conversationId,
      turnId: row.turnId,
      attemptId: row.attemptId,
      parentId: row.parentId,
      revision: row.revision,
      headSha: row.headSha,
      baseSha: row.baseSha,
      authorId: row.authorId,
      provider: row.provider,
      model: row.model,
      summary: row.summary,
      rationale: row.rationale,
      limitations: row.limitations,
      digest: row.digest,
      fileCount: row.fileCount,
      changedLines: row.changedLines,
      decidedById: row.decidedById,
      authorType: row.authorType as 'AI' | 'HUMAN',
      status: PatchStatusSchema.parse(row.status),
      stale: row.headSha !== currentHead,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      files: row.files.map((f) => ({
        path: f.path,
        operation: 'MODIFY',
        oldBlobSha: f.oldBlobSha,
        oldContentHash: f.oldContentHash,
        newContentHash: f.newContentHash,
        diff: f.diff,
        evidenceIds: f.evidenceIds,
        edits: PatchOperationSchema.array().parse(f.edits),
      })),
    };
  }
  private audit(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    row: {
      id: string;
      conversationId: string;
      turnId: string;
      revision: number;
      digest: string;
      fileCount: number;
      changedLines: number;
      status: string;
    },
    event: string,
  ) {
    return db.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'collaboration.patch.' + event,
        resourceType: 'PatchProposal',
        resourceId: row.id,
        description: 'Patch proposal ' + event + '; no repository files changed',
        traceId: actor.traceId,
        metadata: {
          proposalId: row.id,
          conversationId: row.conversationId,
          turnId: row.turnId,
          revision: row.revision,
          digest: row.digest,
          fileCount: row.fileCount,
          changedLines: row.changedLines,
          status: row.status,
        },
      },
    });
  }
}
