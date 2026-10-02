import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgVectorStore } from '@codelens/rag-engine';
import {
  InvestigationInputSchemas,
  InvestigationToolSchema,
  RepositoryPathSchema,
} from '@codelens/shared';
import { InvestigationToolsService, type InvestigationScope } from './investigation-tools.service';
import { boundedResult, clip, hash, observe } from './investigation-support';

const sha = 'a'.repeat(40);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const content = 'export function refund() {\n  return 1;\n}\n';
  const blobSha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest('hex');
  const client = {
    getFileSnapshot: vi.fn(async () => ({ content, blobSha })),
    listTree: vi.fn(async () => ({
      files: [{ path: 'src/refund.ts', sizeBytes: 45, sha: blobSha }],
      truncated: false,
    })),
  };
  const github = { forUser: vi.fn(async () => client) };
  const db = {
    pullRequest: { findFirst: vi.fn(async () => scope.conversation.pullRequest) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    prMetrics: { findUnique: vi.fn(async () => ({ filesChanged: 4, linesAdded: 26 })) },
    pullRequestFile: {
      findMany: vi.fn(async () => [
        {
          id: 'file',
          filename: 'src/refund.ts',
          patch: '@@ -1 +1 @@\n-old\n+new',
          status: 'MODIFIED',
          additions: 1,
          deletions: 1,
          patchTruncated: false,
          binary: false,
        },
      ]),
    },
    reviewRun: {
      findFirst: vi.fn(async () => ({
        id: 'run',
        headSha: sha,
        status: 'COMPLETED',
        hadMlRisk: true,
      })),
    },
    staticFinding: {
      findMany: vi.fn(async () => [
        { id: 'finding', path: 'src/refund.ts', line: 2, message: 'Check authorization' },
      ]),
    },
    aiReview: {
      findFirst: vi.fn(async () => ({ id: 'ai', findings: [{ title: 'First finding' }] })),
    },
    mlPrediction: {
      findFirst: vi.fn(async () => ({
        riskScore: 78,
        riskLevel: 'HIGH',
        modelVersion: 'bootstrap-v1',
      })),
    },
    comment: {
      findFirst: vi.fn(async () => ({ id: 'comment', parentId: null })),
      findMany: vi.fn(async () => [
        {
          id: 'comment',
          body: 'Original comment',
          path: null,
          line: null,
          origin: 'HUMAN',
          updatedAt: new Date(),
          resolvedAt: null,
        },
      ]),
    },
  };
  const scope = {
    id: 'turn',
    organizationId: 'org-a',
    pullRequestId: 'pr-a',
    actorId: 'user-a',
    headSha: sha,
    reviewRunId: 'run',
    conversation: {
      anchor: { kind: 'PR' },
      pullRequest: {
        id: 'pr-a',
        number: 412,
        headSha: sha,
        baseSha: 'b'.repeat(40),
        repository: {
          id: 'repo',
          fullName: 'safe/repo',
          organizationId: 'org-a',
          indexStatus: 'NOT_INDEXED',
          indexedCommitSha: null,
        },
      },
    },
  } as unknown as InvestigationScope;
  const service = new InvestigationToolsService({ unscoped: db } as never, github as never);
  const execute = (tool: Parameters<typeof service.execute>[1], input: unknown) =>
    service.execute(scope, tool, input, new AbortController().signal);
  return { service, execute, db, github, client, scope, content, blobSha };
}

