import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  roleAtLeast,
  Role,
  redactSecrets,
  COLLABORATION_EVIDENCE_TYPES,
  type CollaborationExecutionView,
} from '@codelens/shared';
import {
  COLLABORATOR_LIMITS,
  CollaborationFailure,
  runCollaborator,
  type CollaborationAccounting,
} from '@codelens/ai-agent';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queues/queue.service';
import type { CollaborationJobData } from '../queues/queue.types';
import type { ConversationActor } from './collaboration.service';
import { CollaborationProviderService } from './collaboration-provider.service';
import { InvestigationService } from './investigation.service';
import { PatchProposalService } from './patch-proposal.service';

const ACTIVE = ['QUEUED', 'RUNNING'];
const RETRYABLE = ['RECORDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

@Injectable()
export class CollaborationExecutionService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly providers: CollaborationProviderService,
    private readonly investigation: InvestigationService,
    private readonly patches: PatchProposalService,
  ) {}

  async onModuleInit() {
    const [row] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."CollaborationAttempt"') IS NOT NULL AS ready`;
    if (!row?.ready)
      throw new Error('Collaboration execution schema is not ready. Run db-init migrations.');
  }

  private async scope(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    const member = await db.membership.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    const turn = await db.collaborationTurn.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { conversation: { include: { pullRequest: { include: { repository: true } } } } },
    });
    if (
      !member ||
      !roleAtLeast(member.role as Role, Role.DEVELOPER) ||
      !turn ||
      turn.conversation.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.organizationId !== actor.organizationId ||
      turn.conversation.pullRequest.repository.organizationId !== actor.organizationId ||
      turn.pullRequestId !== turn.conversation.pullRequestId
    )
      throw new NotFoundError('Collaboration turn');
    return turn;
  }
  private lock(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    return db.$queryRaw`SELECT id FROM "CollaborationTurn" WHERE id=${id} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
  }

  async enqueue(actor: ConversationActor, id: string, expectedAttempt?: number) {
    const attempt = await this.prisma.$transaction(async (db) => {
      await this.lock(db, actor, id);
      const turn = await this.scope(db, actor, id);
      if (turn.initiatedById !== actor.userId) throw new NotFoundError('Collaboration turn');
      await this.expire(db, actor, turn);
      if (expectedAttempt === undefined) {
        if (turn.status !== 'RECORDED') {
          if (turn.status === 'QUEUED') return { number: turn.executionAttempt };
          return null;
        }
      } else {
        // Retrying a lost HTTP response with the same expected attempt is idempotent.
        if (turn.executionAttempt === expectedAttempt + 1) return { number: turn.executionAttempt };
        if (turn.executionAttempt !== expectedAttempt || !RETRYABLE.includes(turn.status))
          throw new ConflictError('Turn is not eligible for this retry.');
      }
      const number = turn.executionAttempt + 1;
      const spent = await this.priorBudget(db, actor, id, number);
      if (
        (spent.providerRequests ?? 0) >= COLLABORATOR_LIMITS.requests ||
        (spent.rounds ?? 0) >= COLLABORATOR_LIMITS.rounds ||
        (spent.outputTokens ?? 0) + COLLABORATOR_LIMITS.requestOutput >
          COLLABORATOR_LIMITS.totalOutput
      )
        throw new ConflictError(
          'This human turn has exhausted its provider budget. Start a new message.',
        );
      if (number > 1000) throw new ConflictError('Turn retry limit reached.');
      const row = await db.collaborationAttempt.create({
        data: {
          organizationId: actor.organizationId,
          turnId: id,
          pullRequestId: turn.pullRequestId,
          number,
          fence: randomUUID(),
          traceId: actor.traceId.slice(0, 128),
        },
      });
      await db.collaborationTurn.update({
        where: { id },
        data: { status: 'QUEUED', executionAttempt: number },
      });
      return row;
    });
    if (attempt)
      await this.queue.enqueueCollaboration({
        organizationId: actor.organizationId,
        userId: actor.userId,
        traceId: actor.traceId,
        turnId: id,
        attempt: attempt.number,
      });
    return this.get(actor, id);
  }

  async get(actor: ConversationActor, id: string): Promise<CollaborationExecutionView> {
    return this.prisma.$transaction(async (db) => {
      await this.lock(db, actor, id);
      const turn = await this.scope(db, actor, id);
      await this.expire(db, actor, turn);
      const attempt = await db.collaborationAttempt.findFirst({
        where: { turnId: id, organizationId: actor.organizationId, number: turn.executionAttempt },
      });
      return {
        turnId: id,
        status: turn.status,
        attempt: turn.executionAttempt,
        failureCategory: attempt?.failureCategory ?? null,
        provider: attempt?.provider ?? null,
        model: attempt?.model ?? null,
        providerRequests: attempt?.providerRequests ?? 0,
        providerRetries: attempt?.providerRetries ?? 0,
        repairs: attempt?.repairs ?? 0,
        rounds: attempt?.rounds ?? 0,
        toolCalls: attempt?.toolCalls ?? 0,
        contextBytes: attempt?.contextBytes ?? 0,
        outputTokens: attempt?.outputTokens ?? 0,
        startedAt: attempt?.startedAt?.toISOString() ?? null,
        completedAt: attempt?.completedAt?.toISOString() ?? null,
        stale: turn.headSha !== turn.conversation.pullRequest.headSha,
      };
    });
  }

  async cancel(actor: ConversationActor, id: string) {
    await this.prisma.$transaction(async (db) => {
      await this.lock(db, actor, id);
      const turn = await this.scope(db, actor, id);
      if (turn.initiatedById !== actor.userId) throw new NotFoundError('Collaboration turn');
      if (!ACTIVE.includes(turn.status)) return;
      await db.collaborationTurn.update({ where: { id }, data: { status: 'CANCELLED' } });
      await db.collaborationAttempt.updateMany({
        where: {
          turnId: id,
          organizationId: actor.organizationId,
          number: turn.executionAttempt,
          status: { in: ACTIVE },
        },
        data: {
          status: 'CANCELLED',
          failureCategory: 'CANCELLED',
          fence: randomUUID(),
          completedAt: new Date(),
        },
      });
      await this.cancelTools(db, actor, id);
      await this.audit(db, actor, id, 'cancelled', { attempt: turn.executionAttempt });
    });
    return this.get(actor, id);
  }

  private async cancelTools(db: PrismaTransactionClient, actor: ConversationActor, id: string) {
    await db.collaborationToolCall.updateMany({
      where: { turnId: id, organizationId: actor.organizationId, status: 'RUNNING' },
      data: {
        status: 'CANCELLED',
        fence: randomUUID(),
        failureCategory: 'CANCELLED',
        completedAt: new Date(),
        coverage: 'Turn execution stopped; late evidence discarded',
      },
    });
  }

  private async expire(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turn: { id: string; status: string; executionAttempt: number },
  ) {
    if (turn.status !== 'RUNNING') return;
    const expired = await db.collaborationAttempt.findFirst({
      where: {
        turnId: turn.id,
        organizationId: actor.organizationId,
        number: turn.executionAttempt,
        status: 'RUNNING',
        deadlineAt: { lte: new Date() },
      },
    });
    if (!expired) return;
    await db.collaborationAttempt.update({
      where: { id: expired.id },
      data: {
        status: 'INTERRUPTED',
        fence: randomUUID(),
        failureCategory: 'OUTCOME_UNCERTAIN',
        completedAt: new Date(),
      },
    });
    await db.collaborationTurn.update({ where: { id: turn.id }, data: { status: 'INTERRUPTED' } });
    turn.status = 'INTERRUPTED';
    await this.cancelTools(db, actor, turn.id);
    await this.audit(db, actor, turn.id, 'failed', {
      attempt: turn.executionAttempt,
      category: 'OUTCOME_UNCERTAIN',
    });
  }

  async execute(job: CollaborationJobData): Promise<{ turnId: string; status: string }> {
    if (!job.userId) throw new CollaborationFailure('INVALID_JOB');
    const actor = { organizationId: job.organizationId, userId: job.userId, traceId: job.traceId };
    const reservation = await this.prisma.$transaction(async (db) => {
      await this.lock(db, actor, job.turnId);
      const turn = await this.scope(db, actor, job.turnId);
      if (turn.initiatedById !== actor.userId) throw new NotFoundError('Collaboration turn');
      await this.expire(db, actor, turn);
      if (turn.executionAttempt !== job.attempt || turn.status !== 'QUEUED') return null;
      const attempt = await db.collaborationAttempt.findFirstOrThrow({
        where: { turnId: turn.id, organizationId: actor.organizationId, number: job.attempt },
      });
      if (attempt.status !== 'QUEUED') return null;
      const startedAt = new Date();
      const deadlineAt = new Date(startedAt.getTime() + COLLABORATOR_LIMITS.deadlineMs);
      await db.collaborationAttempt.update({
        where: { id: attempt.id },
        data: { status: 'RUNNING', startedAt, deadlineAt },
      });
      await db.collaborationTurn.update({ where: { id: turn.id }, data: { status: 'RUNNING' } });
      await this.audit(db, actor, turn.id, 'started', {
        attempt: job.attempt,
        queueDelayMs: startedAt.getTime() - attempt.createdAt.getTime(),
      });
      return { turn, attempt, deadlineAt };
    });
    if (!reservation) return { turnId: job.turnId, status: 'NOT_REPLAYED' };
    const { turn, attempt, deadlineAt } = reservation;
    const abort = new AbortController();
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.prisma.unscoped.collaborationAttempt
        .findFirst({
          where: { id: attempt.id, organizationId: actor.organizationId },
          select: { status: true, fence: true },
        })
        .then((row) => {
          if (!row || row.status !== 'RUNNING' || row.fence !== attempt.fence)
            abort.abort(new CollaborationFailure('CANCELLED'));
        })
        .catch(() => abort.abort(new CollaborationFailure('DEPENDENCY_UNAVAILABLE')))
        .finally(() => {
          polling = false;
        });
    }, 200);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const configured = await this.providers.resolve(actor.organizationId);
        const question = await this.prisma.unscoped.conversationMessage.findFirstOrThrow({
          where: {
            turnId: turn.id,
            organizationId: actor.organizationId,
            kind: 'HUMAN',
          },
        });
        const recent = await this.prisma.unscoped.conversationMessage.findMany({
          where: {
            conversationId: turn.conversationId,
            organizationId: actor.organizationId,
            sequence: { lt: question.sequence },
          },
          orderBy: { sequence: 'desc' },
          take: COLLABORATOR_LIMITS.messages,
        });
        const calls = await this.investigation.list(actor, turn.id, { afterSequence: 0, limit: 8 });
        const spent = await this.priorBudget(this.prisma.unscoped, actor, turn.id, job.attempt);
        const evidence = (
          await Promise.all(
            calls.items
              .filter((c) => ['SUCCESS', 'PARTIAL', 'LIMITED'].includes(c.status))
              .map((c) => this.investigation.getCall(actor, c.id)),
          )
        ).flatMap((c) => c.evidence);
        const revisionTarget = turn.revisionOfProposalId
          ? await this.patches.get(actor, turn.revisionOfProposalId)
          : null;
        await this.checkpoint(actor, turn.id, attempt.id, attempt.fence, {
          provider: configured.provider.name.slice(0, 32),
          model: configured.model.slice(0, 128),
        });
        const result = await runCollaborator({
          provider: configured.provider,
          signal: abort.signal,
          deadlineAt: deadlineAt.getTime(),
          context: {
            question: question.content,
            recent: recent.reverse().map((m) => ({ kind: m.kind, content: m.content })),
            evidence,
            priorToolCalls: calls.items.length,
            priorProviderRequests: spent.providerRequests ?? 0,
            priorOutputTokens: spent.outputTokens ?? 0,
            priorRounds: spent.rounds ?? 0,
            metadata: {
              conversationId: turn.conversationId,
              pullRequestId: turn.pullRequestId,
              headSha: turn.headSha,
              baseSha: turn.baseSha,
              reviewRunId: turn.reviewRunId,
              anchor: turn.conversation.anchor,
              historical: turn.headSha !== turn.conversation.pullRequest.headSha,
              ...(revisionTarget
                ? {
                    previousProposalNotFacts: {
                      revision: revisionTarget.revision,
                      summary: revisionTarget.summary,
                      rationale: revisionTarget.rationale,
                      limitations: revisionTarget.limitations,
                      files: revisionTarget.files.map((f) => ({
                        path: f.path,
                        oldBlobSha: f.oldBlobSha,
                        edits: f.edits,
                      })),
                    },
                  }
                : {}),
            },
          },
          checkpoint: (accounting) =>
            this.checkpoint(actor, turn.id, attempt.id, attempt.fence, accounting),
          tool: (name, input, signal) =>
            this.investigation.execute(actor, turn.id, name, randomUUID(), input, {
              signal,
              attemptId: attempt.id,
              fence: attempt.fence,
            }),
        });
        const proposed =
          result.response.action === 'PROPOSE_PATCH'
            ? await this.patches.prepare(actor, turn.id, result.response.proposal, {
                requestId: attempt.id,
                authorType: 'AI',
                attemptId: attempt.id,
                signal: abort.signal,
              })
            : null;
        const response =
          result.response.action === 'PROPOSE_PATCH'
            ? {
                content: 'I prepared a proposed change for review.',
                citations: proposed!.ids.map((evidenceId) => ({
                  evidenceId,
                  claim: 'Supporting context for the proposed change',
                  strength: 'INFERRED' as const,
                })),
              }
            : result.response;
        await this.prisma.$transaction(async (db) => {
          await this.lock(db, actor, turn.id);
          const fresh = await this.scope(db, actor, turn.id);
          const live = await db.collaborationAttempt.findFirst({
            where: {
              id: attempt.id,
              organizationId: actor.organizationId,
              fence: attempt.fence,
              status: 'RUNNING',
              deadlineAt: { gt: new Date() },
            },
          });
          if (
            !live ||
            fresh.status !== 'RUNNING' ||
            fresh.executionAttempt !== job.attempt ||
            abort.signal.aborted
          )
            throw new CollaborationFailure('CANCELLED');
          const ids = response.citations.map((c) => c.evidenceId);
          const available = new Set(live.availableEvidenceIds as string[]);
          const valid = await db.evidenceReference.count({
            where: {
              id: { in: ids },
              organizationId: actor.organizationId,
              sourceType: { in: [...COLLABORATION_EVIDENCE_TYPES] },
              turnId: turn.id,
              toolCall: { status: { in: ['SUCCESS', 'PARTIAL', 'LIMITED'] } },
            },
          });
          if (ids.some((id) => !available.has(id)) || valid !== ids.length)
            throw new CollaborationFailure('INVALID_CITATION');
          if (proposed) await this.patches.persist(db, actor, proposed, live.provider, live.model);
          // The conversation lock serializes sequence allocation with concurrent human submissions.
          await db.$queryRaw`SELECT id FROM "Conversation" WHERE id=${turn.conversationId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
          const conversation = await db.conversation.findFirstOrThrow({
            where: { id: turn.conversationId, organizationId: actor.organizationId },
          });
          const sequence = conversation.lastSequence + 1;
          if (abort.signal.aborted || Date.now() >= deadlineAt.getTime())
            throw new CollaborationFailure('DEADLINE');
          await db.conversationMessage.create({
            data: {
              organizationId: actor.organizationId,
              conversationId: turn.conversationId,
              turnId: turn.id,
              createdById: actor.userId,
              sequence,
              kind: 'ASSISTANT',
              content: redactSecrets(response.content).redacted,
              citations: response.citations.map((c) => ({
                ...c,
                claim: redactSecrets(c.claim).redacted,
              })) as Prisma.InputJsonValue,
              provider: live.provider,
              model: live.model,
            },
          });
          await db.conversation.update({
            where: { id: turn.conversationId },
            data: { lastSequence: sequence },
          });
          await db.collaborationAttempt.update({
            where: { id: attempt.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          await db.collaborationTurn.update({
            where: { id: turn.id },
            data: { status: 'COMPLETED' },
          });
          await this.audit(db, actor, turn.id, 'completed', {
            attempt: job.attempt,
            evidenceCount: ids.length,
            provider: live.provider,
            model: live.model,
            providerRequests: live.providerRequests,
            providerRetries: live.providerRetries,
            repairs: live.repairs,
            tools: live.toolCalls,
            contextBytes: live.contextBytes,
            outputTokens: live.outputTokens,
            providerDurationMs: live.providerDurationMs,
            toolDurationMs: live.toolDurationMs,
            durationMs:
              Date.now() - reservation.deadlineAt.getTime() + COLLABORATOR_LIMITS.deadlineMs,
          });
          // A slow final write/audit must roll back rather than commit past the turn deadline.
          if (abort.signal.aborted || Date.now() >= deadlineAt.getTime())
            throw new CollaborationFailure('DEADLINE');
        });
      };
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => {
              abort.abort(new CollaborationFailure('DEADLINE'));
              reject(new CollaborationFailure('DEADLINE'));
            },
            Math.max(0, deadlineAt.getTime() - Date.now()),
          );
        }),
      ]);
    } catch (error) {
      const category =
        error instanceof CollaborationFailure
          ? error.category
          : error instanceof ValidationError
            ? 'PATCH_INVALID'
            : error instanceof ConflictError
              ? 'PATCH_CONFLICT'
              : 'EXECUTION_UNAVAILABLE';
      await this.prisma.$transaction(async (db) => {
        await this.lock(db, actor, turn.id);
        const changed = await db.collaborationAttempt.updateMany({
          where: {
            id: attempt.id,
            organizationId: actor.organizationId,
            status: 'RUNNING',
            fence: attempt.fence,
          },
          data: {
            status: 'FAILED',
            failureCategory: category,
            completedAt: new Date(),
            fence: randomUUID(),
          },
        });
        if (!changed.count) return;
        await db.collaborationTurn.update({ where: { id: turn.id }, data: { status: 'FAILED' } });
        await this.cancelTools(db, actor, turn.id);
        await this.audit(db, actor, turn.id, 'failed', { attempt: job.attempt, category });
      });
    } finally {
      abort.abort();
      clearInterval(poll);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    return { turnId: turn.id, status: (await this.get(actor, turn.id)).status };
  }

  private async checkpoint(
    actor: ConversationActor,
    turnId: string,
    attemptId: string,
    fence: string,
    data: Partial<CollaborationAccounting> & { provider?: string; model?: string },
  ) {
    await this.prisma.$transaction(async (db) => {
      await this.lock(db, actor, turnId);
      const turn = await this.scope(db, actor, turnId);
      if (turn.status !== 'RUNNING') throw new CollaborationFailure('CANCELLED');
      const changed = await db.collaborationAttempt.updateMany({
        where: {
          id: attemptId,
          organizationId: actor.organizationId,
          status: 'RUNNING',
          fence,
          deadlineAt: { gt: new Date() },
        },
        data,
      });
      if (changed.count !== 1) {
        const current = await db.collaborationAttempt.findFirst({
          where: { id: attemptId, organizationId: actor.organizationId },
        });
        throw new CollaborationFailure(
          current?.fence === fence &&
          current.status === 'RUNNING' &&
          current.deadlineAt &&
          current.deadlineAt.getTime() <= Date.now()
            ? 'DEADLINE'
            : 'CANCELLED',
        );
      }
    });
  }

  private async priorBudget(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turnId: string,
    beforeAttempt: number,
  ) {
    const result = await db.collaborationAttempt.aggregate({
      where: { turnId, organizationId: actor.organizationId, number: { lt: beforeAttempt } },
      _sum: { providerRequests: true, outputTokens: true, rounds: true },
    });
    return result._sum;
  }
  private audit(
    db: PrismaTransactionClient,
    actor: ConversationActor,
    turnId: string,
    suffix: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return db.auditLog.create({
      data: {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        traceId: actor.traceId.slice(0, 128),
        action: `collaboration.turn.${suffix}`,
        resourceType: 'CollaborationTurn',
        resourceId: turnId,
        description: `Collaboration turn ${suffix}`,
        metadata,
      },
    });
  }
}
