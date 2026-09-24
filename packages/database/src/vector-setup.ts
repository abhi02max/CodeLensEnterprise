import type { PrismaClient } from '@prisma/client';

/**
 * Index and column bootstrap for things Prisma cannot express.
 *
 * Prisma has no native `vector` type and no generated-column support, so the
 * pgvector ANN index and the lexical `tsvector` column are created here with raw
 * SQL. Every statement is idempotent and this runs on API startup, which keeps
 * `prisma db push` viable for local development without hand-maintaining a
 * migration for these objects.
 *
 * In production these same statements live in a checked-in migration; running
 * them twice is harmless.
 */

export interface VectorSetupResult {
  extensionsReady: boolean;
  annIndexReady: boolean;
  lexicalSearchReady: boolean;
  warnings: string[];
}

/** Must match the `vector(N)` dimension declared in schema.prisma. */
export const EMBEDDING_DIMENSIONS = 1536;

export async function ensureVectorSetup(
  prisma: PrismaClient,
  options: { embeddingDimensions?: number } = {},
): Promise<VectorSetupResult> {
  const dimensions = options.embeddingDimensions ?? EMBEDDING_DIMENSIONS;
  const warnings: string[] = [];

  let extensionsReady = false;
  let annIndexReady = false;
  let lexicalSearchReady = false;

  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    extensionsReady = true;
  } catch (error) {
    warnings.push(
      `Could not create required extensions (vector, pg_trgm). RAG search will be unavailable. ` +
        `Use the pgvector/pgvector image or grant the role CREATE privilege. ${message(error)}`,
    );
    return { extensionsReady, annIndexReady, lexicalSearchReady, warnings };
  }

  // ---- ANN index for cosine similarity.
  //
  // ivfflat needs `lists` tuned to row count: roughly rows/1000 for under a
  // million rows. 100 suits the tens-of-thousands range a single repository
  // produces. It is also only used once the table has data, so building it early
  // on an empty table is cheap.
  try {
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS rag_chunk_embedding_cosine_idx
      ON "RagChunk" USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
    annIndexReady = true;
  } catch (error) {
    warnings.push(
      `Could not create the ivfflat index; vector search will fall back to a ` +
        `sequential scan and stay correct but slow. ${message(error)}`,
    );
  }

  // ---- Lexical search column.
  //
  // Hybrid retrieval needs exact identifier matching: a diff referencing
  // `resolveOrganizationScope` should surface that symbol even when embeddings
  // rank it low. A generated tsvector over symbol + path + content does that,
  // weighted so the symbol name dominates.
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "RagChunk"
      ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("symbol", '')), 'A') ||
        setweight(to_tsvector('english', replace(coalesce("path", ''), '/', ' ')), 'B') ||
        setweight(to_tsvector('english', left(coalesce("content", ''), 20000)), 'C')
      ) STORED
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS rag_chunk_search_vector_idx
      ON "RagChunk" USING gin (search_vector)
    `);

    // Trigram index for fuzzy path lookup in the repository file picker.
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS rag_chunk_path_trgm_idx
      ON "RagChunk" USING gin ("path" gin_trgm_ops)
    `);

    lexicalSearchReady = true;
  } catch (error) {
    warnings.push(
      `Could not create the lexical search column or its indexes. Hybrid ` +
        `retrieval will run vector-only. ${message(error)}`,
    );
  }

  // ---- Dimension sanity check.
  //
  // A mismatch between EMBEDDING_DIMENSIONS and the declared column type does
  // not fail loudly on write; it fails on insert with an opaque message deep in
  // a background job. Better to surface it at boot.
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ atttypmod: number }>>(`
      SELECT a.atttypmod
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'RagChunk' AND a.attname = 'embedding'
    `);

    const declared = rows[0]?.atttypmod;
    if (typeof declared === 'number' && declared > 0 && declared !== dimensions) {
      warnings.push(
        `Embedding dimension mismatch: the RagChunk.embedding column is ` +
          `vector(${declared}) but EMBEDDING_DIMENSIONS is ${dimensions}. Update ` +
          `schema.prisma and re-index, or switch to a model with ${declared} dimensions.`,
      );
    }
  } catch {
    // Non-fatal: the check is advisory.
  }

  return { extensionsReady, annIndexReady, lexicalSearchReady, warnings };
}

/**
 * Re-tune the ANN index once a repository has accumulated real data. ivfflat
 * `lists` chosen against an empty table is wrong at scale; this recomputes it
 * from the current row count.
 */
export async function retuneVectorIndex(prisma: PrismaClient): Promise<{ lists: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*)::bigint AS count FROM "RagChunk"',
  );
  const total = Number(rows[0]?.count ?? 0n);
  const lists = Math.max(10, Math.min(2000, Math.round(total / 1000) || 10));

  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS rag_chunk_embedding_cosine_idx');
  await prisma.$executeRawUnsafe(`
    CREATE INDEX rag_chunk_embedding_cosine_idx
    ON "RagChunk" USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = ${lists})
  `);

  return { lists };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
