import {
  IndexStatus,
  classifyFile,
  detectLanguage,
  FileFlag,
  isAnalyzable,
  mapWithConcurrency,
  toErrorMessage,
  type CodeChunk,
  type EmbeddedChunk,
  type EmbeddingProvider,
  type IndexProgress,
} from '@codelens/shared';
import { chunkFile } from './chunker';
import { buildEmbeddingInput } from './embeddings';
import type { PgVectorStore } from './pgvector-store';

/**
 * Repository indexing pipeline.
 *
 *   list tree → filter → fetch content → chunk → diff hashes → embed → upsert
 *
 * The `diff hashes` step is what makes this affordable. A repository is indexed
 * once in full; after that, only chunks whose content hash changed are re-embedded.
 * Most of a codebase is untouched between pull requests, so a typical re-index
 * issues a handful of embedding calls rather than thousands.
 */

export interface FileSource {
  /** Returns file content, or null when unavailable or too large. */
  fetch(path: string): Promise<string | null>;
}

export interface IndexerDependencies {
  store: PgVectorStore;
  embeddings: EmbeddingProvider;
  source: FileSource;
}

export interface IndexOptions {
  repositoryId: string;
  commitSha: string;
  /** Candidate paths from the repository tree, with sizes. */
  treeFiles: ReadonlyArray<{ path: string; sizeBytes: number }>;
  force: boolean;
  maxFiles: number;
  includePaths: readonly string[];
  excludePatterns: readonly string[];
  /** Concurrency for content fetching. Bounded to respect API rate limits. */
  fetchConcurrency: number;
  /** False for truncated or fixture trees; never delete unseen paths on an incomplete listing. */
  treeComplete?: boolean;
  onProgress?: (progress: Partial<IndexProgress>) => void;
}

/** Files above this size are skipped: usually vendored bundles or fixtures. */
const MAX_FILE_BYTES = 400_000;

/** Extensions worth indexing. Anything else contributes noise, not context. */
const INDEXABLE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'cs', 'php',
  'c', 'h', 'cpp', 'hpp', 'cc', 'scala',
  'md', 'mdx', 'sql', 'prisma', 'graphql', 'gql', 'proto',
  'yml', 'yaml', 'json', 'toml',
]);

