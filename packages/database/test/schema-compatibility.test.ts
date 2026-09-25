import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  BASELINE_MIGRATION,
  EXPECTED_TABLES,
  criticalSchemaIssues,
  decideInitialization,
  type DatabaseSnapshot,
} from '../src/schema-compatibility';

const observedExpression = `((setweight(to_tsvector('english'::regconfig,
  COALESCE(symbol, ''::text)), 'A'::"char") ||
  setweight(to_tsvector('english'::regconfig,
  replace(COALESCE(path, ''::text), '/'::text, ' '::text)), 'B'::"char")) ||
  setweight(to_tsvector('english'::regconfig,
  "left"(COALESCE(content, ''::text), 20000)), 'C'::"char"))`;

function compatible(): DatabaseSnapshot {
  const columns = {
    User: ['id', 'email', 'passwordHash'],
    Organization: ['id', 'slug'],
    Repository: ['id', 'organizationId', 'githubId', 'fullName'],
    PullRequest: ['id', 'repositoryId', 'number'],
    ReviewRun: ['id', 'pullRequestId', 'headSha'],
    RagChunk: [
      'id',
      'organizationId',
      'repositoryId',
      'path',
      'symbol',
      'kind',
      'content',
      'contentHash',
      'embedding',
      'search_vector',
    ],
    RetrievedContext: ['id', 'reviewRunId', 'chunkId'],
    IndexRun: ['id', 'repositoryId'],
  };

  return {
    tables: [...EXPECTED_TABLES],
    columns: Object.entries(columns).flatMap(([table_name, names]) =>
      names.map((column_name) => ({ table_name, column_name })),
    ),
    extensions: ['vector', 'pg_trgm', 'pgcrypto'],
    ragColumns: [
      { attname: 'embedding', type: 'vector(1536)', attgenerated: '', expression: null },
      {
        attname: 'search_vector',
        type: 'tsvector',
        attgenerated: 's',
        expression: observedExpression,
      },
    ],
    indexes: [
      {
        indexname: 'rag_chunk_embedding_cosine_idx',
        indexdef:
          'CREATE INDEX rag_chunk_embedding_cosine_idx ON public."RagChunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists=\'100\')',
      },
      {
        indexname: 'rag_chunk_path_trgm_idx',
        indexdef:
          'CREATE INDEX rag_chunk_path_trgm_idx ON public."RagChunk" USING gin (path gin_trgm_ops)',
      },
      {
        indexname: 'rag_chunk_search_vector_idx',
        indexdef:
          'CREATE INDEX rag_chunk_search_vector_idx ON public."RagChunk" USING gin (search_vector)',
      },
      {
        indexname: 'RagChunk_repositoryId_path_symbol_contentHash_key',
        indexdef:
          'CREATE UNIQUE INDEX "RagChunk_repositoryId_path_symbol_contentHash_key" ON public."RagChunk" USING btree ("repositoryId", path, symbol, "contentHash")',
      },
    ],
    constraints: ['RagChunk_pkey', 'RagChunk_repositoryId_fkey'],
    migrations: [],
  };
}

test('empty database deploys the baseline', () => {
  const snapshot = compatible();
  snapshot.tables = [];
  assert.deepEqual(decideInitialization(snapshot), { state: 'empty', issues: [] });
});

test('inspected pre-migration schema is eligible for metadata-only baselining', () => {
  assert.deepEqual(decideInitialization(compatible()), { state: 'legacy', issues: [] });
});

test('applied baseline makes repeated initialization safe', () => {
  const snapshot = compatible();
  snapshot.tables.push('_prisma_migrations');
  snapshot.migrations.push({
    migration_name: BASELINE_MIGRATION,
    finished_at: new Date(),
    rolled_back_at: null,
  });
  assert.deepEqual(decideInitialization(snapshot), { state: 'managed', issues: [] });
});

test('partial and unfamiliar databases fail closed', () => {
  const missing = compatible();
  missing.tables = ['RagChunk'];
  assert.equal(decideInitialization(missing).state, 'incompatible');

  const unknown = compatible();
  unknown.tables.push('OtherApplication');
  assert.match(decideInitialization(unknown).issues.join(' '), /unexpected table/);

  const history = compatible();
  history.migrations.push({
    migration_name: 'foreign',
    finished_at: new Date(),
    rolled_back_at: null,
  });
  assert.match(decideInitialization(history).issues.join(' '), /history exists without/);
});

test('RAG checks reject changed vector and lexical definitions', () => {
  const snapshot = compatible();
  snapshot.ragColumns[0]!.type = 'vector(384)';
  snapshot.ragColumns[1]!.expression = 'to_tsvector(content)';
  snapshot.indexes = snapshot.indexes.filter(
    (index) => index.indexname !== 'rag_chunk_search_vector_idx',
  );
  const issues = criticalSchemaIssues(snapshot).join('\n');
  assert.match(issues, /vector\(1536\)/);
  assert.match(issues, /unexpected generated expression/);
  assert.match(issues, /rag_chunk_search_vector_idx/);
});

test('baseline SQL contains the generated column and three RAG indexes', () => {
  const sql = readFileSync(
    join(__dirname, '../prisma/migrations/0_baseline/migration.sql'),
    'utf8',
  );
  const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tables.sort(), [...EXPECTED_TABLES].sort());
  assert.doesNotMatch(sql, /\bDROP (?:TABLE|COLUMN)\b/i);
  assert.match(sql, /"embedding" vector\(1536\)/);
  assert.match(sql, /ADD COLUMN search_vector tsvector\s+GENERATED ALWAYS AS/);
  assert.match(sql, /setweight\(to_tsvector\('english', coalesce\("symbol", ''\)\), 'A'\)/);
  for (const name of [
    'rag_chunk_embedding_cosine_idx',
    'rag_chunk_search_vector_idx',
    'rag_chunk_path_trgm_idx',
  ])
    assert.ok(sql.includes(`CREATE INDEX ${name}`));
  for (const extension of ['vector', 'pg_trgm', 'pgcrypto']) {
    assert.ok(sql.includes(`CREATE EXTENSION IF NOT EXISTS "${extension}"`));
  }
});
