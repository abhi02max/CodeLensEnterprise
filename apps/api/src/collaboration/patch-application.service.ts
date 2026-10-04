import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@codelens/database';
import {
  COLLABORATION_EVIDENCE_TYPES,
  PATCH_APPLICATION_DEADLINE_MS,
  PATCH_APPLICATION_LIMITATIONS,
  Role,
  roleAtLeast,
  PatchApplicationStatusSchema,
  PatchApplicationCleanupSchema,
  PatchApplicationRequestSchema,
  type PatchApplicationRequest,
  type PatchApplicationView,
} from '@codelens/shared';
import { patchHash } from '@codelens/patch-core';
import { requestMaterializationProof } from '@codelens/sandbox-broker/dist/client';
import { BROKER_POLICY_VERSION } from '@codelens/sandbox-broker/dist/protocol';
import { PrismaService } from '../prisma/prisma.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { AppConfigService } from '../config/app-config.service';
import { ConflictError, NotFoundError, UpstreamUnavailableError } from '../common/errors';
import { PatchApplicationQueue, type PatchApplicationJob } from '../queues/patch-application.queue';
import type { ConversationActor } from './collaboration.service';
import { reconstructApplication, verifyApplicationManifest } from './patch-application-content';
import { applicationRead } from './patch-application-deadline';

const ACTIVE = ['QUEUED', 'PREPARING', 'APPLYING'];
const INCLUDE = {
  attempts: {
    orderBy: { generation: 'asc' as const },
    include: { files: { orderBy: { path: 'asc' as const } } },
  },
} as const;
type Application = Prisma.PatchApplicationGetPayload<{ include: typeof INCLUDE }>;
type Proposal = Prisma.PatchProposalGetPayload<{ include: { files: true } }>;

