import {
  ChunkKind,
  RetrievalSource,
  cosineSimilarity,
  guessTestPaths,
  type EmbeddingProvider,
  type RetrievalResult,
  type RetrieveContextInput,
  type RetrievedChunk,
} from '@codelens/shared';
import type { PgVectorStore, StoredChunk } from './pgvector-store';

/**
 * Hybrid retrieval.
 *
 * Naive top-k vector search is the default implementation of RAG and it is not
 * good enough for code review. It fails in three specific ways that this module
 * addresses:
 *
 *   1. It misses exact identifier matches. Embeddings encode meaning, and a diff
 *      calling `recordRefund` shares little vocabulary with the function that
 *      defines it. LEXICAL search over a weighted tsvector finds it directly.
 *
 *   2. It misses structural relationships. The caller that breaks when a
 *      signature changes may be textually unrelated to it. IMPORT_GRAPH walks the
 *      import metadata to find it.
 *
 *   3. It returns near-duplicates. The five closest chunks to a query are
 *      frequently five variations of the same code, which burns the token budget
 *      on redundancy. MMR re-ranking trades a little relevance for coverage.
 *
 * CONVENTION is the fourth strategy and exists for a product reason rather than
 * an information-retrieval one: when the AI suggests tests, it should follow the
 * conventions this repository already uses, so the linked test file is retrieved
 * deliberately rather than hoped for.
 */

export interface RetrieverDependencies {
  store: PgVectorStore;
  embeddings: EmbeddingProvider;
}

/**
 * Per-strategy weights applied during score fusion.
 *
 * Vector leads because it generalizes. Lexical is close behind because an exact
 * symbol match is strong evidence when it happens. The structural strategies are
 * weighted lower: they establish that a chunk is *related*, not that it is
 * relevant to this particular query.
 */
const SOURCE_WEIGHTS: Record<RetrievalSource, number> = {
  VECTOR: 1.0,
  LEXICAL: 0.85,
  IMPORT_GRAPH: 0.55,
  CONVENTION: 0.6,
};

export class HybridRetriever {
  constructor(private readonly deps: RetrieverDependencies) {}

