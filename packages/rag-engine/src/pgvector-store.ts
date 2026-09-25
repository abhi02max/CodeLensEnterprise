import type { PrismaClient } from '@codelens/database';
import {
  chunkArray,
  type ChunkKind,
  type EmbeddedChunk,
  type VectorSearchHit,
  type VectorStore,
} from '@codelens/shared';

/**
 * pgvector-backed vector store.
 *
 * Every query here is raw SQL because Prisma has no vector type. That is
 * acceptable and contained: this is the only module that writes raw SQL against
 * RagChunk, parameters are always bound rather than interpolated, and
 * `organizationId` is included in every predicate so the store cannot leak across
 * tenants even though it bypasses the Prisma tenant extension.
 *
 * pgvector over a dedicated vector database for v1 because it removes a stateful
 * service, keeps chunks transactionally consistent with the repository rows that
 * own them, and supports the lexical half of hybrid search in the same query
 * engine. The {@link VectorStore} interface exists so Qdrant can replace it when
 * scale justifies the extra moving part.
 */

export class PgVectorStore implements VectorStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly organizationId: string,
    private readonly dimensions = 1536,
  ) {}

  /**
   * Insert or update chunks.
   *
   * Batched because a single statement with thousands of parameters exceeds
   * Postgres' 65535-parameter limit. 200 rows at ~12 parameters each stays well
   * clear while keeping round trips low.
   */
  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    for (const batch of chunkArray(chunks, 200)) {
      // Build a parameterized VALUES list. Placeholders are generated, values are
      // always bound — no user or repository content is ever concatenated in.
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (const chunk of batch) {
        if (chunk.embedding.length !== this.dimensions) {
          throw new Error(
            `Embedding dimension mismatch for ${chunk.path}: got ${chunk.embedding.length}, ` +
              `expected ${this.dimensions}. The RagChunk.embedding column and ` +
              `EMBEDDING_DIMENSIONS must agree, and changing either requires a re-index.`,
          );
        }

        values.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::"ChunkKind", $${p++}, $${p++}, ` +
            `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::vector, $${p++}, NOW(), NOW())`,
        );

        params.push(
          chunk.id,
          this.organizationId,
          chunk.repositoryId,
          chunk.path,
          chunk.symbol,
          chunk.kind,
          chunk.language,
          chunk.content,
          chunk.startLine,
          chunk.endLine,
          chunk.tokenCount,
          chunk.contentHash,
          JSON.stringify(chunk.metadata),
          `[${chunk.embedding.join(',')}]`,
          chunk.embeddingModel,
        );
      }

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "RagChunk" (
           "id", "organizationId", "repositoryId", "path", "symbol", "kind", "language",
           "content", "startLine", "endLine", "tokenCount", "contentHash", "metadata",
           "embedding", "embeddingModel", "createdAt", "updatedAt"
         )
         VALUES ${values.join(', ')}
         ON CONFLICT ("repositoryId", "path", "symbol", "contentHash") DO UPDATE SET
           "content" = EXCLUDED."content",
           "metadata" = EXCLUDED."metadata",
           "embedding" = EXCLUDED."embedding",
           "embeddingModel" = EXCLUDED."embeddingModel",
           "tokenCount" = EXCLUDED."tokenCount",
           "startLine" = EXCLUDED."startLine",
           "endLine" = EXCLUDED."endLine",
           "updatedAt" = NOW()`,
        ...params,
      );
    }
  }

  /**
   * Cosine similarity search.
   *
   * `<=>` is pgvector's cosine distance operator, so smaller is closer; the score
   * returned is `1 - distance` to give callers a similarity where larger is
   * better. Ordering by the raw operator is what lets the ivfflat index serve the
   * query instead of falling back to a sequential scan.
   */
  async search(params: {
    repositoryId: string;
    embedding: number[];
    topK: number;
    excludePaths?: string[];
    kinds?: ChunkKind[];
  }): Promise<VectorSearchHit[]> {
    const bindings: unknown[] = [
      `[${params.embedding.join(',')}]`,
      this.organizationId,
      params.repositoryId,
    ];
    let p = 4;

    const conditions = [
      '"organizationId" = $2',
      '"repositoryId" = $3',
      '"embedding" IS NOT NULL',
    ];

    if (params.excludePaths && params.excludePaths.length > 0) {
      conditions.push(`"path" <> ALL($${p}::text[])`);
      bindings.push(params.excludePaths);
      p += 1;
    }

    if (params.kinds && params.kinds.length > 0) {
      conditions.push(`"kind" = ANY($${p}::"ChunkKind"[])`);
      bindings.push(params.kinds);
      p += 1;
    }

    bindings.push(params.topK);

    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; distance: number }>>(
      `SELECT "id", ("embedding" <=> $1::vector) AS distance
       FROM "RagChunk"
       WHERE ${conditions.join(' AND ')}
       ORDER BY "embedding" <=> $1::vector
       LIMIT $${p}`,
      ...bindings,
    );

    return rows.map((row) => ({ chunkId: row.id, score: 1 - Number(row.distance) }));
  }

  /**
   * Full-text search over the generated `search_vector` column.
   *
   * The lexical half of hybrid retrieval. Vector search reliably misses exact
   * identifier matches — a diff calling `recordRefund` may not rank the chunk
   * defining it highly, because the two share little other vocabulary. This finds
   * it immediately, and the column weights symbol names above file paths above
   * body content.
   */
  async searchLexical(params: {
    repositoryId: string;
    terms: string[];
    topK: number;
    excludePaths?: string[];
  }): Promise<VectorSearchHit[]> {
    const query = params.terms
      .map((term) => term.replace(/[^\w]/g, ''))
      .filter((term) => term.length > 2)
      .slice(0, 40)
      .join(' | ');

    if (!query) return [];

    const bindings: unknown[] = [query, this.organizationId, params.repositoryId];
    let p = 4;

    const conditions = [
      '"organizationId" = $2',
      '"repositoryId" = $3',
      'search_vector @@ to_tsquery(\'english\', $1)',
    ];

    if (params.excludePaths && params.excludePaths.length > 0) {
      conditions.push(`"path" <> ALL($${p}::text[])`);
      bindings.push(params.excludePaths);
      p += 1;
    }

    bindings.push(params.topK);

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; rank: number }>>(
        `SELECT "id", ts_rank(search_vector, to_tsquery('english', $1)) AS rank
         FROM "RagChunk"
         WHERE ${conditions.join(' AND ')}
         ORDER BY rank DESC
         LIMIT $${p}`,
        ...bindings,
      );

      return rows.map((row) => ({ chunkId: row.id, score: Number(row.rank) }));
    } catch {
      // The generated column is installed by the database migration. A damaged
      // deployment can still serve vector-only results while readiness reports it.
      return [];
    }
  }

  /**
   * Chunks reachable from a set of paths via the import graph.
   *
   * Finds files that import the changed file and files the changed file imports.
   * This catches relationships embeddings cannot: a caller three modules away
   * shares no vocabulary with the callee but breaks when its contract changes.
   */
  async searchImportGraph(params: {
    repositoryId: string;
    seedPaths: string[];
    topK: number;
    excludePaths?: string[];
  }): Promise<VectorSearchHit[]> {
    if (params.seedPaths.length === 0) return [];

    // Match on the module basename, since import specifiers are written
    // relatively ("./refund.service") and rarely match a repository path.
    const basenames = params.seedPaths
      .map((path) => {
        const file = path.split('/').pop() ?? path;
        return file.replace(/\.[^.]+$/, '');
      })
      .filter((name) => name.length > 2);

    if (basenames.length === 0) return [];

    const bindings: unknown[] = [this.organizationId, params.repositoryId, basenames];
    let p = 4;

    const conditions = [
      '"organizationId" = $1',
      '"repositoryId" = $2',
      // Any import specifier whose tail matches one of the seed basenames.
      `EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(COALESCE("metadata"->'imports', '[]'::jsonb)) AS imp
         WHERE EXISTS (
           SELECT 1 FROM unnest($3::text[]) AS base
           WHERE imp LIKE '%' || base
         )
       )`,
    ];

    if (params.excludePaths && params.excludePaths.length > 0) {
      conditions.push(`"path" <> ALL($${p}::text[])`);
      bindings.push(params.excludePaths);
      p += 1;
    }

    bindings.push(params.topK);

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id"
         FROM "RagChunk"
         WHERE ${conditions.join(' AND ')}
         ORDER BY "tokenCount" DESC
         LIMIT $${p}`,
        ...bindings,
      );

      // Fixed score: this strategy establishes relevance by structure, not
      // degree, so ranking within it is left to the fusion step.
      return rows.map((row) => ({ chunkId: row.id, score: 0.5 }));
    } catch {
      return [];
    }
  }

  /** Chunks at specific paths, for the convention strategy (linked tests, docs). */
  async findByPaths(params: {
    repositoryId: string;
    paths: string[];
    kinds?: ChunkKind[];
    limit: number;
  }): Promise<VectorSearchHit[]> {
    if (params.paths.length === 0) return [];

    const bindings: unknown[] = [this.organizationId, params.repositoryId, params.paths];
    let p = 4;
    const conditions = ['"organizationId" = $1', '"repositoryId" = $2', '"path" = ANY($3::text[])'];

    if (params.kinds && params.kinds.length > 0) {
      conditions.push(`"kind" = ANY($${p}::"ChunkKind"[])`);
      bindings.push(params.kinds);
      p += 1;
    }

    bindings.push(params.limit);

    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "RagChunk"
       WHERE ${conditions.join(' AND ')}
       ORDER BY "startLine" ASC
       LIMIT $${p}`,
      ...bindings,
    );

    return rows.map((row) => ({ chunkId: row.id, score: 0.45 }));
  }

  /** Hydrate chunk rows, including their embeddings for MMR re-ranking. */
  async loadChunks(chunkIds: string[]): Promise<StoredChunk[]> {
    if (chunkIds.length === 0) return [];

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        path: string;
        symbol: string | null;
        kind: string;
        language: string;
        content: string;
        startLine: number;
        endLine: number;
        tokenCount: number;
        metadata: unknown;
        embeddingText: string | null;
      }>
    >(
      `SELECT "id", "path", "symbol", "kind"::text AS kind, "language", "content",
              "startLine", "endLine", "tokenCount", "metadata",
              "embedding"::text AS "embeddingText"
       FROM "RagChunk"
       WHERE "organizationId" = $1 AND "id" = ANY($2::text[])`,
      this.organizationId,
      chunkIds,
    );

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      symbol: row.symbol,
      kind: row.kind as ChunkKind,
      language: row.language,
      content: row.content,
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
      tokenCount: Number(row.tokenCount),
      metadata: (row.metadata ?? {}) as StoredChunk['metadata'],
      embedding: parseVector(row.embeddingText),
    }));
  }

  async deleteByRepository(repositoryId: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM "RagChunk" WHERE "organizationId" = $1 AND "repositoryId" = $2`,
      this.organizationId,
      repositoryId,
    );
  }

  async deleteByPaths(repositoryId: string, paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;

    return this.prisma.$executeRawUnsafe(
      `DELETE FROM "RagChunk"
       WHERE "organizationId" = $1 AND "repositoryId" = $2 AND "path" = ANY($3::text[])`,
      this.organizationId,
      repositoryId,
      paths,
    );
  }

  async countByRepository(repositoryId: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "RagChunk"
       WHERE "organizationId" = $1 AND "repositoryId" = $2`,
      this.organizationId,
      repositoryId,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  /**
   * Existing content hashes keyed by `path:symbol`.
   *
   * Drives incremental indexing: an unchanged hash means skip both the chunking
   * and the embedding call for that symbol, which is what makes re-indexing a
   * large repository after a small change affordable.
   */
  async existingHashes(repositoryId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ path: string; symbol: string | null; contentHash: string }>
    >(
      `SELECT "path", "symbol", "contentHash" FROM "RagChunk"
       WHERE "organizationId" = $1 AND "repositoryId" = $2`,
      this.organizationId,
      repositoryId,
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(`${row.path}:${row.symbol ?? ''}`, row.contentHash);
    }
    return map;
  }
}

export interface StoredChunk {
  id: string;
  path: string;
  symbol: string | null;
  kind: ChunkKind;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  metadata: {
    imports?: string[];
    exports?: string[];
    route?: { method: string; path: string } | null;
    linkedTestPath?: string | null;
    parentSymbol?: string | null;
    docComment?: string | null;
  };
  /** Null when the row predates embedding or embedding failed. */
  embedding: number[] | null;
}

/** pgvector renders vectors as "[0.1,0.2,...]" when cast to text. */
function parseVector(text: string | null): number[] | null {
  if (!text) return null;

  try {
    const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!inner) return null;
    return inner.split(',').map(Number);
  } catch {
    return null;
  }
}
