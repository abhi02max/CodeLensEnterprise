import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  CreateConversationSchema,
  CreateConversationMessageSchema,
  ConversationAnchorSchema,
  GetConversationSchema,
  ListConversationsSchema,
} from '@codelens/shared';
import { CollaborationService } from './collaboration.service';

const actor = { organizationId: 'org-a', userId: 'user-a', traceId: 'trace-a' };
const head = 'a'.repeat(40);
const now = new Date('2026-10-02T00:00:00Z');
function fixture() {
  const conversation = {
    id: 'conversation-a',
    organizationId: 'org-a',
    pullRequestId: 'pr-a',
    createdById: 'user-a',
    title: 'Discuss query',
    anchor: { kind: 'PR' },
    status: 'OPEN',
    lastSequence: 0,
    createdBy: { id: 'user-a', name: 'Developer' },
    createdAt: now,
    updatedAt: now,
    requestHash: '',
  };
  const pr = {
    id: 'pr-a',
    organizationId: 'org-a',
    headSha: head,
    number: 1,
    repository: { fullName: 'test/repo', organizationId: 'org-a' },
  };
  const db = {
    membership: {
      findFirst: vi.fn(async ({ where }) =>
        where.organizationId === 'org-a' && where.userId === 'user-a' ? {} : null,
      ),
    },
    pullRequest: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === 'pr-a' && where.organizationId === 'org-a' ? pr : null,
      ),
    },
    conversation: {
      findFirst: vi.fn(async ({ where }) =>
        where.organizationId === 'org-a' && where.id === 'conversation-a' ? conversation : null,
      ),
      create: vi.fn(async ({ data }) => ({ ...conversation, ...data })),
      update: vi.fn(),
      findMany: vi.fn(async () => [conversation]),
    },
    conversationMessage: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }) => ({
        id: 'message-a',
        kind: 'HUMAN',
        ...data,
        createdBy: conversation.createdBy,
        createdAt: now,
        turn: {
          id: 'turn-a',
          conversationId: conversation.id,
          headSha: head,
          reviewRunId: 'run-a',
          sequence: data.sequence,
          status: 'RECORDED',
          initiatedById: actor.userId,
          createdAt: now,
          requestHash: '',
        },
      })),
    },
    collaborationTurn: { create: vi.fn(async ({ data }) => ({ id: 'turn-a', ...data })) },
    reviewRun: { findFirst: vi.fn(async () => ({ id: 'run-a' })) },
    pullRequestFile: { findFirst: vi.fn(async () => ({ id: 'file-a' })) },
    staticFinding: { findFirst: vi.fn(async () => null) },
    aiReview: { findFirst: vi.fn(async () => null) },
    comment: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => []),
  };
  const transaction = vi.fn(async (fn) => fn(db));
  const getPullRequest = vi.fn(async () => ({ headSha: head }));
  const github = { forUser: vi.fn(async () => ({ getPullRequest })) };
  const service = new CollaborationService(
    { unscoped: db, $transaction: transaction } as never,
    github as never,
  );
  return { service, db, transaction, github, getPullRequest, conversation, pr };
}
const creation = () =>
  CreateConversationSchema.parse({ requestId: randomUUID(), title: 'Discuss query' });
const message = () => ({ requestId: randomUUID(), content: 'Where does this value originate?' });

