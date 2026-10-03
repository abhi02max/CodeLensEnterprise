import { it, expect, vi } from 'vitest';
import { validateCollaborationAction, runCollaborator, COLLABORATOR_LIMITS } from './collaborator';
const proposal = {
  summary: 'Prepared change',
  rationale: 'Supporting context',
  limitations: 'Not applied or tested',
  files: [
    {
      operation: 'MODIFY',
      path: 'src/a.ts',
      expectedBlobSha: 'a'.repeat(40),
      edits: [{ startLine: 1, endLine: 1, expectedText: 'old', replacement: 'new' }],
      evidenceIds: ['e1'],
    },
  ],
};
it('accepts bounded data-only proposal with persisted available evidence', () => {
  expect(
    validateCollaborationAction(
      JSON.stringify({ action: 'PROPOSE_PATCH', proposal }),
      new Set(['e1']),
    ).action,
  ).toBe('PROPOSE_PATCH');
});
it('rejects fabricated evidence and authoritative-scope or execution injection', () => {
  expect(() =>
    validateCollaborationAction(JSON.stringify({ action: 'PROPOSE_PATCH', proposal }), new Set()),
  ).toThrow('INVALID_CITATION');
  for (const field of ['tenant', 'repositoryId', 'command', 'shell', 'accepted', 'push'])
    expect(() =>
      validateCollaborationAction(
        JSON.stringify({ action: 'PROPOSE_PATCH', proposal, [field]: 'injected' }),
        new Set(['e1']),
      ),
    ).toThrow('SCHEMA_INVALID');
});
it('invalid proposals consume existing bounded repair budget, not a new loop', async () => {
  const complete = vi.fn(async () => ({
    content: JSON.stringify({
      action: 'PROPOSE_PATCH',
      proposal: { ...proposal, command: 'execute' },
    }),
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    costCents: 0,
    finishReason: 'stop',
    model: 'deterministic',
  }));
  await expect(
    runCollaborator({
      provider: { name: 'DETERMINISTIC', complete } as never,
      context: { question: 'Propose', metadata: {}, recent: [], evidence: [] },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + COLLABORATOR_LIMITS.deadlineMs,
      checkpoint: async () => {},
      tool: async () => {
        throw new Error('No execution');
      },
    }),
  ).rejects.toThrow('SCHEMA_INVALID');
  expect(complete).toHaveBeenCalledTimes(2);
});
