import { expect, it, vi } from 'vitest';
import { aiFixture, hash } from '../../test/validation-ai-fixture';
import { ValidationAiService } from './validation-ai.service';
import type { LlmProvider } from '@codelens/shared';
const actor = { organizationId: 'org', userId: 'user' };
function setup() {
  const { run, ml } = aiFixture(),
    rows: any[] = [],
    audits: any[] = [];
  let role = 'DEVELOPER',
    allowed = true,
    currentHead = run.headSha;
  const matches = (r: any, w: any) =>
    Object.entries(w).every(([k, v]) =>
      v && typeof v === 'object' ? ('in' in v ? (v as any).in.includes(r[k]) : true) : r[k] === v,
    );
  const db: any = {
    $queryRaw: vi.fn(async () => []),
    membership: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === 'org' && where.userId === 'user' ? { role } : null,
      ),
    },
    validationRun: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === run.id && where.organizationId === 'org' ? structuredClone(run) : null,
      ),
    },
    pullRequest: { findFirst: vi.fn(async () => ({ headSha: currentHead })) },
    collaborationTurn: {
      findFirst: vi.fn(async () => ({ headSha: run.headSha, baseSha: run.application.baseSha })),
    },
    validationMlComparison: { findFirst: vi.fn(async () => structuredClone(ml)) },
    validationAiReview: {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(rows.filter((r) => matches(r, where)).at(-1) ?? null),
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        structuredClone(rows.find((r) => r.id === where.id) ?? null),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: any) =>
        structuredClone(rows.find((r) => r.id === where.id)),
      ),
      findMany: vi.fn(async ({ where }: any) =>
        structuredClone(rows.filter((r) => matches(r, where))),
      ),
      create: vi.fn(async ({ data }: any) => {
        const r = {
          state: 'QUEUED',
          packetHeader: null,
          packetDigest: null,
          result: null,
          fence: null,
          assessment: null,
          reportedProvider: null,
          reportedModel: null,
          failureCategory: null,
          createdAt: new Date(),
          completedAt: null,
          ...data,
          attempts: [],
          evidence: [],
        };
        rows.push(r);
        return structuredClone(r);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = rows.find((r) => r.id === where.id);
        Object.assign(r, data);
        return structuredClone(r);
      }),
    },
    validationAiReviewAttempt: {
      create: vi.fn(async ({ data }: any) => {
        const a = {
          generation: 1,
          requests: 0,
          retries: 0,
          repairs: 0,
          reservedTokens: 0,
          promptTokens: null,
          completionTokens: null,
          unknownRequests: 0,
          durationMs: 0,
          ...data,
        };
        rows.find((r) => r.id === data.reviewId).attempts.push(a);
        return structuredClone(a);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const a = rows.find((r) => r.id === where.reviewId_generation.reviewId).attempts[0];
        Object.assign(a, data);
        return structuredClone(a);
      }),
    },
    validationAiEvidenceReference: {
      create: vi.fn(async ({ data }: any) => {
        rows.find((r) => r.id === data.reviewId).evidence.push(data);
        return data;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
  };
  let serial = Promise.resolve();
  const prisma: any = {
    unscoped: db,
    $transaction: (fn: any) => {
      const p = serial.then(async () => {
        const before = structuredClone(rows);
        try {
          return await fn(db);
        } catch (e) {
          rows.splice(0, rows.length, ...before);
          throw e;
        }
      });
      serial = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
  };
  const settings = {
    requestedProvider: 'OPENAI',
    requestedModel: 'test-model',
    configurationDigest: hash('config'),
  };
  const complete = vi.fn<LlmProvider['complete']>(async (p) => {
    const packet = JSON.parse(p.messages[1]!.content);
    const c = { text: 'Advisory scoped observation', evidenceIds: [packet.entries[0].id] };
    return {
      content: JSON.stringify({
        assessment: 'INCONCLUSIVE',
        summary: c,
        addressedConcerns: [],
        residualConcerns: [],
        introducedConcerns: [],
        suggestedFollowups: [],
        limitations: ['Not approval'],
      }),
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      usageReported: true,
      finishReason: 'stop',
      costCents: 0,
    };
  });
  const provider: any = {
    settings: vi.fn(async () => {
      if (!allowed) throw new Error('disabled');
      return settings;
    }),
    secrets: () => [],
    resolve: vi.fn(async () => {
      if (!allowed) throw new Error('disabled');
      return { name: 'TEST', complete };
    }),
  };
  const queue = { enqueue: vi.fn(async () => {}) },
    service = new ValidationAiService(prisma, queue as never, provider);
  return {
    service,
    rows,
    audits,
    db,
    run,
    ml,
    complete,
    queue,
    role: (v: string) => (role = v),
    policy: (v: boolean) => (allowed = v),
    head: (v: string) => (currentHead = v),
  };
}
const request = { requestId: '00000000-0000-4000-8000-000000000005' };
it('replays the same reservation and serializes active requests', async () => {
  const f = setup();
  const a = await f.service.request(actor, 'validation', request);
  const b = await f.service.request(actor, 'validation', request);
  expect(a?.id).toBe(b?.id);
  expect(f.rows).toHaveLength(1);
  await expect(
    f.service.request(actor, 'validation', { requestId: '00000000-0000-4000-8000-000000000006' }),
  ).rejects.toThrow('already active');
});
it('conflicting request reuse is rejected', async () => {
  const f = setup();
  await f.service.request(actor, 'validation', request);
  f.rows[0].requestHash = hash('other');
  await expect(f.service.request(actor, 'validation', request)).rejects.toThrow('reused');
});
it('seals references, validates citations and persists one result under duplicate delivery', async () => {
  const f = setup();
  const before = JSON.stringify({ run: f.run, ml: f.ml });
  const row = await f.service.request(actor, 'validation', request);
  await Promise.all([f.service.execute(row!.id), f.service.execute(row!.id)]);
  const out = await f.service.get(actor, 'validation', row!.id);
  expect(out).toMatchObject({
    state: 'COMPLETED',
    result: { assessment: 'INCONCLUSIVE' },
    accounting: { requests: 1, unknownRequests: 0 },
  });
  expect(f.complete).toHaveBeenCalledOnce();
  expect(out!.evidence.some((e) => e.id === out!.result!.summary.evidenceIds[0])).toBe(true);
  expect(JSON.stringify({ run: f.run, ml: f.ml })).toBe(before);
  expect(JSON.stringify(f.audits)).not.toContain('return eval');
});
it.each(['VIEWER', 'foreign'])('denies %s membership without provider execution', async (role) => {
  const f = setup();
  if (role === 'VIEWER') f.role(role);
  await expect(
    f.service.request(
      role === 'foreign' ? { organizationId: 'foreign', userId: 'user' } : actor,
      'validation',
      request,
    ),
  ).rejects.toThrow();
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.rows).toHaveLength(0);
});
it('cancellation is idempotent and no provider call follows queued cancellation', async () => {
  const f = setup();
  const row = await f.service.request(actor, 'validation', request);
  await f.service.cancel(actor, 'validation', row!.id, request.requestId);
  await f.service.cancel(actor, 'validation', row!.id, request.requestId);
  await f.service.execute(row!.id);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.rows[0].state).toBe('CANCELLED');
});
it('cancellation fences a late provider response', async () => {
  const f = setup();
  let release!: (v: any) => void;
  f.complete.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const row = await f.service.request(actor, 'validation', request);
  const operation = f.service.execute(row!.id);
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce());
  await f.service.cancel(actor, 'validation', row!.id, request.requestId);
  release({
    content: '{}',
    model: 'test-model',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costCents: 0,
    finishReason: 'stop',
  });
  await operation;
  expect(f.rows[0]).toMatchObject({ state: 'CANCELLED', result: null });
});
it('stale readback retains sealed identity and result', async () => {
  const f = setup();
  const row = await f.service.request(actor, 'validation', request);
  await f.service.execute(row!.id);
  const before = await f.service.get(actor, 'validation', row!.id);
  f.head('f'.repeat(40));
  const after = await f.service.get(actor, 'validation', row!.id);
  expect(after?.stale).toBe(true);
  expect(after?.packetDigest).toBe(before?.packetDigest);
  expect(after?.result).toEqual(before?.result);
});
it('policy revocation prevents provider dispatch and keeps evidence intact', async () => {
  const f = setup();
  const row = await f.service.request(actor, 'validation', request);
  f.policy(false);
  await f.service.execute(row!.id);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.rows[0].state).toBe('FAILED');
  expect(f.run.state).toBe('COMPLETED');
});
it('expired interrupted execution is failed without replay', async () => {
  const f = setup();
  const row = await f.service.request(actor, 'validation', request);
  f.rows[0].state = 'RUNNING';
  f.rows[0].deadlineAt = new Date(0);
  const count = f.queue.enqueue.mock.calls.length;
  await f.service.reconcile();
  expect(f.rows[0].failureCategory).toBe('EXPIRED_NO_REEXECUTION');
  expect(f.queue.enqueue).toHaveBeenCalledTimes(count);
  expect(f.complete).not.toHaveBeenCalled();
});
it('terminal decision cancellation is rejected', async () => {
  const f = setup();
  const row = await f.service.request(actor, 'validation', request);
  await f.service.execute(row!.id);
  await expect(f.service.cancel(actor, 'validation', row!.id, request.requestId)).rejects.toThrow(
    'terminal',
  );
});
it('retains reported model on rejected output without persisting a partial assessment', async () => {
  const f = setup();
  f.complete.mockResolvedValue({
    content: '{}',
    model: 'reported-model',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    usageReported: true,
    finishReason: 'stop',
    costCents: 0,
  });
  const row = await f.service.request(actor, 'validation', request);
  await f.service.execute(row!.id);
  expect(await f.service.get(actor, 'validation', row!.id)).toMatchObject({
    state: 'FAILED',
    reportedModel: 'reported-model',
    result: null,
    accounting: { requests: 2, repairs: 1 },
  });
});