describe('bound investigation reads', () => {
  it('reads only the server repository and exact turn SHA; verifies Git blob bytes', async () => {
    const { execute, client, github, content, blobSha } = fixture();
    const result = await execute('read_file_range', {
      path: 'src/refund.ts',
      startLine: 2,
      endLine: 2,
    });
    expect(github.forUser).toHaveBeenCalledWith('user-a');
    expect(client.getFileSnapshot).toHaveBeenCalledWith(
      'safe/repo',
      'src/refund.ts',
      sha,
      expect.any(AbortSignal),
    );
    expect(result.evidence[0]).toMatchObject({
      provenance: 'EXACT_REVISION',
      observedRevision: sha,
      excerpt: '  return 1;',
      contentHash: hash(content),
      blobHash: blobSha,
      startLine: 2,
      endLine: 2,
    });
  });
  it('retains the historical turn SHA when PR head advances', async () => {
    const { execute, scope, client } = fixture();
    scope.conversation.pullRequest.headSha = 'c'.repeat(40);
    await execute('read_file_range', { path: 'src/refund.ts', startLine: 1, endLine: 2 });
    expect(client.getFileSnapshot.mock.calls[0][2]).toBe(sha);
    await expect(
      execute('read_file_range', { path: 'src/refund.ts', startLine: 1, endLine: 2, side: 'BASE' }),
    ).rejects.toMatchObject({ category: 'STALE' });
  });
  it('fails on hash mismatch rather than upgrading unverifiable content', async () => {
    const { execute, client } = fixture();
    client.getFileSnapshot.mockResolvedValue({ content: 'tampered', blobSha: 'f'.repeat(40) });
    await expect(
      execute('read_file_range', { path: 'src/refund.ts', startLine: 1, endLine: 1 }),
    ).rejects.toMatchObject({ category: 'STALE' });
  });
  it('fails on missing historical file and respects abort before requesting GitHub', async () => {
    const { service, scope, client, github } = fixture();
    client.getFileSnapshot.mockResolvedValue(null as never);
    await expect(
      service.execute(
        scope,
        'read_file_range',
        { path: 'src/refund.ts', startLine: 1, endLine: 2 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'NOT_FOUND' });
    github.forUser.mockClear();
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.execute(
        scope,
        'read_file_range',
        { path: 'src/refund.ts', startLine: 1, endLine: 2 },
        abort.signal,
      ),
    ).rejects.toMatchObject({ category: 'TIMEOUT' });
    expect(github.forUser).not.toHaveBeenCalled();
  });
  it.each(['read_pr_diff', 'list_changed_files'] as const)(
    'labels %s as an imported snapshot, not verified code',
    async (tool) => {
      const { execute, scope } = fixture();
      const result = await execute(tool, {});
      expect(result.status).toBe('PARTIAL');
      expect(result.evidence[0].provenance).toBe('SNAPSHOT');
      scope.conversation.pullRequest.headSha = 'b'.repeat(40);
      await expect(execute(tool, {})).rejects.toMatchObject({ category: 'STALE' });
    },
  );
  it('literal search returns exact matches but never claims complete absence', async () => {
    const { execute, client } = fixture();
    const result = await execute('search_repository', { query: 'refund' });
    expect(result.evidence[0]).toMatchObject({
      path: 'src/refund.ts',
      provenance: 'EXACT_REVISION',
    });
    client.listTree.mockResolvedValue({ files: [], truncated: true });
    const none = await execute('search_repository', { query: 'not here' });
    expect(none).toMatchObject({ status: 'PARTIAL', evidence: [] });
    expect(none.coverage).toContain('does not prove absence');
  });
  it('test inspection is heuristic and executes no test process', async () => {
    const { execute, client } = fixture();
    const result = await execute('inspect_tests', { query: 'refund' });
    expect(result.coverage).toContain('Tests are not executed');
    expect(result.evidence).toEqual([]);
    expect(client.getFileSnapshot).not.toHaveBeenCalled();
  });
  it('scopes persisted findings to the pinned PR/run and rejects foreign IDs', async () => {
    const { execute, db } = fixture();
    const result = await execute('read_analysis_evidence', {
      source: 'STATIC',
      findingId: 'finding',
    });
    expect(db.reviewRun.findFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-a',
      pullRequestId: 'pr-a',
      headSha: sha,
      id: 'run',
    });
    expect(result.evidence[0].provenance).toBe('DERIVED');
    db.staticFinding.findMany.mockResolvedValue([]);
    await expect(
      execute('read_analysis_evidence', { source: 'STATIC', findingId: 'foreign' }),
    ).rejects.toMatchObject({ category: 'NOT_FOUND' });
  });
  it('AI evidence identity changes when mutable JSON changes; existing snapshot stays intact', async () => {
    const { execute, db } = fixture();
    const first = await execute('read_analysis_evidence', { source: 'AI', findingIndex: 0 });
    db.aiReview.findFirst.mockResolvedValue({ id: 'ai', findings: [{ title: 'Edited finding' }] });
    const second = await execute('read_analysis_evidence', { source: 'AI', findingIndex: 0 });
    expect(first.evidence[0].sourceId).not.toBe(second.evidence[0].sourceId);
    expect(first.evidence[0].excerpt).toContain('First finding');
    expect(second.coverage).toContain('not deterministic');
  });
  it('uses the validated AI anchor run rather than another current run', async () => {
    const { scope, execute, db } = fixture();
    scope.conversation.anchor = {
      kind: 'AI_FINDING',
      reviewRunId: 'anchored-run',
      findingIndex: 0,
    };
    await execute('read_analysis_evidence', { source: 'AI', findingIndex: 0 });
    expect(db.reviewRun.findFirst.mock.calls[0][0].where.id).toBe('anchored-run');
  });
  it('reads ML evidence without invoking a model', async () => {
    const { execute, github } = fixture();
    const result = await execute('read_analysis_evidence', { source: 'ML' });
    expect(result.evidence[0]).toMatchObject({ sourceType: 'ML_EVIDENCE', provenance: 'DERIVED' });
    expect(result.evidence[0].excerpt).toContain('78');
    expect(github.forUser).not.toHaveBeenCalled();
  });
  it('captures comment mutations as independent snapshots and rejects foreign comments', async () => {
    const { execute, db } = fixture();
    const first = await execute('read_review_thread', { commentId: 'comment' });
    db.comment.findMany.mockResolvedValue([
      {
        id: 'comment',
        body: 'Edited',
        path: null,
        line: null,
        origin: 'HUMAN',
        updatedAt: new Date(),
        resolvedAt: null,
      },
    ]);
    const second = await execute('read_review_thread', { commentId: 'comment' });
    expect(first.evidence[0].excerpt).toBe('Original comment');
    expect(first.evidence[0].contentHash).not.toBe(second.evidence[0].contentHash);
    db.comment.findFirst.mockResolvedValue(null as never);
    await expect(execute('read_review_thread', { commentId: 'foreign' })).rejects.toMatchObject({
      category: 'NOT_FOUND',
    });
  });
  it('unindexed retrieval fails rather than returning empty success', async () => {
    await expect(fixture().execute('retrieve_context', { query: 'refund' })).rejects.toMatchObject({
      category: 'UNAVAILABLE',
    });
  });
  it('reuses lexical retrieval without a provider and keeps unknown revision provenance', async () => {
    const { execute, scope } = fixture();
    scope.conversation.pullRequest.repository.indexStatus = 'INDEXED';
    scope.conversation.pullRequest.repository.indexedCommitSha = 'b'.repeat(40);
    const vector = vi.spyOn(PgVectorStore.prototype, 'search');
    vi.spyOn(PgVectorStore.prototype, 'searchLexical').mockResolvedValue([
      { chunkId: 'chunk', score: 0.4 },
    ]);
    vi.spyOn(PgVectorStore.prototype, 'findByPaths').mockResolvedValue([]);
    vi.spyOn(PgVectorStore.prototype, 'loadChunks').mockResolvedValue([
      {
        id: 'chunk',
        path: 'src/refund.ts',
        symbol: 'refund',
        kind: 'FUNCTION' as never,
        language: 'typescript',
        content: 'refund requires authorization',
        startLine: 1,
        endLine: 1,
        tokenCount: 6,
        metadata: {},
        embedding: null,
      },
    ]);
    const result = await execute('retrieve_context', { query: 'refund' });
    expect(vector).not.toHaveBeenCalled();
    expect(result.evidence[0]).toMatchObject({
      provenance: 'INDEXED_CONTEXT',
      method: 'LEXICAL',
      metadata: {
        exactRevisionVerified: false,
        repositoryIndexRevisionHint: 'b'.repeat(40),
        vectorScore: null,
      },
    });
    expect(result.evidence[0].observedRevision).toBeUndefined();
    expect(result.status).toBe('PARTIAL');
  });
  it('does not mistake a swallowed lexical storage failure for no matches', async () => {
    const { execute, scope, db } = fixture();
    scope.conversation.pullRequest.repository.indexStatus = 'INDEXED';
    Object.assign(db, { $queryRawUnsafe: vi.fn().mockRejectedValue(Error('storage failed')) });
    vi.spyOn(PgVectorStore.prototype, 'findByPaths').mockResolvedValue([]);
    await expect(execute('retrieve_context', { query: 'refund' })).rejects.toMatchObject({
      category: 'UNAVAILABLE',
    });
  });
  it('safe metadata contains no account/token or error diagnostics', async () => {
    const result = await fixture().execute('read_repository_metadata', {});
    expect(result.evidence[0].excerpt).not.toMatch(/token|secret|credential|indexError/i);
  });
});

