import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@codelens/database';
import type { EmbeddedChunk } from '@codelens/shared';
import { chunkFile } from './chunker';
import { PgVectorStore } from './pgvector-store';

describe('pgvector upsert conflict targets', () => {
  it('uses the deterministic id for whole-file chunks and the composite key for named chunks', async () => {
    const execute = vi.fn(async () => 1);
    const query = vi.fn(async () => []);
    const store = new PgVectorStore(
      { $executeRawUnsafe: execute, $queryRawUnsafe: query } as unknown as PrismaClient,
      'org-1',
      2,
    );
    const wholeFile = chunkFile({
      repositoryId: 'repo-1',
      path: 'config.json',
      content: '{"enabled":true}',
    })[0]!;
    const named = chunkFile({
      repositoryId: 'repo-1',
      path: 'README.md',
      content: '# Refund policy\n\nRefunds require ledger verification and approval.',
    })[0]!;
    const embed = (chunk: typeof wholeFile): EmbeddedChunk => ({
      ...chunk,
      embedding: [1, 0],
      embeddingModel: 'test',
    });

    await store.upsert([embed(wholeFile), embed(named)]);
    await store.upsert([embed(wholeFile), embed(named)]);

    expect(wholeFile.symbol).toBeNull();
    expect(named.symbol).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(4);
    expect(String(execute.mock.calls[0]?.[0])).toContain(
      'ON CONFLICT ("repositoryId", "path", "symbol", "contentHash")',
    );
    expect(String(execute.mock.calls[1]?.[0])).toContain('ON CONFLICT ("id")');
    expect(String(execute.mock.calls[3]?.[0])).toContain('ON CONFLICT ("id")');
  });

  it('reuses a legacy whole-file id when force-refreshing the same logical chunk', async () => {
    const execute = vi.fn(async (..._args: unknown[]) => 1);
    const wholeFile = chunkFile({
      repositoryId: 'repo-1',
      path: 'config.json',
      content: '{"enabled":true}',
    })[0]!;
    const query = vi.fn(async () => [{
      id: 'legacy-id',
      repositoryId: wholeFile.repositoryId,
      path: wholeFile.path,
      contentHash: wholeFile.contentHash,
    }]);
    const store = new PgVectorStore(
      { $executeRawUnsafe: execute, $queryRawUnsafe: query } as unknown as PrismaClient,
      'org-1',
      2,
    );

    await store.upsert([{ ...wholeFile, embedding: [1, 0], embeddingModel: 'test' }]);

    expect(query).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toBe('legacy-id');
    expect(String(execute.mock.calls[0]?.[0])).toContain('ON CONFLICT ("id")');
  });

  it('prunes by logical chunk identity so a compatible legacy id is retained', async () => {
    const execute = vi.fn(async (..._args: unknown[]) => 1);
    const store = new PgVectorStore(
      { $executeRawUnsafe: execute } as unknown as PrismaClient,
      'org-1',
    );
    const retained = { path: 'README.md', symbol: 'Refund policy', contentHash: 'hash-1' };

    await store.pruneIndexedPaths('repo-1', ['README.md'], [retained]);

    const [sql, organizationId, repositoryId, paths, identityJson] = execute.mock.calls[0]!;
    expect(sql).toContain('keep.symbol IS NOT DISTINCT FROM old.symbol');
    expect(sql).toContain('keep."contentHash" = old."contentHash"');
    expect(sql).not.toContain('old."id"');
    expect([organizationId, repositoryId, paths]).toEqual(['org-1', 'repo-1', ['README.md']]);
    expect(JSON.parse(String(identityJson))).toEqual([retained]);
  });
});