  async retrieve(input: RetrieveContextInput): Promise<RetrievalResult> {
    const startedAt = Date.now();

    const candidateCounts: Record<RetrievalSource, number> = {
      VECTOR: 0,
      LEXICAL: 0,
      IMPORT_GRAPH: 0,
      CONVENTION: 0,
    };

    // Over-fetch relative to topK: fusion and MMR both need headroom to choose
    // from, and a candidate pool the size of the final result makes re-ranking
    // meaningless.
    const poolSize = Math.max(input.topK * 3, 24);

    /**
     * Embedding failure degrades to the three non-vector strategies rather than failing.
     *
     * The vector leg is the strongest single signal, but it is also the only one with an
     * external dependency: it needs an embedding provider, which can be unconfigured, rate
     * limited, or down. Lexical, import-graph and convention retrieval all run entirely inside
     * Postgres and need no embedding at all.
     *
     * Hard-requiring the vector leg would mean an embedding outage produces reviews with no
     * repository context whatsoever, when three quarters of the retrieval machinery was still
     * available. Callers can detect the degradation from `candidateCounts.VECTOR === 0`.
     */
    let queryEmbedding: number[] | null = null;

    try {
      queryEmbedding = await this.deps.embeddings.embedOne(input.query);
    } catch (error) {
      queryEmbedding = null;
    }

    const conventionPaths = buildConventionPaths(input.graphSeedPaths);

    const [vectorHits, lexicalHits, graphHits, conventionHits] = await Promise.all([
      queryEmbedding
        ? this.deps.store.search({
            repositoryId: input.repositoryId,
            embedding: queryEmbedding,
            topK: poolSize,
            excludePaths: input.excludePaths,
            kinds: input.kinds.length > 0 ? input.kinds : undefined,
          })
        : Promise.resolve([]),
      input.symbols.length > 0
        ? this.deps.store.searchLexical({
            repositoryId: input.repositoryId,
            terms: input.symbols,
            topK: poolSize,
            excludePaths: input.excludePaths,
          })
        : Promise.resolve([]),
      input.graphSeedPaths.length > 0
        ? this.deps.store.searchImportGraph({
            repositoryId: input.repositoryId,
            seedPaths: input.graphSeedPaths,
            topK: Math.ceil(poolSize / 2),
            excludePaths: input.excludePaths,
          })
        : Promise.resolve([]),
      conventionPaths.length > 0
        ? this.deps.store.findByPaths({
            repositoryId: input.repositoryId,
            paths: conventionPaths,
            limit: 8,
          })
        : Promise.resolve([]),
    ]);

    candidateCounts.VECTOR = vectorHits.length;
    candidateCounts.LEXICAL = lexicalHits.length;
    candidateCounts.IMPORT_GRAPH = graphHits.length;
    candidateCounts.CONVENTION = conventionHits.length;

    // ---- fusion
    const fused = fuseCandidates([
      { source: RetrievalSource.VECTOR, hits: vectorHits },
      { source: RetrievalSource.LEXICAL, hits: lexicalHits },
      { source: RetrievalSource.IMPORT_GRAPH, hits: graphHits },
      { source: RetrievalSource.CONVENTION, hits: conventionHits },
    ]);

    if (fused.size === 0) {
      return {
        chunks: [],
        totalTokens: 0,
        candidateCounts,
        droppedForDiversity: 0,
        droppedForBudget: 0,
        durationMs: Date.now() - startedAt,
        embeddingModel: this.deps.embeddings.model,
      };
    }

    const stored = await this.deps.store.loadChunks([...fused.keys()]);
    const storedById = new Map(stored.map((chunk) => [chunk.id, chunk]));

    const candidates = [...fused.values()]
      .map((candidate) => {
        const chunk = storedById.get(candidate.chunkId);
        return chunk ? { ...candidate, chunk } : null;
      })
      .filter((value): value is FusedCandidate & { chunk: StoredChunk } => value !== null)
      .sort((a, b) => b.score - a.score);

    // ---- MMR re-ranking
    //
    // Works without a query embedding: the diversity penalty compares candidates to each other,
    // not to the query, and falls back to token overlap when chunk embeddings are absent.
    const { selected, droppedForDiversity } = maximalMarginalRelevance({
      candidates,
      queryEmbedding: queryEmbedding ?? [],
      lambda: input.mmrLambda,
      limit: input.topK,
    });

    // ---- token budget
    const chunks: RetrievedChunk[] = [];
    let totalTokens = 0;
    let droppedForBudget = 0;

    for (const candidate of selected) {
      if (totalTokens + candidate.chunk.tokenCount > input.maxTokens && chunks.length > 0) {
        droppedForBudget += 1;
        continue;
      }

      totalTokens += candidate.chunk.tokenCount;
      chunks.push(toRetrievedChunk(candidate));
    }

    return {
      chunks,
      totalTokens,
      candidateCounts,
      droppedForDiversity,
      droppedForBudget,
      durationMs: Date.now() - startedAt,
      embeddingModel: this.deps.embeddings.model,
    };
  }

  /**
   * Repository-level context: README and architecture documentation.
   *
   * Retrieved once per review rather than per file. This is what lets the AI cite
   * a repository's stated conventions instead of offering generic advice, which is
   * the single biggest qualitative difference between a useful review and a
   * plausible-sounding one.
   */
  async retrieveRepositoryOverview(params: {
    repositoryId: string;
    query: string;
    maxTokens: number;
  }): Promise<RetrievedChunk[]> {
    // Same degradation as retrieve(): without an embedding provider, fall back to lexical
    // search over the query terms plus the conventional documentation paths.
    let embedding: number[] | null = null;

    try {
      embedding = await this.deps.embeddings.embedOne(params.query);
    } catch {
      embedding = null;
    }

    const hits = embedding
      ? await this.deps.store.search({
          repositoryId: params.repositoryId,
          embedding,
          topK: 10,
          kinds: [ChunkKind.DOC_SECTION, ChunkKind.SCHEMA_MODEL],
        })
      : await this.deps.store.searchLexical({
          repositoryId: params.repositoryId,
          terms: params.query.split(/\W+/).filter((term) => term.length > 3),
          topK: 10,
        });

    const stored = await this.deps.store.loadChunks(hits.map((hit) => hit.chunkId));
    const byId = new Map(stored.map((chunk) => [chunk.id, chunk]));

    const chunks: RetrievedChunk[] = [];
    let tokens = 0;

    for (const hit of hits) {
      const chunk = byId.get(hit.chunkId);
      if (!chunk) continue;
      if (tokens + chunk.tokenCount > params.maxTokens && chunks.length > 0) continue;

      tokens += chunk.tokenCount;
      chunks.push(
        toRetrievedChunk({
          chunkId: chunk.id,
          score: hit.score,
          vectorScore: embedding ? hit.score : null,
          lexicalScore: embedding ? null : hit.score,
          sources: [embedding ? RetrievalSource.VECTOR : RetrievalSource.LEXICAL],
          chunk,
        }),
      );
    }

    return chunks;
  }
}