export async function indexRepository(
  deps: IndexerDependencies,
  options: IndexOptions,
): Promise<IndexProgress> {
  const startedAt = new Date();

  const progress: IndexProgress = {
    repositoryId: options.repositoryId,
    status: IndexStatus.INDEXING,
    filesDiscovered: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    chunksReused: 0,
    embeddingsGenerated: 0,
    tokensEmbedded: 0,
    estimatedCostCents: 0,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    error: null,
    cacheHitRate: 0,
  };

  try {
    // ---- select files
    const selected = selectIndexableFiles(options);
    progress.filesDiscovered = selected.length;
    progress.filesSkipped = options.treeFiles.length - selected.length;
    options.onProgress?.(progress);

    // Every path in the repository, so the chunker can resolve linked test files.
    const knownPaths = new Set(options.treeFiles.map((file) => file.path));

    // ---- existing hashes for incremental indexing
    const existingHashes = options.force
      ? new Map<string, string>()
      : await deps.store.existingHashes(options.repositoryId);

    // ---- fetch and chunk
    const allChunks: CodeChunk[] = [];
    const fetchedPaths: string[] = [];

    const fetched = await mapWithConcurrency(
      selected,
      options.fetchConcurrency,
      async (file) => {
        try {
          const content = await deps.source.fetch(file.path);
          return content === null ? null : { path: file.path, content };
        } catch {
          // A single unreadable file must not abort the index run.
          return null;
        }
      },
    );

    for (const entry of fetched) {
      if (!entry) {
        progress.filesSkipped += 1;
        continue;
      }

      fetchedPaths.push(entry.path);

      const chunks = chunkFile({
        repositoryId: options.repositoryId,
        path: entry.path,
        content: entry.content,
        options: { knownPaths },
      });

      allChunks.push(...chunks);
      progress.filesProcessed += 1;

      if (progress.filesProcessed % 25 === 0) {
        options.onProgress?.({ ...progress, chunksCreated: allChunks.length });
      }
    }

    progress.chunksCreated = allChunks.length;

    // ---- skip unchanged chunks
    const toEmbed: CodeChunk[] = [];

    for (const chunk of allChunks) {
      const key = `${chunk.path}:${chunk.symbol ?? ''}`;
      if (existingHashes.get(key) === chunk.contentHash) {
        progress.chunksReused += 1;
        continue;
      }
      toEmbed.push(chunk);
    }

    progress.cacheHitRate =
      allChunks.length === 0 ? 0 : progress.chunksReused / allChunks.length;
    options.onProgress?.(progress);

    // ---- embed and store
    if (toEmbed.length > 0) {
      // Batched so a large repository does not hold every vector in memory at
      // once: 1536 floats per chunk adds up quickly across tens of thousands.
      const batchSize = 128;

      for (let offset = 0; offset < toEmbed.length; offset += batchSize) {
        const batch = toEmbed.slice(offset, offset + batchSize);
        const inputs = batch.map((chunk) => buildEmbeddingInput(chunk));
        const vectors = await deps.embeddings.embed(inputs);
        if (vectors.length !== batch.length) {
          throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} chunks`);
        }

        const embedded: EmbeddedChunk[] = [];

        for (const [index, chunk] of batch.entries()) {
          const embedding = vectors[index];
          if (!embedding) throw new Error(`Embedding provider omitted chunk ${chunk.path}`);

          embedded.push({
            ...chunk,
            embedding,
            embeddingModel: deps.embeddings.model,
          });

          progress.tokensEmbedded += chunk.tokenCount;
        }

        await deps.store.upsert(embedded);
        progress.embeddingsGenerated += embedded.length;

        options.onProgress?.(progress);
      }
    }

    await deps.store.pruneIndexedPaths(
      options.repositoryId,
      fetchedPaths,
      allChunks,
    );

    if (options.treeComplete) {
      const currentPaths = new Set(options.treeFiles.map((file) => file.path));
      const removed = orphanedPaths(await deps.store.indexedPaths(options.repositoryId), currentPaths);
      await deps.store.deleteByPaths(options.repositoryId, removed);
    }

    // text-embedding-3-small is $0.02 per million tokens at time of writing.
    progress.estimatedCostCents = Math.ceil((progress.tokensEmbedded / 1_000_000) * 2);
    progress.status = IndexStatus.INDEXED;
    progress.finishedAt = new Date().toISOString();

    options.onProgress?.(progress);
    return progress;
  } catch (error) {
    progress.status = IndexStatus.FAILED;
    progress.error = toErrorMessage(error);
    progress.finishedAt = new Date().toISOString();
    options.onProgress?.(progress);
    return progress;
  }
}

/**
 * Choose which files to index.
 *
 * Prioritized rather than merely filtered: when a repository exceeds `maxFiles`,
 * which files get dropped determines whether retrieval is useful at all. Docs and
 * API surface rank above tests, which rank above config, because architecture
 * documentation and route definitions carry disproportionate context per token.
 */
export function selectIndexableFiles(options: {
  treeFiles: ReadonlyArray<{ path: string; sizeBytes: number }>;
  maxFiles: number;
  includePaths: readonly string[];
  excludePatterns: readonly string[];
}): Array<{ path: string; sizeBytes: number }> {
  const excluded = options.excludePatterns.map(globToRegExp);

  const candidates = options.treeFiles.filter((file) => {
    if (file.sizeBytes > MAX_FILE_BYTES) return false;
    if (!isAnalyzable(file.path)) return false;

    const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
    if (!INDEXABLE_EXTENSIONS.has(extension)) return false;

    if (options.includePaths.length > 0) {
      const matches = options.includePaths.some((prefix) => file.path.startsWith(prefix));
      if (!matches) return false;
    }

    if (excluded.some((pattern) => pattern.test(file.path))) return false;

    // Vendored dependencies are somebody else's code and drown out the repo's own.
    if (/(^|\/)(node_modules|vendor|third_party|\.venv|venv|dist|build)\//.test(file.path)) {
      return false;
    }

    return true;
  });

  if (candidates.length <= options.maxFiles) return candidates;

  return [...candidates]
    .sort((a, b) => indexPriority(b.path) - indexPriority(a.path))
    .slice(0, options.maxFiles);
}

function indexPriority(path: string): number {
  const flags = classifyFile(path);
  const language = detectLanguage(path);
  let score = 0;

  // Architecture docs are the highest-value context per token in the repository.
  if (language === 'markdown') score += 40;
  if (/readme|architecture|contributing|adr|design/i.test(path)) score += 30;

  if (flags.includes(FileFlag.API_SURFACE)) score += 25;
  if (language === 'prisma' || path.endsWith('.proto') || path.endsWith('.graphql')) score += 25;

  // Sensitive areas are where reviews matter most, so their context matters most.
  if (flags.includes(FileFlag.AUTH)) score += 20;
  if (flags.includes(FileFlag.PAYMENT)) score += 20;
  if (flags.includes(FileFlag.DATABASE)) score += 15;

  // Tests below source: valuable for convention, but only after the code exists.
  if (flags.includes(FileFlag.TEST)) score += 8;
  if (flags.includes(FileFlag.CONFIG)) score += 3;
  if (flags.includes(FileFlag.DOCS)) score += 5;

  // Shallow paths tend to be more central than deeply nested ones.
  score -= path.split('/').length;

  return score;
}

/** Minimal glob support: `*` within a segment, `**` across segments. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${escaped}$`);
}

/**
 * Paths whose chunks should be deleted after a complete tree has been indexed.
 *
 * Renames and deletions leave orphaned chunks that vector search will happily
 * return, so the AI would receive context describing code that no longer exists.
 */
export function orphanedPaths(
  indexedPaths: readonly string[],
  currentPaths: ReadonlySet<string>,
): string[] {
  return indexedPaths.filter((path) => !currentPaths.has(path));
}
