import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '@codelens/shared';
import { indexRepository } from './indexer';
import type { PgVectorStore } from './pgvector-store';

const path = 'README.md';
const content = '# Refund policy\n\nEvery overcredit refund needs ledger verification and reviewer approval. ' +
  'The charge identifier must stay tenant scoped throughout the payment flow.\n';

function options(treeComplete = false) {
  return {
    repositoryId: 'repo-1',
    commitSha: 'commit-1',
    treeFiles: [{ path, sizeBytes: Buffer.byteLength(content) }],
    force: false,
    maxFiles: 10,
    includePaths: [],
    excludePatterns: [],
    fetchConcurrency: 1,
    treeComplete,
  };
}

function dependencies(embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))) {
  const store = {
    existingHashes: vi.fn(async () => new Map()),
    upsert: vi.fn(async () => undefined),
    pruneIndexedPaths: vi.fn(async () => 0),
    indexedPaths: vi.fn(async () => [path, 'deleted.md']),
    deleteByPaths: vi.fn(async () => 0),
  };
  return {
    store,
    embeddings: { model: 'test', dimensions: 2, embed } as EmbeddingProvider,
    source: { fetch: vi.fn(async () => content) },
  };
}

describe('index reconciliation', () => {
  it('prunes superseded chunks only after replacements are stored', async () => {
    const deps = dependencies();
    const progress = await indexRepository({
      store: deps.store as unknown as PgVectorStore,
      embeddings: deps.embeddings,
      source: deps.source,
    }, options());

    expect(progress.status).toBe('INDEXED');
    expect(deps.store.upsert).toHaveBeenCalledOnce();
    expect(deps.store.pruneIndexedPaths).toHaveBeenCalledWith(
      'repo-1',
      [path],
      expect.arrayContaining([expect.objectContaining({ path, contentHash: expect.any(String) })]),
    );
    expect(deps.store.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      deps.store.pruneIndexedPaths.mock.invocationCallOrder[0]!,
    );
    expect(deps.store.deleteByPaths).not.toHaveBeenCalled();
  });

  it('retains old chunks when embedding fails', async () => {
    const deps = dependencies(vi.fn(async () => { throw new Error('provider unavailable'); }));
    const progress = await indexRepository({
      store: deps.store as unknown as PgVectorStore,
      embeddings: deps.embeddings,
      source: deps.source,
    }, options(true));

    expect(progress.status).toBe('FAILED');
    expect(deps.store.pruneIndexedPaths).not.toHaveBeenCalled();
    expect(deps.store.deleteByPaths).not.toHaveBeenCalled();
  });

  it('removes absent paths only for an explicitly complete tree', async () => {
    const deps = dependencies();
    await indexRepository({
      store: deps.store as unknown as PgVectorStore,
      embeddings: deps.embeddings,
      source: deps.source,
    }, options(true));

    expect(deps.store.deleteByPaths).toHaveBeenCalledWith('repo-1', ['deleted.md']);
  });
});
