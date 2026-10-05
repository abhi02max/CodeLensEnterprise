import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import { runValidationAi, ValidationAiFailure } from '@codelens/ai-agent';
import {
  Role,
  roleAtLeast,
  VALIDATION_AI,
  ValidationAiRequestSchema,
  ValidationAiPacketSchema,
  ValidationAiResultSchema,
  type ValidationAiView,
  type ValidationAiAccounting,
  type ValidationAiPacket,
} from '@codelens/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { ValidationAiQueue } from '../queues/validation-ai.queue';
import { riskDigest } from '../ml/strict-risk-client';
import type { ConversationActor } from './collaboration.service';
import { AI_SOURCE_INCLUDE, aiLineage, buildValidationAiPacket } from './validation-ai-content';
import { ValidationAiProviderService } from './validation-ai-provider.service';

const ACTIVE = ['QUEUED', 'PREPARING', 'RUNNING'];
const INCLUDE = {
  attempts: { orderBy: { generation: 'asc' as const } },
  evidence: { orderBy: { ordinal: 'asc' as const } },
} satisfies Prisma.ValidationAiReviewInclude;
type Review = Prisma.ValidationAiReviewGetPayload<{ include: typeof INCLUDE }>;
const json = (v: unknown) => v as Prisma.InputJsonValue;

