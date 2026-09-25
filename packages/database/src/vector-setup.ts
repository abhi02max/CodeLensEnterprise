import type { PrismaClient } from '@prisma/client';

/** Must match the `vector(N)` dimension declared in schema.prisma. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Explicit maintenance operation, not part of API startup. Rebuild the ANN
 * index after a repository grows enough to need a different `lists` value.
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
