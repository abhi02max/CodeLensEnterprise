import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  Role,
  roleAtLeast,
  ML_CONTRACT,
  ML_FEATURE_SCHEMA,
  ValidationMlRequestSchema,
  VALIDATION_ML_LIMITATIONS,
  type ValidationMlView,
} from '@codelens/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { MlService } from '../ml/ml.service';
import { riskDigest } from '../ml/strict-risk-client';
import { ValidationMlQueue } from '../queues/validation-ml.queue';
import { ConflictError, NotFoundError } from '../common/errors';
import type { ConversationActor } from './collaboration.service';
import { applicationRead } from './patch-application-deadline';
import { reconstructValidation } from './validation-content';
import { ML_EXTRACTION, freezeMlMetadata, extractValidationMl } from './validation-ml-content';

const ACTIVE = ['QUEUED', 'PREPARING', 'RUNNING'];
const INCLUDE = {
  assessments: { orderBy: { side: 'asc' as const } },
} satisfies Prisma.ValidationMlComparisonInclude;
type Comparison = Prisma.ValidationMlComparisonGetPayload<{ include: typeof INCLUDE }>;
const json = (value: unknown) => value as Prisma.InputJsonValue;

@Injectable()
export class ValidationMlService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
    private readonly ml: MlService,
    private readonly queue: ValidationMlQueue,
  ) {}
  async onModuleInit() {
    const [value] = await this.prisma.unscoped.$queryRaw<
      Array<{ ready: boolean }>
    >`SELECT to_regclass('public."ValidationMlComparison"') IS NOT NULL AND to_regclass('public."ValidationMlAssessment"') IS NOT NULL AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN ('validation_ml_comparison_guard','validation_ml_assessment_guard'))=2 AS ready`;
    if (!value?.ready) throw new Error('ML assessment schema not ready. Run db-init migrations.');
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
    if (!m || !roleAtLeast(m.role as Role, Role.DEVELOPER))
      throw new NotFoundError('ML assessment');
  }
  private async scope(
    db: PrismaTransactionClient,
    organizationId: string,
    id: string,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT p.id FROM "ValidationRun" v JOIN "PatchApplication" a ON a.id=v."applicationId" JOIN "PatchProposal" p ON p.id=a."proposalId" JOIN "PullRequest" r ON r.id=v."pullRequestId" WHERE v.id=${id} AND v."organizationId"=${organizationId} FOR SHARE OF v,a,p,r`;
    const run = await db.validationRun.findFirst({
      where: { id, organizationId },
      include: {
        application: {
          include: {
            proposal: { include: { files: true } },
            attempts: { include: { files: true } },
          },
        },
        staticAnalyses: { include: { findings: true } },
      },
    });
    if (!run) throw new NotFoundError('ML assessment');
    const app = run.application;
    const pr = await db.pullRequest.findFirst({
      where: {
        id: run.pullRequestId,
        organizationId,
        repositoryId: run.repositoryId,
        repository: { organizationId },
      },
      include: { repository: true },
    });
    const turn = await db.collaborationTurn.findFirst({
      where: {
        id: run.turnId,
        organizationId,
        conversationId: run.conversationId,
        pullRequestId: run.pullRequestId,
      },
    });
    if (
      !pr ||
      !turn ||
      turn.headSha !== app.headSha ||
      turn.baseSha !== app.baseSha ||
      run.headSha !== app.headSha
    )
      throw new NotFoundError('ML assessment');
    return { run, app, pr };
  }
  private eligible(scope: Awaited<ReturnType<ValidationMlService['scope']>>, row?: Comparison) {
    const { run, app } = scope,
      p = app.proposal;
    const applied = app.attempts.find((a) => a.status === 'APPLIED' && a.cleanup === 'DISPOSED');
    if (
      run.state !== 'COMPLETED' ||
      run.cleanup !== 'DISPOSED' ||
      app.status !== 'APPLIED' ||
      app.cleanup !== 'DISPOSED' ||
      p.status !== 'ACCEPTED' ||
      !applied ||
      !/^[a-f0-9]{40}$/.test(app.baseSha) ||
      !/^[a-f0-9]{40}$/.test(app.headSha) ||
      p.organizationId !== app.organizationId ||
      p.repositoryId !== run.repositoryId ||
      p.pullRequestId !== run.pullRequestId ||
      p.conversationId !== run.conversationId ||
      p.turnId !== run.turnId ||
      p.headSha !== run.headSha ||
      p.baseSha !== app.baseSha ||
      p.revision !== run.proposalRevision ||
      p.revision !== app.proposalRevision ||
      p.digest !== run.proposalDigest ||
      p.digest !== app.proposalDigest ||
      run.proposalId !== app.proposalId ||
      run.snapshotDigest !== applied.snapshotDigest ||
      run.candidateDigest !== applied.manifestDigest
    )
      throw new ConflictError('ML assessment lineage is not eligible.');
    if (
      row &&
      (row.validationId !== run.id ||
        row.applicationId !== app.id ||
        row.repositoryId !== run.repositoryId ||
        row.pullRequestId !== run.pullRequestId ||
        row.proposalId !== p.id ||
        row.proposalRevision !== p.revision ||
        row.proposalDigest !== p.digest ||
        row.baseSha !== app.baseSha ||
        row.headSha !== run.headSha ||
        row.snapshotDigest !== run.snapshotDigest ||
        row.candidateDigest !== run.candidateDigest)
    )
      throw new Error('ML_BINDING_REJECTED');
    return applied;
  }
  private audit(
    db: PrismaTransactionClient,
    row: Comparison,
    event: string,
    details: Record<string, string | number | null> = {},
  ) {
    return db.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'collaboration.validation.ml.' + event,
        resourceType: 'ValidationMlComparison',
        resourceId: row.id,
        description: 'Advisory model comparison ' + event,
        metadata: {
          validationId: row.validationId,
          comparisonId: row.id,
          state: row.state,
          outcome: row.outcome,
          ...details,
        },
      },
    });
  }
  async request(actor: ConversationActor, id: string, raw: { requestId: string }) {
    const input = ValidationMlRequestSchema.parse(raw),
      requestHash = riskDigest({ validationId: id });
    const row = await this.prisma.$transaction(async (db) => {
      const identity = JSON.stringify([actor.organizationId, actor.userId, input.requestId]);
      await db.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))) AS ml_request_lock`;
      await this.member(db, actor, true);
      const scope = await this.scope(db, actor.organizationId, id);
      const existing = await db.validationMlComparison.findFirst({
        where: {
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId: input.requestId,
        },
        include: INCLUDE,
      });
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictError('ML request reused for another validation.');
        return existing;
      }
      await db.$queryRaw`SELECT id FROM "ValidationRun" WHERE id=${id} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
      this.eligible(await this.scope(db, actor.organizationId, id, true));
      const active = await db.validationMlComparison.findFirst({
        where: { validationId: id, organizationId: actor.organizationId, state: { in: ACTIVE } },
      });
      if (active) throw new ConflictError('ML comparison is already active.');
      const created = await db.validationMlComparison.create({
        data: {
          id: randomUUID(),
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId: input.requestId,
          requestHash,
          validationId: id,
          repositoryId: scope.run.repositoryId,
          pullRequestId: scope.run.pullRequestId,
          applicationId: scope.app.id,
          proposalId: scope.app.proposalId,
          proposalRevision: scope.run.proposalRevision,
          proposalDigest: scope.run.proposalDigest,
          baseSha: scope.app.baseSha,
          headSha: scope.run.headSha,
          snapshotDigest: scope.run.snapshotDigest,
          candidateDigest: scope.run.candidateDigest,
          featureSchemaVersion: ML_FEATURE_SCHEMA,
          requestContractVersion: ML_CONTRACT,
          extractorVersion: ML_EXTRACTION.extractorVersion,
          diffPolicyVersion: ML_EXTRACTION.diffPolicyVersion,
          staticPolicyVersion: ML_EXTRACTION.staticPolicyVersion,
          textNormalizationVersion: ML_EXTRACTION.textNormalizationVersion,
          deadlineAt: new Date(Date.now() + 360000),
        },
        include: INCLUDE,
      });
      await this.audit(db, created, 'requested');
      await this.audit(db, created, 'queued');
      return created;
    });
    if (row.state === 'QUEUED') await this.queue.enqueue(row.id).catch(() => undefined);
    return this.get(actor, id, row.id);
  }
  private async locked(db: PrismaTransactionClient, id: string) {
    await db.$queryRaw`SELECT id FROM "ValidationMlComparison" WHERE id=${id}::uuid FOR UPDATE`;
    const row = await db.validationMlComparison.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw new NotFoundError('ML assessment');
    return row;
  }
  private async live(db: PrismaTransactionClient, id: string, fence: string) {
    const row = await this.locked(db, id);
    if (
      !ACTIVE.includes(row.state) ||
      row.fence !== fence ||
      row.deadlineAt.getTime() <= Date.now()
    )
      throw new Error('ML_FENCE_REJECTED');
    await this.member(db, { organizationId: row.organizationId, userId: row.requestedById }, true);
    const scope = await this.scope(db, row.organizationId, row.validationId, true);
    this.eligible(scope, row);
    return { row, scope };
  }
  async execute(id: string) {
    const claim = await this.prisma.$transaction(async (db) => {
      const row = await this.locked(db, id);
      if (row.state !== 'QUEUED' || row.fence) return null;
      if (row.deadlineAt.getTime() <= Date.now()) {
        await this.fail(db, row, 'EXPIRED_NO_REEXECUTION');
        return null;
      }
      const fence = randomUUID();
      const updated = await db.validationMlComparison.update({
        where: { id },
        data: { state: 'PREPARING', fence, startedAt: new Date() },
        include: INCLUDE,
      });
      await this.audit(db, updated, 'extraction_started');
      return { row: updated, fence };
    });
    if (!claim) return;
    const signal = AbortSignal.timeout(Math.max(1, claim.row.deadlineAt.getTime() - Date.now()));
    try {
      const { scope } = await this.prisma.$transaction((db) => this.live(db, id, claim.fence));
      const row = claim.row,
        applied = this.eligible(scope, row);
      // Freeze all non-source inputs once, in one database snapshot, before network reads.
      const frozen = await this.prisma.$transaction(
        async (db) => {
          await this.live(db, id, claim.fence);
          await db.$queryRaw`SELECT id FROM "PullRequest" WHERE id=${row.pullRequestId} AND "organizationId"=${row.organizationId} FOR SHARE`;
          const pr = await db.pullRequest.findFirstOrThrow({
            where: { id: row.pullRequestId, organizationId: row.organizationId },
          });
          if (pr.headSha !== row.headSha || pr.baseSha !== row.baseSha)
            throw new Error('ML_METADATA_UNAVAILABLE');
          const commits = await db.commit.findMany({
            where: { pullRequestId: pr.id },
            orderBy: [{ authoredAt: 'asc' }, { sha: 'asc' }],
            take: 10001,
          });
          const findingPaths = await db.staticFinding.findMany({
            where: {
              organizationId: row.organizationId,
              severity: { in: ['HIGH', 'CRITICAL'] },
              preexisting: false,
              reviewRun: {
                status: 'COMPLETED',
                pullRequest: {
                  repositoryId: row.repositoryId,
                  organizationId: row.organizationId,
                  id: { not: row.pullRequestId },
                },
              },
            },
            select: { path: true },
            distinct: ['path'],
            take: 1001,
          });
          const rejected = await db.pullRequestFile.findMany({
            where: {
              pullRequest: {
                repositoryId: row.repositoryId,
                organizationId: row.organizationId,
                id: { not: row.pullRequestId },
                reviews: { some: { verdict: 'CHANGES_REQUESTED' } },
              },
            },
            select: { filename: true },
            distinct: ['filename'],
            take: 1001,
          });
          if (findingPaths.length > 1000 || rejected.length > 1000)
            throw new Error('ML_METADATA_BOUND');
          return freezeMlMetadata(
            pr.title,
            commits.map((c) => c.message),
            pr.commitCount,
            [
              ...new Set([
                ...findingPaths.flatMap((f) => (f.path ? [f.path] : [])),
                ...rejected.map((f) => f.filename),
              ]),
            ],
            new Date().toISOString(),
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const client = await applicationRead(this.github.forUser(row.requestedById), signal);
      const base = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        row.baseSha,
        signal,
      );
      const original = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        row.headSha,
        signal,
      );
      const patched = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        row.headSha,
        signal,
      );
      const sources = reconstructValidation(original, patched, scope.app.proposal, row, {
        version: 1,
        snapshotDigest: applied.snapshotDigest,
        proposalDigest: row.proposalDigest,
        files: [...applied.files]
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map(({ path, contentHash, byteLength }) => ({ path, contentHash, byteLength })),
        digest: applied.manifestDigest,
      });
      if (base.revision !== row.baseSha || base.repository !== original.repository)
        throw new Error('ML_SOURCE_UNAVAILABLE');
      const deadline = Date.now() + 5000;
      const getEvidence = (side: string) => {
        const evidence = scope.run.staticAnalyses.find((a) => a.side === side);
        if (!evidence) throw new Error('ML_STATIC_UNAVAILABLE');
        return evidence;
      };
      const a = getEvidence('ORIGINAL'),
        b = getEvidence('PATCHED');
      const extracted = {
        ORIGINAL: extractValidationMl(
          base.files,
          sources.ORIGINAL,
          row.snapshotDigest,
          a,
          frozen,
          deadline,
        ),
        PATCHED: extractValidationMl(
          base.files,
          sources.PATCHED,
          row.candidateDigest,
          b,
          frozen,
          deadline,
        ),
      };
      await this.prisma.$transaction(async (db) => {
        await this.live(db, id, claim.fence);
        const updated = await db.validationMlComparison.update({
          where: { id },
          data: {
            state: 'RUNNING',
            baseSourceDigest: base.digest,
            frozenMetadata: json(frozen.metadata),
            frozenMetadataDigest: frozen.digest,
          },
          include: INCLUDE,
        });
        for (const side of ['ORIGINAL', 'PATCHED'] as const)
          await this.audit(db, updated, 'features_completed', {
            side,
            featureDigest: extracted[side].featureDigest,
            frozenMetadataDigest: frozen.digest,
          });
        await this.audit(db, updated, 'inference_started');
      });
      signal.throwIfAborted();
      // Exactly one strict pair call; no retry can silently select a replacement artifact.
      const result = await applicationRead(
        this.ml.predictRiskPair({
          contractVersion: ML_CONTRACT,
          featureSchemaVersion: ML_FEATURE_SCHEMA,
          organizationId: row.organizationId,
          original: extracted.ORIGINAL.features,
          patched: extracted.PATCHED.features,
        }),
        signal,
      );
      await this.prisma.$transaction(async (db) => {
        const { row: current } = await this.live(db, id, claim.fence);
        for (const side of ['ORIGINAL', 'PATCHED'] as const) {
          const observation =
            result.status === 'AVAILABLE'
              ? side === 'ORIGINAL'
                ? result.original
                : result.patched
              : null;
          await db.validationMlAssessment.create({
            data: {
              id: randomUUID(),
              comparisonId: id,
              organizationId: row.organizationId,
              side,
              featureDigest: extracted[side].featureDigest,
              features: json(extracted[side].features),
              staticResultDigest: side === 'ORIGINAL' ? a.resultDigest : b.resultDigest,
              availability: result.status,
              scoreTenths: observation?.scoreTenths ?? null,
              band: observation?.band ?? null,
              probabilityMicros: observation?.probabilityMicros ?? null,
              confidenceMillis: observation?.confidenceMillis ?? null,
              warnings: observation?.warnings ?? [],
              failureCategory: result.status === 'UNAVAILABLE' ? result.category : null,
            },
          });
        }
        const delta =
          result.status === 'AVAILABLE'
            ? result.patched.scoreTenths - result.original.scoreTenths
            : null;
        const bands = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        const movement =
          result.status === 'AVAILABLE'
            ? Math.sign(bands.indexOf(result.patched.band) - bands.indexOf(result.original.band))
            : null;
        const updated = await db.validationMlComparison.update({
          where: { id },
          data: {
            state: 'COMPLETED',
            completedAt: new Date(),
            outcome:
              delta === null
                ? 'UNAVAILABLE'
                : delta < 0
                  ? 'LOWER'
                  : delta > 0
                    ? 'HIGHER'
                    : 'UNCHANGED',
            deltaTenths: delta,
            bandMovement:
              movement === null
                ? null
                : movement < 0
                  ? 'LOWER'
                  : movement > 0
                    ? 'HIGHER'
                    : 'UNCHANGED',
            modelIdentity: result.status === 'AVAILABLE' ? json(result.identity) : Prisma.DbNull,
            resultDigest: result.status === 'AVAILABLE' ? result.resultDigest : null,
            failureCategory: result.status === 'UNAVAILABLE' ? result.category : null,
          },
          include: INCLUDE,
        });
        await this.audit(db, current, 'inference_completed', {
          failureCategory: result.status === 'UNAVAILABLE' ? result.category : null,
        });
        await this.audit(
          db,
          updated,
          result.status === 'AVAILABLE' ? 'comparison_completed' : 'unavailable',
          { deltaTenths: delta },
        );
      });
    } catch (error) {
      await this.prisma.$transaction(async (db) => {
        const row = await this.locked(db, id);
        if (!ACTIVE.includes(row.state) || row.fence !== claim.fence) return;
        // Categories are allowlisted, never raw network/provider/source exception text.
        const category =
          error instanceof Error &&
          [
            'ML_METADATA_UNAVAILABLE',
            'ML_METADATA_BOUND',
            'ML_SOURCE_BOUND',
            'ML_SOURCE_UNAVAILABLE',
            'ML_STATIC_UNAVAILABLE',
            'ML_DIFF_BOUND',
            'ML_EXTRACTION_TIMEOUT',
          ].includes(error.message)
            ? error.message
            : 'ML_PREPARATION_UNAVAILABLE';
        await this.fail(db, row, signal.aborted ? 'TIMEOUT' : category);
      });
    }
  }
  private async fail(
    db: PrismaTransactionClient,
    row: Comparison,
    category: string,
    state = 'FAILED',
  ) {
    const updated = await db.validationMlComparison.update({
      where: { id: row.id },
      data: { state, outcome: 'UNAVAILABLE', failureCategory: category, completedAt: new Date() },
      include: INCLUDE,
    });
    await this.audit(db, updated, state === 'CANCELLED' ? 'cancelled' : 'unavailable');
    if (state === 'FAILED') await this.audit(db, updated, 'failed', { failureCategory: category });
  }
  async reconcile() {
    const rows = await this.prisma.unscoped.validationMlComparison.findMany({
      where: { state: { in: ACTIVE } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: INCLUDE,
    });
    for (const candidate of rows) {
      if (candidate.deadlineAt.getTime() <= Date.now())
        await this.prisma.$transaction(async (db) => {
          const row = await this.locked(db, candidate.id);
          if (ACTIVE.includes(row.state) && row.deadlineAt.getTime() <= Date.now())
            await this.fail(db, row, 'EXPIRED_NO_REEXECUTION');
        });
      else if (candidate.state === 'QUEUED')
        await this.queue.enqueue(candidate.id).catch(() => undefined);
    }
  }
  async get(
    actor: ConversationActor,
    validationId: string,
    id?: string,
  ): Promise<ValidationMlView | null> {
    await this.member(this.prisma.unscoped, actor);
    const scope = await this.scope(this.prisma.unscoped, actor.organizationId, validationId);
    const row = await this.prisma.unscoped.validationMlComparison.findFirst({
      where: { validationId, organizationId: actor.organizationId, ...(id ? { id } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INCLUDE,
    });
    if (!row) {
      if (id) throw new NotFoundError('ML assessment');
      return null;
    }
    return {
      id: row.id,
      validationId: row.validationId,
      applicationId: row.applicationId,
      proposalId: row.proposalId,
      proposalRevision: row.proposalRevision,
      proposalDigest: row.proposalDigest,
      baseSha: row.baseSha,
      headSha: row.headSha,
      snapshotDigest: row.snapshotDigest,
      candidateDigest: row.candidateDigest,
      baseSourceDigest: row.baseSourceDigest,
      state: row.state as ValidationMlView['state'],
      outcome: row.outcome as ValidationMlView['outcome'],
      deltaTenths: row.deltaTenths,
      bandMovement: row.bandMovement,
      failureCategory: row.failureCategory,
      frozenMetadataDigest: row.frozenMetadataDigest,
      metadataProvenance: 'ASSESSMENT_START_PERSISTED_METADATA',
      featureSchemaVersion: row.featureSchemaVersion,
      extractorVersion: row.extractorVersion,
      diffPolicyVersion: row.diffPolicyVersion,
      staticPolicyVersion: row.staticPolicyVersion,
      textNormalizationVersion: row.textNormalizationVersion,
      modelIdentity: row.modelIdentity as ValidationMlView['modelIdentity'],
      resultDigest: row.resultDigest,
      stale: scope.pr.headSha !== row.headSha,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      assessments: row.assessments.map((a) => ({
        side: a.side as 'ORIGINAL' | 'PATCHED',
        featureDigest: a.featureDigest,
        features: a.features as ValidationMlView['assessments'][number]['features'],
        staticResultDigest: a.staticResultDigest,
        availability: a.availability as 'AVAILABLE' | 'UNAVAILABLE',
        scoreTenths: a.scoreTenths,
        band: a.band,
        probabilityMicros: a.probabilityMicros,
        confidenceMillis: a.confidenceMillis,
        warnings: a.warnings,
        failureCategory: a.failureCategory,
      })),
      limitations: VALIDATION_ML_LIMITATIONS,
    };
  }
  async cancel(actor: ConversationActor, validationId: string, id: string, requestId: string) {
    ValidationMlRequestSchema.parse({ requestId });
    await this.get(actor, validationId, id);
    await this.prisma.$transaction(async (db) => {
      const row = await this.locked(db, id);
      await this.member(db, actor, true);
      if (row.state === 'CANCELLED') return;
      if (!ACTIVE.includes(row.state))
        throw new ConflictError('ML comparison is already terminal.');
      await this.fail(db, row, 'CANCELLED_BY_USER', 'CANCELLED');
    });
    return this.get(actor, validationId, id);
  }
}
