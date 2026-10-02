import { describe, expect, it, vi } from 'vitest';
vi.mock('../../rag/rag.service', () => ({ RagService: class {} }));
vi.mock('../queue.service', () => ({ classifyJobError: (error: unknown) => error }));
import { RepoIndexProcessor } from './repo-index.processor';

describe('repository indexing queue outcome', () => {
  it('rejects a failed engine result without publishing completion or leaking its error', async () => {
    const indexRepository = vi.fn(async () => ({ status: 'FAILED', error: 'sensitive-provider-body' }));
    const updateProgress = vi.fn(async () => {});
    const processor = new RepoIndexProcessor({} as never, { indexRepository } as never);
    await expect(processor.process({ data: { repositoryId: 'repo-1' }, updateProgress } as never))
      .rejects.toThrow('Repository indexing failed; see the index run diagnostics');
    expect(updateProgress.mock.calls.map(([progress]) => progress)).not.toContainEqual(
      expect.objectContaining({ stage: 'DONE' }),
    );
    expect(updateProgress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'FAILED' }));
    expect(JSON.stringify(updateProgress.mock.calls)).not.toContain('sensitive-provider-body');
  });

  it('publishes completion only for a successfully persisted index', async () => {
    const progress = { status: 'INDEXED', filesProcessed: 3, chunksCreated: 3, chunksReused: 2,
      embeddingsGenerated: 1, estimatedCostCents: 1, cacheHitRate: 2 / 3 };
    const updateProgress = vi.fn(async () => {});
    const processor = new RepoIndexProcessor({} as never,
      { indexRepository: vi.fn(async () => progress) } as never);
    await expect(processor.process({ data: { repositoryId: 'repo-1' }, updateProgress } as never))
      .resolves.toMatchObject({ repositoryId: 'repo-1', status: 'INDEXED', embeddingsGenerated: 1 });
    expect(updateProgress).toHaveBeenLastCalledWith({ percent: 100, stage: 'DONE', message: 'Index complete' });
  });
});
