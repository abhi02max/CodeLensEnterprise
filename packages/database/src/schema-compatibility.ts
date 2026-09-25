import type { PrismaClient } from '@prisma/client';

export const BASELINE_MIGRATION = '0_baseline';

export const EXPECTED_TABLES = [
  'User',
  'Account',
  'Organization',
  'Membership',
  'Team',
  'TeamMember',
  'Invite',
  'ApiKey',
  'ReviewPolicy',
  'AiSettings',
  'Repository',
  'RepositoryTeam',
  'PullRequest',
  'PullRequestFile',
  'Commit',
  'ReviewRun',
  'ToolRun',
  'StaticFinding',
  'DismissedFinding',
  'PrMetrics',
  'MlPrediction',
  'AiReview',
  'RagChunk',
  'RetrievedContext',
  'IndexRun',
  'Review',
  'Comment',
  'ShareLink',
  'AuditLog',
] as const;

const COLUMNS: Record<string, string[]> = {
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

// pg_get_expr deparses the migration expression this way on PostgreSQL 16.
// Comparing the deparsed expression catches a column with the right type but
// different ranking semantics. Whitespace is irrelevant; the SQL structure is not.
const SEARCH_EXPRESSION = `
  ((setweight(to_tsvector('english'::regconfig, COALESCE(symbol, ''::text)), 'A'::"char")
  || setweight(to_tsvector('english'::regconfig,
  replace(COALESCE(path, ''::text), '/'::text, ' '::text)), 'B'::"char"))
  || setweight(to_tsvector('english'::regconfig,
  "left"(COALESCE(content, ''::text), 20000)), 'C'::"char"))
`;

const INDEXES: Record<string, RegExp> = {
  rag_chunk_embedding_cosine_idx: /USING ivfflat \(embedding vector_cosine_ops\)/i,
  rag_chunk_path_trgm_idx: /USING gin \(path gin_trgm_ops\)/i,
  rag_chunk_search_vector_idx: /USING gin \(search_vector\)/i,
  RagChunk_repositoryId_path_symbol_contentHash_key:
    /CREATE UNIQUE INDEX .+ ON .+"RagChunk" USING btree \("repositoryId", path, symbol, "contentHash"\)/i,
};

export interface DatabaseSnapshot {
  tables: string[];
  columns: Array<{ table_name: string; column_name: string }>;
  extensions: string[];
  ragColumns: Array<{
    attname: string;
    type: string;
    attgenerated: string;
    expression: string | null;
  }>;
  indexes: Array<{ indexname: string; indexdef: string }>;
  constraints: string[];
  migrations: Array<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>;
}

export type InitializationState = 'empty' | 'legacy' | 'managed';

function compact(expression: string): string {
  return expression.replace(/\s+/g, '').toLowerCase();
}

export function criticalSchemaIssues(snapshot: DatabaseSnapshot): string[] {
  const issues: string[] = [];
  const tables = new Set(snapshot.tables);
  const columns = new Set(snapshot.columns.map((row) => `${row.table_name}.${row.column_name}`));
  const extensions = new Set(snapshot.extensions);
  const indexes = new Map(snapshot.indexes.map((row) => [row.indexname, row.indexdef]));
  const constraints = new Set(snapshot.constraints);

  for (const table of EXPECTED_TABLES) {
    if (!tables.has(table)) issues.push(`missing table public."${table}"`);
  }
  for (const [table, expected] of Object.entries(COLUMNS)) {
    if (!tables.has(table)) continue;
    for (const column of expected) {
      if (!columns.has(`${table}.${column}`)) issues.push(`missing column ${table}.${column}`);
    }
  }
  for (const extension of ['vector', 'pg_trgm', 'pgcrypto']) {
    if (!extensions.has(extension)) issues.push(`missing extension ${extension}`);
  }

  const embedding = snapshot.ragColumns.find((column) => column.attname === 'embedding');
  if (embedding?.type !== 'vector(1536)') {
    issues.push(`RagChunk.embedding must be vector(1536), found ${embedding?.type ?? 'absent'}`);
  }
  const search = snapshot.ragColumns.find((column) => column.attname === 'search_vector');
  if (search?.type !== 'tsvector' || search.attgenerated !== 's') {
    issues.push('RagChunk.search_vector must be a stored generated tsvector');
  } else if (compact(search.expression ?? '') !== compact(SEARCH_EXPRESSION)) {
    issues.push('RagChunk.search_vector has an unexpected generated expression');
  }

  for (const [name, definition] of Object.entries(INDEXES)) {
    const actual = indexes.get(name);
    if (!actual || !definition.test(actual)) issues.push(`missing or incompatible index ${name}`);
  }
  for (const name of ['RagChunk_pkey', 'RagChunk_repositoryId_fkey']) {
    if (!constraints.has(name)) issues.push(`missing constraint ${name}`);
  }
  return issues;
}

export function decideInitialization(snapshot: DatabaseSnapshot): {
  state: InitializationState | 'incompatible';
  issues: string[];
} {
  const userTables = snapshot.tables.filter((table) => table !== '_prisma_migrations');
  const baseline = snapshot.migrations.find((row) => row.migration_name === BASELINE_MIGRATION);
  if (userTables.length === 0 && snapshot.migrations.length === 0) {
    return { state: 'empty', issues: [] };
  }

  const issues = criticalSchemaIssues(snapshot);
  if (baseline) {
    if (!baseline.finished_at || baseline.rolled_back_at) {
      issues.push(`${BASELINE_MIGRATION} is not a completed migration`);
    }
    return { state: issues.length ? 'incompatible' : 'managed', issues };
  }
  if (snapshot.migrations.length > 0) {
    issues.push('migration history exists without the CodeLens baseline');
  }
  for (const table of userTables) {
    if (!(EXPECTED_TABLES as readonly string[]).includes(table)) {
      issues.push(`unexpected table public."${table}" in pre-migration database`);
    }
  }
  return { state: issues.length ? 'incompatible' : 'legacy', issues };
}

export async function readDatabaseSnapshot(prisma: PrismaClient): Promise<DatabaseSnapshot> {
  const [tables, columns, extensions, ragColumns, indexes, constraints] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    ),
    prisma.$queryRawUnsafe<DatabaseSnapshot['columns']>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    ),
    prisma.$queryRawUnsafe<Array<{ extname: string }>>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto')`,
    ),
    prisma.$queryRawUnsafe<DatabaseSnapshot['ragColumns']>(`
      SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type,
             a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('public."RagChunk"')
        AND a.attname IN ('embedding', 'search_vector')
    `),
    prisma.$queryRawUnsafe<DatabaseSnapshot['indexes']>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'RagChunk'`,
    ),
    prisma.$queryRawUnsafe<Array<{ conname: string }>>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass('public."RagChunk"')
    `),
  ]);

  const migrationTableExists = tables.some((row) => row.tablename === '_prisma_migrations');
  const migrations = migrationTableExists
    ? await prisma.$queryRawUnsafe<DatabaseSnapshot['migrations']>(
        `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      )
    : [];

  return {
    tables: tables.map((row) => row.tablename),
    columns,
    extensions: extensions.map((row) => row.extname),
    ragColumns,
    indexes,
    constraints: constraints.map((row) => row.conname),
    migrations,
  };
}