@Injectable()
export class PatchApplicationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
    private readonly config: AppConfigService,
    private readonly queue: PatchApplicationQueue,
  ) {}
  async onModuleInit() {
    const [state] = await this.prisma.unscoped.$queryRaw<Array<{ ready: boolean }>>`
      SELECT to_regclass('public."PatchApplication"') IS NOT NULL
        AND to_regclass('public."PatchApplicationAttempt"') IS NOT NULL
        AND to_regclass('public."PatchApplicationFileResult"') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
          AND tgname IN ('protect_patch_application','protect_patch_application_attempt',
            'verify_patch_application_scope','verify_patch_application_attempt','protect_patch_application_file_result'))=5 AS ready`;
    if (!state?.ready)
      throw new Error('Patch application schema is not ready. Run db-init migrations.');
  }

  private async membership(
    db: PrismaTransactionClient,
    actor: Pick<ConversationActor, 'organizationId' | 'userId'>,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT id FROM "Membership" WHERE "organizationId"=${actor.organizationId} AND "userId"=${actor.userId} FOR SHARE`;
    const member = await db.membership.findFirst({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    if (!member || !roleAtLeast(member.role as Role, Role.DEVELOPER))
      throw new NotFoundError('Patch application');
  }
  private async proposal(db: PrismaTransactionClient, org: string, id: string, lock = false) {
    if (lock)
      await db.$queryRaw`SELECT id FROM "PatchProposal" WHERE id=${id} AND "organizationId"=${org} FOR UPDATE`;
    const proposal = await db.patchProposal.findFirst({
      where: { id, organizationId: org },
      include: { files: true },
    });
    if (!proposal) throw new NotFoundError('Patch application');
    const turn = await db.collaborationTurn.findFirst({
      where: {
        id: proposal.turnId,
        organizationId: org,
        conversationId: proposal.conversationId,
        pullRequestId: proposal.pullRequestId,
      },
    });
    const pr = await db.pullRequest.findFirst({
      where: {
        id: proposal.pullRequestId,
        organizationId: org,
        repositoryId: proposal.repositoryId,
        repository: { organizationId: org },
      },
      include: { repository: true },
    });
    if (!turn || !pr || turn.headSha !== proposal.headSha || turn.baseSha !== proposal.baseSha)
      throw new NotFoundError('Patch application');
    return { proposal, pr };
  }
  private async evidence(db: PrismaTransactionClient, p: Proposal) {
    const ids = [...new Set(p.files.flatMap((f) => f.evidenceIds))].sort();
    const linked = await db.patchProposalEvidence.findMany({
      where: { proposalId: p.id, organizationId: p.organizationId, turnId: p.turnId },
    });
    if (JSON.stringify(linked.map((e) => e.evidenceId).sort()) !== JSON.stringify(ids))
      throw new Error('EVIDENCE_REJECTED');
    const count = await db.evidenceReference.count({
      where: {
        id: { in: ids },
        organizationId: p.organizationId,
        turnId: p.turnId,
        sourceType: { in: [...COLLABORATION_EVIDENCE_TYPES] },
        toolCall: {
          organizationId: p.organizationId,
          repositoryId: p.repositoryId,
          pullRequestId: p.pullRequestId,
          status: { in: ['SUCCESS', 'PARTIAL', 'LIMITED'] },
        },
      },
    });
    if (count !== ids.length) throw new Error('EVIDENCE_REJECTED');
  }
  private eligible(
    p: Proposal,
    a: { proposalRevision: number; proposalDigest: string; headSha: string; baseSha: string },
  ) {
    if (
      p.status !== 'ACCEPTED' ||
      p.revision !== a.proposalRevision ||
      p.digest !== a.proposalDigest ||
      p.headSha !== a.headSha ||
      p.baseSha !== a.baseSha
    )
      throw new ConflictError('Proposal is no longer eligible for isolated application.');
  }

  async request(actor: ConversationActor, id: string, raw: PatchApplicationRequest) {
    const input = PatchApplicationRequestSchema.parse(raw);
    const hash = patchHash(
      JSON.stringify({
        proposalId: id,
        revision: input.expectedProposalRevision,
        digest: input.expectedProposalDigest,
      }),
    );
    const row = await this.prisma.$transaction(async (db) => {
      // Actor-scoped request serialization, independent of caller-provided proposal identity.
      const key = JSON.stringify([actor.organizationId, actor.userId, input.requestId]);
      await db.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key},0))) AS request_lock`;
      const { proposal } = await this.proposal(db, actor.organizationId, id, true);
      await this.membership(db, actor, true);
      const existing = await db.patchApplication.findFirst({
        where: {
          organizationId: actor.organizationId,
          requestedById: actor.userId,
          requestId: input.requestId,
        },
        include: INCLUDE,
      });
      if (existing) {
        if (existing.requestHash !== hash)
          throw new ConflictError('Application request was reused with different content.');
        return existing;
      }
      if (!this.config.executorImage)
        throw new UpstreamUnavailableError(
          'sandbox',
          'Restricted executor deployment is not configured.',
        );
      this.eligible(proposal, {
        proposalRevision: input.expectedProposalRevision,
        proposalDigest: input.expectedProposalDigest,
        headSha: proposal.headSha,
        baseSha: proposal.baseSha,
      });
      await this.evidence(db, proposal);
      const prior = await db.patchApplication.findFirst({
        where: {
          proposalId: id,
          organizationId: actor.organizationId,
          OR: [{ status: { in: ACTIVE } }, { cleanup: 'UNCERTAIN' }],
        },
      });
      if (prior) throw new ConflictError('An application is active or cleanup remains uncertain.');
      const now = new Date(),
        appId = randomUUID(),
        attemptId = randomUUID();
      const deadlineAt = new Date(now.getTime() + PATCH_APPLICATION_DEADLINE_MS);
      const result = await db.patchApplication.create({
        data: {
          id: appId,
          organizationId: actor.organizationId,
          proposalId: id,
          turnId: proposal.turnId,
          repositoryId: proposal.repositoryId,
          pullRequestId: proposal.pullRequestId,
          conversationId: proposal.conversationId,
          requestedById: actor.userId,
          requestId: input.requestId,
          requestHash: hash,
          proposalRevision: proposal.revision,
          proposalDigest: proposal.digest,
          headSha: proposal.headSha,
          baseSha: proposal.baseSha,
          executorImage: this.config.executorImage,
          policyVersion: BROKER_POLICY_VERSION,
          traceId: actor.traceId?.slice(0, 100),
          createdAt: now,
          deadlineAt,
          attempts: {
            create: {
              id: attemptId,
              generation: 1,
              jobId: `patch-application-${appId}-1`,
              brokerNonce: randomUUID(),
              createdAt: now,
              deadlineAt,
            },
          },
        },
        include: INCLUDE,
      });
      await this.audit(db, result, 'requested', actor.userId);
      return result;
    });
    if (row.status === 'QUEUED') {
      // Database commit precedes Redis. A failed enqueue is recovered by the worker reconciler.
      await this.enqueue(row).catch(() => undefined);
    }
    return this.get(actor, row.id);
  }
  private enqueue(row: Application) {
    const attempt = row.attempts.at(-1)!;
    return this.queue.enqueue(attempt.jobId, {
      organizationId: row.organizationId,
      applicationId: row.id,
      attemptId: attempt.id,
    });
  }
  private async locked(db: PrismaTransactionClient, data: PatchApplicationJob) {
    const initial = await db.patchApplication.findFirst({
      where: { id: data.applicationId, organizationId: data.organizationId },
    });
    if (!initial) throw new NotFoundError('Patch application');
    await db.$queryRaw`SELECT id FROM "PatchProposal" WHERE id=${initial.proposalId} AND "organizationId"=${data.organizationId} FOR UPDATE`;
    const proposal = await db.patchProposal.findFirstOrThrow({
      where: { id: initial.proposalId, organizationId: data.organizationId },
      include: { files: true },
    });
    await db.$queryRaw`SELECT id FROM "PatchApplication" WHERE id=${initial.id} AND "organizationId"=${data.organizationId} FOR UPDATE`;
    const row = await db.patchApplication.findFirstOrThrow({
      where: { id: initial.id, organizationId: data.organizationId },
      include: INCLUDE,
    });
    const attempt = row.attempts.find((a) => a.id === data.attemptId);
    if (!attempt || attempt.generation !== row.attempts.at(-1)?.generation)
      throw new NotFoundError('Patch application attempt');
    return { row, attempt, proposal };
  }
  private async transition(
    db: PrismaTransactionClient,
    row: Application,
    attemptId: string,
    status: string,
    cleanup: string,
    category: string | null,
    actorId?: string,
    extra: Prisma.PatchApplicationAttemptUncheckedUpdateInput = {},
    actionRequestId?: string,
  ) {
    const terminal = !ACTIVE.includes(status),
      completedAt = terminal ? new Date() : null;
    await db.patchApplicationAttempt.update({
      where: { id: attemptId },
      data: { ...extra, status, cleanup, failureCategory: category, completedAt },
    });
    const changed = await db.patchApplication.update({
      where: { id: row.id },
      data: { status, cleanup, failureCategory: category, completedAt },
      include: INCLUDE,
    });
    await this.audit(db, changed, status.toLowerCase(), actorId, actionRequestId);
    return changed;
  }
  private audit(
    db: PrismaTransactionClient,
    row: Application,
    event: string,
    actorId?: string,
    actionRequestId?: string,
  ) {
    return db.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: 'collaboration.patch.application.' + event,
        resourceType: 'PatchApplication',
        resourceId: row.id,
        description:
          'Isolated patch application ' + event + '; no repository changes or code validation',
        traceId: row.traceId,
        metadata: {
          applicationId: row.id,
          proposalId: row.proposalId,
          conversationId: row.conversationId,
          turnId: row.turnId,
          proposalRevision: row.proposalRevision,
          proposalDigest: row.proposalDigest,
          status: row.status,
          headSha: row.headSha,
          requestId: row.requestId,
          actionRequestId: actionRequestId ?? row.requestId,
          executorImage: row.executorImage,
          policyVersion: row.policyVersion,
          cleanup: row.cleanup,
          failureCategory: row.failureCategory,
          generation: row.attempts.at(-1)?.generation ?? 1,
          brokerNonce: row.attempts.at(-1)?.brokerNonce ?? null,
          resultDigest: row.attempts.at(-1)?.manifestDigest ?? null,
          fileCount: row.attempts.at(-1)?.files.length ?? 0,
        },
      },
    });
  }

  async execute(data: PatchApplicationJob) {
    const claimed = await this.prisma.$transaction(async (db) => {
      const { row, attempt, proposal } = await this.locked(db, data);
      if (row.status !== 'QUEUED' || attempt.status !== 'QUEUED') return null;
      try {
        if (row.deadlineAt.getTime() <= Date.now()) throw new Error('DEADLINE');
        await this.membership(
          db,
          { organizationId: row.organizationId, userId: row.requestedById },
          true,
        );
        this.eligible(proposal, row);
        await this.proposal(db, row.organizationId, row.proposalId);
        await this.evidence(db, proposal);
      } catch {
        await this.transition(db, row, attempt.id, 'FAILED', 'NOT_STARTED', 'PRELAUNCH_REJECTED');
        return null;
      }
      const fence = randomUUID();
      await this.transition(db, row, attempt.id, 'PREPARING', 'NOT_STARTED', null, undefined, {
        fence,
        startedAt: new Date(),
      });
      return { row, attempt, proposal, fence };
    });
    if (!claimed) return;
    const abort = new AbortController();
    let stopped = false;
    const deadline = setTimeout(
      () => abort.abort(),
      Math.max(1, claimed.row.deadlineAt.getTime() - Date.now()),
    );
    const monitor = async () => {
      while (!stopped && !abort.signal.aborted) {
        await new Promise((r) => setTimeout(r, 250));
        if (stopped) break;
        try {
          const row = await applicationRead(
            this.prisma.unscoped.patchApplication.findFirst({
              where: { id: data.applicationId, organizationId: data.organizationId },
            }),
            abort.signal,
          );
          const p = await applicationRead(
            this.prisma.unscoped.patchProposal.findFirst({
              where: { id: claimed.row.proposalId, organizationId: data.organizationId },
            }),
            abort.signal,
          );
          await applicationRead(
            this.membership(this.prisma.unscoped, {
              organizationId: data.organizationId,
              userId: claimed.row.requestedById,
            }),
            abort.signal,
          );
          if (!row || !p || !ACTIVE.includes(row.status) || row.deadlineAt.getTime() <= Date.now())
            abort.abort();
          else this.eligible(p as Proposal, row);
        } catch {
          abort.abort();
        }
      }
    };
    const watching = monitor();
    try {
      const client = await applicationRead(
        this.github.forUser(claimed.row.requestedById),
        abort.signal,
      );
      const scope = await applicationRead(
        this.proposal(this.prisma.unscoped, data.organizationId, claimed.row.proposalId),
        abort.signal,
      );
      const snapshot = await client.materializeExactSnapshot(
        scope.pr.repository.fullName,
        claimed.row.headSha,
        abort.signal,
      );
      abort.signal.throwIfAborted();
      const { payload, expected } = reconstructApplication(snapshot, claimed.proposal);
      const key = await applicationRead(readFile('/run/secrets/broker-key'), abort.signal);
      if (key.length !== 32) throw new Error('BROKER_KEY_REQUIRED');
      const launch = await this.prisma.$transaction(async (db) => {
        const { row, attempt, proposal } = await this.locked(db, data);
        if (
          row.status !== 'PREPARING' ||
          attempt.fence !== claimed.fence ||
          row.deadlineAt.getTime() <= Date.now()
        )
          return false;
        await this.membership(
          db,
          { organizationId: row.organizationId, userId: row.requestedById },
          true,
        );
        this.eligible(proposal, row);
        await this.proposal(db, row.organizationId, row.proposalId);
        await this.evidence(db, proposal);
        if (row.executorImage !== this.config.executorImage) throw new Error('DEPLOYMENT_CHANGED');
        await this.transition(db, row, attempt.id, 'APPLYING', 'UNCERTAIN', null, undefined, {
          snapshotDigest: snapshot.digest,
        });
        return true;
      });
      if (!launch) return;
      abort.signal.throwIfAborted();
      const proof = await requestMaterializationProof(
        '/control/broker.sock',
        key,
        payload,
        abort.signal,
        claimed.row.deadlineAt.getTime(),
        claimed.attempt.brokerNonce,
      );
      if (
        !proof.deployment ||
        proof.deployment.executorImage !== claimed.row.executorImage ||
        proof.deployment.policyVersion !== claimed.row.policyVersion
      )
        throw new Error('DEPLOYMENT_REJECTED');
      if (proof.result.status !== 'MATERIALIZED') throw new Error('BROKER_REJECTED');
      const manifest = verifyApplicationManifest(expected, proof.result.result);
      await this.prisma.$transaction(async (db) => {
        const { row, attempt, proposal } = await this.locked(db, data);
        if (row.status !== 'APPLYING' || attempt.fence !== claimed.fence) return;
        // A late signed result is never allowed to revive a cancelled/expired/ineligible application.
        if (row.deadlineAt.getTime() <= Date.now() || abort.signal.aborted) {
          await this.transition(db, row, attempt.id, 'FAILED', 'DISPOSED', 'DEADLINE_OR_CANCELLED');
          return;
        }
        try {
          await this.membership(
            db,
            { organizationId: row.organizationId, userId: row.requestedById },
            true,
          );
          this.eligible(proposal, row);
          await this.proposal(db, row.organizationId, row.proposalId);
          await this.evidence(db, proposal);
        } catch {
          await this.transition(db, row, attempt.id, 'FAILED', 'DISPOSED', 'FINALIZATION_REJECTED');
          return;
        }
        await db.patchApplicationFileResult.createMany({
          data: manifest.files.map((f) => {
            const old = snapshot.files.find((source) => source.path === f.path)!;
            return {
              ...f,
              applicationId: row.id,
              attemptId: attempt.id,
              organizationId: row.organizationId,
              oldBlobSha: old.blobSha,
              oldContentHash: old.contentHash,
            };
          }),
        });
        await this.transition(db, row, attempt.id, 'APPLIED', 'DISPOSED', null, undefined, {
          snapshotDigest: snapshot.digest,
          manifestDigest: manifest.digest,
        });
      });
    } catch {
      await this.prisma.$transaction(async (db) => {
        const { row, attempt } = await this.locked(db, data);
        if (!ACTIVE.includes(row.status) || attempt.fence !== claimed.fence) return;
        await this.transition(
          db,
          row,
          attempt.id,
          'FAILED',
          row.cleanup,
          row.deadlineAt.getTime() <= Date.now()
            ? 'DEADLINE'
            : row.status === 'APPLYING'
              ? 'BROKER_OR_RESULT_REJECTED'
              : 'PREPARATION_REJECTED',
        );
      });
    } finally {
      stopped = true;
      clearTimeout(deadline);
      abort.abort();
      await watching;
    }
  }

  async reconcile() {
    const rows = await this.prisma.unscoped.patchApplication.findMany({
      where: { status: { in: ACTIVE } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: INCLUDE,
    });
    for (const candidate of rows) {
      const data = {
        organizationId: candidate.organizationId,
        applicationId: candidate.id,
        attemptId: candidate.attempts.at(-1)!.id,
      };
      if (candidate.deadlineAt.getTime() <= Date.now()) {
        await this.prisma.$transaction(async (db) => {
          const { row, attempt } = await this.locked(db, data);
          if (!ACTIVE.includes(row.status) || row.deadlineAt.getTime() > Date.now()) return;
          await this.transition(db, row, attempt.id, 'FAILED', row.cleanup, 'DEADLINE');
        });
      } else if (candidate.status === 'QUEUED')
        await this.enqueue(candidate).catch(() => undefined);
    }
  }
  async get(actor: ConversationActor, id: string): Promise<PatchApplicationView> {
    await this.membership(this.prisma.unscoped, actor);
    const row = await this.prisma.unscoped.patchApplication.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Patch application');
    const { pr } = await this.proposal(this.prisma.unscoped, actor.organizationId, row.proposalId);
    return this.view(row, pr.headSha);
  }
  async list(actor: ConversationActor, id: string, query: { afterId?: string; limit: number }) {
    await this.membership(this.prisma.unscoped, actor);
    const { pr } = await this.proposal(this.prisma.unscoped, actor.organizationId, id);
    if (
      query.afterId &&
      !(await this.prisma.unscoped.patchApplication.findFirst({
        where: { id: query.afterId, proposalId: id, organizationId: actor.organizationId },
      }))
    )
      throw new NotFoundError('Patch application');
    const rows = await this.prisma.unscoped.patchApplication.findMany({
      where: {
        proposalId: id,
        organizationId: actor.organizationId,
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      include: INCLUDE,
    });
    return {
      items: rows.slice(0, query.limit).map((r) => this.view(r, pr.headSha)),
      nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  }
  async cancel(actor: ConversationActor, id: string, requestId: string) {
    await this.get(actor, id);
    await this.prisma.$transaction(async (db) => {
      const current = await db.patchApplication.findFirstOrThrow({
        where: { id, organizationId: actor.organizationId },
        include: INCLUDE,
      });
      const { row, attempt } = await this.locked(db, {
        organizationId: actor.organizationId,
        applicationId: id,
        attemptId: current.attempts.at(-1)!.id,
      });
      await this.membership(db, actor, true);
      if (row.status === 'CANCELLED') return;
      if (!ACTIVE.includes(row.status)) throw new ConflictError('Application is already terminal.');
      await this.transition(
        db,
        row,
        attempt.id,
        'CANCELLED',
        row.cleanup,
        null,
        actor.userId,
        {},
        requestId,
      );
    });
    // Repeated authorized cancellation returns the same terminal state without another audit transition.
    return this.get(actor, id);
  }
  private view(row: Application, currentHead: string): PatchApplicationView {
    return {
      limitations: PATCH_APPLICATION_LIMITATIONS,
      id: row.id,
      proposalId: row.proposalId,
      proposalRevision: row.proposalRevision,
      proposalDigest: row.proposalDigest,
      headSha: row.headSha,
      baseSha: row.baseSha,
      requestedById: row.requestedById,
      status: PatchApplicationStatusSchema.parse(row.status),
      cleanup: PatchApplicationCleanupSchema.parse(row.cleanup),
      failureCategory: row.failureCategory,
      executorImage: row.executorImage,
      policyVersion: row.policyVersion,
      stale: row.headSha !== currentHead,
      createdAt: row.createdAt.toISOString(),
      deadlineAt: row.deadlineAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      attempts: row.attempts.map((a) => ({
        generation: a.generation,
        status: PatchApplicationStatusSchema.parse(a.status),
        cleanup: PatchApplicationCleanupSchema.parse(a.cleanup),
        failureCategory: a.failureCategory,
        jobId: a.jobId,
        startedAt: a.startedAt?.toISOString() ?? null,
        completedAt: a.completedAt?.toISOString() ?? null,
        snapshotDigest: a.snapshotDigest,
        manifestDigest: a.manifestDigest,
        files: a.files.map(({ path, oldBlobSha, oldContentHash, contentHash, byteLength }) => ({
          path,
          oldBlobSha,
          oldContentHash,
          contentHash,
          byteLength,
        })),
      })),
    };
  }
}