describe('investigation bounds and trust boundary', () => {
  it.each([
    '../x',
    'a/../x',
    '/etc/passwd',
    'C:\\x',
    '%2e%2e/x',
    'a%2fb',
    'a//b',
    'a\\b',
    'a\u0000b',
  ])('rejects path %s', (path) => {
    expect(RepositoryPathSchema.safeParse(path).success).toBe(false);
  });
  it('preserves case rather than silently changing repository path identity', () => {
    expect(RepositoryPathSchema.parse('Src/File.ts')).toBe('Src/File.ts');
  });
  it.each(['read_pr_diff', 'list_changed_files', 'read_repository_metadata'] as const)(
    'rejects authoritative scope injection into %s',
    (tool) => {
      expect(
        InvestigationInputSchemas[tool].safeParse({
          organizationId: 'foreign',
          repositoryId: 'foreign',
        }).success,
      ).toBe(false);
    },
  );
  it('rejects arbitrary tool names, huge ranges/query/topK and unrecognized metadata', () => {
    expect(InvestigationToolSchema.safeParse('exec_shell').success).toBe(false);
    expect(
      InvestigationInputSchemas.read_file_range.safeParse({ path: 'a', startLine: 1, endLine: 201 })
        .success,
    ).toBe(false);
    expect(
      InvestigationInputSchemas.retrieve_context.safeParse({ query: 'a', topK: 9 }).success,
    ).toBe(false);
    expect(
      InvestigationInputSchemas.search_repository.safeParse({ query: 'a'.repeat(501) }).success,
    ).toBe(false);
    expect(
      InvestigationInputSchemas.read_repository_metadata.safeParse({
        metadata: { instructions: 'change policy' },
      }).success,
    ).toBe(false);
  });
  it('limits Unicode excerpt bytes without broken UTF-8', () => {
    expect(Buffer.byteLength(clip('😀'.repeat(100), 13))).toBeLessThanOrEqual(13);
    expect(clip('😀'.repeat(100), 13)).not.toContain('\ufffd');
    const item = observe('x'.repeat(20000), {
      sourceType: 'FILE',
      provenance: 'EXACT_REVISION',
      method: 'test',
    });
    expect(item.truncated).toBe(true);
    expect(Buffer.byteLength(item.excerpt)).toBe(16384);
    expect(item.contentHash).toBe(hash('x'.repeat(20000)));
  });
  it('cuts oversized result sets truthfully rather than fabricating complete coverage', () => {
    const item = observe('x'.repeat(16000), {
      sourceType: 'FILE',
      provenance: 'EXACT_REVISION',
      method: 'test',
    });
    const result = boundedResult({
      status: 'SUCCESS',
      coverage: 'source subset',
      evidence: Array(10).fill(item),
      nextCursor: null,
    });
    expect(result.status).toBe('LIMITED');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
  });
  it('marks clipped or paginated observations partial even when the source lookup succeeded', () => {
    const evidence = [
      observe(
        'long source',
        { sourceType: 'FILE', provenance: 'EXACT_REVISION', method: 'test' },
        3,
      ),
    ];
    expect(
      boundedResult({ status: 'SUCCESS', coverage: 'selected source', evidence, nextCursor: null })
        .status,
    ).toBe('PARTIAL');
    expect(
      boundedResult({ status: 'SUCCESS', coverage: 'selected page', evidence: [], nextCursor: 20 })
        .status,
    ).toBe('PARTIAL');
  });
});