// ---------------------------------------------------------------- fusion

interface FusedCandidate {
  chunkId: string;
  score: number;
  vectorScore: number | null;
  lexicalScore: number | null;
  sources: RetrievalSource[];
}

/**
 * Fuse ranked lists from multiple strategies.
 *
 * Scores from different strategies are not comparable — cosine similarity lives
 * in [0,1] while `ts_rank` is unbounded and typically small — so each list is
 * normalized to its own maximum before weighting. Reciprocal-rank fusion would be
 * the alternative; normalized weighting is used here because it preserves the
 * *margin* between a strong and a weak match, which matters when deciding what
 * fits in a token budget.
 *
 * A chunk found by several strategies receives a bonus. Independent agreement is
 * meaningful evidence: if both the embedding and an exact symbol match point at
 * the same function, it is almost certainly the right one.
 */
export function fuseCandidates(
  lists: ReadonlyArray<{ source: RetrievalSource; hits: ReadonlyArray<{ chunkId: string; score: number }> }>,
): Map<string, FusedCandidate> {
  const fused = new Map<string, FusedCandidate>();

  for (const { source, hits } of lists) {
    if (hits.length === 0) continue;

    const maxScore = Math.max(...hits.map((hit) => hit.score), Number.EPSILON);

    for (const hit of hits) {
      // Cosine similarity may be negative (especially with deterministic test vectors).
      // It is evidence of a vector hit, but not negative relevance to amplify by EPSILON.
      const normalized = Math.max(0, hit.score) / maxScore;
      const weighted = normalized * SOURCE_WEIGHTS[source];

      const existing = fused.get(hit.chunkId);

      if (!existing) {
        fused.set(hit.chunkId, {
          chunkId: hit.chunkId,
          score: weighted,
          vectorScore: source === RetrievalSource.VECTOR ? hit.score : null,
          lexicalScore: source === RetrievalSource.LEXICAL ? hit.score : null,
          sources: [source],
        });
        continue;
      }

      // Take the best single contribution, then add a multi-source bonus rather
      // than summing: summing would let three weak signals outrank one strong one.
      existing.score = Math.max(existing.score, weighted) + 0.12;
      existing.sources.push(source);

      if (source === RetrievalSource.VECTOR) existing.vectorScore = hit.score;
      if (source === RetrievalSource.LEXICAL) existing.lexicalScore = hit.score;
    }
  }

  return fused;
}

// ---------------------------------------------------------------- MMR

/**
 * Maximal Marginal Relevance.
 *
 * Iteratively selects the candidate maximizing
 *
 *   λ · relevance(candidate) − (1 − λ) · max similarity(candidate, already selected)
 *
 * λ=1 reduces to plain relevance ranking and reproduces the duplicate problem;
 * λ=0 selects for pure novelty and returns unrelated chunks. The default 0.7
 * keeps relevance dominant while breaking up clusters of near-identical code.
 *
 * Chunks without a stored embedding fall back to token-overlap similarity, so a
 * row that failed to embed still participates rather than being silently dropped.
 */
