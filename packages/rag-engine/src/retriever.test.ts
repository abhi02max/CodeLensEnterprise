import { describe, expect, it, vi } from 'vitest';
import { ChunkKind, RetrievalSource, type EmbeddingProvider } from '@codelens/shared';
import { HybridRetriever, fuseCandidates, maximalMarginalRelevance } from './retriever';
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
  it('normalizes independent scales and fuses overlapping IDs without losing sources', () => {
    const fused = fuseCandidates([
      { source: RetrievalSource.VECTOR, hits: [{ chunkId: 'A', score: 0.8 }, { chunkId: 'B', score: 0.7 }] },
      { source: RetrievalSource.LEXICAL, hits: [{ chunkId: 'A', score: 1000 }, { chunkId: 'C', score: 900 }] },
    ]);
    expect(fused.size).toBe(3);
    expect(fused.get('A')).toMatchObject({ score: 1.12, vectorScore: 0.8, lexicalScore: 1000,
      sources: [RetrievalSource.VECTOR, RetrievalSource.LEXICAL] });
    expect(fused.get('B')?.score).toBeCloseTo(0.875);
    expect(fused.get('C')?.score).toBeCloseTo(0.765);
    expect(fused.get('B')!.score).toBeGreaterThan(fused.get('C')!.score);
  });

  it('retains all contributing strategies', () => {
    const sources = Object.values(RetrievalSource);
    const result = fuseCandidates(sources.map((source) => ({ source, hits: [{ chunkId: 'A', score: 1 }] })));
    expect(result.size).toBe(1);
    expect(result.get('A')?.sources).toEqual(sources);
  });

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

describe('hybrid embedding outage', () => {
  it('still retrieves lexical context without inventing vector evidence', async () => {
    const { retriever: subject, store } = retriever(async () => { throw new Error('unavailable'); });
    Object.assign(store, { searchImportGraph: vi.fn(async () => []), findByPaths: vi.fn(async () => []) });
    const result = await subject.retrieve({ repositoryId: 'repo-1', query: 'refund', symbols: ['refund'],
      topK: 2, excludePaths: [], graphSeedPaths: [], kinds: [], maxTokens: 256, mmrLambda: 0.7 });
    expect(store.search).not.toHaveBeenCalled();
    expect(result.candidateCounts.VECTOR).toBe(0);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({ sources: [RetrievalSource.LEXICAL], vectorScore: null, lexicalScore: 0.25 });
  });
});

describe('MMR mechanics', () => {
  const candidates = (): Array<{ chunk: StoredChunk; score: number }> => [
    { chunk: { ...chunk, id: 'A', path: 'a.ts', embedding: [1, 0] }, score: 1 },
    { chunk: { ...chunk, id: 'B', path: 'b.ts', embedding: [1, 0] }, score: 0.95 },
    { chunk: { ...chunk, id: 'C', path: 'c.ts', embedding: [0, 1] }, score: 0.8 },
  ];
  const select = (rows: ReturnType<typeof candidates>, lambda: number, limit: number) =>
    maximalMarginalRelevance({ candidates: rows, lambda, limit, queryEmbedding: [1, 0] }).selected.map((row) => row.chunk.id);

  it('selects relevance order when diversity is disabled', () => {
    expect(select(candidates(), 1, 2)).toEqual(['A', 'B']);
  });
  it('selects a lower-relevance distinct candidate ahead of a near duplicate', () => {
    // After A: B = .5*.95 - .5*1 = -.025; C = .5*.8 - .5*0 = .4.
    expect(select(candidates(), 0.5, 2)).toEqual(['A', 'C']);
  });
  it('returns available candidates when fewer than k exist, including empty input', () => {
    expect(select(candidates(), 1, 10)).toEqual(['A', 'B', 'C']);
    expect(select([], 0.5, 2)).toEqual([]);
  });
  it('uses content overlap for missing or mixed embeddings', () => {
    const rows = candidates();
    rows[0]!.chunk.content = 'refund payments errors';
    rows[1]!.chunk.content = 'refund payments errors';
    rows[2]!.chunk.content = 'database schema migrations';
    rows[1]!.chunk.embedding = null;
    expect(select(rows, 0.5, 2)).toEqual(['A', 'C']);
    rows[0]!.chunk.embedding = null;
    rows[2]!.chunk.embedding = null;
    expect(select(rows, 0.5, 2)).toEqual(['A', 'C']);
  });
  it('preserves candidate order for equal MMR objectives', () => {
    const rows = candidates();
    rows[2]!.score = rows[1]!.score;
    expect(select(rows, 1, 3)).toEqual(['A', 'B', 'C']);
  });
});
