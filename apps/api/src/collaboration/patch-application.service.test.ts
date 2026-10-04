import { randomUUID, createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { canonicalPatch, constructPatchFile, patchHash } from '@codelens/patch-core';
import { snapshotDigest } from '@codelens/github/dist/exact-git-snapshot';
import { reconstructApplication } from './patch-application-content';
import { PatchApplicationService } from './patch-application.service';

const broker = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@codelens/sandbox-broker/dist/client', () => ({
  requestMaterializationProof: broker.request,
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => Buffer.alloc(32, 7)) }));

const actor = { organizationId: 'org', userId: 'human', traceId: 'trace' };
function fixture() {
  const content = 'old\n',
    blob = createHash('sha1').update('blob 4\0old\n').digest('hex');
  const intent = {
    summary: 'Proposed',
    rationale: 'Observation',
    limitations: 'Not validated',
    files: [
      {
        operation: 'MODIFY' as const,
        path: 'a.ts',
        expectedBlobSha: blob,
        evidenceIds: ['e1'],
        edits: [{ startLine: 1, endLine: 1, expectedText: 'old', replacement: 'new' }],
      },
    ],
  };
  const file = constructPatchFile(intent.files[0]!, {
    revision: 'a'.repeat(40),
    path: 'a.ts',
    objectSha: blob,
    mode: '100644',
    kind: 'REGULAR_FILE',
    content,
    contentHash: patchHash(content),
    components: [],
    modificationEligible: true,
  });
  const canonical = canonicalPatch({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, intent, [
    file,
  ]);
  const rawSnapshot = {
    version: 1 as const,
    repository: 'owner/repo',
    revision: 'a'.repeat(40),
    files: [
      { path: 'a.ts', blobSha: blob, content, contentHash: patchHash(content), byteLength: 4 },
    ],
  };
  const snapshot = { ...rawSnapshot, digest: snapshotDigest(rawSnapshot) };
  const p = {
    id: 'proposal',
    organizationId: 'org',
    status: 'ACCEPTED',
    revision: 1,
    digest: canonical.digest,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    turnId: 'turn',
    conversationId: 'conversation',
    repositoryId: 'repo',
    pullRequestId: 'pr',
    summary: intent.summary,
    rationale: intent.rationale,
    limitations: intent.limitations,
    files: [file],
  };
  const applications: any[] = [],
    audit: any[] = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    membership: { findFirst: vi.fn(async () => ({ role: 'DEVELOPER' })) },
    patchProposal: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === 'org' && where.id === p.id ? p : null,
      ),
      findFirstOrThrow: vi.fn(async () => structuredClone(p)),
    },
    collaborationTurn: { findFirst: vi.fn(async () => ({ ...p, id: 'turn' })) },
    pullRequest: {
      findFirst: vi.fn(async () => ({
        id: 'pr',
        headSha: p.headSha,
        repository: { fullName: 'owner/repo' },
      })),
    },
    patchProposalEvidence: { findMany: vi.fn(async () => [{ evidenceId: 'e1' }]) },
    evidenceReference: { count: vi.fn(async () => 1) },
    patchApplication: {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(
          applications.find(
            (a) =>
              (!where.id || a.id === where.id) &&
              (!where.proposalId || a.proposalId === where.proposalId) &&
              a.organizationId === where.organizationId &&
              (!where.requestId || a.requestId === where.requestId) &&
              (!where.requestedById || a.requestedById === where.requestedById) &&
              (!where.OR ||
                ['QUEUED', 'PREPARING', 'APPLYING'].includes(a.status) ||
                a.cleanup === 'UNCERTAIN'),
          ) ?? null,
        ),
      ),
      create: vi.fn(async ({ data }: any) => {
        const { attempts, ...fields } = data;
        const row = {
          ...fields,
          status: 'QUEUED',
          cleanup: 'NOT_STARTED',
          failureCategory: null,
          completedAt: null,
          attempts: [
            {
              ...attempts.create,
              status: 'QUEUED',
              cleanup: 'NOT_STARTED',
              failureCategory: null,
              startedAt: null,
              completedAt: null,
              snapshotDigest: null,
              manifestDigest: null,
              files: [],
            },
          ],
        };
        applications.push(row);
        return structuredClone(row);
      }),
      findMany: vi.fn(async () => applications),
      findFirstOrThrow: vi.fn(async ({ where }: any) =>
        structuredClone(applications.find((a) => a.id === where.id)),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = applications.find((a) => a.id === where.id);
        Object.assign(row, data);
        return structuredClone(row);
      }),
    },
    patchApplicationAttempt: {
      update: vi.fn(async ({ where, data }: any) => {
        const a = applications.flatMap((r) => r.attempts).find((a) => a.id === where.id);
        Object.assign(a, data);
        return structuredClone(a);
      }),
    },
    patchApplicationFileResult: {
      createMany: vi.fn(async ({ data }: any) => {
        for (const f of data)
          applications
            .flatMap((r) => r.attempts)
            .find((a) => a.id === f.attemptId)
            .files.push(f);
        return { count: data.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return data;
      }),
    },
  };
  let serial = Promise.resolve();
  const prisma = {
    unscoped: db,
    $transaction: (fn: any) => {
      const result = serial.then(() => fn(db));
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const queue = { enqueue: vi.fn(async () => undefined) };
  const config = { executorImage: 'sha256:' + 'd'.repeat(64) };
  const github = {
    forUser: vi.fn(async () => ({ materializeExactSnapshot: vi.fn(async () => snapshot) })),
  };
  broker.request.mockReset().mockResolvedValue({
    deployment: {
      executorImage: config.executorImage,
      policyVersion: 'restricted-materialization-v1',
    },
    result: {
      version: 1,
      status: 'MATERIALIZED',
      result: reconstructApplication(snapshot, p).expected,
    },
  });
  const service = new PatchApplicationService(
    prisma as never,
    github as never,
    config as never,
    queue as never,
  );
  const input = {
    requestId: randomUUID(),
    expectedProposalRevision: 1,
    expectedProposalDigest: p.digest,
  };
  return { service, input, p, db, queue, applications, audit, config, github, snapshot };
}
it('reserves canonical identity before enqueue and returns bounded metadata', async () => {
  const f = fixture(),
    result = await f.service.request(actor, f.p.id, f.input);
  expect(result.status).toBe('QUEUED');
  expect(result.deadlineAt).toBe(
    new Date(new Date(result.createdAt).getTime() + 150000).toISOString(),
  );
  expect(f.queue.enqueue.mock.calls[0]?.[1]).toEqual({
    organizationId: 'org',
    applicationId: result.id,
    attemptId: f.applications[0].attempts[0].id,
  });
  expect(f.audit[0].metadata.proposalDigest).toBe(f.p.digest);
  expect(JSON.stringify(f.audit[0].metadata)).not.toMatch(
    /"(?:replacement|expectedText|source|command|environment)":/,
  );
});
it('identical replay and concurrent actor-scoped requests share one logical identity', async () => {
  const f = fixture(),
    results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.request(actor, f.p.id, f.input)),
    );
  expect(new Set(results.map((r) => r.id)).size).toBe(1);
  expect(f.applications).toHaveLength(1);
});
it('conflicting request reuse is rejected without changing identity or deadline', async () => {
  const f = fixture(),
    first = await f.service.request(actor, f.p.id, f.input);
  await expect(
    f.service.request(actor, f.p.id, { ...f.input, expectedProposalDigest: 'e'.repeat(64) }),
  ).rejects.toThrow('reused');
  expect((await f.service.get(actor, first.id)).deadlineAt).toBe(first.deadlineAt);
});
it.each(['PROPOSED', 'REJECTED', 'SUPERSEDED'])(
  'rejects %s before reserving/enqueueing',
  async (status) => {
    const f = fixture();
    f.p.status = status;
    await expect(f.service.request(actor, f.p.id, f.input)).rejects.toThrow('eligible');
    expect(f.applications).toHaveLength(0);
    expect(f.queue.enqueue).not.toHaveBeenCalled();
  },
);
it.each(['revision', 'digest'] as const)('rejects mismatched expected %s', async (field) => {
  const f = fixture();
  const input = {
    ...f.input,
    ...(field === 'revision'
      ? { expectedProposalRevision: 2 }
      : { expectedProposalDigest: 'e'.repeat(64) }),
  };
  await expect(f.service.request(actor, f.p.id, input)).rejects.toThrow('eligible');
  expect(f.applications).toHaveLength(0);
});
it('foreign proposals and current membership removal/low privilege are scoped 404', async () => {
  const f = fixture();
  await expect(
    f.service.request({ ...actor, organizationId: 'foreign' }, f.p.id, f.input),
  ).rejects.toThrow('not found');
  f.db.membership.findFirst.mockResolvedValue({ role: 'VIEWER' });
  await expect(f.service.request(actor, f.p.id, f.input)).rejects.toThrow('not found');
  expect(f.applications).toHaveLength(0);
});
it('missing pins or unusable/foreign evidence fail before enqueue', async () => {
  const f = fixture();
  f.db.collaborationTurn.findFirst.mockResolvedValue({
    ...f.p,
    baseSha: null,
    id: 'turn',
  } as never);
  await expect(f.service.request(actor, f.p.id, f.input)).rejects.toThrow('not found');
  const g = fixture();
  g.db.evidenceReference.count.mockResolvedValue(0);
  await expect(g.service.request(actor, g.p.id, g.input)).rejects.toThrow('EVIDENCE');
  expect(g.queue.enqueue).not.toHaveBeenCalled();
});
it('retains a database reservation across an enqueue gap and reconciles the same job', async () => {
  const f = fixture();
  f.queue.enqueue.mockRejectedValueOnce(new Error('Redis unavailable'));
  const first = await f.service.request(actor, f.p.id, f.input);
  await f.service.reconcile();
  expect(f.applications).toHaveLength(1);
  expect(f.queue.enqueue.mock.calls[0]).toEqual(f.queue.enqueue.mock.calls[1]);
  expect((await f.service.get(actor, first.id)).status).toBe('QUEUED');
});
it('rejects a different request while a proposal already has active or uncertain application', async () => {
  const f = fixture();
  await f.service.request(actor, f.p.id, f.input);
  await expect(
    f.service.request(actor, f.p.id, { ...f.input, requestId: randomUUID() }),
  ).rejects.toThrow('active');
  f.applications[0].status = 'FAILED';
  f.applications[0].cleanup = 'UNCERTAIN';
  await expect(
    f.service.request(actor, f.p.id, { ...f.input, requestId: randomUUID() }),
  ).rejects.toThrow('uncertain');
});
it('reports current-head staleness without altering exact historical pins', async () => {
  const f = fixture(),
    first = await f.service.request(actor, f.p.id, f.input);
  f.db.pullRequest.findFirst.mockResolvedValue({
    id: 'pr',
    headSha: 'e'.repeat(40),
    repository: { fullName: 'owner/repo' },
  });
  expect(await f.service.get(actor, first.id)).toMatchObject({
    stale: true,
    headSha: 'a'.repeat(40),
  });
});
it('missing deployment is unavailable, not a test fallback', async () => {
  const f = fixture();
  f.config.executorImage = '';
  await expect(f.service.request(actor, f.p.id, f.input)).rejects.toThrow('not configured');
  expect(f.applications).toHaveLength(0);
});

