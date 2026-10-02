import { beforeEach, describe, expect, it, vi } from 'vitest';
const engine = vi.hoisted(() => ({ indexRepository: vi.fn(), gemini: vi.fn() }));
vi.mock('@codelens/rag-engine', () => ({
  indexRepository: engine.indexRepository,
  PgVectorStore: class {},
  CachedEmbeddingProvider: class {},
  OpenAiEmbeddingProvider: class {},
  LocalEmbeddingProvider: class {},
  HybridRetriever: class {},
  GeminiEmbeddingProvider: engine.gemini,
}));
vi.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { RagService } from './rag.service';

describe('persisted repository index metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['FAILED', 0, 3, 'openai'],
    ['FAILED', 7, 3, 'openai'],
    ['INDEXED', 7, 3, 'openai'],
    ['INDEXED', 3, 3, 'gemini'],
  ])(
    '%s records persisted count %i rather than generated count %i (%s)',
    async (status, persisted, candidates, embeddingProvider) => {
      const repositoryUpdate = vi.fn(async () => ({}));
      const count = vi.fn(async () => persisted);
      const prisma = {
        unscoped: {
          repository: {
            findFirst: vi.fn(async () => ({
              id: 'repo-1',
              fullName: 'owner/repo',
              defaultBranch: 'main',
            })),
            update: repositoryUpdate,
          },
          indexRun: {
            create: vi.fn(async () => ({ id: 'index-1' })),
            update: vi.fn(async () => ({})),
          },
          ragChunk: { count },
          $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
        },
      };
      const client = {
        getDefaultBranchSha: vi.fn(async () => 'new-sha'),
        listTree: vi.fn(async () => ({ files: [], truncated: false })),
      };
      engine.indexRepository.mockResolvedValue({
        status,
        chunksCreated: candidates,
        chunksReused: 0,
        filesProcessed: 3,
        filesSkipped: 0,
        embeddingsGenerated: 0,
        tokensEmbedded: 0,
        estimatedCostCents: 0,
        cacheHitRate: 0,
        error: status === 'FAILED' ? 'Provider unavailable' : null,
      });
      const service = new RagService(
        prisma as never,
        {} as never,
        {
          rag: {
            embeddingProvider,
            maxIndexedFiles: 100,
            geminiApiKey: 'synthetic-only',
            embeddingDimensions: 1536,
          },
          ai: { apiKeys: { openai: 'test-only' }, baseUrls: {} },
        } as never,
        { forRepository: vi.fn(async () => ({ client })) } as never,
        { record: vi.fn(async () => {}) } as never,
        {
          getPolicy: vi.fn(async () => ({ excludePatterns: [] })),
          getAiSettings: vi.fn(async () => ({
            embeddingProvider,
            embeddingModel: embeddingProvider === 'gemini' ? 'gemini-embedding-2' : 'test-model',
          })),
        } as never,
      );
      await service.indexRepository({
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        userId: null,
        force: false,
      });
      expect(count).toHaveBeenCalledWith({
        where: { repositoryId: 'repo-1', organizationId: 'org-1' },
      });
      if (embeddingProvider === 'gemini')
        expect(engine.gemini).toHaveBeenCalledWith({
          apiKey: 'synthetic-only',
          model: 'gemini-embedding-2',
          dimensions: 1536,
        });
      const data = repositoryUpdate.mock.calls.at(-1)?.[0].data;
      expect(data).toMatchObject({ indexStatus: status, indexedChunkCount: persisted });
      if (status === 'FAILED') {
        expect(data).not.toHaveProperty('indexedAt');
        expect(data).not.toHaveProperty('indexedCommitSha');
      } else {
        expect(data).toMatchObject({ indexedAt: expect.any(Date), indexedCommitSha: 'new-sha' });
      }
    },
  );
});
