import { afterEach, expect, it, vi } from 'vitest';
import { OpenAiEmbeddingProvider } from './embeddings';
import { indexRepository } from './indexer';

afterEach(() => vi.unstubAllGlobals());
it('withholds raw provider bodies from public errors and persisted indexing diagnostics', async () => {
  const marker = 'SECRET_PROVIDER_MARKER';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: marker, code: marker } }), { status: 401 })));
  const provider = new OpenAiEmbeddingProvider({ apiKey: 'synthetic-only' });
  const error = await provider.embed(['fixture']).catch((error: Error) => error);
  expect(String(error)).toContain('OpenAI');
  expect(String(error)).toContain('401');
  expect(String(error)).not.toContain(marker);
  const diagnostics: unknown[] = [];
  const store = { existingHashes: async () => new Map(), upsert: vi.fn(), pruneIndexedPaths: vi.fn() };
  const result = await indexRepository({ store: store as never, embeddings: provider, source: { fetch: async () => '# Fixture\n\nA sufficiently detailed harmless architecture description for indexing and diagnostics verification.\n' } }, {
    repositoryId: 'synthetic', commitSha: 'synthetic', treeFiles: [{ path: 'README.md', sizeBytes: 150 }], maxFiles: 1,
    force: false, includePaths: [], excludePatterns: [], fetchConcurrency: 1, treeComplete: false,
    onProgress: (progress) => { diagnostics.push(JSON.stringify(progress)); },
  });
  expect(result.status).toBe('FAILED');
  expect(JSON.stringify(diagnostics)).not.toContain(marker);
  expect(store.upsert).not.toHaveBeenCalled();
  expect(store.pruneIndexedPaths).not.toHaveBeenCalled();
});
it('does not echo malformed successful response bodies or transport errors', async () => {
  const provider = new OpenAiEmbeddingProvider({ apiKey: 'synthetic-only' });
  for (const fetch of [vi.fn(async () => new Response('SECRET_PROVIDER_MARKER')), vi.fn(async () => { throw new Error('SECRET_PROVIDER_MARKER'); })]) {
    vi.stubGlobal('fetch', fetch);
    const error = await provider.embed(['fixture']).catch((error: Error) => error);
    expect(String(error)).not.toContain('SECRET_PROVIDER_MARKER');
  }
});