export function maximalMarginalRelevance<T extends { chunk: StoredChunk; score: number }>(params: {
  candidates: readonly T[];
  queryEmbedding: number[];
  lambda: number;
  limit: number;
}): { selected: T[]; droppedForDiversity: number } {
  const { candidates, lambda, limit } = params;
  if (candidates.length === 0) return { selected: [], droppedForDiversity: 0 };

  const selected: T[] = [];
  const remaining = [...candidates];

  // Highest-relevance candidate seeds the selection; with nothing selected yet
  // the diversity penalty is zero, so this is just argmax relevance.
  const first = remaining.shift();
  if (first) selected.push(first);

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (const [index, candidate] of remaining.entries()) {
      let maxSimilarity = 0;

      for (const chosen of selected) {
        const similarity = chunkSimilarity(candidate.chunk, chosen.chunk);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }

      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) selected.push(chosen);
  }

  return { selected, droppedForDiversity: remaining.length };
}

function chunkSimilarity(a: StoredChunk, b: StoredChunk): number {
  // Two chunks from the same file are redundant regardless of vector distance.
  if (a.path === b.path) return 0.9;

  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) {
    return cosineSimilarity(a.embedding, b.embedding);
  }

  return tokenOverlap(a.content, b.content);
}

/** Jaccard overlap on identifier tokens; the fallback when embeddings are absent. */
function tokenOverlap(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .match(/\b[a-z_$][\w$]{2,}\b/g)
        ?.slice(0, 200) ?? [],
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  return intersection / (setA.size + setB.size - intersection);
}

// ---------------------------------------------------------------- helpers

/** Conventional companions of the changed files: tests plus architecture docs. */
function buildConventionPaths(seedPaths: readonly string[]): string[] {
  const paths = new Set<string>();

  for (const seed of seedPaths) {
    for (const candidate of guessTestPaths(seed)) paths.add(candidate);
  }

  for (const doc of [
    'README.md',
    'readme.md',
    'docs/architecture.md',
    'docs/ARCHITECTURE.md',
    'ARCHITECTURE.md',
    'CONTRIBUTING.md',
    'docs/conventions.md',
  ]) {
    paths.add(doc);
  }

  return [...paths];
}

function toRetrievedChunk(candidate: FusedCandidate & { chunk: StoredChunk }): RetrievedChunk {
  return {
    chunkId: candidate.chunk.id,
    path: candidate.chunk.path,
    symbol: candidate.chunk.symbol,
    kind: candidate.chunk.kind,
    language: candidate.chunk.language,
    content: candidate.chunk.content,
    startLine: candidate.chunk.startLine,
    endLine: candidate.chunk.endLine,
    tokenCount: candidate.chunk.tokenCount,
    score: Number(candidate.score.toFixed(4)),
    vectorScore: candidate.vectorScore === null ? null : Number(candidate.vectorScore.toFixed(4)),
    lexicalScore: candidate.lexicalScore === null ? null : Number(candidate.lexicalScore.toFixed(4)),
    sources: candidate.sources,
    rationale: buildRationale(candidate),
  };
}

/**
 * One-line explanation of why a chunk was included.
 *
 * Rendered in the RAG Context Viewer. A reviewer who can see why the AI was
 * shown a given file can judge whether its conclusion was well-founded, which is
 * the whole argument for persisting retrieval results at all.
 */
function buildRationale(candidate: FusedCandidate & { chunk: StoredChunk }): string {
  const parts: string[] = [];
  const unique = [...new Set(candidate.sources)];

  if (unique.includes(RetrievalSource.VECTOR)) {
    parts.push('semantically similar to the change');
  }
  if (unique.includes(RetrievalSource.LEXICAL)) {
    parts.push('references an identifier from the diff');
  }
  if (unique.includes(RetrievalSource.IMPORT_GRAPH)) {
    parts.push('imports or is imported by a changed file');
  }
  if (unique.includes(RetrievalSource.CONVENTION)) {
    parts.push(
      candidate.chunk.kind === ChunkKind.TEST_CASE || candidate.chunk.path.includes('test')
        ? 'existing test for a changed file, showing this repository’s test conventions'
        : 'documents the repository’s conventions',
    );
  }

  const reason = parts.length > 0 ? parts.join('; ') : 'matched the retrieval query';
  const agreement = unique.length > 1 ? ` (${unique.length} independent strategies agreed)` : '';

  return `${capitalize(reason)}${agreement}.`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
