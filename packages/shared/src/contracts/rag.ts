import { z } from 'zod';
import { ChunkKind, IndexStatus, RetrievalSource } from '../enums';

/** A chunk as produced by the indexer, before embedding. */
export interface CodeChunk {
  /** Deterministic: sha256(repositoryId + path + symbol + contentHash). */
  id: string;
  repositoryId: string;
  path: string;
  /** Function/class/heading name. Null for whole-file chunks. */
  symbol: string | null;
  kind: ChunkKind;
  language: string;
  content: string;
  /** 1-based inclusive line range in the source file. */
  startLine: number;
  endLine: number;
  tokenCount: number;
  /** sha256 of content; enables skip-if-unchanged on re-index. */
  contentHash: string;
  metadata: ChunkMetadata;
}

/**
 * Structural metadata carried alongside each chunk. `imports`/`exports` power
 * the import-graph retrieval strategy, which catches related files that
 * embeddings miss because they share no vocabulary.
 */
export interface ChunkMetadata {
  imports: string[];
  exports: string[];
  /** HTTP method + path for ROUTE chunks. */
  route: { method: string; path: string } | null;
  /** Conventional test file for this source file, if one exists in the repo. */
  linkedTestPath: string | null;
  /** Enclosing symbol for nested declarations. */
  parentSymbol: string | null;
  /** Doc comment attached to the symbol, kept separate from the body. */
  docComment: string | null;
  /** True when the chunk is a fragment of an oversized symbol. */
  isPartial: boolean;
  partIndex: number | null;
}

export interface EmbeddedChunk extends CodeChunk {
  embedding: number[];
  embeddingModel: string;
}

// ---------------------------------------------------------------- indexing

export const IndexRepositorySchema = z.object({
  /** Re-embed every file instead of only those whose hash changed. */
  force: z.boolean().default(false),
  /** Override the default file cap for large monorepos. */
  maxFiles: z.number().int().min(1).max(20_000).optional(),
  /** Restrict indexing to these path prefixes. */
  includePaths: z.array(z.string().max(300)).max(50).default([]),
});
export type IndexRepositoryInput = z.infer<typeof IndexRepositorySchema>;

export interface IndexProgress {
  repositoryId: string;
  status: IndexStatus;
  filesDiscovered: number;
  filesProcessed: number;
  filesSkipped: number;
  chunksCreated: number;
  chunksReused: number;
  embeddingsGenerated: number;
  tokensEmbedded: number;
  estimatedCostCents: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Ratio of reused chunks; the main lever on indexing cost. */
  cacheHitRate: number;
}

// ---------------------------------------------------------------- retrieval

export const RetrieveContextSchema = z.object({
  repositoryId: z.string(),
  /** Text to search with, typically concatenated diff hunks for one file. */
  query: z.string().min(1).max(20_000),
  topK: z.number().int().min(1).max(50).default(12),
  /** Exclude chunks from these paths; usually the changed files themselves. */
  excludePaths: z.array(z.string()).max(300).default([]),
  /** Identifiers extracted from the diff, for the lexical strategy. */
  symbols: z.array(z.string().max(200)).max(200).default([]),
  /** Paths whose importers/importees should be pulled in. */
  graphSeedPaths: z.array(z.string().max(300)).max(50).default([]),
  kinds: z.array(z.nativeEnum(ChunkKind)).default([]),
  maxTokens: z.number().int().min(256).max(32_000).default(4000),
  mmrLambda: z.number().min(0).max(1).default(0.7),
});
export type RetrieveContextInput = z.infer<typeof RetrieveContextSchema>;

export interface RetrievedChunk {
  chunkId: string;
  path: string;
  symbol: string | null;
  kind: ChunkKind;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  /** Final rank score after fusion and MMR re-ranking. */
  score: number;
  /** Raw cosine similarity, null when the chunk came from a non-vector source. */
  vectorScore: number | null;
  lexicalScore: number | null;
  /** Every strategy that surfaced this chunk. Shown in the RAG viewer. */
  sources: RetrievalSource[];
  /** Why this chunk was included, in one line, for the context viewer. */
  rationale: string;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  totalTokens: number;
  /** How many candidates each strategy contributed before fusion. */
  candidateCounts: Record<RetrievalSource, number>;
  /** Candidates dropped by the MMR diversity filter. */
  droppedForDiversity: number;
  /** Candidates dropped by the token budget. */
  droppedForBudget: number;
  durationMs: number;
  embeddingModel: string;
}

/** Per-file retrieval, assembled for the whole PR. */
export interface PrContextBundle {
  /** Keyed by changed file path. */
  perFile: Record<string, RetrievalResult>;
  /** Repo-level chunks: README, architecture docs, root config. */
  repositoryOverview: RetrievedChunk[];
  totalTokens: number;
  filesWithContext: number;
  filesWithoutContext: string[];
}

// ---------------------------------------------------------------- vector store

/**
 * Abstraction over pgvector and Qdrant. pgvector is the default because it
 * avoids a second stateful service and stays transactionally consistent with the
 * repository rows; Qdrant becomes worthwhile past a few million chunks.
 */
export interface VectorSearchHit {
  chunkId: string;
  score: number;
}

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  search(params: {
    repositoryId: string;
    embedding: number[];
    topK: number;
    excludePaths?: string[];
    kinds?: ChunkKind[];
  }): Promise<VectorSearchHit[]>;
  deleteByRepository(repositoryId: string): Promise<number>;
  deleteByPaths(repositoryId: string, paths: string[]): Promise<number>;
  countByRepository(repositoryId: string): Promise<number>;
  /** Existing content hashes, so the indexer can skip unchanged files. */
  existingHashes(repositoryId: string): Promise<Map<string, string>>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}
