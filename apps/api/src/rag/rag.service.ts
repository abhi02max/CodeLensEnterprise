import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  ChunkKind,
  IndexStatus,
  RetrieveContextSchema,
  estimateTokens,
  type EmbeddingProvider,
  type IndexProgress,
  type PrContextBundle,
  type RetrievalResult,
  type RetrievedChunk,
} from '@codelens/shared';
import {
  CachedEmbeddingProvider,
  GeminiEmbeddingProvider,
  HybridRetriever,
  LocalEmbeddingProvider,
  OpenAiEmbeddingProvider,
  PgVectorStore,
  indexRepository,
} from '@codelens/rag-engine';
import { extractIdentifiers, extractImportSpecifiers, parseUnifiedPatch } from '@codelens/github';
import { NotFoundError, ValidationError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../audit-logs/audit.service';
import { GithubClientFactory } from '../auth/github-client.factory';
import { PolicyService } from '../organizations/policy.service';
import { authoritativeRunId } from '../analysis/analysis-report.service';

/**
 * Repository indexing and context retrieval.
 *
 * Wires `packages/rag-engine` to the API's Postgres, Redis and GitHub access. The engine
 * itself is storage-agnostic; this service supplies the pgvector store, the cached
 * embedding provider, and a file source backed by the GitHub tree API.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly github: GithubClientFactory,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  /**
   * Build the embedding provider for an organization.
   *
   * Always wrapped in {@link CachedEmbeddingProvider}. Keying the cache on a content hash
   * is the single biggest cost lever in the whole product: most of a repository does not
   * change between pull requests, so a re-index should issue a handful of embedding calls
   * rather than thousands.
   */
  private async embeddingProvider(organizationId: string): Promise<EmbeddingProvider> {
    const settings = await this.policy.getAiSettings(organizationId);

    const inner: EmbeddingProvider =
      settings.embeddingProvider === 'local'
        ? new LocalEmbeddingProvider({
            serviceUrl: this.config.ml.url,
            model: settings.embeddingModel,
            dimensions: this.config.rag.embeddingDimensions,
          })
        : settings.embeddingProvider === 'gemini'
        ? new GeminiEmbeddingProvider({
            apiKey: this.config.rag.geminiApiKey,
            model: settings.embeddingModel,
            dimensions: this.config.rag.embeddingDimensions,
          })
        : new OpenAiEmbeddingProvider({
            apiKey: this.config.ai.apiKeys.openai,
            model: settings.embeddingModel,
            dimensions: this.config.rag.embeddingDimensions,
            baseUrl: this.config.ai.baseUrls.openai,
          });

    return new CachedEmbeddingProvider(inner, this.redis);
  }

  private store(organizationId: string): PgVectorStore {
    return new PgVectorStore(
      this.prisma.unscoped,
      organizationId,
      this.config.rag.embeddingDimensions,
    );
  }

  private async retriever(organizationId: string): Promise<HybridRetriever> {
    return new HybridRetriever({
      store: this.store(organizationId),
      embeddings: await this.embeddingProvider(organizationId),
    });
  }

  /**
   * Index a repository.
   *
   * Long-running and called from a BullMQ worker rather than a request. Progress is
   * persisted to the IndexRun row as it goes, so the UI can show live progress on an
   * operation that can take minutes on a large repository.
   */
  async indexRepository(params: {
    organizationId: string;
    repositoryId: string;
    userId: string | null;
    force: boolean;
    maxFiles?: number;
    includePaths?: string[];
    onProgress?: (progress: Partial<IndexProgress>) => void;
  }): Promise<IndexProgress> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: params.repositoryId, organizationId: params.organizationId },
      select: { id: true, fullName: true, defaultBranch: true, indexedCommitSha: true },
    });

    if (!repository) throw new NotFoundError('Repository', params.repositoryId);

    if (this.config.rag.embeddingProvider === 'openai' && !this.config.ai.apiKeys.openai) {
      throw new ValidationError(
        'Repository indexing requires an embedding provider. Set OPENAI_API_KEY, or switch ' +
          'the organization to local embeddings.',
      );
    }

    const { client } = await this.github.forRepository({
      repositoryId: params.repositoryId,
      organizationId: params.organizationId,
      preferUserId: params.userId,
    });

    const headSha = await client.getDefaultBranchSha(
      repository.fullName,
      repository.defaultBranch,
    );

    const tree = await client.listTree(repository.fullName, headSha);

    if (tree.truncated) {
      this.logger.warn(
        `GitHub truncated the file tree for ${repository.fullName}; indexing the subset it ` +
          `returned. Use includePaths to narrow the scope for very large repositories.`,
      );
    }

    const policy = await this.policy.getPolicy(params.organizationId);

    const indexRun = await this.prisma.unscoped.indexRun.create({
      data: {
        organizationId: params.organizationId,
        repositoryId: params.repositoryId,
        status: IndexStatus.INDEXING,
        commitSha: headSha,
        force: params.force,
        filesDiscovered: tree.files.length,
      },
      select: { id: true },
    });

    await this.prisma.unscoped.repository.update({
      where: { id: params.repositoryId },
      data: { indexStatus: IndexStatus.INDEXING, indexError: null },
    });

    try {
      const progress = await indexRepository(
        {
          store: this.store(params.organizationId),
          embeddings: await this.embeddingProvider(params.organizationId),
          source: {
            fetch: (path) => client.getFileContent(repository.fullName, path, headSha),
          },
        },
        {
          repositoryId: params.repositoryId,
          commitSha: headSha,
          treeFiles: tree.files,
          force: params.force,
          maxFiles: params.maxFiles ?? this.config.rag.maxIndexedFiles,
          includePaths: params.includePaths ?? [],
          excludePatterns: policy.excludePatterns,
          // Bounded so a large repository does not exhaust the GitHub hourly budget in a
          // burst and trigger a secondary rate limit.
          fetchConcurrency: 8,
          treeComplete: !tree.truncated,
          onProgress: (partial) => {
            params.onProgress?.(partial);
            void this.persistProgress(indexRun.id, partial);
          },
        },
      );

      const persistedChunkCount = await this.prisma.unscoped.ragChunk.count({
        where: { repositoryId: params.repositoryId, organizationId: params.organizationId },
      });

      await this.prisma.unscoped.$transaction([
        this.prisma.unscoped.indexRun.update({
          where: { id: indexRun.id },
          data: {
            status: progress.status,
            filesProcessed: progress.filesProcessed,
            filesSkipped: progress.filesSkipped,
            chunksCreated: progress.chunksCreated,
            chunksReused: progress.chunksReused,
            embeddingsGenerated: progress.embeddingsGenerated,
            tokensEmbedded: progress.tokensEmbedded,
            estimatedCostCents: progress.estimatedCostCents,
            error: progress.error,
            finishedAt: new Date(),
          },
        }),
        this.prisma.unscoped.repository.update({
          where: { id: params.repositoryId },
          data: {
            indexStatus: progress.status,
            ...(progress.status === IndexStatus.INDEXED
              ? { indexedAt: new Date(), indexedCommitSha: headSha }
              : {}),
            indexedChunkCount: persistedChunkCount,
            indexError: progress.error,
          },
        }),
      ]);

      await this.audit.record({
        organizationId: params.organizationId,
        action:
          progress.status === IndexStatus.INDEXED
            ? AuditAction.REPO_INDEX_COMPLETED
            : AuditAction.REPO_INDEX_STARTED,
        actorId: params.userId,
        resourceType: 'Repository',
        resourceId: params.repositoryId,
        description:
          progress.status === IndexStatus.INDEXED
            ? `Indexed ${repository.fullName}: ${progress.chunksCreated} chunks, ` +
              `${progress.chunksReused} reused, ${progress.embeddingsGenerated} embedded ` +
              `(~${progress.estimatedCostCents}c)`
            : `Indexing ${repository.fullName} failed: ${progress.error}`,
        metadata: {
          commitSha: headSha,
          chunksCreated: progress.chunksCreated,
          chunksReused: progress.chunksReused,
          cacheHitRate: Number(progress.cacheHitRate.toFixed(3)),
          estimatedCostCents: progress.estimatedCostCents,
        },
      });

      return progress;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.unscoped.$transaction([
        this.prisma.unscoped.indexRun.update({
          where: { id: indexRun.id },
          data: { status: IndexStatus.FAILED, error: message, finishedAt: new Date() },
        }),
        this.prisma.unscoped.repository.update({
          where: { id: params.repositoryId },
          data: { indexStatus: IndexStatus.FAILED, indexError: message },
        }),
      ]);

      throw error;
    }
  }

  private async persistProgress(
    indexRunId: string,
    partial: Partial<IndexProgress>,
  ): Promise<void> {
    try {
      await this.prisma.unscoped.indexRun.update({
        where: { id: indexRunId },
        data: {
          filesProcessed: partial.filesProcessed ?? undefined,
          filesSkipped: partial.filesSkipped ?? undefined,
          chunksCreated: partial.chunksCreated ?? undefined,
          chunksReused: partial.chunksReused ?? undefined,
          embeddingsGenerated: partial.embeddingsGenerated ?? undefined,
          tokensEmbedded: partial.tokensEmbedded ?? undefined,
        },
      });
    } catch {
      // Progress reporting must never fail an index run.
    }
  }

  /** Ad-hoc context search, backing the RAG context viewer. */
  async searchContext(
    organizationId: string,
    repositoryId: string,
    input: Partial<Parameters<HybridRetriever['retrieve']>[0]> & { query: string },
  ): Promise<RetrievalResult> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: repositoryId, organizationId },
      select: { id: true, indexStatus: true, fullName: true },
    });

    if (!repository) throw new NotFoundError('Repository', repositoryId);

    if (repository.indexStatus !== IndexStatus.INDEXED) {
      throw new ValidationError(
        `${repository.fullName} is not indexed (status ${repository.indexStatus}). Index it ` +
          `before searching for context.`,
      );
    }

    const parsed = RetrieveContextSchema.parse({
      ...input,
      repositoryId,
      topK: input.topK ?? this.config.rag.topK,
      mmrLambda: input.mmrLambda ?? this.config.rag.mmrLambda,
      maxTokens: input.maxTokens ?? this.config.rag.maxContextTokensPerFile,
    });

    const retriever = await this.retriever(organizationId);
    return retriever.retrieve(parsed);
  }

  /**
   * Retrieve context for every changed file in a pull request.
   *
   * This is what makes the AI review specific to the codebase rather than generic. For each
   * changed file the query is built from the diff itself, and identifiers plus import
   * specifiers extracted from the patch drive the lexical and import-graph strategies that
   * pure vector search misses.
   */
  async buildPrContext(params: {
    organizationId: string;
    repositoryId: string;
    files: Array<{ filename: string; patch: string | null }>;
    pullRequestTitle: string;
    maxTokensPerFile?: number;
  }): Promise<PrContextBundle> {
    const repository = await this.prisma.unscoped.repository.findFirst({
      where: { id: params.repositoryId, organizationId: params.organizationId },
      select: { indexStatus: true },
    });

    const perFile: Record<string, RetrievalResult> = {};
    const filesWithoutContext: string[] = [];

    if (!repository || repository.indexStatus !== IndexStatus.INDEXED) {
      return {
        perFile,
        repositoryOverview: [],
        totalTokens: 0,
        filesWithContext: 0,
        filesWithoutContext: params.files.map((file) => file.filename),
      };
    }

    const retriever = await this.retriever(params.organizationId);
    const changedPaths = params.files.map((file) => file.filename);

    // Repository-level context once per review rather than per file: README and
    // architecture docs are the same for every file and would otherwise be retrieved
    // dozens of times and dominate the token budget.
    const repositoryOverview = await retriever.retrieveRepositoryOverview({
      repositoryId: params.repositoryId,
      query: `${params.pullRequestTitle}\n\nArchitecture, conventions and error handling`,
      maxTokens: 2000,
    });

    let totalTokens = repositoryOverview.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

    for (const file of params.files) {
      if (!file.patch) {
        filesWithoutContext.push(file.filename);
        continue;
      }

      const hunks = parseUnifiedPatch(file.patch);

      // The query is the changed code itself. Identifiers and imports are passed
      // separately so the lexical and import-graph strategies can use them directly
      // rather than hoping the embedding captures them.
      const result = await retriever.retrieve({
        repositoryId: params.repositoryId,
        query: `${file.filename}\n\n${file.patch.slice(0, 8000)}`,
        topK: this.config.rag.topK,
        // The changed files themselves are excluded: the model already has their diff,
        // and returning them as "context" wastes budget on content it can see.
        excludePaths: changedPaths,
        symbols: extractIdentifiers(hunks, 40),
        graphSeedPaths: [file.filename, ...extractImportSpecifiers(hunks).slice(0, 10)],
        kinds: [],
        maxTokens: params.maxTokensPerFile ?? this.config.rag.maxContextTokensPerFile,
        mmrLambda: this.config.rag.mmrLambda,
      });

      if (result.chunks.length === 0) {
        filesWithoutContext.push(file.filename);
        continue;
      }

      perFile[file.filename] = result;
      totalTokens += result.totalTokens;
    }

    return {
      perFile,
      repositoryOverview,
      totalTokens,
      filesWithContext: Object.keys(perFile).length,
      filesWithoutContext,
    };
  }

  /**
   * Persist the retrieved context for a run.
   *
   * Stored rather than recomputed so the RAG Context Viewer shows what the AI actually
   * saw, even after the repository is re-indexed and the underlying chunks change. Without
   * this the explanation of a past review becomes unfalsifiable.
   */
  async persistRetrievedContext(
    reviewRunId: string,
    bundle: PrContextBundle,
  ): Promise<number> {
    const rows: Array<{
      reviewRunId: string;
      forFilePath: string | null;
      chunkId: string;
      path: string;
      symbol: string | null;
      kind: ChunkKind;
      content: string;
      startLine: number;
      endLine: number;
      tokenCount: number;
      score: number;
      vectorScore: number | null;
      lexicalScore: number | null;
      sources: string[];
      rationale: string | null;
      rank: number;
    }> = [];

    const push = (chunk: RetrievedChunk, forFilePath: string | null, rank: number): void => {
      rows.push({
        reviewRunId,
        forFilePath,
        chunkId: chunk.chunkId,
        path: chunk.path,
        symbol: chunk.symbol,
        kind: chunk.kind as ChunkKind,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenCount: chunk.tokenCount,
        score: chunk.score,
        vectorScore: chunk.vectorScore,
        lexicalScore: chunk.lexicalScore,
        sources: chunk.sources,
        rationale: chunk.rationale,
        rank,
      });
    };

    for (const [index, chunk] of bundle.repositoryOverview.entries()) {
      push(chunk, null, index + 1);
    }

    for (const [filePath, result] of Object.entries(bundle.perFile)) {
      for (const [index, chunk] of result.chunks.entries()) {
        push(chunk, filePath, index + 1);
      }
    }

    if (rows.length === 0) return 0;

    await this.prisma.unscoped.retrievedContext.createMany({ data: rows });
    return rows.length;
  }

  /** Context recorded for a run, for the viewer. */
  async getRunContext(organizationId: string, pullRequestId: string) {
    const pullRequest = await this.prisma.unscoped.pullRequest.findFirst({
      where: { id: pullRequestId, organizationId }, select: { headSha: true },
    });
    if (!pullRequest) throw new NotFoundError('Pull request', pullRequestId);

    const runId = await authoritativeRunId(
      this.prisma, organizationId, pullRequestId, pullRequest.headSha,
    );
    const run = runId && await this.prisma.unscoped.reviewRun.findFirst({
      where: { id: runId, organizationId }, select: { id: true, createdAt: true },
    });

    if (!run) return { reviewRunId: null, retrievedAt: null, chunks: [] };

    const chunks = await this.prisma.unscoped.retrievedContext.findMany({
      where: { reviewRunId: run.id },
      orderBy: [{ forFilePath: 'asc' }, { rank: 'asc' }],
    });

    return {
      reviewRunId: run.id,
      retrievedAt: run.createdAt.toISOString(),
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        forFilePath: chunk.forFilePath,
        chunkId: chunk.chunkId,
        path: chunk.path,
        symbol: chunk.symbol,
        kind: chunk.kind,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenCount: chunk.tokenCount,
        score: chunk.score,
        vectorScore: chunk.vectorScore,
        lexicalScore: chunk.lexicalScore,
        sources: chunk.sources,
        rationale: chunk.rationale,
        rank: chunk.rank,
      })),
    };
  }

  /** Index statistics for the repository detail page. */
  async indexStats(organizationId: string, repositoryId: string) {
    const [repository, latestRun, chunkCount, kindBreakdown] = await Promise.all([
      this.prisma.unscoped.repository.findFirst({
        where: { id: repositoryId, organizationId },
        select: { indexStatus: true, indexedAt: true, indexedChunkCount: true, indexError: true },
      }),
      this.prisma.unscoped.indexRun.findFirst({
        where: { repositoryId, organizationId },
        orderBy: { startedAt: 'desc' },
      }),
      this.store(organizationId).countByRepository(repositoryId),
      this.prisma.unscoped.ragChunk.groupBy({
        by: ['kind'],
        where: { repositoryId, organizationId },
        _count: { _all: true },
        _sum: { tokenCount: true },
      }),
    ]);

    if (!repository) throw new NotFoundError('Repository', repositoryId);

    return {
      status: repository.indexStatus,
      indexedAt: repository.indexedAt?.toISOString() ?? null,
      error: repository.indexError,
      chunkCount,
      totalTokens: kindBreakdown.reduce((sum, row) => sum + (row._sum.tokenCount ?? 0), 0),
      byKind: kindBreakdown.map((row) => ({
        kind: row.kind,
        count: row._count._all,
        tokens: row._sum.tokenCount ?? 0,
      })),
      latestRun: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,
            filesDiscovered: latestRun.filesDiscovered,
            filesProcessed: latestRun.filesProcessed,
            chunksCreated: latestRun.chunksCreated,
            chunksReused: latestRun.chunksReused,
            embeddingsGenerated: latestRun.embeddingsGenerated,
            estimatedCostCents: latestRun.estimatedCostCents,
            startedAt: latestRun.startedAt.toISOString(),
            finishedAt: latestRun.finishedAt?.toISOString() ?? null,
            error: latestRun.error,
          }
        : null,
    };
  }

  /** Rough token estimate for a prospective index, shown before a user commits to it. */
  estimateIndexTokens(files: Array<{ sizeBytes: number }>): number {
    return files.reduce((sum, file) => sum + estimateTokens('x'.repeat(file.sizeBytes)), 0);
  }
}
