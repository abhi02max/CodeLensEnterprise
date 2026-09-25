/** One-shot Compose initialization. Never reconciles a live schema with db push. */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  BASELINE_MIGRATION,
  decideInitialization,
  readDatabaseSnapshot,
} from '../src/schema-compatibility';

const prisma = new PrismaClient();

function prismaCli(...args: string[]): void {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function main(): Promise<void> {
  const before = decideInitialization(await readDatabaseSnapshot(prisma));
  if (before.state === 'incompatible') {
    throw new Error(
      `Database is not compatible with the CodeLens baseline:\n- ${before.issues.join('\n- ')}`,
    );
  }

  console.log(`Database state: ${before.state}`);
  if (before.state === 'legacy') {
    // Only migration metadata is written. Tables, chunks and embeddings are untouched.
    console.log(`Recording existing schema as ${BASELINE_MIGRATION}`);
    prismaCli('migrate', 'resolve', '--applied', BASELINE_MIGRATION);
  }

  prismaCli('migrate', 'deploy');
  const after = decideInitialization(await readDatabaseSnapshot(prisma));
  if (after.state !== 'managed') {
    throw new Error(
      `Database verification failed after migration:\n- ${after.issues.join('\n- ')}`,
    );
  }
  console.log('Database migrations and RAG infrastructure ready');
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
