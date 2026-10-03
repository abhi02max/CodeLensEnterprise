import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CollaborationExecutionService } from './collaboration-execution.service';

const actor = { organizationId: 'org-a', userId: 'user-a', traceId: 'trace-a' };
function fixture() {
  const conversation = {
    id: 'conversation-a',
    organizationId: 'org-a',
    pullRequestId: 'pr-a',
    lastSequence: 1,
    anchor: { kind: 'PR' },
    pullRequest: {
      id: 'pr-a',
      organizationId: 'org-a',
      headSha: 'a'.repeat(40),
      repository: { organizationId: 'org-a' },
    },
  };
  const turn = {
    id: 'turn-a',
    organizationId: 'org-a',
    conversationId: conversation.id,
    pullRequestId: 'pr-a',
    initiatedById: 'user-a',
    status: 'RECORDED',
    executionAttempt: 0,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    reviewRunId: null,
    conversation,
  };
  const attempts: any[] = [],
    messages: any[] = [
      {
        id: 'human-a',
        sequence: 1,
        kind: 'HUMAN',
        turnId: 'turn-a',
        content: 'Question',
        organizationId: 'org-a',
        conversationId: 'conversation-a',
      },
    ];
  const audits: any[] = [],
    evidence: any[] = [];
  function matches(row: any, where: any): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (value && typeof value === 'object') {
        if ('in' in value) return value.in.includes(row[key]);
        if ('gt' in value) return row[key] > value.gt;
        if ('lt' in value) return row[key] < value.lt;
        if ('lte' in value) return row[key] <= value.lte;
      }
      return row[key] === value;
    });
  }
  const db = {
    $queryRaw: vi.fn(async () => []),
    membership: {
      findFirst: vi.fn(async ({ where }) =>
        where.organizationId === 'org-a' && where.userId === 'user-a'
          ? { role: 'DEVELOPER' }
          : null,
      ),
    },
    collaborationTurn: {
      findFirst: vi.fn(async ({ where }) => (matches(turn, where) ? { ...turn } : null)),
      update: vi.fn(async ({ data }) => Object.assign(turn, data)),
    },
    collaborationAttempt: {
      aggregate: vi.fn(async ({ where }) => ({
        _sum: Object.fromEntries(
          ['providerRequests', 'outputTokens', 'rounds'].map((key) => [
            key,
            attempts
              .filter((row) => matches(row, where))
              .reduce((total, row) => total + row[key], 0),
          ]),
        ),
      })),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: randomUUID(),
          status: 'QUEUED',
          createdAt: new Date(),
          startedAt: null,
          deadlineAt: null,
          completedAt: null,
          providerRequests: 0,
          providerRetries: 0,
          repairs: 0,
          rounds: 0,
          toolCalls: 0,
          contextBytes: 0,
          outputTokens: 0,
          availableEvidenceIds: [],
          ...data,
        };
        attempts.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }) => attempts.find((row) => matches(row, where)) ?? null),
      findFirstOrThrow: vi.fn(async ({ where }) => {
        const row = attempts.find((row) => matches(row, where));
        if (!row) throw new Error('missing');
        return row;
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(
          attempts.find((row) => matches(row, where)),
          data,
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = attempts.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    },
    conversation: {
      findFirstOrThrow: vi.fn(async () => conversation),
      update: vi.fn(async ({ data }) => Object.assign(conversation, data)),
    },
    conversationMessage: {
      findFirstOrThrow: vi.fn(async ({ where }) => messages.find((row) => matches(row, where))),
      findMany: vi.fn(async ({ where, take }) =>
        messages
          .filter((row) => matches(row, where))
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, take),
      ),
      create: vi.fn(async ({ data }) => {
        if (messages.some((m) => m.turnId === data.turnId && m.kind === data.kind))
          throw new Error('duplicate');
        const row = { id: randomUUID(), ...data };
        messages.push(row);
        return row;
      }),
    },
    evidenceReference: {
      count: vi.fn(
        async ({ where }) =>
          evidence.filter(
            (row) =>
              where.id.in.includes(row.id) &&
              row.organizationId === where.organizationId &&
              row.turnId === where.turnId,
          ).length,
      ),
    },
    collaborationToolCall: { updateMany: vi.fn(async () => ({ count: 0 })) },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        audits.push(data);
        return data;
      }),
    },
  };
  let tail = Promise.resolve();
  const prisma = {
    unscoped: db,
    $transaction: vi.fn((fn) => {
      const work = tail.then(async () => {
        const before = structuredClone({ turn, conversation, attempts, messages, audits });
        try {
          return await fn(db);
        } catch (error) {
          Object.assign(conversation, before.conversation);
          Object.assign(turn, before.turn, { conversation });
          attempts.splice(0, attempts.length, ...before.attempts);
          messages.splice(0, messages.length, ...before.messages);
          audits.splice(0, audits.length, ...before.audits);
          throw error;
        }
      });
      tail = work.catch(() => {});
      return work;
    }),
  };
  const queue = { enqueueCollaboration: vi.fn(async () => {}) };
  const complete = vi.fn(async () => ({
    content: JSON.stringify({
      action: 'RESPOND',
      content: 'Unknown without evidence.',
      certainty: 'UNKNOWN',
      citations: [],
    }),
    model: 'stub',
    usage: { completionTokens: 50, promptTokens: 10, totalTokens: 60 },
    costCents: 0,
    finishReason: 'stop',
  }));
  const providers = {
    resolve: vi.fn(async () => ({
      provider: { name: 'DETERMINISTIC', complete },
      model: 'test-model',
    })),
  };
  const investigation = {
    list: vi.fn(async () => ({ items: [] })),
    getCall: vi.fn(),
    execute: vi.fn(),
  };
  const service = new CollaborationExecutionService(
    prisma as never,
    queue as never,
    providers as never,
    investigation as never,
  );
  const job = () => ({
    ...actor,
    userId: actor.userId,
    turnId: turn.id,
    attempt: turn.executionAttempt,
  });
  return {
    service,
    turn,
    attempts,
    messages,
    audits,
    evidence,
    db,
    queue,
    complete,
    providers,
    investigation,
    conversation,
    job,
  };
}
describe('collaboration execution ownership and fencing', () => {
  it('rolls back an assistant if final persistence crosses the deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const audit = f.db.auditLog.create.getMockImplementation()!;
      f.db.auditLog.create.mockImplementation(async (args) => {
        const result = await audit(args);
        if (args.data.action === 'collaboration.turn.completed')
          vi.setSystemTime(new Date(Date.now() + 90001));
        return result;
      });
      await f.service.enqueue(actor, 'turn-a');
      await f.service.execute(f.job());
      expect(f.turn.status).toBe('FAILED');
      expect(f.attempts[0].failureCategory).toBe('DEADLINE');
      expect(f.messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('verifies readiness without runtime DDL', async () => {
    const f = fixture();
    await expect(f.service.onModuleInit()).rejects.toThrow('schema is not ready');
    f.db.$queryRaw.mockResolvedValue([{ ready: true }] as never);
    await f.service.onModuleInit();
    expect(f.db.collaborationAttempt.create).not.toHaveBeenCalled();
  });
  it('explicit retry cannot restore spent provider or output reservations', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    f.turn.status = 'FAILED';
    Object.assign(f.attempts[0], { status: 'FAILED', providerRequests: 4, outputTokens: 8000 });
    await expect(f.service.enqueue(actor, 'turn-a', 1)).rejects.toThrow(
      'exhausted its provider budget',
    );
    expect(f.attempts).toHaveLength(1);
  });
  it('deadline abort is a truthful terminal failure with no assistant write', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let entered = false;
      f.complete.mockImplementation(async () => {
        entered = true;
        return new Promise(() => {});
      });
      await f.service.enqueue(actor, 'turn-a');
      const work = f.service.execute(f.job());
      while (!entered) await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(90001);
      await work;
      expect(f.turn.status).toBe('FAILED');
      expect(f.attempts[0].failureCategory).toBe('DEADLINE');
      expect(f.messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('reserves queued attempt, completes with one ordered assistant, and audits no message text', async () => {
    const f = fixture();
    expect((await f.service.enqueue(actor, 'turn-a')).status).toBe('QUEUED');
    expect((await f.service.execute(f.job())).status).toBe('COMPLETED');
    expect(f.messages.map((m) => [m.kind, m.sequence])).toEqual([
      ['HUMAN', 1],
      ['ASSISTANT', 2],
    ]);
    expect(f.attempts[0]).toMatchObject({ status: 'COMPLETED', providerRequests: 1, rounds: 1 });
    expect(JSON.stringify(f.audits)).not.toContain('Unknown without evidence');
    expect(f.audits.map((a) => a.action)).toEqual([
      'collaboration.turn.started',
      'collaboration.turn.completed',
    ]);
  });
  it('duplicate enqueue and queue replay do not duplicate attempts or assistant messages', async () => {
    const f = fixture();
    await Promise.all([f.service.enqueue(actor, 'turn-a'), f.service.enqueue(actor, 'turn-a')]);
    expect(f.attempts).toHaveLength(1);
    await f.service.execute(f.job());
    await f.service.execute(f.job());
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.messages).toHaveLength(2);
  });
  it('active replay never starts a second provider execution', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    f.turn.status = 'RUNNING';
    f.attempts[0].status = 'RUNNING';
    f.attempts[0].deadlineAt = new Date(Date.now() + 90000);
    expect((await f.service.execute(f.job())).status).toBe('NOT_REPLAYED');
    expect(f.complete).not.toHaveBeenCalled();
  });
  it('expired crash lease is interrupted, fenced, and never silently replayed', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    const fence = f.attempts[0].fence;
    f.turn.status = 'RUNNING';
    Object.assign(f.attempts[0], { status: 'RUNNING', deadlineAt: new Date(Date.now() - 1) });
    expect(await f.service.get(actor, 'turn-a')).toMatchObject({
      status: 'INTERRUPTED',
      failureCategory: 'OUTCOME_UNCERTAIN',
    });
    expect(f.attempts[0].fence).not.toBe(fence);
    await f.service.execute(f.job());
    expect(f.complete).not.toHaveBeenCalled();
  });
  it('explicit retry retains failed attempt and uses a new deterministic execution identity', async () => {
    const f = fixture();
    f.providers.resolve.mockRejectedValueOnce(new Error('credential-marker'));
    await f.service.enqueue(actor, 'turn-a');
    await f.service.execute(f.job());
    expect(f.turn.status).toBe('FAILED');
    Object.assign(f.turn.conversation.pullRequest, { baseSha: 'c'.repeat(40) });
    await f.service.enqueue(actor, 'turn-a', 1);
    await f.service.enqueue(actor, 'turn-a', 1);
    expect(f.attempts).toHaveLength(2);
    await f.service.execute(f.job());
    expect(f.messages.filter((m) => m.kind === 'ASSISTANT')).toHaveLength(1);
    expect(f.attempts.map((a) => a.status)).toEqual(['FAILED', 'COMPLETED']);
    expect(f.turn).toMatchObject({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
    expect(JSON.stringify(f.audits)).not.toContain('credential-marker');
  });
  it('completed turns cannot be retried with a new attempt', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    await f.service.execute(f.job());
    await expect(f.service.enqueue(actor, 'turn-a', 1)).rejects.toThrow('not eligible');
  });
  it('queued cancellation prevents any provider request and invalidates tools', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    expect((await f.service.cancel(actor, 'turn-a')).status).toBe('CANCELLED');
    await f.service.execute(f.job());
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.db.collaborationToolCall.updateMany).toHaveBeenCalled();
  });
  it('late completion after cancellation cannot persist an assistant', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const ordinary = f.complete.getMockImplementation()!;
    f.complete.mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return ordinary();
    });
    await f.service.enqueue(actor, 'turn-a');
    const running = f.service.execute(f.job());
    while (!release) await new Promise((r) => setTimeout(r, 1));
    await f.service.cancel(actor, 'turn-a');
    release();
    await running;
    expect(f.messages).toHaveLength(1);
    expect(f.turn.status).toBe('CANCELLED');
  });
  it('cancellation propagates a transport abort signal across API/worker state polling', async () => {
    const f = fixture();
    let entered = false;
    f.complete.mockImplementation(async (params: any) => {
      entered = true;
      return new Promise((_, reject) =>
        params.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    });
    await f.service.enqueue(actor, 'turn-a');
    const running = f.service.execute(f.job());
    while (!entered) await new Promise((r) => setTimeout(r, 1));
    await f.service.cancel(actor, 'turn-a');
    await running;
    expect(f.messages).toHaveLength(1);
    expect(f.turn.status).toBe('CANCELLED');
  });
  it('stale attempt job cannot take ownership after explicit retry', async () => {
    const f = fixture();
    await f.service.enqueue(actor, 'turn-a');
    const old = f.job();
    await f.service.cancel(actor, 'turn-a');
    await f.service.enqueue(actor, 'turn-a', 1);
    await f.service.execute(old);
    expect(f.complete).not.toHaveBeenCalled();
  });
  it('head movement marks execution historical without changing its pin', async () => {
    const f = fixture();
    f.conversation.pullRequest.headSha = 'b'.repeat(40);
    expect((await f.service.get(actor, 'turn-a')).stale).toBe(true);
    expect(f.turn.headSha).toBe('a'.repeat(40));
  });
  it.each(['get', 'cancel', 'enqueue'])('foreign tenant cannot %s turn', async (method) => {
    const f = fixture();
    await expect(
      (f.service as any)[method]({ ...actor, organizationId: 'org-b' }, 'turn-a'),
    ).rejects.toThrow('not found');
    expect(f.queue.enqueueCollaboration).not.toHaveBeenCalled();
  });
  it('foreign queue payload cannot execute', async () => {
    const f = fixture();
    await expect(f.service.execute({ ...f.job(), organizationId: 'org-b' })).rejects.toThrow(
      'not found',
    );
    expect(f.complete).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'enqueue'])(
    'another local actor cannot %s another users turn',
    async (method) => {
      const f = fixture();
      f.db.membership.findFirst.mockResolvedValue({ role: 'DEVELOPER' });
      await expect(
        (f.service as any)[method]({ ...actor, userId: 'user-b' }, 'turn-a', 0),
      ).rejects.toThrow('not found');
    },
  );
  it('queue outage preserves reserved human turn for same-request re-enqueue', async () => {
    const f = fixture();
    f.queue.enqueueCollaboration.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(f.service.enqueue(actor, 'turn-a')).rejects.toThrow('queue unavailable');
    await f.service.enqueue(actor, 'turn-a');
    expect(f.attempts).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
  });
  it('revalidates citation existence at final transaction, not only model parse', async () => {
    const f = fixture();
    const observation = {
      id: 'evidence-a',
      toolCallId: 'call-a',
      sourceType: 'FILE_RANGE',
      provenance: 'EXACT_REVISION',
      observedRevision: 'a'.repeat(40),
      excerpt: 'source',
      metadata: {},
      path: 'src/a.ts',
    };
    f.investigation.list.mockResolvedValue({
      items: [{ id: 'call-a', status: 'SUCCESS' }],
    } as never);
    f.investigation.getCall.mockResolvedValue({ evidence: [observation] });
    f.complete.mockResolvedValue({
      content: JSON.stringify({
        action: 'RESPOND',
        certainty: 'EVIDENCE_BASED',
        content: 'Observation',
        citations: [{ evidenceId: 'evidence-a', claim: 'Source', strength: 'OBSERVED' }],
      }),
      model: 'stub',
      usage: { completionTokens: 10, promptTokens: 10, totalTokens: 20 },
      costCents: 0,
      finishReason: 'stop',
    });
    await f.service.enqueue(actor, 'turn-a');
    await f.service.execute(f.job());
    expect(f.turn.status).toBe('FAILED');
    expect(f.attempts[0].failureCategory).toBe('INVALID_CITATION');
    expect(f.messages).toHaveLength(1);
  });
});
