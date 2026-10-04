import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canonicalPatch,
  constructPatchFile,
  materializeCandidate,
  patchHash,
} from '@codelens/patch-core';
import { snapshotDigest } from '@codelens/github/dist/exact-git-snapshot';
import { validateInput } from '@codelens/validation-executor';
import { ValidationService } from './validation.service';
import { reconstructApplication } from './patch-application-content';

const broker = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@codelens/validation-broker/dist/client', () => ({ requestValidation: broker.request }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => Buffer.alloc(32, 7)) }));
const actor = { organizationId: 'org', userId: 'user' };
afterEach(() => {
  vi.unstubAllEnvs();
  broker.request.mockReset();
});
function fixture() {
  vi.stubEnv('CODELENS_VALIDATION_IMAGE', 'sha256:' + 'a'.repeat(64));
  vi.stubEnv('CODELENS_VALIDATION_BUNDLE_DIGEST', 'b'.repeat(64));
  vi.stubEnv('CODELENS_VALIDATION_CONFIGURATION_DIGEST', 'c'.repeat(64));
  const content = 'export const a = 1;\n',
    head = 'a'.repeat(40),
    base = 'b'.repeat(40);
  const blob = (s: string) =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(s)}\0`)
      .update(s)
      .digest('hex');
  const source = {
    path: 'src/a.ts',
    content,
    blobSha: blob(content),
    contentHash: patchHash(content),
    byteLength: Buffer.byteLength(content),
  };
  const raw = {
    version: 1 as const,
    repository: 'owner/repo',
    revision: head,
    files: [
      {
        path: 'package.json',
        content: '{}',
        blobSha: blob('{}'),
        contentHash: patchHash('{}'),
        byteLength: 2,
      },
      source,
    ],
  };
  const snapshot = { ...raw, digest: snapshotDigest(raw) };
  const intent = {
    summary: 'Proposed',
    rationale: 'Evidence',
    limitations: 'Not safe by assumption',
    files: [
      {
        path: source.path,
        operation: 'MODIFY' as const,
        expectedBlobSha: source.blobSha,
        evidenceIds: ['evidence'],
        edits: [
          {
            startLine: 1,
            endLine: 1,
            expectedText: 'export const a = 1;',
            replacement: 'export const a = 2;',
          },
        ],
      },
    ],
  };
  const file = constructPatchFile(intent.files[0]!, {
    revision: head,
    path: source.path,
    objectSha: source.blobSha,
    content,
    contentHash: source.contentHash,
    kind: 'REGULAR_FILE',
    mode: '100644',
    components: [],
    modificationEligible: true,
  });
  const digest = canonicalPatch({ headSha: head, baseSha: base }, intent, [file]).digest;
  const p = {
    id: 'proposal',
    organizationId: 'org',
    repositoryId: 'repo',
    pullRequestId: 'pr',
    conversationId: 'conversation',
    turnId: 'turn',
    status: 'ACCEPTED',
    revision: 1,
    digest,
    headSha: head,
    baseSha: base,
    ...intent,
    files: [file],
  };
  const manifest = materializeCandidate(reconstructApplication(snapshot, p).payload).result;
  const app = {
    id: 'app',
    organizationId: 'org',
    proposalId: p.id,
    repositoryId: 'repo',
    pullRequestId: 'pr',
    conversationId: 'conversation',
    turnId: 'turn',
    proposalRevision: 1,
    proposalDigest: digest,
    headSha: head,
    baseSha: base,
    status: 'APPLIED',
    cleanup: 'DISPOSED',
    proposal: p,
    attempts: [
      {
        id: 'application-attempt',
        status: 'APPLIED',
        cleanup: 'DISPOSED',
        snapshotDigest: snapshot.digest,
        manifestDigest: manifest.digest,
        files: manifest.files,
      },
    ],
  };
  const runs: any[] = [],
    audit: any[] = [];
  let role: string | null = 'DEVELOPER';
  const matches = (r: any, w: any) =>
    Object.entries(w).every(([k, v]: any) =>
      k === 'OR'
        ? v.some((part: any) => matches(r, part))
        : typeof v === 'object' && v !== null
          ? 'in' in v
            ? v.in.includes(r[k])
            : 'gt' in v
              ? r[k] > v.gt
              : true
          : r[k] === v,
    );
  const db = {
    $queryRaw: vi.fn(async () => []),
    membership: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === 'org' && role ? { role } : null,
      ),
    },
    patchApplication: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === 'app' && where.organizationId === 'org' ? structuredClone(app) : null,
      ),
    },
    pullRequest: {
      findFirst: vi.fn(async () => ({ headSha: head, repository: { fullName: 'owner/repo' } })),
    },
    collaborationTurn: { findFirst: vi.fn(async () => ({ headSha: head, baseSha: base })) },
    validationRun: {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(runs.find((r) => matches(r, where)) ?? null),
      ),
      findFirstOrThrow: vi.fn(async ({ where }: any) =>
        structuredClone(runs.find((r) => matches(r, where))),
      ),
      findMany: vi.fn(async ({ where, take }: any) =>
        structuredClone(runs.filter((r) => matches(r, where)).slice(0, take)),
      ),
      create: vi.fn(async ({ data }: any) => {
        const { attempts, ...rest } = data;
        const row = {
          ...rest,
          state: 'QUEUED',
          outcome: null,
          cleanup: 'NOT_STARTED',
          failureCategory: null,
          completedAt: null,
          attempts: [
            { ...attempts.create, fence: null, startedAt: null, completedAt: null, steps: [] },
          ],
        };
        runs.push(row);
        return structuredClone(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = runs.find((r) => r.id === where.id);
        Object.assign(r, data);
        return structuredClone(r);
      }),
    },
    validationAttempt: {
      update: vi.fn(async ({ where, data }: any) => {
        const a = runs.flatMap((r) => r.attempts).find((a) => a.id === where.id);
        Object.assign(a, data);
        return structuredClone(a);
      }),
    },
    validationStep: {
      create: vi.fn(async ({ data }: any) => {
        runs
          .flatMap((r) => r.attempts)
          .find((a) => a.id === data.attemptId)
          .steps.push(data);
        return data;
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
      const result = serial.then(async () => {
        const backup = structuredClone(runs),
          logs = structuredClone(audit);
        try {
          return await fn(db);
        } catch (e) {
          runs.splice(0, runs.length, ...backup);
          audit.splice(0, audit.length, ...logs);
          throw e;
        }
      });
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const snapshotRead = vi.fn(async () => structuredClone(snapshot));
  const queue = { enqueue: vi.fn(async () => {}) };
  const service = new ValidationService(
    prisma as never,
    { forUser: async () => ({ materializeExactSnapshot: snapshotRead }) } as never,
    queue as never,
    {
      get validationDeployment() {
        return {
          image: process.env.CODELENS_VALIDATION_IMAGE,
          bundleDigest: process.env.CODELENS_VALIDATION_BUNDLE_DIGEST,
          configurationDigest: process.env.CODELENS_VALIDATION_CONFIGURATION_DIGEST,
        };
      },
    } as never,
  );
  broker.request.mockImplementation(async (_socket, _key, input, nonce) => ({
    version: 1,
    profile: input.profile,
    profileVersion: 1,
    policyVersion: 'validation-local-v1',
    image: process.env.CODELENS_VALIDATION_IMAGE,
    bundleDigest: process.env.CODELENS_VALIDATION_BUNDLE_DIGEST,
    configurationDigest: process.env.CODELENS_VALIDATION_CONFIGURATION_DIGEST,
    correlation: nonce,
    inputDigest: validateInput(input).digest,
    status: 'VALIDATION_EXECUTED',
    observed: {
      started: true,
      exitCode: 0,
      termination: 'EXITED',
      oom: false,
      durationMs: 2,
      cleanup: 'DISPOSED',
      stdout: { digest: patchHash(''), capturedBytes: 0, excerpt: '', complete: true },
      stderr: { digest: patchHash(''), capturedBytes: 0, excerpt: '', complete: true },
    },
    runnerReported: {
      trusted: false,
      status: 'VALID',
      reportDigest: patchHash('report'),
      report: {
        version: 1,
        kind: input.profile === 'vitest-unit-v1' ? 'tests' : 'typecheck',
        passed: 1,
        failed: 0,
        total: 1,
      },
    },
  }));
  const create = () =>
    service.request(actor, 'app', {
      requestId: randomUUID(),
      profiles: ['typescript-typecheck-v1', 'vitest-unit-v1'],
    });
  const job = () => ({
    organizationId: 'org',
    validationId: runs[0].id,
    attemptId: runs[0].attempts[0].id,
  });
  return {
    service,
    app,
    p,
    snapshot,
    runs,
    audit,
    db,
    queue,
    create,
    job,
    snapshotRead,
    setRole: (r: string | null) => (role = r),
  };
}
it('eligible application creates one actor-scoped run under concurrent identical replay', async () => {
  const f = fixture(),
    input = { requestId: randomUUID(), profiles: ['typescript-typecheck-v1'] as const };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.service.request(actor, 'app', { ...input, profiles: [...input.profiles] }),
    ),
  );
  expect(new Set(results.map((r) => r.id)).size).toBe(1);
  expect(f.runs).toHaveLength(1);
  await expect(
    f.service.request(actor, 'app', { ...input, profiles: ['vitest-unit-v1'] }),
  ).rejects.toThrow();
});
it.each(['FAILED', 'QUEUED', 'CANCELLED'])('rejects application status %s', async (status) => {
  const f = fixture();
  f.app.status = status;
  await expect(f.create()).rejects.toThrow();
  expect(f.runs).toHaveLength(0);
});
it('rejects cleanup uncertainty, unaccepted proposal and corrupted persisted bindings', async () => {
  const f = fixture();
  f.app.cleanup = 'UNCERTAIN';
  await expect(f.create()).rejects.toThrow();
  f.app.cleanup = 'DISPOSED';
  f.p.status = 'REJECTED';
  await expect(f.create()).rejects.toThrow();
  f.p.status = 'ACCEPTED';
  f.app.proposalDigest = 'x';
  await expect(f.create()).rejects.toThrow();
});
it.each([null, 'VIEWER'])('rejects removed or insufficient current membership %s', async (role) => {
  const f = fixture();
  f.setRole(role);
  await expect(f.create()).rejects.toThrow();
});
it('foreign tenant and application reads, creation and cancellation are scoped', async () => {
  const f = fixture();
  const r = await f.create();
  await expect(f.service.get({ ...actor, organizationId: 'foreign' }, r.id)).rejects.toThrow();
  await expect(
    f.service.request(actor, 'foreign', { requestId: randomUUID(), profiles: ['vitest-unit-v1'] }),
  ).rejects.toThrow();
  await expect(
    f.service.cancel({ ...actor, organizationId: 'foreign' }, r.id, randomUUID()),
  ).rejects.toThrow();
});
it('uses independent exact pinned HEAD snapshots and consumes no retained workspace', async () => {
  const f = fixture();
  await f.create();
  await f.service.execute(f.job());
  const result = await f.service.get(actor, f.runs[0].id);
  expect(result.state).toBe('COMPLETED');
  expect(result.outcome).toBe('BOTH_PASS');
  expect(result.steps).toHaveLength(4);
  expect(f.snapshotRead).toHaveBeenCalledTimes(2);
  for (const call of f.snapshotRead.mock.calls as any[]) expect(call[1]).toBe(f.app.headSha);
  expect(result.steps.every((s) => s.runnerReported.trusted === false)).toBe(true);
  expect(result.steps[0]!.inputDigest).not.toBe(result.steps[1]!.inputDigest);
});
it('duplicate worker delivery never launches twice', async () => {
  const f = fixture();
  await f.create();
  await Promise.all([f.service.execute(f.job()), f.service.execute(f.job())]);
  expect(broker.request).toHaveBeenCalledTimes(4);
  await f.service.execute(f.job());
  expect(broker.request).toHaveBeenCalledTimes(4);
});
it('snapshot/candidate corruption rejects before any broker launch', async () => {
  const f = fixture();
  await f.create();
  f.snapshotRead.mockImplementation(async () => ({ ...f.snapshot, digest: 'f'.repeat(64) }));
  await f.service.execute(f.job());
  expect(f.runs[0].state).toBe('FAILED');
  expect(broker.request).not.toHaveBeenCalled();
});
it('queued cancellation is idempotent, terminal and prevents launch', async () => {
  const f = fixture();
  const r = await f.create();
  await f.service.cancel(actor, r.id, randomUUID());
  const logs = f.audit.length;
  await f.service.cancel(actor, r.id, randomUUID());
  expect(f.audit).toHaveLength(logs);
  await f.service.execute(f.job());
  expect(broker.request).not.toHaveBeenCalled();
  expect(f.runs[0].state).toBe('CANCELLED');
});
it.each([1, 2])(
  'active cancellation at side call %s rejects late success and prevents further launches',
  async (call) => {
    const f = fixture();
    const original = broker.request.getMockImplementation()!;
    let count = 0;
    broker.request.mockImplementation(async (...args) => {
      count++;
      if (count === call) await f.service.cancel(actor, f.runs[0].id, randomUUID());
      return original(...args);
    });
    await f.create();
    await f.service.execute(f.job());
    expect(f.runs[0].state).toBe('CANCELLED');
    expect(f.runs[0].cleanup).toBe('UNCERTAIN');
    expect(f.runs[0].attempts[0].steps).toHaveLength(call - 1);
    expect(count).toBe(call);
  },
);
it('expired worker attempt is fenced terminal without replaying hostile execution', async () => {
  const f = fixture();
  await f.create();
  f.runs[0].state = 'RUNNING';
  f.runs[0].cleanup = 'UNCERTAIN';
  f.runs[0].attempts[0].fence = randomUUID();
  f.runs[0].deadlineAt = new Date(0);
  await f.service.reconcile();
  expect(f.runs[0].state).toBe('FAILED');
  expect(f.runs[0].cleanup).toBe('UNCERTAIN');
  expect(broker.request).not.toHaveBeenCalled();
});
it('missing queued jobs are re-enqueued with the existing database identity', async () => {
  const f = fixture();
  await f.create();
  f.queue.enqueue.mockClear();
  await f.service.reconcile();
  expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
  expect(f.queue.enqueue.mock.calls[0]![0]).toBe(f.runs[0].attempts[0].jobId);
});
it('readback and audits exclude fences, HMAC keys, source and runner output', async () => {
  const f = fixture();
  await f.create();
  await f.service.execute(f.job());
  const view = await f.service.get(actor, f.runs[0].id);
  expect(JSON.stringify(view)).not.toContain(f.runs[0].attempts[0].fence);
  for (const forbidden of [
    'expectedText',
    'replacement',
    'brokerNonce',
    'fence',
    'stdout',
    'stderr',
  ])
    expect(JSON.stringify(f.audit)).not.toContain(forbidden);
  const started = f.audit.filter((a) => a.action.endsWith('step_started'));
  const completed = f.audit.filter((a) => a.action.endsWith('step_completed'));
  expect(started).toHaveLength(4);
  expect(completed).toHaveLength(4);
  expect(
    started.every((a) => a.metadata.state === 'RUNNING' && a.metadata.cleanup === 'UNCERTAIN'),
  ).toBe(true);
  expect(
    completed.every((a) => a.metadata.state === 'RUNNING' && a.metadata.cleanup === 'DISPOSED'),
  ).toBe(true);
});

it('historical head movement is visible without replacing the pinned input', async () => {
  const f = fixture();
  await f.create();
  f.db.pullRequest.findFirst.mockResolvedValue({
    headSha: 'f'.repeat(40),
    repository: { fullName: 'owner/repo' },
  });
  await f.service.execute(f.job());
  const view = await f.service.get(actor, f.runs[0].id);
  expect(view.state).toBe('COMPLETED');
  expect(view.stale).toBe(true);
  expect(view.headSha).toBe(f.app.headSha);
});
it.each(['INFRASTRUCTURE_FAILED', 'CANCELLED'])(
  'persists authenticated %s before failing instead of rolling it back',
  async (status) => {
    const f = fixture(),
      original = broker.request.getMockImplementation()!;
    broker.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      result.status = status;
      result.observed.termination = status === 'CANCELLED' ? 'CANCELLED' : 'INFRASTRUCTURE';
      return result;
    });
    await f.create();
    await f.service.execute(f.job());
    expect(f.runs[0].state).toBe('FAILED');
    expect(f.runs[0].cleanup).toBe('DISPOSED');
    expect(f.runs[0].attempts[0].steps).toHaveLength(1);
    expect(f.runs[0].attempts[0].steps[0].outcome).toBe('INCONCLUSIVE');
  },
);
it('uncertain authenticated cleanup prevents both later sides and another run', async () => {
  const f = fixture(),
    original = broker.request.getMockImplementation()!;
  broker.request.mockImplementation(async (...args) => {
    const result = await original(...args);
    result.observed.cleanup = 'UNCERTAIN';
    return result;
  });
  await f.create();
  await f.service.execute(f.job());
  expect(f.runs[0].state).toBe('FAILED');
  expect(f.runs[0].cleanup).toBe('UNCERTAIN');
  expect(broker.request).toHaveBeenCalledTimes(1);
  await expect(f.create()).rejects.toThrow();
});
it('membership revocation during execution rejects a late result', async () => {
  const f = fixture(),
    original = broker.request.getMockImplementation()!;
  broker.request.mockImplementation(async (...args) => {
    f.setRole(null);
    return original(...args);
  });
  await f.create();
  await f.service.execute(f.job());
  expect(f.runs[0].state).toBe('FAILED');
  expect(f.runs[0].attempts[0].steps).toHaveLength(0);
  expect(broker.request).toHaveBeenCalledTimes(1);
});
