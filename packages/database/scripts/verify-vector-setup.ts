/**
 * Verifies the raw-SQL bootstrap that Prisma cannot express: the pgvector ANN
 * index, the generated tsvector column, and a round-trip hybrid query.
 *
 * Run against a live database after `pnpm db:push`:
 *   pnpm --filter @codelens/database verify:vector
 */

import { PrismaClient } from '@prisma/client';
import { ensureVectorSetup } from '../src/vector-setup';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await ensureVectorSetup(prisma);

  console.log('extensions ready     :', result.extensionsReady);
  console.log('ivfflat index ready  :', result.annIndexReady);
  console.log('lexical search ready :', result.lexicalSearchReady);

  for (const warning of result.warnings) {
    console.warn('  warning:', warning);
  }

  const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'RagChunk' ORDER BY indexname`,
  );
  console.log('\nindexes on RagChunk:');
  for (const row of indexes) console.log('  -', row.indexname);

  // Write a real embedding through raw SQL, since Prisma cannot bind a vector.
  const chunk = await prisma.ragChunk.findFirst({ select: { id: true, path: true } });
  if (chunk) {
    const embedding = Array.from({ length: 1536 }, (_, i) => Math.sin(i) * 0.01);
    await prisma.$executeRawUnsafe(
      `UPDATE "RagChunk" SET embedding = $1::vector WHERE id = $2`,
      `[${embedding.join(',')}]`,
      chunk.id,
    );
    console.log(`\nwrote a 1536-dim embedding to ${chunk.path}`);

    const hits = await prisma.$queryRawUnsafe<Array<{ path: string; distance: number }>>(
      `SELECT "path", embedding <=> $1::vector AS distance
       FROM "RagChunk"
       WHERE embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT 3`,
      `[${embedding.join(',')}]`,
    );
    console.log('cosine search returned:');
    for (const hit of hits) console.log(`  - ${hit.path}  distance=${hit.distance.toFixed(6)}`);
  }

  const lexical = await prisma.$queryRawUnsafe<Array<{ path: string; rank: number }>>(
    `SELECT "path", ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
     FROM "RagChunk"
     WHERE search_vector @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT 3`,
    'refund',
  );
  console.log('\nlexical search for "refund" returned:');
  for (const hit of lexical) console.log(`  - ${hit.path}  rank=${hit.rank.toFixed(6)}`);

  console.log('\nvector setup verified.');
}

main()
  .catch((error) => {
    console.error('verification failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
