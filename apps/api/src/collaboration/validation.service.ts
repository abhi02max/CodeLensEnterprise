import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import { patchHash } from '@codelens/patch-core';
import { requestValidation } from '@codelens/validation-broker/dist/client';
import { approvedProfile } from '@codelens/validation-broker/dist/profile';
import { sanitizeOutput } from '@codelens/validation-broker/dist/output';
import { runValidationStatic } from '@codelens/static-analysis/dist/validation-static-runner';
import {
  STATIC_IDENTITY,
  STATIC_BOUNDS,
  staticInputDigest,
  type StaticResult,
} from '@codelens/static-analysis/dist/validation-static';
import {
  Role,
  roleAtLeast,
  ValidationRequestSchema,
  ValidationStateSchema,
  ValidationOutcomeSchema,
  VALIDATION_LIMITATIONS,
  VALIDATION_PROFILES,
  type ValidationRequest,
  type ValidationView,
  type ValidationStepView,
  type StaticFindingsQuery,
  type ValidationStaticView,
  type ValidationFindingView,
  STATIC_LIMITATIONS,
} from '@codelens/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { AppConfigService } from '../config/app-config.service';
import { ConflictError, NotFoundError, UpstreamUnavailableError } from '../common/errors';
import { ValidationQueue, type ValidationJob } from '../queues/validation.queue';
import type { ConversationActor } from './collaboration.service';
import { applicationRead } from './patch-application-deadline';
import {
  reconstructValidation,
  compatibleFiles,
  verifiedObservation,
  compareSteps,
  aggregateComparisons,
} from './validation-content';
import { verifyStaticResults } from './validation-static-content';

