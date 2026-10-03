import { it, expect, vi } from 'vitest';
import { PatchProposalService } from './patch-proposal.service';
import { patchHash } from './patch-content';
import { ConflictError } from '../common/errors';
const actor = { organizationId: 'org', userId: 'user', traceId: 'test' };
const intent = {
  summary: 'Proposed',
  rationale: 'Context',
  limitations: 'Not applied',
  files: [
    {
      operation: 'MODIFY' as const,
      path: 'a.ts',
      expectedBlobSha: 'c'.repeat(40),
      edits: [{ startLine: 1, endLine: 1, expectedText: 'old', replacement: 'new' }],
      evidenceIds: ['e1'],
    },
  ],
};
function fixture() {
  const turn = {
    id: 'turn',
    organizationId: 'org',
    conversationId: 'conversation',
    pullRequestId: 'pr',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    revisionOfProposalId: null,
    conversation: {
      organizationId: 'org',
      pullRequestId: 'pr',
      pullRequest: {
        id: 'pr',
        organizationId: 'org',
        repositoryId: 'repo',
        headSha: 'a'.repeat(40),
        repository: { organizationId: 'org', fullName: 'owner/repo' },
      },
    },
  };
  const source = {
    revision: turn.headSha,
    path: 'a.ts',
    kind: 'REGULAR_FILE',
    mode: '100644',
    objectSha: 'c'.repeat(40),
    components: [],
    modificationEligible: true,
    content: 'old\n',
    contentHash: patchHash('old\n'),
  };
  const client = { verifyExactFile: vi.fn(async () => source) };
  const db = {
    membership: { findFirst: vi.fn(async () => ({ role: 'DEVELOPER' })) },
    collaborationTurn: { findFirst: vi.fn(async () => turn) },
    evidenceReference: { count: vi.fn(async () => 1) },
    patchProposal: { findFirst: vi.fn(async () => null) },
  };
  const service = new PatchProposalService(
    { unscoped: db } as never,
    { forUser: vi.fn(async () => client) } as never,
  );
  return { service, turn, db, client, source };
}
it('verifies exact pinned source outside any transaction and derives authority server-side', async () => {
  const f = fixture();
  const result = await f.service.prepare(actor, 'turn', intent, {
    requestId: 'action',
    authorType: 'AI',
  });
  expect(f.client.verifyExactFile).toHaveBeenCalledWith('owner/repo', 'a.ts', 'a'.repeat(40), {
    signal: undefined,
  });
  expect(result).toMatchObject({
    repositoryId: 'repo',
    pullRequestId: 'pr',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    revision: 1,
  });
});
it.each(['headSha', 'baseSha'] as const)(
  'missing exact %s fails before Git reads',
  async (field) => {
    const f = fixture();
    f.turn[field] = '';
    await expect(
      f.service.prepare(actor, 'turn', intent, { requestId: 'action', authorType: 'AI' }),
    ).rejects.toThrow('lacks');
    expect(f.client.verifyExactFile).not.toHaveBeenCalled();
  },
);
it('foreign tenant and foreign evidence fail closed before Git reads', async () => {
  const f = fixture();
  f.turn.conversation.pullRequest.repository.organizationId = 'other';
  await expect(
    f.service.prepare(actor, 'turn', intent, { requestId: 'action', authorType: 'AI' }),
  ).rejects.toThrow('not found');
  expect(f.client.verifyExactFile).not.toHaveBeenCalled();
  f.turn.conversation.pullRequest.repository.organizationId = 'org';
  f.db.evidenceReference.count.mockResolvedValue(0);
  await expect(
    f.service.prepare(actor, 'turn', intent, { requestId: 'action', authorType: 'AI' }),
  ).rejects.toThrow('outside');
  expect(f.client.verifyExactFile).not.toHaveBeenCalled();
});
it('membership removal and low privilege fail closed', async () => {
  const f = fixture();
  f.db.membership.findFirst.mockResolvedValue({ role: 'VIEWER' });
  await expect(
    f.service.prepare(actor, 'turn', intent, { requestId: 'action', authorType: 'AI' }),
  ).rejects.toThrow('not found');
});
it('current PR head movement does not repin historical proposal', async () => {
  const f = fixture();
  f.turn.conversation.pullRequest.headSha = 'd'.repeat(40);
  const result = await f.service.prepare(actor, 'turn', intent, {
    requestId: 'action',
    authorType: 'AI',
  });
  expect(result.headSha).toBe('a'.repeat(40));
});
it('wrong exact revision rejects even when blob appears compatible', async () => {
  const f = fixture();
  f.source.revision = 'd'.repeat(40);
  await expect(
    f.service.prepare(actor, 'turn', intent, { requestId: 'action', authorType: 'AI' }),
  ).rejects.toThrow('revision mismatch');
});
it('recovers an identical revision committed between replay check and preparation', async () => {
  const f = fixture(),
    parent = { id: 'parent', turnId: 'turn' },
    child = { id: 'child', requestHash: patchHash(JSON.stringify({ intent, parentId: 'parent' })) };
  f.db.patchProposal.findFirst
    .mockResolvedValueOnce(parent as never)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(child as never);
  vi.spyOn(f.service, 'prepare').mockRejectedValue(new ConflictError('Target superseded'));
  const read = vi.spyOn(f.service, 'get').mockResolvedValue({ id: 'child' } as never);
  expect(
    await f.service.revise(actor, 'parent', { requestId: 'request', proposal: intent }),
  ).toEqual({ id: 'child' });
  expect(read).toHaveBeenCalledWith(actor, 'child');
});
