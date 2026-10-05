import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { snapshotDigest } from '@codelens/github/dist/exact-git-snapshot';
import { canonicalPatch, constructPatchFile, patchHash } from '@codelens/patch-core';
import { analyzeStaticSource } from '@codelens/static-analysis/dist/validation-static';
import { reconstructApplication } from './patch-application-content';
import { ValidationMlService } from './validation-ml.service';
import { riskDigest } from '../ml/strict-risk-client';
import {
  ML_BAND_POLICY,
  ML_CONTRACT,
  ML_FEATURE_SCHEMA,
  authoritativeRiskBand,
} from '@codelens/shared';
const actor = { organizationId: 'org', userId: 'user' };
function fixture() {
  const head = 'a'.repeat(40),
    base = 'b'.repeat(40);
  const blob = (s: string) =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(s)}\0`)
      .update(s)
      .digest('hex');
  const make = (revision: string, content: string) => {
    const raw = {
      version: 1 as const,
      repository: 'owner/repo',
      revision,
      files: [
        {
          path: 'src/auth.ts',
          content,
          blobSha: blob(content),
          contentHash: patchHash(content),
          byteLength: Buffer.byteLength(content),
        },
      ],
    };
    return { ...raw, digest: snapshotDigest(raw) };
  };
  const original = make(head, 'export function run(input: string) { return eval(input); }\n'),
    baseline = make(base, 'export function run(input: string) { return input; }\n');
  const source = original.files[0]!;
  const intent = {
    summary: 'Review proposal',
    rationale: 'Evidence',
    limitations: 'Not applied to repository',
    files: [
      {
        path: source.path,
        operation: 'MODIFY' as const,
        expectedBlobSha: source.blobSha,
        evidenceIds: ['e'],
        edits: [
          {
            startLine: 1,
            endLine: 1,
            expectedText: source.content.trimEnd(),
            replacement: 'export function run(input: string) { return input; }',
          },
        ],
      },
    ],
  };
  const file = constructPatchFile(intent.files[0]!, {
    revision: head,
    path: source.path,
    objectSha: source.blobSha,
    content: source.content,
    contentHash: source.contentHash,
    kind: 'REGULAR_FILE',
    mode: '100644',
    modificationEligible: true,
    components: [],
  });
  const p = {
    id: 'proposal',
    organizationId: 'org',
    repositoryId: 'repo',
    pullRequestId: 'pr',
    conversationId: 'conversation',
    turnId: 'turn',
    status: 'ACCEPTED',
    revision: 1,
    headSha: head,
    baseSha: base,
    digest: canonicalPatch({ headSha: head, baseSha: base }, intent, [file]).digest,
    ...intent,
    files: [file],
  };
  const manifest = reconstructApplication(original, p).expected;
  const app = {
    id: 'app',
    organizationId: 'org',
    proposalId: p.id,
    headSha: head,
    baseSha: base,
    status: 'APPLIED',
    cleanup: 'DISPOSED',
    proposalRevision: 1,
    proposalDigest: p.digest,
    proposal: p,
    attempts: [
      {
        status: 'APPLIED',
        cleanup: 'DISPOSED',
        snapshotDigest: original.digest,
        manifestDigest: manifest.digest,
        files: manifest.files,
      },
    ],
  };
  const patched = make(head, intent.files[0]!.edits[0]!.replacement + '\n');
  const analyses = (['ORIGINAL', 'PATCHED'] as const).map((side) => {
    const s = side === 'ORIGINAL' ? original : patched,
      r = analyzeStaticSource(s.files, side, []);
    return {
      side,
      ...r,
      ...r.identity,
      sourceDigest: side === 'ORIGINAL' ? original.digest : manifest.digest,
      findingCount: r.findings.length,
      resultDigest: riskDigest(r),
    };
  });
  const run = {
    id: 'validation',
    organizationId: 'org',
    repositoryId: 'repo',
    pullRequestId: 'pr',
    conversationId: 'conversation',
    turnId: 'turn',
    applicationId: 'app',
    proposalId: p.id,
    proposalRevision: 1,
    proposalDigest: p.digest,
    headSha: head,
    snapshotDigest: original.digest,
    candidateDigest: manifest.digest,
    state: 'COMPLETED',
    cleanup: 'DISPOSED',
    application: app,
    staticAnalyses: analyses,
  };
  const pr = {
    id: 'pr',
    headSha: head,
    baseSha: base,
    title: 'Review input',
    commitCount: 1,
    repository: { fullName: 'owner/repo' },
  };
  const rows: any[] = [],
    audits: any[] = [];
  let role: string | null = 'DEVELOPER';
  const matches = (r: any, w: any) =>
    Object.entries(w).every(([k, v]: any) =>
      typeof v === 'object' && v !== null
        ? 'in' in v
          ? v.in.includes(r[k])
          : r[k] && matches(r[k], v)
        : r[k] === v,
    );
  const db = {
    $queryRaw: vi.fn(async () => []),
    membership: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.organizationId === 'org' && role ? { role } : null,
      ),
    },
    validationRun: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === run.id && where.organizationId === 'org' ? structuredClone(run) : null,
      ),
    },
    pullRequest: {
      findFirst: vi.fn(async () => structuredClone(pr)),
      findFirstOrThrow: vi.fn(async () => structuredClone(pr)),
    },
    collaborationTurn: { findFirst: vi.fn(async () => ({ headSha: head, baseSha: base })) },
    commit: { findMany: vi.fn(async () => [{ message: 'Review input' }]) },
    staticFinding: { findMany: vi.fn(async () => []) },
    pullRequestFile: { findMany: vi.fn(async () => []) },
    validationMlComparison: {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(rows.filter((r) => matches(r, where)).at(-1) ?? null),
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        structuredClone(rows.find((r) => r.id === where.id) ?? null),
      ),
      findMany: vi.fn(async ({ where }: any) =>
        structuredClone(rows.filter((r) => matches(r, where))),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          state: 'QUEUED',
          outcome: null,
          failureCategory: null,
          fence: null,
          completedAt: null,
          createdAt: new Date(),
          deltaTenths: null,
          bandMovement: null,
          modelIdentity: null,
          ...data,
          assessments: [],
        };
        rows.push(row);
        return structuredClone(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return structuredClone(row);
      }),
    },
    validationMlAssessment: {
      create: vi.fn(async ({ data }: any) => {
        rows.find((r) => r.id === data.comparisonId).assessments.push(data);
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
  const prisma = {
    unscoped: db,
    $transaction: (fn: any) => {
      const result = serial.then(async () => {
        const before = structuredClone(rows);
        try {
          return await fn(db);
        } catch (e) {
          rows.splice(0, rows.length, ...before);
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
  const identity = {
    manifestVersion: 1,
    featureSchemaVersion: ML_FEATURE_SCHEMA,
    artifactDigest: 'c'.repeat(64),
    preprocessingDigest: 'd'.repeat(64),
    calibrationDigest: 'e'.repeat(64),
    modelName: 'test',
    modelVersion: 'v1',
    isBaseline: true,
    contractVersion: ML_CONTRACT,
    inferenceImplementation: 'codelens-risk-inference-impl-v1',
    bandPolicyVersion: ML_BAND_POLICY,
    bundleScope: 'SHARED',
    organizationId: null,
    runtimeIdentity: 'test',
    implementationDigest: 'f'.repeat(64),
    runtimeDigest: '1'.repeat(64),
  };
  const model = vi.fn(async (input: any) => {
    const observe = (features: any, scoreTenths: number) => ({
      featureDigest: riskDigest(features),
      scoreTenths,
      probabilityMicros: scoreTenths * 1000,
      confidenceMillis: 700,
      band: authoritativeRiskBand(scoreTenths / 10, 0.7),
      warnings: [],
    });
    const response = {
      status: 'AVAILABLE',
      identity,
      original: observe(input.original, 650),
      patched: observe(input.patched, 550),
    };
    return { ...response, resultDigest: riskDigest(response) };
  });
  const snapshot = vi.fn(async (_repo: string, revision: string) =>
    structuredClone(revision === base ? baseline : original),
  );
  const queue = { enqueue: vi.fn(async () => {}) };
  const service = new ValidationMlService(
    prisma as never,
    { forUser: async () => ({ materializeExactSnapshot: snapshot }) } as never,
    { predictRiskPair: model } as never,
    queue as never,
  );
  return {
    service,
    rows,
    audits,
    db,
    run,
    app,
    pr,
    model,
    snapshot,
    queue,
    setRole: (value: string | null) => {
      role = value;
    },
  };
}
it('persists direct-base pair, precise movement and safe public readback without product mutations', async () => {
  const f = fixture(),
    before = JSON.stringify(f.run);
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  const done = await f.service.get(actor, 'validation');
  expect(done!.state).toBe('COMPLETED');
  expect(done!.outcome).toBe('LOWER');
  expect(done!.deltaTenths).toBe(-100);
  expect(done!.bandMovement).toBe('LOWER');
  expect(done!.assessments).toHaveLength(2);
  expect(f.model).toHaveBeenCalledTimes(1);
  expect(f.snapshot.mock.calls.map((c) => c[1])).toEqual([
    'b'.repeat(40),
    'a'.repeat(40),
    'a'.repeat(40),
  ]);
  expect(done).not.toHaveProperty('fence');
  expect(done).not.toHaveProperty('frozenMetadata');
  expect(done!.frozenMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(f.run)).toBe(before);
  expect(f.model.mock.calls[0]![0].original.security_findings_count).toBe(1);
  expect(f.model.mock.calls[0]![0].patched.security_findings_count).toBe(0);
  expect(JSON.stringify(f.audits)).not.toContain('Review input');
});
it('coalesces simultaneous actor request replay and duplicate worker delivery', async () => {
  const f = fixture(),
    input = { requestId: randomUUID() };
  const [a, b] = await Promise.all([
    f.service.request(actor, 'validation', input),
    f.service.request(actor, 'validation', input),
  ]);
  expect(a!.id).toBe(b!.id);
  expect(f.rows).toHaveLength(1);
  await Promise.all([f.service.execute(a!.id), f.service.execute(a!.id)]);
  await f.service.execute(a!.id);
  expect(f.model).toHaveBeenCalledTimes(1);
});
it.each(['VIEWER', null])('denies absent/invalid current membership %s', async (role) => {
  const f = fixture();
  f.setRole(role);
  await expect(
    f.service.request(actor, 'validation', { requestId: randomUUID() }),
  ).rejects.toThrow();
  expect(f.rows).toHaveLength(0);
});
it('foreign validation is scoped 404', async () => {
  const f = fixture();
  await expect(
    f.service.get({ organizationId: 'foreign', userId: 'user' }, 'validation'),
  ).rejects.toThrow();
});
it.each(['snapshotDigest', 'candidateDigest', 'proposalDigest', 'headSha'])(
  'rejects %s lineage mismatch before inference',
  async (field) => {
    const f = fixture();
    (f.run as any)[field] = 'c'.repeat(64);
    await expect(
      f.service.request(actor, 'validation', { requestId: randomUUID() }),
    ).rejects.toThrow();
    expect(f.model).not.toHaveBeenCalled();
  },
);
it('static failure and incomplete metadata cannot become zero risk', async () => {
  const f = fixture();
  f.run.staticAnalyses[0]!.status = 'FAILED';
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  expect(f.rows[0].outcome).toBe('UNAVAILABLE');
  expect(f.rows[0].deltaTenths).toBeNull();
  expect(f.model).not.toHaveBeenCalled();
});
it('stale current HEAD is a readback flag, not repinning', async () => {
  const f = fixture();
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  const before = JSON.stringify(f.rows[0]);
  f.pr.headSha = 'c'.repeat(40);
  expect((await f.service.get(actor, 'validation'))!.stale).toBe(true);
  expect(JSON.stringify(f.rows[0])).toBe(before);
});
it('cancel fences a late inference result and is replay-safe', async () => {
  const f = fixture();
  let resolve: any;
  const entered = new Promise<void>((r) =>
    f.model.mockImplementationOnce(async () => {
      r();
      return await new Promise<any>((done) => {
        resolve = done;
      });
    }),
  );
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  const execution = f.service.execute(row!.id);
  await entered;
  await f.service.cancel(actor, 'validation', row!.id, randomUUID());
  resolve({ status: 'UNAVAILABLE', category: 'SERVICE_UNAVAILABLE' });
  await execution;
  expect(f.rows[0].state).toBe('CANCELLED');
  expect(f.rows[0].assessments).toHaveLength(0);
  await f.service.cancel(actor, 'validation', row!.id, randomUUID());
});
it('reconciliation repairs queued transport but never reruns terminal history', async () => {
  const f = fixture();
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  f.queue.enqueue.mockClear();
  await f.service.reconcile();
  expect(f.queue.enqueue).toHaveBeenCalledWith(row!.id);
  await f.service.execute(row!.id);
  f.queue.enqueue.mockClear();
  await f.service.reconcile();
  expect(f.queue.enqueue).not.toHaveBeenCalled();
});
it('unavailable strict pair persists nulls on both sides', async () => {
  const f = fixture();
  f.model.mockResolvedValueOnce({
    status: 'UNAVAILABLE',
    category: 'NO_MODEL_ASSESSMENT',
    contractVersion: ML_CONTRACT,
  } as never);
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  const done = await f.service.get(actor, 'validation');
  expect(done!.outcome).toBe('UNAVAILABLE');
  expect(done!.assessments.every((a) => a.scoreTenths === null && a.band === null)).toBe(true);
  expect(done!.failureCategory).toBe('NO_MODEL_ASSESSMENT');
});
it.each([
  ['UNCHANGED', 0],
  ['HIGHER', 10],
] as const)('persists %s score movement independently of band movement', async (outcome, delta) => {
  const f = fixture();
  const original = f.model.getMockImplementation()!;
  f.model.mockImplementationOnce(async (input) => {
    const result = await original(input);
    result.patched.scoreTenths = result.original.scoreTenths + delta;
    result.patched.probabilityMicros = result.patched.scoreTenths * 1000;
    result.patched.band = result.original.band;
    return { ...result, resultDigest: riskDigest(result) };
  });
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  const done = await f.service.get(actor, 'validation');
  expect(done!.outcome).toBe(outcome);
  expect(done!.deltaTenths).toBe(delta);
  expect(done!.bandMovement).toBe('UNCHANGED');
});
it('incomplete commit metadata fails without fabricated assessments', async () => {
  const f = fixture();
  f.pr.commitCount = 2;
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  expect(f.rows[0].state).toBe('FAILED');
  expect(f.rows[0].assessments).toHaveLength(0);
  expect(f.model).not.toHaveBeenCalled();
  expect(f.audits.some((a) => a.action.endsWith('.failed'))).toBe(true);
});
it.each(['EXACT_REVISION_UNAVAILABLE', 'UNSUPPORTED_GIT_OBJECT'])(
  'source failure %s does not reach inference',
  async (category) => {
    const f = fixture();
    f.snapshot.mockRejectedValueOnce(new Error(category));
    const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
    await f.service.execute(row!.id);
    expect(f.rows[0].state).toBe('FAILED');
    expect(f.rows[0].outcome).toBe('UNAVAILABLE');
    expect(f.rows[0].assessments).toHaveLength(0);
    expect(f.model).not.toHaveBeenCalled();
  },
);
it.each(['', 'malformed'])('missing/malformed pinned base %s is not fabricated', async (base) => {
  const f = fixture();
  f.app.baseSha = base;
  await expect(
    f.service.request(actor, 'validation', { requestId: randomUUID() }),
  ).rejects.toThrow();
  expect(f.model).not.toHaveBeenCalled();
});
it('head movement during reconstruction cannot repin a comparison', async () => {
  const f = fixture();
  const read = f.snapshot.getMockImplementation()!;
  f.snapshot.mockImplementationOnce(async (repo, revision) => {
    f.pr.headSha = 'c'.repeat(40);
    return read(repo, revision);
  });
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  const done = await f.service.get(actor, 'validation');
  expect(done!.state).toBe('COMPLETED');
  expect(done!.stale).toBe(true);
  expect(done!.headSha).toBe('a'.repeat(40));
});
it('revoked membership during inference fences result persistence', async () => {
  const f = fixture();
  f.model.mockImplementationOnce(async () => {
    f.setRole(null);
    return { status: 'UNAVAILABLE', category: 'SERVICE_UNAVAILABLE' } as never;
  });
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  await f.service.execute(row!.id);
  expect(f.rows[0].state).toBe('FAILED');
  expect(f.rows[0].assessments).toHaveLength(0);
});
it('expired preparation is terminal and never regenerated', async () => {
  const f = fixture();
  const row = await f.service.request(actor, 'validation', { requestId: randomUUID() });
  f.rows[0].deadlineAt = new Date(0);
  await f.service.execute(row!.id);
  await f.service.reconcile();
  expect(f.rows[0].failureCategory).toBe('EXPIRED_NO_REEXECUTION');
  expect(f.model).not.toHaveBeenCalled();
});