const ACTIVE = ['QUEUED', 'PREPARING', 'RUNNING'];
const INCLUDE = {
  attempts: {
    orderBy: { generation: 'asc' as const },
    include: {
      steps: { orderBy: [{ profile: 'asc' as const }, { side: 'asc' as const }] },
    },
  },
} satisfies Prisma.ValidationRunInclude;
type Run = Prisma.ValidationRunGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class ValidationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
    private readonly queue: ValidationQueue,
    private readonly config: AppConfigService,
  ) {}
  async onModuleInit() {
    const [state] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."ValidationRun"') IS NOT NULL
        AND to_regclass('public."ValidationAttempt"') IS NOT NULL
        AND to_regclass('public."ValidationStep"') IS NOT NULL
        AND to_regclass('public."ValidationStaticAnalysis"') IS NOT NULL
        AND to_regclass('public."ValidationFinding"') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
          AND tgname IN ('validation_run_guard','validation_attempt_guard','validation_step_guard','validation_static_guard','validation_finding_guard'))=5 AS ready`;
    if (!state?.ready) throw new Error('Validation schema not ready. Run db-init migrations.');
  }
  private deployment() {
    const { image, bundleDigest, configurationDigest } = this.config.validationDeployment;
    try {
      approvedProfile('typescript-typecheck-v1', image, bundleDigest, configurationDigest);
    } catch {
      throw new UpstreamUnavailableError(
        'validation',
        'Fixed validation deployment is not configured.',
      );
    }
    return { image, bundleDigest, configurationDigest };
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
    if (!m || !roleAtLeast(m.role as Role, Role.DEVELOPER)) throw new NotFoundError('Validation');
  }
  private async application(db: PrismaTransactionClient, org: string, id: string, lock = false) {
    if (lock)
      await db.$queryRaw`SELECT id FROM "PatchApplication" WHERE id=${id} AND "organizationId"=${org} FOR UPDATE`;
    const app = await db.patchApplication.findFirst({
      where: { id, organizationId: org },
      include: {
        proposal: { include: { files: true } },
        attempts: { include: { files: true } },
      },
    });
    if (!app) throw new NotFoundError('Validation');
    if (lock)
      await db.$queryRaw`SELECT id FROM "PatchProposal" WHERE id=${app.proposalId} AND "organizationId"=${org} FOR SHARE`;
    const pr = await db.pullRequest.findFirst({
      where: {
        id: app.pullRequestId,
        organizationId: org,
        repositoryId: app.repositoryId,
        repository: { organizationId: org },
      },
      include: { repository: true },
    });
    const turn = await db.collaborationTurn.findFirst({
      where: {
        id: app.turnId,
        organizationId: org,
        conversationId: app.conversationId,
        pullRequestId: app.pullRequestId,
      },
    });
    if (!pr || !turn || turn.headSha !== app.headSha || turn.baseSha !== app.baseSha)
      throw new NotFoundError('Validation');
    return { app, pr };
  }
  private eligible(scope: Awaited<ReturnType<ValidationService['application']>>) {
    const { app } = scope,
      p = app.proposal;
    const attempt = app.attempts.find((a) => a.status === 'APPLIED' && a.cleanup === 'DISPOSED');
    if (
      app.status !== 'APPLIED' ||
      app.cleanup !== 'DISPOSED' ||
      !attempt?.snapshotDigest ||
      !attempt.manifestDigest ||
      p.status !== 'ACCEPTED' ||
      p.organizationId !== app.organizationId ||
      p.repositoryId !== app.repositoryId ||
      p.pullRequestId !== app.pullRequestId ||
      p.conversationId !== app.conversationId ||
      p.turnId !== app.turnId ||
      p.revision !== app.proposalRevision ||
      p.digest !== app.proposalDigest ||
      p.headSha !== app.headSha ||
      p.baseSha !== app.baseSha
    )
      throw new ConflictError('Application is not eligible for paired validation.');
    return attempt;
  }
  private bind(row: Run, scope: Awaited<ReturnType<ValidationService['application']>>) {
    const attempt = this.eligible(scope),
      app = scope.app;
    if (
      row.proposalId !== app.proposalId ||
      row.repositoryId !== app.repositoryId ||
      row.pullRequestId !== app.pullRequestId ||
      row.conversationId !== app.conversationId ||
      row.turnId !== app.turnId ||
      row.headSha !== app.headSha ||
      row.proposalRevision !== app.proposalRevision ||
      row.proposalDigest !== app.proposalDigest ||
      row.snapshotDigest !== attempt.snapshotDigest ||
      row.candidateDigest !== attempt.manifestDigest
    )
      throw new Error('VALIDATION_BINDING_REJECTED');
    return attempt;
  }
  async request(actor: ConversationActor, id: string, raw: ValidationRequest) {
    const input = ValidationRequestSchema.parse(raw),
      profiles = [...input.profiles].sort();
    const requestHash = patchHash(JSON.stringify({ applicationId: id, profiles }));
    const row = await this.prisma.$transaction(async (db) => {
      const identity = JSON.stringify([actor.organizationId, actor.userId, input.requestId]);
      await db.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))) AS validation_request_lock`;
      await this.member(db, actor, true);
      const scope = await this.application(db, actor.organizationId, id, true);
      const existing = await db.validationRun.findFirst({
        where: {
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId: input.requestId,
        },
        include: INCLUDE,
      });
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictError('Validation request reused with different content.');
        return existing;
      }
      const applied = this.eligible(scope),
        app = scope.app;
      const prior = await db.validationRun.findFirst({
        where: {
          organizationId: actor.organizationId,
          applicationId: id,
          OR: [{ state: { in: ACTIVE } }, { cleanup: 'UNCERTAIN' }],
        },
      });
      if (prior) throw new ConflictError('Validation is active or cleanup remains uncertain.');
      const now = new Date(),
        runId = randomUUID(),
        attemptId = randomUUID();
      const created = await db.validationRun.create({
        data: {
          id: runId,
          organizationId: actor.organizationId,
          applicationId: id,
          proposalId: app.proposalId,
          repositoryId: app.repositoryId,
          pullRequestId: app.pullRequestId,
          conversationId: app.conversationId,
          turnId: app.turnId,
          requestedById: actor.userId,
          requestId: input.requestId,
          requestHash,
          proposalRevision: app.proposalRevision,
          proposalDigest: app.proposalDigest,
          headSha: app.headSha,
          snapshotDigest: applied.snapshotDigest!,
          candidateDigest: applied.manifestDigest!,
          ...this.deployment(),
          profiles,
          createdAt: now,
          updatedAt: now,
          deadlineAt: new Date(now.getTime() + 720000),
          attempts: { create: { id: attemptId, generation: 1, jobId: `validation-${runId}-1` } },
        },
        include: INCLUDE,
      });
      await this.audit(db, created, 'requested', actor.userId);
      await this.audit(db, created, 'queued');
      return created;
    });
    if (row.state === 'QUEUED') await this.enqueue(row).catch(() => undefined);
    return this.get(actor, row.id);
  }
  private enqueue(row: Run) {
    const a = row.attempts.at(-1)!;
    return this.queue.enqueue(a.jobId, {
      organizationId: row.organizationId,
      validationId: row.id,
      attemptId: a.id,
    });
  }
  private async locked(db: PrismaTransactionClient, data: ValidationJob) {
    await db.$queryRaw`SELECT id FROM "ValidationRun" WHERE id=${data.validationId} AND "organizationId"=${data.organizationId} FOR UPDATE`;
    const row = await db.validationRun.findFirst({
      where: { id: data.validationId, organizationId: data.organizationId },
      include: INCLUDE,
    });
    const attempt = row?.attempts.find((a) => a.id === data.attemptId);
    if (!row || !attempt || attempt.generation !== row.attempts.at(-1)?.generation)
      throw new NotFoundError('Validation');
    return { row, attempt };
  }
  private async live(db: PrismaTransactionClient, data: ValidationJob, fence: string) {
    const value = await this.locked(db, data);
    if (
      !ACTIVE.includes(value.row.state) ||
      value.attempt.fence !== fence ||
      value.row.deadlineAt.getTime() <= Date.now()
    )
      throw new Error('VALIDATION_FENCE_REJECTED');
    await this.member(
      db,
      { organizationId: value.row.organizationId, userId: value.row.requestedById },
      true,
    );
    const scope = await this.application(
      db,
      value.row.organizationId,
      value.row.applicationId,
      true,
    );
    this.bind(value.row, scope);
    return { ...value, scope };
  }
  private audit(
    db: PrismaTransactionClient,
    row: Run,
    event: string,
    actorId?: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    return db.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: 'collaboration.validation.' + event,
        resourceType: 'ValidationRun',
        resourceId: row.id,
        description: 'Paired isolated validation ' + event + '; runner reports are untrusted',
        metadata: {
          validationId: row.id,
          applicationId: row.applicationId,
          proposalId: row.proposalId,
          proposalRevision: row.proposalRevision,
          headSha: row.headSha,
          state: row.state,
          cleanup: row.cleanup,
          generation: 1,
          ...details,
        },
      },
    });
  }
  private async terminal(
    db: PrismaTransactionClient,
    row: Run,
    state: string,
    cleanup: string,
    failureCategory: string | null,
    outcome: string | null = null,
  ) {
    if (!ACTIVE.includes(row.state)) return;
    const completedAt = new Date();
    await db.validationAttempt.update({
      where: { id: row.attempts.at(-1)!.id },
      data: { completedAt },
    });
    const updated = await db.validationRun.update({
      where: { id: row.id },
      data: { state, cleanup, failureCategory, outcome, completedAt },
      include: INCLUDE,
    });
    await this.audit(db, updated, state.toLowerCase());
    if (cleanup === 'UNCERTAIN') await this.audit(db, updated, 'cleanup_uncertain');
  }
  async execute(data: ValidationJob) {
    const claimed = await this.prisma.$transaction(async (db) => {
      const { row, attempt } = await this.locked(db, data);
      if (row.state !== 'QUEUED' || attempt.fence !== null) return null;
      const fence = randomUUID();
      try {
        if (row.deadlineAt.getTime() <= Date.now()) throw new Error('EXPIRED');
        await this.member(
          db,
          { organizationId: row.organizationId, userId: row.requestedById },
          true,
        );
        this.bind(row, await this.application(db, row.organizationId, row.applicationId));
      } catch {
        await this.terminal(db, row, 'FAILED', 'NOT_STARTED', 'PRELAUNCH_REJECTED');
        return null;
      }
      await db.validationAttempt.update({
        where: { id: attempt.id },
        data: { fence, startedAt: new Date() },
      });
      const updated = await db.validationRun.update({
        where: { id: row.id },
        data: { state: 'PREPARING' },
        include: INCLUDE,
      });
      await this.audit(db, updated, 'attempt_started');
      return { row: updated, fence };
    });
    if (!claimed) return;
    const abort = new AbortController();
    let stopped = false;
    const timer = setTimeout(
      () => abort.abort(),
      Math.max(1, claimed.row.deadlineAt.getTime() - Date.now()),
    );
    const watching = (async () => {
      while (!stopped && !abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 250));
        if (stopped) break;
        try {
          const row = await applicationRead(
            this.prisma.unscoped.validationRun.findFirst({
              where: {
                id: data.validationId,
                organizationId: data.organizationId,
              },
              include: INCLUDE,
            }),
            abort.signal,
          );
          if (
            !row ||
            !ACTIVE.includes(row.state) ||
            row.attempts.at(-1)?.fence !== claimed.fence ||
            row.deadlineAt.getTime() <= Date.now()
          )
            abort.abort();
          else {
            await applicationRead(
              this.member(this.prisma.unscoped, {
                organizationId: row.organizationId,
                userId: row.requestedById,
              }),
              abort.signal,
            );
            this.bind(
              row,
              await applicationRead(
                this.application(this.prisma.unscoped, row.organizationId, row.applicationId),
                abort.signal,
              ),
            );
          }
        } catch {
          abort.abort();
        }
      }
    })();
    try {
      const row = claimed.row;
      const scope = await applicationRead(
        this.application(this.prisma.unscoped, row.organizationId, row.applicationId),
        abort.signal,
      );
      const applied = this.bind(row, scope);
      const client = await applicationRead(this.github.forUser(row.requestedById), abort.signal);
      const original = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        row.headSha,
        abort.signal,
      );
      const patched = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        row.headSha,
        abort.signal,
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
      abort.signal.throwIfAborted();
      // Compatibility is decided for both sides before any hostile execution.
      const inputs = row.profiles.flatMap((profile) => {
        if (!VALIDATION_PROFILES.includes(profile as (typeof VALIDATION_PROFILES)[number]))
          throw new Error('PROFILE_REJECTED');
        return (['ORIGINAL', 'PATCHED'] as const).map((side) => ({
          side,
          ...compatibleFiles(profile as (typeof VALIDATION_PROFILES)[number], sources[side]),
        }));
      });
      const key = await applicationRead(readFile('/run/secrets/validation-key'), abort.signal);
      if (key.length !== 32) throw new Error('KEY_REQUIRED');
      for (const item of inputs) {
        const nonce = randomUUID(),
          startedAt = new Date();
        await this.prisma.$transaction(async (db) => {
          await this.live(db, data, claimed.fence);
          const updated = await db.validationRun.update({
            where: { id: row.id },
            data: { state: 'RUNNING', cleanup: 'UNCERTAIN' },
            include: INCLUDE,
          });
          await this.audit(db, updated, 'step_started', undefined, {
            profile: item.input.profile,
            side: item.side,
            inputDigest: item.digest,
          });
        });
        abort.signal.throwIfAborted();
        // The broker independently enforces compatibility, including UNSUPPORTED/no-launch.
        const result = await requestValidation(
          '/validation-control/validation.sock',
          key,
          item.input,
          nonce,
          abort.signal,
          row.deadlineAt.getTime(),
        );
        const verified = verifiedObservation(result, {
          ...row,
          profile: item.input.profile,
          nonce,
          inputDigest: item.digest,
        });
        const safe = verified.result;
        for (const stream of [safe.observed.stdout, safe.observed.stderr]) {
          stream.excerpt = sanitizeOutput(stream.excerpt, [
            key.toString('hex'),
            key.toString('base64'),
          ]);
        }
        const failed = await this.prisma.$transaction(async (db) => {
          await this.live(db, data, claimed.fence);
          await db.validationStep.create({
            data: {
              id: randomUUID(),
              validationId: row.id,
              attemptId: data.attemptId,
              organizationId: row.organizationId,
              profile: safe.profile,
              profileVersion: 1,
              side: item.side,
              inputDigest: safe.inputDigest,
              resultDigest: patchHash(JSON.stringify(safe)),
              brokerNonce: nonce,
              status: safe.status,
              outcome: verified.outcome,
              observed: safe.observed,
              runnerReported: safe.runnerReported,
              startedAt,
              completedAt: new Date(),
            },
          });
          const updated = await db.validationRun.update({
            where: { id: row.id },
            data: { cleanup: safe.observed.cleanup },
            include: INCLUDE,
          });
          await this.audit(db, updated, 'step_completed', undefined, {
            profile: safe.profile,
            profileVersion: 1,
            side: item.side,
            inputDigest: safe.inputDigest,
            resultDigest: patchHash(JSON.stringify(safe)),
            durationMs: safe.observed.durationMs,
            exitCategory: safe.observed.termination,
          });
          return (
            safe.observed.cleanup === 'UNCERTAIN' ||
            safe.status === 'INFRASTRUCTURE_FAILED' ||
            safe.status === 'CANCELLED'
          );
        });
        if (failed) throw new Error('EXECUTION_UNCERTAIN');
      }
      // Pure source-only analysis follows observed paired execution; no runner report is source authority.
      await this.prisma.$transaction(async (db) => {
        const { row: current } = await this.live(db, data, claimed.fence);
        await this.audit(db, current, 'static_started', undefined, {
          rulesetVersion: STATIC_IDENTITY.rulesetVersion,
          rulesetDigest: STATIC_IDENTITY.rulesetDigest,
          configurationDigest: STATIC_IDENTITY.configurationDigest,
        });
      });
      const staticStarted = Date.now();
      let staticResults = await runValidationStatic(
        sources,
        scope.app.proposal.files.map((f) => ({
          path: f.path,
          edits: f.edits as unknown as Array<{
            startLine: number;
            endLine: number;
            replacement: string;
          }>,
        })),
        abort.signal,
      );
      try {
        verifyStaticResults(staticResults, sources);
      } catch {
        staticResults = Object.fromEntries(
          (['ORIGINAL', 'PATCHED'] as const).map((side) => [
            side,
            {
              status: 'FAILED',
              reason: 'RESULT_REJECTED',
              identity: STATIC_IDENTITY,
              inputDigest: staticInputDigest(sources[side]),
              findings: [],
            },
          ]),
        ) as unknown as Record<'ORIGINAL' | 'PATCHED', StaticResult>;
      }
      await this.prisma.$transaction(async (db) => {
        const { row: current } = await this.live(db, data, claimed.fence);
        for (const side of ['ORIGINAL', 'PATCHED'] as const) {
          const result = staticResults[side];
          const analysisId = randomUUID();
          await db.validationStaticAnalysis.create({
            data: {
              id: analysisId,
              validationId: row.id,
              organizationId: row.organizationId,
              attemptId: data.attemptId,
              side,
              status: result.status,
              reason: result.reason,
              ...result.identity,
              sourceDigest: side === 'ORIGINAL' ? row.snapshotDigest : row.candidateDigest,
              inputDigest: result.inputDigest,
              resultDigest: patchHash(JSON.stringify(result)),
              findingCount: result.findings.length,
              durationMs: Math.min(30000, Date.now() - staticStarted),
            },
          });
          if (result.findings.length)
            await db.validationFinding.createMany({
              data: result.findings.map((f) => ({
                ...f,
                id: randomUUID(),
                analysisId,
                organizationId: row.organizationId,
              })),
            });
          await this.audit(db, current, 'static_side_completed', undefined, {
            side,
            status: result.status,
            reason: result.reason,
            sourceDigest: side === 'ORIGINAL' ? row.snapshotDigest : row.candidateDigest,
            rulesetVersion: result.identity.rulesetVersion,
            findingCount: result.findings.length,
          });
        }
        const counts = staticResults.ORIGINAL.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.classification] = (acc[f.classification] ?? 0) + 1;
          return acc;
        }, {});
        for (const f of staticResults.PATCHED.findings)
          if (!f.counterpartDigest) counts[f.classification] = (counts[f.classification] ?? 0) + 1;
        await this.audit(db, current, 'static_compared', undefined, {
          ...counts,
          status:
            staticResults.ORIGINAL.status === 'COMPLETE' &&
            staticResults.PATCHED.status === 'COMPLETE'
              ? 'COMPLETE'
              : 'INCOMPARABLE',
        });
      });
      await this.prisma.$transaction(async (db) => {
        const { row: current } = await this.live(db, data, claimed.fence);
        const comparisons = this.comparisons(current);
        await this.terminal(
          db,
          current,
          'COMPLETED',
          'DISPOSED',
          null,
          aggregateComparisons(comparisons.map((v) => v.outcome)),
        );
      });
    } catch {
      await this.prisma.$transaction(async (db) => {
        const { row, attempt } = await this.locked(db, data);
        if (ACTIVE.includes(row.state) && attempt.fence === claimed.fence)
          await this.terminal(
            db,
            row,
            'FAILED',
            row.cleanup,
            row.cleanup === 'UNCERTAIN'
              ? 'BROKER_OR_CLEANUP_UNCERTAIN'
              : 'PREPARATION_OR_RESULT_REJECTED',
            'INCONCLUSIVE',
          );
      });
    } finally {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await watching;
    }
  }
  async reconcile() {
    const rows = await this.prisma.unscoped.validationRun.findMany({
      where: { state: { in: ACTIVE } },
      include: INCLUDE,
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    for (const candidate of rows) {
      const a = candidate.attempts.at(-1)!;
      if (candidate.deadlineAt.getTime() <= Date.now())
        await this.prisma.$transaction(async (db) => {
          const { row } = await this.locked(db, {
            organizationId: candidate.organizationId,
            validationId: candidate.id,
            attemptId: a.id,
          });
          if (ACTIVE.includes(row.state) && row.deadlineAt.getTime() <= Date.now())
            await this.terminal(
              db,
              row,
              'FAILED',
              row.cleanup,
              'EXPIRED_NO_REEXECUTION',
              'INCONCLUSIVE',
            );
        });
      else if (candidate.state === 'QUEUED') await this.enqueue(candidate).catch(() => undefined);
    }
  }
  async get(actor: ConversationActor, id: string): Promise<ValidationView> {
    await this.member(this.prisma.unscoped, actor);
    const row = await this.prisma.unscoped.validationRun.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Validation');
    const scope = await this.application(
      this.prisma.unscoped,
      actor.organizationId,
      row.applicationId,
    );
    return this.view(row, scope.pr.headSha);
  }
  async staticFindings(
    actor: ConversationActor,
    id: string,
    query: StaticFindingsQuery,
  ): Promise<ValidationStaticView> {
    await this.get(actor, id);
    const analyses = await this.prisma.unscoped.validationStaticAnalysis.findMany({
      where: { validationId: id, organizationId: actor.organizationId },
      orderBy: { side: 'asc' },
    });
    const relation = { validationId: id, organizationId: actor.organizationId };
    if (
      query.afterId &&
      !(await this.prisma.unscoped.validationFinding.findFirst({
        where: { id: query.afterId, organizationId: actor.organizationId, analysis: relation },
      }))
    )
      throw new NotFoundError('Validation finding');
    const all = await this.prisma.unscoped.validationFinding.findMany({
      where: { organizationId: actor.organizationId, analysis: relation },
      take: STATIC_BOUNDS.findings * 2,
    });
    const summary: ValidationStaticView['summary'] = {
      UNCHANGED: 0,
      RESOLVED: 0,
      INTRODUCED: 0,
      CHANGED: 0,
      INCOMPARABLE: 0,
    };
    const sideById = new Map(analyses.map((a) => [a.id, a.side]));
    for (const f of all)
      if (sideById.get(f.analysisId) === 'ORIGINAL' || !f.counterpartDigest)
        summary[f.classification as keyof typeof summary]++;
    const rows = await this.prisma.unscoped.validationFinding.findMany({
      where: {
        organizationId: actor.organizationId,
        analysis: { ...relation, ...(query.side ? { side: query.side } : {}) },
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
        ...(query.rule ? { ruleId: query.rule } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.classification ? { classification: query.classification } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      analyses: analyses.map(
        ({
          side,
          status,
          reason,
          rulesetVersion,
          rulesetDigest,
          configurationDigest,
          fingerprintVersion,
          sourceDigest,
          inputDigest,
          resultDigest,
          findingCount,
          durationMs,
        }) => ({
          side: side as 'ORIGINAL' | 'PATCHED',
          status: status as StaticResult['status'],
          reason,
          rulesetVersion,
          rulesetDigest,
          configurationDigest,
          fingerprintVersion,
          sourceDigest,
          inputDigest,
          resultDigest,
          findingCount,
          durationMs,
        }),
      ),
      summary,
      items: rows
        .slice(0, query.limit)
        .map(
          ({
            id,
            analysisId,
            analyzer,
            ruleId,
            severity,
            category,
            path,
            startLine,
            endLine,
            message,
            occurrenceFingerprint,
            findingDigest,
            classification,
            comparability,
            counterpartDigest,
            diffRelation,
          }) => ({
            id,
            side: sideById.get(analysisId) as 'ORIGINAL' | 'PATCHED',
            analyzer,
            ruleId,
            severity,
            category,
            path,
            startLine,
            endLine,
            message,
            occurrenceFingerprint,
            findingDigest,
            classification: classification as ValidationFindingView['classification'],
            comparability,
            counterpartDigest,
            diffRelation: diffRelation as ValidationFindingView['diffRelation'],
          }),
        ),
      nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      limitations: STATIC_LIMITATIONS,
    };
  }
  async list(actor: ConversationActor, id: string, query: { afterId?: string; limit: number }) {
    await this.member(this.prisma.unscoped, actor);
    const scope = await this.application(this.prisma.unscoped, actor.organizationId, id);
    if (
      query.afterId &&
      !(await this.prisma.unscoped.validationRun.findFirst({
        where: {
          id: query.afterId,
          applicationId: id,
          organizationId: actor.organizationId,
        },
      }))
    )
      throw new NotFoundError('Validation');
    const rows = await this.prisma.unscoped.validationRun.findMany({
      where: {
        applicationId: id,
        organizationId: actor.organizationId,
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      include: INCLUDE,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.view(r, scope.pr.headSha)),
      nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  }
  async cancel(actor: ConversationActor, id: string, requestId: string) {
    await this.get(actor, id);
    await this.prisma.$transaction(async (db) => {
      const initial = await db.validationRun.findFirstOrThrow({
        where: { id, organizationId: actor.organizationId },
        include: INCLUDE,
      });
      const { row } = await this.locked(db, {
        organizationId: actor.organizationId,
        validationId: id,
        attemptId: initial.attempts.at(-1)!.id,
      });
      await this.member(db, actor, true);
      if (row.state === 'CANCELLED') return;
      if (!ACTIVE.includes(row.state)) throw new ConflictError('Validation is already terminal.');
      await this.audit(db, row, 'cancellation_requested', actor.userId, { requestId });
      await this.terminal(db, row, 'CANCELLED', row.cleanup, null, 'INCONCLUSIVE');
    });
    return this.get(actor, id);
  }
  private comparisons(row: Run) {
    const steps = row.attempts.at(-1)!.steps;
    return row.profiles.map((profile) => ({
      profile: profile as (typeof VALIDATION_PROFILES)[number],
      outcome: compareSteps(
        steps.find((s) => s.profile === profile && s.side === 'ORIGINAL')?.outcome,
        steps.find((s) => s.profile === profile && s.side === 'PATCHED')?.outcome,
      ),
    }));
  }
  private view(row: Run, currentHead: string): ValidationView {
    const steps = row.attempts.at(-1)!.steps;
    return {
      id: row.id,
      applicationId: row.applicationId,
      proposalId: row.proposalId,
      proposalRevision: row.proposalRevision,
      proposalDigest: row.proposalDigest,
      headSha: row.headSha,
      snapshotDigest: row.snapshotDigest,
      candidateDigest: row.candidateDigest,
      image: row.image,
      bundleDigest: row.bundleDigest,
      configurationDigest: row.configurationDigest,
      profiles: row.profiles.map((p) => VALIDATION_PROFILES.find((known) => known === p)!),
      state: ValidationStateSchema.parse(row.state),
      outcome: row.outcome ? ValidationOutcomeSchema.parse(row.outcome) : null,
      cleanup: row.cleanup as ValidationView['cleanup'],
      failureCategory: row.failureCategory,
      stale: row.headSha !== currentHead,
      limitations: VALIDATION_LIMITATIONS,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      comparisons: this.comparisons(row),
      steps: steps.map((s) => ({
        id: s.id,
        profile: s.profile as ValidationStepView['profile'],
        profileVersion: s.profileVersion,
        side: s.side as ValidationStepView['side'],
        inputDigest: s.inputDigest,
        resultDigest: s.resultDigest,
        status: s.status,
        outcome: s.outcome as ValidationStepView['outcome'],
        observed: s.observed as unknown as ValidationStepView['observed'],
        runnerReported: s.runnerReported as unknown as ValidationStepView['runnerReported'],
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt.toISOString(),
      })),
    };
  }
}