@Injectable()
export class ValidationAiService implements OnModuleInit {
  private readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ValidationAiQueue,
    private readonly provider: ValidationAiProviderService,
  ) {}
  async onModuleInit() {
    const [r] = await this.prisma.unscoped.$queryRaw<
      Array<{ ready: boolean }>
    >`SELECT to_regclass('public."ValidationAiReview"') IS NOT NULL AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN ('validation_ai_review_guard','validation_ai_attempt_guard','validation_ai_evidence_guard'))=3 AS ready`;
    if (!r?.ready) throw new Error('AI re-review schema not ready. Run db-init migrations.');
  }
  private async member(
    db: PrismaTransactionClient,
    actor: Pick<ConversationActor, 'organizationId' | 'userId'>,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT id FROM "Membership" WHERE "organizationId"=${actor.organizationId} AND "userId"=${actor.userId} FOR SHARE`;
    const m = await db.membership.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    if (!m || !roleAtLeast(m.role as Role, Role.DEVELOPER)) throw new NotFoundError('AI re-review');
  }
  private async source(db: PrismaTransactionClient, org: string, id: string) {
    const run = await db.validationRun.findFirst({
      where: { id, organizationId: org },
      include: AI_SOURCE_INCLUDE,
    });
    if (!run) throw new NotFoundError('AI re-review');
    const pr = await db.pullRequest.findFirst({
      where: {
        id: run.pullRequestId,
        organizationId: org,
        repositoryId: run.repositoryId,
        repository: { organizationId: org },
      },
    });
    const turn = await db.collaborationTurn.findFirst({
      where: {
        id: run.turnId,
        organizationId: org,
        conversationId: run.conversationId,
        pullRequestId: run.pullRequestId,
      },
    });
    if (!pr || !turn || turn.headSha !== run.headSha || turn.baseSha !== run.application.baseSha)
      throw new NotFoundError('AI re-review');
    return { run, pr };
  }
  private audit(
    db: PrismaTransactionClient,
    r: Review,
    event: string,
    metadata: Record<string, string | number | null> = {},
  ) {
    return db.auditLog.create({
      data: {
        organizationId: r.organizationId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'collaboration.validation.ai.' + event,
        resourceType: 'ValidationAiReview',
        resourceId: r.id,
        description: 'Advisory AI re-review ' + event,
        metadata: {
          reviewId: r.id,
          validationId: r.validationId,
          packetDigest: r.packetDigest,
          state: r.state,
          requestedProvider: r.requestedProvider,
          requestedModel: r.requestedModel,
          packetVersion: r.packetVersion,
          promptVersion: r.promptVersion,
          schemaVersion: r.schemaVersion,
          evidenceCount: r.evidence.length,
          requests: r.attempts[0]?.requests ?? 0,
          retries: r.attempts[0]?.retries ?? 0,
          repairs: r.attempts[0]?.repairs ?? 0,
          reservedTokens: r.attempts[0]?.reservedTokens ?? 0,
          promptTokens: r.attempts[0]?.promptTokens ?? null,
          completionTokens: r.attempts[0]?.completionTokens ?? null,
          unknownRequests: r.attempts[0]?.unknownRequests ?? 0,
          durationMs: r.attempts[0]?.durationMs ?? 0,
          ...metadata,
        },
      },
    });
  }
  async request(actor: ConversationActor, validationId: string, raw: { requestId: string }) {
    const input = ValidationAiRequestSchema.parse(raw),
      requestHash = riskDigest({ validationId });
    const r = await this.prisma.$transaction(async (db) => {
      const identity = JSON.stringify([actor.organizationId, actor.userId, input.requestId]);
      await db.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))) AS ai_request_lock`;
      await this.member(db, actor, true);
      const { run } = await this.source(db, actor.organizationId, validationId);
      const prior = await db.validationAiReview.findFirst({
        where: {
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId: input.requestId,
        },
        include: INCLUDE,
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new ConflictError('AI request reused for another validation.');
        return prior;
      }
      await db.$queryRaw`SELECT id FROM "ValidationRun" WHERE id=${validationId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      if (
        await db.validationAiReview.findFirst({
          where: { validationId, organizationId: actor.organizationId, state: { in: ACTIVE } },
        })
      )
        throw new ConflictError('AI re-review is already active.');
      const ml = await db.validationMlComparison.findFirst({
        where: {
          validationId,
          organizationId: actor.organizationId,
          state: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { assessments: true },
      });
      if (!ml) throw new ConflictError('Persisted terminal ML evidence is required.');
      let lineage: ValidationAiPacket['lineage'];
      try {
        lineage = aiLineage(run, ml);
      } catch {
        throw new ConflictError('Persisted candidate evidence is not eligible.');
      }
      const settings = await this.provider.settings(actor.organizationId);
      const created = await db.validationAiReview.create({
        data: {
          id: randomUUID(),
          ...lineage,
          requestedById: actor.userId,
          requestId: input.requestId,
          requestHash,
          ...settings,
          packetVersion: VALIDATION_AI.packet,
          promptVersion: VALIDATION_AI.prompt,
          schemaVersion: VALIDATION_AI.schema,
          deadlineAt: new Date(Date.now() + VALIDATION_AI.executionMs),
        },
        include: INCLUDE,
      });
      await this.audit(db, created, 'requested');
      return created;
    });
    if (r.state === 'QUEUED') await this.queue.enqueue(r.id).catch(() => undefined);
    return this.get(actor, validationId, r.id);
  }
  private async locked(db: PrismaTransactionClient, id: string) {
    await db.$queryRaw`SELECT id FROM "ValidationAiReview" WHERE id=${id}::uuid FOR UPDATE`;
    const r = await db.validationAiReview.findUnique({ where: { id }, include: INCLUDE });
    if (!r) throw new NotFoundError('AI re-review');
    return r;
  }
  private async live(db: PrismaTransactionClient, id: string, fence: string) {
    const r = await this.locked(db, id);
    if (!ACTIVE.includes(r.state) || r.fence !== fence || r.deadlineAt.getTime() <= Date.now())
      throw new ValidationAiFailure('FENCE_REJECTED');
    await this.member(db, { organizationId: r.organizationId, userId: r.requestedById }, true);
    return r;
  }
  private packet(r: Review) {
    if (!r.packetHeader || !r.packetDigest) throw new ValidationAiFailure('PACKET_INVALID');
    const packet = ValidationAiPacketSchema.parse({
      ...(r.packetHeader as object),
      entries: r.evidence.map((e) => ({
        id: e.evidenceId,
        sourceId: e.sourceId,
        trust: e.trust,
        contentDigest: e.contentDigest,
        payload: e.payload,
      })),
    });
    if (
      riskDigest(packet) !== r.packetDigest ||
      packet.entries.some((e) => riskDigest(e.payload) !== e.contentDigest)
    )
      throw new ValidationAiFailure('PACKET_INVALID');
    return packet;
  }
  async execute(id: string) {
    const claim = await this.prisma.$transaction(async (db) => {
      const r = await this.locked(db, id);
      if (r.state !== 'QUEUED' || r.fence) return null;
      if (r.deadlineAt.getTime() <= Date.now()) {
        await this.fail(db, r, 'EXPIRED_NO_REEXECUTION');
        return null;
      }
      const fence = randomUUID();
      const updated = await db.validationAiReview.update({
        where: { id },
        data: { state: 'PREPARING', fence, startedAt: new Date() },
        include: INCLUDE,
      });
      await db.validationAiReviewAttempt.create({
        data: { id: randomUUID(), reviewId: id, organizationId: r.organizationId, fence },
      });
      return { r: updated, fence };
    });
    if (!claim) return;
    const controller = new AbortController(),
      deadline = setTimeout(
        () => controller.abort(),
        Math.max(1, claim.r.deadlineAt.getTime() - Date.now()),
      );
    this.controllers.set(id, controller);
    let polling = false;
    let reportedProvider: string | null = null,
      reportedModel: string | null = null;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.prisma.unscoped.validationAiReview
        .findUnique({ where: { id }, select: { state: true, fence: true } })
        .then(
          (r) => {
            if (!r || !ACTIVE.includes(r.state) || r.fence !== claim.fence) controller.abort();
          },
          () => controller.abort(),
        )
        .finally(() => {
          polling = false;
        });
    }, 500);
    try {
      await this.prisma.$transaction(async (db) => {
        const r = await this.live(db, id, claim.fence),
          { run } = await this.source(db, r.organizationId, r.validationId);
        const ml = await db.validationMlComparison.findFirst({
          where: { id: r.mlComparisonId, organizationId: r.organizationId },
          include: { assessments: true },
        });
        if (!ml) throw new ValidationAiFailure('EVIDENCE_UNAVAILABLE');
        const built = buildValidationAiPacket(run, ml, this.provider.secrets());
        if (riskDigest(built.packet.lineage) !== riskDigest(this.lineage(r)))
          throw new ValidationAiFailure('EVIDENCE_LINEAGE');
        for (const [ordinal, e] of built.packet.entries.entries())
          await db.validationAiEvidenceReference.create({
            data: {
              reviewId: id,
              organizationId: r.organizationId,
              evidenceId: e.id,
              sourceId: e.sourceId,
              type: e.payload.type,
              trust: e.trust,
              contentDigest: e.contentDigest,
              ordinal,
              payload: json(e.payload),
            },
          });
        const { entries: _entries, ...header } = built.packet;
        const updated = await db.validationAiReview.update({
          where: { id },
          data: { state: 'RUNNING', packetDigest: built.digest, packetHeader: json(header) },
          include: INCLUDE,
        });
        await this.audit(db, updated, 'packet_built', {
          evidenceCount: built.packet.entries.length,
        });
      });
      const sealed = await this.prisma.unscoped.validationAiReview.findUniqueOrThrow({
        where: { id },
        include: INCLUDE,
      });
      const provider = await this.provider.resolve(sealed.organizationId, sealed),
        packet = this.packet(sealed);
      reportedProvider = provider.name;
      const checkpoint = async (
        accounting: ValidationAiAccounting,
        model: string | null,
        kind?: string,
      ) => {
        if (model !== null) reportedModel = model;
        await this.provider.resolve(sealed.organizationId, sealed);
        await this.prisma.$transaction(async (db) => {
          const r = await this.live(db, id, claim.fence);
          if (r.state !== 'RUNNING') throw new ValidationAiFailure('FENCE_REJECTED');
          await db.validationAiReviewAttempt.update({
            where: { reviewId_generation: { reviewId: id, generation: 1 } },
            data: accounting,
          });
          if (kind) {
            await this.audit(db, r, 'provider_requested', {
              requests: accounting.requests,
              retries: accounting.retries,
              repairs: accounting.repairs,
              reservedTokens: accounting.reservedTokens,
            });
            if (kind === 'REPAIR') await this.audit(db, r, 'repair_attempted');
          }
        });
      };
      const completion = await runValidationAi({
        provider,
        packet,
        signal: controller.signal,
        secrets: this.provider.secrets(),
        beforeRequest: (a, k) => checkpoint(a, null, k),
        afterRequest: (a, m) => checkpoint(a, m),
      });
      await this.provider.resolve(sealed.organizationId, sealed);
      await this.prisma.$transaction(async (db) => {
        const r = await this.live(db, id, claim.fence),
          finalPacket = this.packet(r);
        const available = new Set(finalPacket.entries.map((e) => e.id));
        const result = ValidationAiResultSchema.parse(completion.result);
        if (
          [
            result.summary,
            ...result.addressedConcerns,
            ...result.residualConcerns,
            ...result.introducedConcerns,
            ...result.suggestedFollowups,
          ].some((c) => c.evidenceIds.some((e) => !available.has(e)))
        )
          throw new ValidationAiFailure('INVALID_CITATION');
        await db.validationAiReviewAttempt.update({
          where: { reviewId_generation: { reviewId: id, generation: 1 } },
          data: { ...completion.accounting, completedAt: new Date() },
        });
        const updated = await db.validationAiReview.update({
          where: { id },
          data: {
            state: 'COMPLETED',
            assessment: result.assessment,
            result: json(result),
            reportedProvider: provider.name,
            reportedModel: completion.reportedModel,
            completedAt: new Date(),
          },
          include: INCLUDE,
        });
        await this.audit(db, updated, 'completed', {
          assessment: result.assessment,
          requests: completion.accounting.requests,
          citationCount: [
            result.summary,
            ...result.addressedConcerns,
            ...result.residualConcerns,
            ...result.introducedConcerns,
            ...result.suggestedFollowups,
          ].reduce((n, c) => n + c.evidenceIds.length, 0),
        });
      });
    } catch (error) {
      const allowed = new Set([
        'PACKET_BOUND',
        'EVIDENCE_LINEAGE',
        'EVIDENCE_CANDIDATE',
        'EVIDENCE_VALIDATION',
        'EVIDENCE_STATIC',
        'EVIDENCE_ML',
        'EVIDENCE_UNAVAILABLE',
        'PROVIDER_DISABLED',
        'PROVIDER_CONFIGURATION_CHANGED',
        'PROVIDER_CONFIGURATION',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_TIMEOUT',
        'RESPONSE_BOUND',
        'INVALID_OUTPUT',
        'INVALID_CITATION',
        'OUTPUT_BOUND',
      ]);
      const category =
        error instanceof ValidationAiFailure && allowed.has(error.category)
          ? error.category
          : error instanceof Error && allowed.has(error.message)
            ? error.message
            : 'PREPARATION_UNAVAILABLE';
      await this.prisma.$transaction(async (db) => {
        const r = await this.locked(db, id);
        if (ACTIVE.includes(r.state) && r.fence === claim.fence)
          await this.fail(
            db,
            r,
            controller.signal.aborted ? 'EXPIRED_OR_CANCELLED' : category,
            'FAILED',
            { reportedProvider, reportedModel },
          );
      });
    } finally {
      clearTimeout(deadline);
      clearInterval(poll);
      this.controllers.delete(id);
    }
  }
  private lineage(r: Review): ValidationAiPacket['lineage'] {
    return {
      organizationId: r.organizationId,
      repositoryId: r.repositoryId,
      pullRequestId: r.pullRequestId,
      validationId: r.validationId,
      applicationId: r.applicationId,
      proposalId: r.proposalId,
      proposalRevision: r.proposalRevision,
      proposalDigest: r.proposalDigest,
      baseSha: r.baseSha,
      headSha: r.headSha,
      snapshotDigest: r.snapshotDigest,
      candidateDigest: r.candidateDigest,
      staticIds: r.staticIds,
      mlComparisonId: r.mlComparisonId,
    };
  }
  private async fail(
    db: PrismaTransactionClient,
    r: Review,
    category: string,
    state = 'FAILED',
    reported: { reportedProvider: string | null; reportedModel: string | null } = {
      reportedProvider: null,
      reportedModel: null,
    },
  ) {
    if (r.attempts.length)
      await db.validationAiReviewAttempt.update({
        where: { reviewId_generation: { reviewId: r.id, generation: 1 } },
        data: { failureCategory: category, completedAt: new Date() },
      });
    const updated = await db.validationAiReview.update({
      where: { id: r.id },
      data: { state, failureCategory: category, ...reported, completedAt: new Date() },
      include: INCLUDE,
    });
    await this.audit(db, updated, state === 'CANCELLED' ? 'cancelled' : 'failed', {
      failureCategory: category,
    });
  }
  async reconcile() {
    const rows = await this.prisma.unscoped.validationAiReview.findMany({
      where: { state: { in: ACTIVE } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: INCLUDE,
    });
    for (const candidate of rows) {
      if (candidate.deadlineAt.getTime() <= Date.now())
        await this.prisma.$transaction(async (db) => {
          const r = await this.locked(db, candidate.id);
          if (ACTIVE.includes(r.state) && r.deadlineAt.getTime() <= Date.now())
            await this.fail(db, r, 'EXPIRED_NO_REEXECUTION');
        });
      else if (candidate.state === 'QUEUED')
        await this.queue.enqueue(candidate.id).catch(() => undefined);
    }
  }
  async get(
    actor: ConversationActor,
    validationId: string,
    id?: string,
  ): Promise<ValidationAiView | null> {
    await this.member(this.prisma.unscoped, actor);
    const { pr } = await this.source(this.prisma.unscoped, actor.organizationId, validationId);
    const r = await this.prisma.unscoped.validationAiReview.findFirst({
      where: { organizationId: actor.organizationId, validationId, ...(id ? { id } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INCLUDE,
    });
    if (!r) {
      if (id) throw new NotFoundError('AI re-review');
      return null;
    }
    const packet = r.packetDigest ? this.packet(r) : null,
      a = r.attempts[0];
    return {
      id: r.id,
      validationId: r.validationId,
      state: r.state as ValidationAiView['state'],
      lineage: this.lineage(r),
      packetDigest: r.packetDigest,
      packetVersion: r.packetVersion,
      promptVersion: r.promptVersion,
      schemaVersion: r.schemaVersion,
      requestedProvider: r.requestedProvider,
      requestedModel: r.requestedModel,
      reportedProvider: r.reportedProvider,
      reportedModel: r.reportedModel,
      result: r.result ? ValidationAiResultSchema.parse(r.result) : null,
      failureCategory: r.failureCategory,
      stale: pr.headSha !== r.headSha,
      coverage: packet?.coverage ?? null,
      evidence: packet?.entries ?? [],
      accounting: a
        ? {
            requests: a.requests,
            retries: a.retries,
            repairs: a.repairs,
            reservedTokens: a.reservedTokens,
            promptTokens: a.promptTokens,
            completionTokens: a.completionTokens,
            unknownRequests: a.unknownRequests,
            durationMs: a.durationMs,
          }
        : null,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    };
  }
  async cancel(actor: ConversationActor, validationId: string, id: string, requestId: string) {
    ValidationAiRequestSchema.parse({ requestId });
    await this.get(actor, validationId, id);
    await this.prisma.$transaction(async (db) => {
      const r = await this.locked(db, id);
      await this.member(db, actor, true);
      if (r.state === 'CANCELLED') return;
      if (!ACTIVE.includes(r.state)) throw new ConflictError('AI re-review is terminal.');
      await this.fail(db, r, 'CANCELLED_BY_USER', 'CANCELLED');
    });
    this.controllers.get(id)?.abort();
    return this.get(actor, validationId, id);
  }
}
