/**
 * Read-only verification of the migration-owned vector and lexical search setup.
 *
 * Run against a live database after `pnpm db:migrate`:
 *   pnpm --filter @codelens/database verify:vector
 */

import { PrismaClient } from '@prisma/client';
import { criticalSchemaIssues, readDatabaseSnapshot } from '../src/schema-compatibility';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const issues = criticalSchemaIssues(await readDatabaseSnapshot(prisma));
  if (issues.length > 0) throw new Error(issues.join('\n'));
  console.log('extensions and RAG indexes ready');

  const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'RagChunk' ORDER BY indexname`,
  );
  console.log('\nindexes on RagChunk:');
  for (const row of indexes) console.log('  -', row.indexname);

  const sample = await prisma.$queryRawUnsafe<Array<{ embedding: string }>>(
    `SELECT embedding::text AS embedding FROM "RagChunk" WHERE embedding IS NOT NULL LIMIT 1`,
  );
  if (sample[0]) {
    const hits = await prisma.$queryRawUnsafe<Array<{ path: string; distance: number }>>(
      `SELECT "path", embedding <=> $1::vector AS distance
       FROM "RagChunk"
       WHERE embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT 3`,
      sample[0].embedding,
    );
    console.log('cosine search returned:');
    for (const hit of hits) console.log(`  - ${hit.path}  distance=${hit.distance.toFixed(6)}`);
  } else console.log('no stored embeddings; vector query skipped');

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
