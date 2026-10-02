import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvestigationService } from './investigation.service';
import { hash, observe, InvestigationFailure } from './investigation-support';

const actor = { organizationId: 'org-a', userId: 'user-a', traceId: 'safe-trace' };
function fixture() {
  const calls: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const turn = {
    id: 'turn-a',
    organizationId: 'org-a',
    pullRequestId: 'pr-a',
    headSha: 'a'.repeat(40),
    conversation: {
      organizationId: 'org-a',
      pullRequestId: 'pr-a',
      pullRequest: {
        id: 'pr-a',
        organizationId: 'org-a',
        repositoryId: 'repo-a',
        repository: { id: 'repo-a', organizationId: 'org-a' },
      },
    },
  };
  function matching(row: Record<string, unknown>, where: Record<string, unknown>) {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'deadlineAt') return (row.deadlineAt as Date) < (value as { lt: Date }).lt;
      return row[key] === value;
    });
  }
  const includeEvidence = (row: Record<string, unknown>) => ({
    ...row,
    evidence: evidence.filter((x) => x.toolCallId === row.id),
  });
  const db = {
    membership: {
      findFirst: vi.fn(async ({ where }) =>
        where.organizationId === 'org-a' && where.userId === 'user-a' ? { role: 'OWNER' } : null,
      ),
    },
    collaborationTurn: {
      findFirst: vi.fn(async ({ where }) =>
        where.organizationId === 'org-a' && where.id === 'turn-a' ? turn : null,
      ),
    },
    collaborationToolCall: {
      findFirst: vi.fn(async ({ where }) => {
        const row = calls.find((r) => matching(r, where));
        return row ? includeEvidence(row) : null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }) => {
        const row = calls.find((r) => matching(r, where));
        if (!row) throw Error('Missing');
        return includeEvidence(row);
      }),
      findMany: vi.fn(async ({ where }) => calls.filter((r) => matching(r, where))),
      count: vi.fn(async ({ where }) => calls.filter((r) => matching(r, where)).length),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: randomUUID(),
          version: '1',
          status: 'RUNNING',
          coverage: 'Pending',
          nextCursor: null,
          failureCategory: null,
          diagnostic: null,
          startedAt: new Date(),
          completedAt: null,
          durationMs: 0,
          ...data,
        };
        calls.push(row);
        return includeEvidence(row);
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of calls)
          if (matching(row, where)) {
            Object.assign(row, data);
            count++;
          }
        return { count };
      }),
    },
    evidenceReference: {
      create: vi.fn(async ({ data }) => {
        const row = {
          id: randomUUID(),
          sourceId: null,
          observedRevision: null,
          indexRevision: null,
          path: null,
          side: null,
          startLine: null,
          endLine: null,
          blobHash: null,
          observedAt: new Date(),
          ...data,
        };
        evidence.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }) => evidence.find((r) => matching(r, where)) ?? null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => []),
  };
  const tools = {
    execute: vi.fn(async () => ({
      status: 'SUCCESS',
      coverage: 'Known source subset',
      nextCursor: null,
      evidence: [
        observe('Safe observation', {
          sourceType: 'REPOSITORY_METADATA',
          provenance: 'SNAPSHOT',
          method: 'test',
        }),
      ],
    })),
  };
  const service = new InvestigationService(
    { unscoped: db, $transaction: async (fn: (db: unknown) => unknown) => fn(db) } as never,
    tools as never,
  );
  return { service, db, tools, calls, evidence, turn };
}
afterEach(() => vi.useRealTimers());
describe('investigation reservation and finalization', () => {
  it('requires readiness without creating schema', async () => {
    const { service, db } = fixture();
    await expect(service.onModuleInit()).rejects.toThrow('schema is not ready');
    db.$queryRaw.mockResolvedValue([{ ready: true }] as never);
    await service.onModuleInit();
    expect(db.collaborationToolCall.create).not.toHaveBeenCalled();
  });
  it('records a call/evidence with server scope, sequence and content-free audit', async () => {
    const { service, db } = fixture();
    const result = await service.execute(
      actor,
      'turn-a',
      'read_repository_metadata',
      randomUUID(),
      {},
    );
    expect(result).toMatchObject({
      status: 'SUCCESS',
      sequence: 1,
      version: '1',
      evidence: [{ trust: 'UNTRUSTED_DATA' }],
    });
    expect(db.collaborationToolCall.create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org-a',
      pullRequestId: 'pr-a',
      repositoryId: 'repo-a',
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('Safe observation');
    expect(db.auditLog.create.mock.calls.map((c) => c[0].data.action)).toEqual([
      'collaboration.tool.requested',
      'collaboration.tool.completed',
    ]);
  });
  it('same normalized request replays its persisted result without executing again', async () => {
    const { service, tools } = fixture();
    const key = randomUUID();
    const first = await service.execute(actor, 'turn-a', 'read_repository_metadata', key, {});
    expect(await service.execute(actor, 'turn-a', 'read_repository_metadata', key, {})).toEqual(
      first,
    );
    expect(tools.execute).toHaveBeenCalledOnce();
    await expect(
      service.execute(actor, 'turn-a', 'list_changed_files', key, {}),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('enforces a hard eight-call turn budget', async () => {
    const { service, tools } = fixture();
    for (let i = 0; i < 8; i++)
      await service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {});
    await expect(
      service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {}),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tools.execute).toHaveBeenCalledTimes(8);
  });
  it('does not return sensitive upstream failure text as an empty success', async () => {
    const { service, tools } = fixture();
    tools.execute.mockRejectedValue(Error('sensitive supplied marker must never appear'));
    const result = await service.execute(
      actor,
      'turn-a',
      'read_repository_metadata',
      randomUUID(),
      {},
    );
    expect(result).toMatchObject({
      status: 'UNAVAILABLE',
      failureCategory: 'UNAVAILABLE',
      evidence: [],
    });
    expect(JSON.stringify(result)).not.toContain('supplied marker');
  });
  it('preserves typed stale/missing categories without raw diagnostics', async () => {
    const { service, tools } = fixture();
    tools.execute.mockRejectedValue(new InvestigationFailure('STALE'));
    expect(
      await service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {}),
    ).toMatchObject({ status: 'UNAVAILABLE', failureCategory: 'STALE' });
  });
  it('bounds deadline and ignores late completion without inserting evidence', async () => {
    vi.useFakeTimers();
    const { service, tools, evidence } = fixture();
    let finish: ((value: unknown) => void) | undefined;
    tools.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const pending = service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {});
    await vi.advanceTimersByTimeAsync(20001);
    expect(await pending).toMatchObject({ status: 'TIMEOUT', evidence: [] });
    finish?.({
      status: 'SUCCESS',
      coverage: 'late',
      nextCursor: null,
      evidence: [
        observe('late', { sourceType: 'FILE', provenance: 'EXACT_REVISION', method: 'test' }),
      ],
    });
    await Promise.resolve();
    expect(evidence).toHaveLength(0);
  });
  it('marks interrupted expired reservations CANCELLED and does not reexecute them', async () => {
    const { service, calls, tools } = fixture();
    const key = randomUUID();
    calls.push({
      id: 'interrupted',
      organizationId: 'org-a',
      turnId: 'turn-a',
      requestedById: 'user-a',
      requestId: key,
      inputHash: hash(JSON.stringify({ tool: 'read_repository_metadata', input: {} })),
      status: 'RUNNING',
      fence: 'old',
      startedAt: new Date(Date.now() - 60000),
      deadlineAt: new Date(Date.now() - 30000),
      tool: 'read_repository_metadata',
      sequence: 1,
      version: '1',
    });
    const result = await service.execute(actor, 'turn-a', 'read_repository_metadata', key, {});
    expect(result).toMatchObject({
      status: 'CANCELLED',
      failureCategory: 'CANCELLED',
      evidence: [],
    });
    expect(tools.execute).not.toHaveBeenCalled();
  });
  it.each(['org-b', 'guessed-org'])(
    'denies foreign turn and fabricated scope for %s',
    async (organizationId) => {
      const { service, tools } = fixture();
      await expect(
        service.execute(
          { ...actor, organizationId },
          'turn-a',
          'read_repository_metadata',
          randomUUID(),
          {},
        ),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(tools.execute).not.toHaveBeenCalled();
    },
  );
  it('foreign call and evidence IDs return scoped 404s', async () => {
    const { service } = fixture();
    const call = await service.execute(
      actor,
      'turn-a',
      'read_repository_metadata',
      randomUUID(),
      {},
    );
    const foreign = { ...actor, organizationId: 'org-b' };
    await expect(service.getCall(foreign, call.id)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(service.getEvidence(foreign, call.evidence[0].id)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(service.getEvidence(actor, 'forged')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
  it('rejects unexpected fields before creating a reservation', async () => {
    const { service, db } = fixture();
    await expect(
      service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {
        credentialId: 'foreign',
      }),
    ).rejects.toThrow();
    await expect(service.execute(actor, 'turn-a', 'shell', randomUUID(), {})).rejects.toThrow();
    expect(db.collaborationToolCall.create).not.toHaveBeenCalled();
  });
  it('rechecks current membership rather than trusting a prior session', async () => {
    const { service, db, tools } = fixture();
    db.membership.findFirst.mockResolvedValue(null);
    await expect(
      service.execute(actor, 'turn-a', 'read_repository_metadata', randomUUID(), {}),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(tools.execute).not.toHaveBeenCalled();
  });
});
