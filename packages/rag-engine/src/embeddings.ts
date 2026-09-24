import { createHash } from 'node:crypto';
import { chunkArray, retry, type EmbeddingProvider } from '@codelens/shared';

/**
 * Embedding providers.
 *
 * Two implementations behind one interface:
 *
 *   - OpenAiEmbeddingProvider for hosted embeddings
 *   - LocalEmbeddingProvider, which delegates to the ML service running
 *     sentence-transformers, for organizations that cannot send code to a
 *     third party at all
 *
 * The caching wrapper matters more than either. Most of a repository does not
 * change between pull requests, so re-embedding on every index run would be the
 * dominant cost of the entire product. Keying the cache on a content hash makes
 * re-indexing a mostly-free operation.
 */

export interface EmbeddingCache {
  get(key: string): Promise<number[] | null>;
  set(key: string, value: number[], ttlSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------- openai

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(params: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
  }) {
    this.apiKey = params.apiKey;
    this.model = params.model ?? 'text-embedding-3-small';
    this.dimensions = params.dimensions ?? 1536;
    this.baseUrl = params.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embedOne(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    if (!embedding) throw new Error('Embedding provider returned no vector');
    return embedding;
  }

  /**
   * Batch embed.
   *
   * Batches are capped at 96 inputs: the API accepts more, but a large batch that
   * fails takes every input down with it, and retrying 2048 items because one was
   * malformed is expensive. 96 keeps the blast radius small while still amortizing
   * request overhead.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (const batch of chunkArray(texts, 96)) {
      const vectors = await retry(
        async () => {
          const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: this.model,
              input: batch.map((text) => sanitizeForEmbedding(text)),
              // Supported by text-embedding-3-*; lets one model serve multiple
              // dimension configurations without re-indexing from scratch.
              ...(this.model.startsWith('text-embedding-3') ? { dimensions: this.dimensions } : {}),
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            const error = new Error(
              `Embedding request failed (${response.status}): ${body.slice(0, 300)}`,
            );
            // Mark rate limits and server errors as retryable.
            (error as Error & { retryable?: boolean }).retryable =
              response.status === 429 || response.status >= 500;
            throw error;
          }

          const data = (await response.json()) as {
            data: Array<{ embedding: number[]; index: number }>;
          };

          // The API does not guarantee response order matches input order.
          return data.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
        },
        {
          attempts: 4,
          baseDelayMs: 1000,
          maxDelayMs: 20_000,
          shouldRetry: (error) => (error as Error & { retryable?: boolean }).retryable === true,
        },
      );

      results.push(...vectors);
    }

    return results;
  }
}

// ---------------------------------------------------------------- local

/**
 * Local embeddings via the ML service.
 *
 * Trades quality for the guarantee that no source code leaves the deployment.
 * Note the dimension difference: all-MiniLM-L6-v2 produces 384-dimensional
 * vectors, so switching providers requires a matching `vector(N)` column and a
 * full re-index. `ensureVectorSetup` warns when the two disagree.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private readonly serviceUrl: string;

  constructor(params: { serviceUrl: string; model?: string; dimensions?: number }) {
    this.serviceUrl = params.serviceUrl.replace(/\/$/, '');
    this.model = params.model ?? 'all-MiniLM-L6-v2';
    this.dimensions = params.dimensions ?? 384;
  }

  async embedOne(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    if (!embedding) throw new Error('Local embedding provider returned no vector');
    return embedding;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (const batch of chunkArray(texts, 64)) {
      const vectors = await retry(
        async () => {
          const response = await fetch(`${this.serviceUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              texts: batch.map((text) => sanitizeForEmbedding(text)),
              model: this.model,
            }),
          });

          if (!response.ok) {
            const error = new Error(`Local embedding service failed (${response.status})`);
            (error as Error & { retryable?: boolean }).retryable = response.status >= 500;
            throw error;
          }

          const data = (await response.json()) as { embeddings: number[][] };
          return data.embeddings;
        },
        {
          attempts: 3,
          baseDelayMs: 500,
          shouldRetry: (error) => (error as Error & { retryable?: boolean }).retryable === true,
        },
      );

      results.push(...vectors);
    }

    return results;
  }
}

// ---------------------------------------------------------------- caching

/**
 * Content-hash caching wrapper.
 *
 * The single most effective cost control in the indexing pipeline. A repository
 * re-indexed after a one-file change should issue one embedding call, not
 * thousands, and that only happens if the cache key is derived from content
 * rather than from path or chunk id.
 */
export class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly cache: EmbeddingCache,
    private readonly ttlSeconds = 60 * 60 * 24 * 30,
  ) {
    this.model = inner.model;
    this.dimensions = inner.dimensions;
  }