async function queued(f: ReturnType<typeof fixture>) {
  const row = await f.service.request(actor, f.p.id, f.input);
  return {
    organizationId: actor.organizationId,
    applicationId: row.id,
    attemptId: f.applications[0].attempts[0].id,
  };
}
it('claims one duplicate delivery and finalizes only authenticated expected hashes and disposal', async () => {
  const f = fixture(),
    job = await queued(f);
  await Promise.all([f.service.execute(job), f.service.execute(job)]);
  expect(broker.request).toHaveBeenCalledTimes(1);
  expect(f.applications[0]).toMatchObject({ status: 'APPLIED', cleanup: 'DISPOSED' });
  expect(f.applications[0].attempts[0].files).toHaveLength(1);
  const before = JSON.stringify(f.applications[0]);
  await f.service.execute(job);
  expect(JSON.stringify(f.applications[0])).toBe(before);
  expect(f.audit.map((a) => a.metadata.status)).toEqual([
    'QUEUED',
    'PREPARING',
    'APPLYING',
    'APPLIED',
  ]);
});
it.each(['PROPOSED', 'REJECTED', 'SUPERSEDED'])(
  'proposal becomes %s before launch: no broker execution',
  async (status) => {
    const f = fixture(),
      job = await queued(f);
    f.github.forUser.mockResolvedValue({
      materializeExactSnapshot: vi.fn(async () => {
        f.p.status = status;
        return f.snapshot;
      }),
    });
    await f.service.execute(job);
    expect(broker.request).not.toHaveBeenCalled();
    expect(f.applications[0]).toMatchObject({ status: 'FAILED', cleanup: 'NOT_STARTED' });
  },
);
it('supersession before finalization cannot mark a cleaned materialization APPLIED', async () => {
  const f = fixture(),
    job = await queued(f),
    proof = await broker.request();
  broker.request.mockClear();
  broker.request.mockImplementation(async () => {
    f.p.status = 'SUPERSEDED';
    return proof;
  });
  await f.service.execute(job);
  expect(f.applications[0]).toMatchObject({
    status: 'FAILED',
    cleanup: 'DISPOSED',
    failureCategory: 'FINALIZATION_REJECTED',
  });
  expect(f.db.patchApplicationFileResult.createMany).not.toHaveBeenCalled();
});
it('membership revocation before finalization fails closed and persists no result files', async () => {
  const f = fixture(),
    job = await queued(f),
    proof = await broker.request();
  broker.request.mockClear();
  broker.request.mockImplementation(async () => {
    f.db.membership.findFirst.mockResolvedValue({ role: 'VIEWER' });
    return proof;
  });
  await f.service.execute(job);
  expect(f.applications[0]).toMatchObject({ status: 'FAILED', cleanup: 'DISPOSED' });
  expect(f.db.patchApplicationFileResult.createMany).not.toHaveBeenCalled();
});
it('cancellation before claim never obtains snapshot or broker authority', async () => {
  const f = fixture(),
    job = await queued(f);
  await f.service.cancel(actor, job.applicationId, randomUUID());
  await f.service.execute(job);
  expect(f.applications[0]).toMatchObject({ status: 'CANCELLED', cleanup: 'NOT_STARTED' });
  expect(f.github.forUser).not.toHaveBeenCalled();
  expect(broker.request).not.toHaveBeenCalled();
});
it('cancellation wins against late authenticated completion without revival or replacement attempt', async () => {
  const f = fixture(),
    job = await queued(f),
    proof = await broker.request();
  broker.request.mockClear();
  broker.request.mockImplementation(async () => {
    await f.service.cancel(actor, job.applicationId, randomUUID());
    return proof;
  });
  await f.service.execute(job);
  expect(f.applications[0]).toMatchObject({ status: 'CANCELLED', cleanup: 'UNCERTAIN' });
  expect(f.applications[0].attempts).toHaveLength(1);
  expect(f.db.patchApplicationFileResult.createMany).not.toHaveBeenCalled();
});
it.each(['snapshotDigest', 'proposalDigest', 'digest', 'files'] as const)(
  'untrusted result %s mismatch cannot finalize',
  async (field) => {
    const f = fixture(),
      job = await queued(f),
      proof = await broker.request();
    broker.request.mockClear();
    proof.result.result[field] = field === 'files' ? [] : 'e'.repeat(64);
    broker.request.mockResolvedValue(proof);
    await f.service.execute(job);
    expect(f.applications[0]).toMatchObject({ status: 'FAILED', cleanup: 'UNCERTAIN' });
    expect(f.db.patchApplicationFileResult.createMany).not.toHaveBeenCalled();
  },
);
it.each(['missing', 'wrong-image', 'wrong-policy'])(
  'deployment attestation %s is rejected',
  async (kind) => {
    const f = fixture(),
      job = await queued(f),
      proof = await broker.request();
    broker.request.mockClear();
    if (kind === 'missing') delete proof.deployment;
    else if (kind === 'wrong-image') proof.deployment.executorImage = 'sha256:' + 'e'.repeat(64);
    else proof.deployment.policyVersion = 'other';
    broker.request.mockResolvedValue(proof);
    await f.service.execute(job);
    expect(f.applications[0].status).toBe('FAILED');
    expect(f.db.patchApplicationFileResult.createMany).not.toHaveBeenCalled();
  },
);
it('broker authentication/cleanup uncertainty never retries or leaks its raw diagnostic', async () => {
  const f = fixture(),
    job = await queued(f);
  broker.request.mockRejectedValue(new Error('private-marker-never-audit'));
  await f.service.execute(job);
  await f.service.execute(job);
  expect(broker.request).toHaveBeenCalledTimes(1);
  expect(f.applications[0]).toMatchObject({ status: 'FAILED', cleanup: 'UNCERTAIN' });
  expect(JSON.stringify(f.audit)).not.toContain('private-marker-never-audit');
});
it('expired orphan is fenced without resetting deadline or launching a replacement attempt', async () => {
  const f = fixture(),
    job = await queued(f);
  const row = f.applications[0];
  row.status = row.attempts[0].status = 'PREPARING';
  row.deadlineAt = row.attempts[0].deadlineAt = new Date(Date.now() - 1000);
  const before = row.deadlineAt.toISOString();
  await f.service.reconcile();
  await f.service.execute(job);
  expect(row).toMatchObject({
    status: 'FAILED',
    failureCategory: 'DEADLINE',
    cleanup: 'NOT_STARTED',
  });
  expect(row.deadlineAt.toISOString()).toBe(before);
  expect(row.attempts).toHaveLength(1);
  expect(broker.request).not.toHaveBeenCalled();
});
