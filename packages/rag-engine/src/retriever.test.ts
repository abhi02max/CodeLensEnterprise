import { describe, expect, it, vi } from 'vitest';
import { ChunkKind, RetrievalSource, type EmbeddingProvider } from '@codelens/shared';
import { HybridRetriever, fuseCandidates } from './retriever';
import type { PgVectorStore, StoredChunk } from './pgvector-store';

const chunk: StoredChunk = {
  id: 'doc-1',
  path: 'docs/architecture.md',
  symbol: 'Error handling',
  kind: ChunkKind.DOC_SECTION,
  language: 'markdown',
  content: 'Refund errors are handled by the payment service.',
  startLine: 1,
  endLine: 1,
  tokenCount: 12,
  metadata: {},
  embedding: null,
};

function retriever(embedOne: () => Promise<number[]>) {
  const store = {
    search: vi.fn(async () => [{ chunkId: chunk.id, score: 0.8 }]),
    searchLexical: vi.fn(async () => [{ chunkId: chunk.id, score: 0.25 }]),
    loadChunks: vi.fn(async () => [chunk]),
  };
  const embeddings = { model: 'test', dimensions: 1536, embedOne };
  return {
    store,
    retriever: new HybridRetriever({
      store: store as unknown as PgVectorStore,
      embeddings: embeddings as EmbeddingProvider,
    }),
  };
}

describe('repository overview provenance', () => {
  it('labels lexical fallback as lexical when query embedding fails', async () => {
    const { retriever: subject, store } = retriever(async () => {
      throw new Error('no embedding provider');
    });
    const [result] = await subject.retrieveRepositoryOverview({
      repositoryId: 'repo-1',
      query: 'refund error handling',
      maxTokens: 100,
    });

    expect(store.search).not.toHaveBeenCalled();
    expect(store.searchLexical).toHaveBeenCalledOnce();
    expect(result?.sources).toEqual([RetrievalSource.LEXICAL]);
    expect(result?.lexicalScore).toBe(0.25);
    expect(result?.vectorScore).toBeNull();
    expect(result?.rationale).not.toMatch(/semantically similar/i);
  });

  it('retains vector provenance when vector search actually runs', async () => {
    const { retriever: subject, store } = retriever(async () => [1, 0]);
    const [result] = await subject.retrieveRepositoryOverview({
      repositoryId: 'repo-1',
      query: 'refund error handling',
      maxTokens: 100,
    });

    expect(store.search).toHaveBeenCalledOnce();
    expect(store.searchLexical).not.toHaveBeenCalled();
    expect(result?.sources).toEqual([RetrievalSource.VECTOR]);
    expect(result?.vectorScore).toBe(0.8);
    expect(result?.lexicalScore).toBeNull();
  });
});

describe('candidate fusion', () => {
  it('keeps a negative raw vector score without amplifying it into a huge negative rank', () => {
    const [candidate] = fuseCandidates([
      {
        source: RetrievalSource.VECTOR,
        hits: [{ chunkId: 'negative', score: -0.0248 }],
      },
    ]).values();

    expect(candidate?.vectorScore).toBe(-0.0248);
    expect(candidate?.sources).toEqual([RetrievalSource.VECTOR]);
    expect(candidate?.score).toBe(0);
  });
});