  get stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total === 0 ? 0 : this.hits / total };
  }

  async embedOne(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    if (!embedding) throw new Error('Cached embedding provider returned no vector');
    return embedding;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[] | null>(texts.length).fill(null);
    const uncachedIndices: number[] = [];

    // The model is part of the key: the same text embedded by a different model
    // is a different vector, and mixing them silently corrupts search results.
    const keys = texts.map((text) => this.cacheKey(text));

    await Promise.all(
      keys.map(async (key, index) => {
        const cached = await this.cache.get(key).catch(() => null);
        if (cached && cached.length === this.dimensions) {
          results[index] = cached;
          this.hits += 1;
        } else {
          uncachedIndices.push(index);
          this.misses += 1;
        }
      }),
    );

    if (uncachedIndices.length > 0) {
      const toEmbed = uncachedIndices.map((index) => texts[index] ?? '');
      const fresh = await this.inner.embed(toEmbed);

      await Promise.all(
        uncachedIndices.map(async (originalIndex, i) => {
          const vector = fresh[i];
          if (!vector) return;

          results[originalIndex] = vector;
          const key = keys[originalIndex];
          if (key) {
            await this.cache.set(key, vector, this.ttlSeconds).catch(() => {
              // A cache write failure must not fail an index run.
            });
          }
        }),
      );
    }

    return results.map((vector) => vector ?? new Array<number>(this.dimensions).fill(0));
  }

  private cacheKey(text: string): string {
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 40);
    return `emb:${this.model}:${this.dimensions}:${hash}`;
  }
}

/** In-memory cache for tests and single-process development. */
export class InMemoryEmbeddingCache implements EmbeddingCache {
  private readonly store = new Map<string, number[]>();

  async get(key: string): Promise<number[] | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: number[]): Promise<void> {
    this.store.set(key, value);
  }
}

/**
 * Prepare text for embedding.
 *
 * Null bytes break the API, and extremely long inputs are truncated server-side
 * anyway — doing it here makes the token accounting honest rather than silently
 * paying for content that was discarded.
 */
function sanitizeForEmbedding(text: string): string {
  const cleaned = text.replace(/\0/g, '').trim();
  // 8191 tokens is the model limit; ~3.6 chars/token leaves a safety margin.
  const maxChars = 28_000;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned || ' ';
}

/**
 * Text actually sent for embedding.
 *
 * Prefixing the path and symbol measurably improves retrieval: it gives the
 * vector lexical anchors that a bare function body lacks, so a query mentioning
 * a file or symbol name lands closer to the right chunk.
 */
export function buildEmbeddingInput(chunk: {
  path: string;
  symbol: string | null;
  kind: string;
  content: string;
  metadata?: { docComment?: string | null; route?: { method: string; path: string } | null };
}): string {
  const header: string[] = [`${chunk.kind} in ${chunk.path}`];

  if (chunk.symbol) header.push(`symbol: ${chunk.symbol}`);
  if (chunk.metadata?.route) {
    header.push(`route: ${chunk.metadata.route.method} ${chunk.metadata.route.path}`);
  }
  if (chunk.metadata?.docComment) header.push(`doc: ${chunk.metadata.docComment}`);

  return `${header.join('\n')}\n\n${chunk.content}`;
}