describe('conversation foundation', () => {
  it('refuses startup when the forward migration is missing', async () => {
    const { service } = fixture();
    await expect(service.onModuleInit()).rejects.toThrow('Conversation schema is not ready');
  });
  it('verifies readiness without mutating schema', async () => {
    const { service, db } = fixture();
    db.$queryRaw.mockResolvedValue([{ ready: true }]);
    await service.onModuleInit();
    expect(db.conversation.create).not.toHaveBeenCalled();
  });
  it('creates PR-owned context and transactionally records safe audit metadata', async () => {
    const { service, db, transaction } = fixture();
    expect((await service.create(actor, 'pr-a', creation())).pullRequestId).toBe('pr-a');
    expect(transaction).toHaveBeenCalledOnce();
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'collaboration.conversation.created',
      actorId: actor.userId,
      metadata: { contextKind: 'PR' },
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('Discuss query');
  });
  it('lists scoped conversations and returns stable cursor pagination', async () => {
    const { service, db, conversation } = fixture();
    db.conversation.findMany.mockResolvedValue([
      conversation,
      { ...conversation, id: 'conversation-b' },
    ]);
    const result = await service.list(actor, 'pr-a', { limit: 1 });
    expect(result.items.map((row) => row.id)).toEqual(['conversation-a']);
    expect(result.nextAfterId).toBe('conversation-a');
  });
  it('reads bounded ordered history with collaboration execution enabled', async () => {
    const { service, db } = fixture();
    expect(
      await service.get(actor, 'conversation-a', { afterSequence: 0, limit: 20 }),
    ).toMatchObject({ messages: [], nextAfterSequence: null, aiExecutionAvailable: true });
    expect(db.conversationMessage.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { sequence: 'asc' },
      take: 21,
      where: { organizationId: 'org-a' },
    });
  });
  it('records one human message/turn at the upstream-verified head, not a queued AI job', async () => {
    const { service, db, github } = fixture();
    const result = await service.message(actor, 'conversation-a', message());
    expect(result).toMatchObject({
      aiExecutionAvailable: false,
      message: { sequence: 1, kind: 'HUMAN', turn: { headSha: head, status: 'RECORDED' } },
    });
    expect(github.forUser).toHaveBeenCalledWith(actor.userId);
    expect(db.collaborationTurn.create.mock.calls[0][0].data.reviewRunId).toBe('run-a');
    expect(db.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({
      contentLength: message().content.length,
      sequence: 1,
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(
      'Where does this value originate?',
    );
  });
  it('advances the explicit sequence independently of timestamps', async () => {
    const { service, conversation } = fixture();
    conversation.lastSequence = 5;
    expect((await service.message(actor, conversation.id, message())).message.sequence).toBe(6);
  });
  it('does not require an analysis run', async () => {
    const { service, db } = fixture();
    db.reviewRun.findFirst.mockResolvedValue(null);
    await service.message(actor, 'conversation-a', message());
    expect(db.collaborationTurn.create.mock.calls[0][0].data.reviewRunId).toBeNull();
  });
  it.each(['org-b', 'unknown'])(
    'does not expose guessed conversations to tenant %s',
    async (organizationId) => {
      const { service, db } = fixture();
      await expect(
        service.get({ ...actor, organizationId }, 'conversation-a', {
          afterSequence: 0,
          limit: 20,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(
        service.message({ ...actor, organizationId }, 'conversation-a', message()),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(
        service.list({ ...actor, organizationId }, 'pr-a', { limit: 20 }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(db.conversationMessage.create).not.toHaveBeenCalled();
    },
  );
  it('rejects an actor with no current membership even if a conversation ID is valid', async () => {
    const { service, db } = fixture();
    await expect(
      service.message({ ...actor, userId: 'departed-user' }, 'conversation-a', message()),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(db.collaborationTurn.create).not.toHaveBeenCalled();
  });
  it('gives identical inaccessible responses for known/guessed IDs after membership removal', async () => {
    const { service, db } = fixture();
    const departed = { ...actor, userId: 'departed-user' };
    const errors = await Promise.all(
      ['conversation-a', 'guessed'].map(async (id) => {
        try {
          await service.get(departed, id, { afterSequence: 0, limit: 20 });
        } catch (error) {
          return error;
        }
      }),
    );
    expect(errors[0].getResponse()).toEqual(errors[1].getResponse());
    expect(db.conversation.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'STATIC_FINDING', findingId: 'foreign' },
    { kind: 'AI_FINDING', reviewRunId: 'foreign', findingIndex: 0 },
    { kind: 'COMMENT', commentId: 'foreign' },
  ])('rejects foreign nested anchor $kind', async (anchor) => {
    const { service } = fixture();
    await expect(
      service.create(actor, 'pr-a', CreateConversationSchema.parse({ ...creation(), anchor })),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('rejects a path not in the authorized PR', async () => {
    const { service, db } = fixture();
    db.pullRequestFile.findFirst.mockResolvedValue(null);
    await expect(
      service.create(actor, 'pr-a', { ...creation(), anchor: { kind: 'FILE', path: 'other.ts' } }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('rejects another PR cursor without leaking its existence', async () => {
    const { service } = fixture();
    await expect(
      service.list(actor, 'pr-a', { limit: 20, afterId: 'foreign' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('fails closed on unavailable or missing upstream head without writes', async () => {
    const { service, getPullRequest, db } = fixture();
    getPullRequest.mockRejectedValue(new Error('upstream contains sensitive detail'));
    await expect(service.message(actor, 'conversation-a', message())).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(db.collaborationTurn.create).not.toHaveBeenCalled();
  });
  it('rejects a stale cached PR instead of silently pinning it', async () => {
    const { service, pr, db } = fixture();
    pr.headSha = 'b'.repeat(40);
    await expect(service.message(actor, 'conversation-a', message())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.conversationMessage.create).not.toHaveBeenCalled();
  });
  it('replays creation without a second audit row and conflicts on incompatible reuse', async () => {
    const { service, db } = fixture();
    const input = creation();
    const created = await service.create(actor, 'pr-a', input);
    const persisted = db.conversation.create.mock.results[0];
    db.conversation.findFirst.mockResolvedValue(await persisted.value);
    expect(await service.create(actor, 'pr-a', input)).toEqual(created);
    await expect(
      service.create(actor, 'pr-a', { ...input, title: 'Different' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.conversation.create).toHaveBeenCalledOnce();
    expect(db.auditLog.create).toHaveBeenCalledOnce();
  });
  it('replays persisted messages even during an upstream outage; conflicting reuse fails', async () => {
    const { service, db, github } = fixture();
    const input = message();
    await service.message(actor, 'conversation-a', input);
    const row = await db.conversationMessage.create.mock.results[0].value;
    row.turn.requestHash = db.collaborationTurn.create.mock.calls[0][0].data.requestHash;
    db.conversationMessage.findFirst.mockResolvedValue(row);
    expect((await service.message(actor, 'conversation-a', input)).message.id).toBe(row.id);
    await expect(
      service.message(actor, 'conversation-a', { ...input, content: 'Different' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(github.forUser).toHaveBeenCalledOnce();
    expect(db.conversationMessage.create).toHaveBeenCalledOnce();
  });
  it('propagates transactional audit failures instead of falsely reporting an audited mutation', async () => {
    const { service, db } = fixture();
    db.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(service.create(actor, 'pr-a', creation())).rejects.toThrow('audit unavailable');
  });
});

describe('closed, bounded conversation contracts', () => {
  it.each([
    { content: 'a'.repeat(8001) },
    { content: '' },
    { content: 'hello', kind: 'ASSISTANT' },
    { content: 'hello', createdById: 'foreign' },
    { content: 'hello', reviewRunId: 'foreign' },
  ])('rejects invalid message input %j', (fields) => {
    expect(
      CreateConversationMessageSchema.safeParse({ requestId: randomUUID(), ...fields }).success,
    ).toBe(false);
  });
  it.each(['../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'a/../b', 'a//b', 'a\u0000b'])(
    'rejects unsafe path %s',
    (path) => {
      expect(ConversationAnchorSchema.safeParse({ kind: 'FILE', path }).success).toBe(false);
    },
  );
  it('bounds range/title/pagination and rejects arbitrary scope metadata', () => {
    expect(
      ConversationAnchorSchema.safeParse({
        kind: 'RANGE',
        path: 'src/a.ts',
        startLine: 5,
        endLine: 4,
        side: 'RIGHT',
      }).success,
    ).toBe(false);
    expect(
      CreateConversationSchema.safeParse({ ...creation(), title: 'x'.repeat(161) }).success,
    ).toBe(false);
    expect(
      CreateConversationSchema.safeParse({ ...creation(), organizationId: 'other' }).success,
    ).toBe(false);
    expect(GetConversationSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(ListConversationsSchema.safeParse({ limit: -1 }).success).toBe(false);
  });
});
