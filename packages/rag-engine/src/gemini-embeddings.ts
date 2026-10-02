import type { EmbeddingProvider } from '@codelens/shared';
import { sanitizeForEmbedding } from './embeddings';

/** Native text-only embedding requests, with explicit dimensions and no implicit retries. */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly config: { apiKey: string; model: string; dimensions: number }) {
    if (!config.apiKey) throw new Error('Gemini embedding credentials are not configured');
    if (config.model !== 'gemini-embedding-2')
      throw new Error('Unsupported Gemini embedding model');
    if (
      !Number.isInteger(config.dimensions) ||
      config.dimensions < 128 ||
      config.dimensions > 3072
    ) {
      throw new Error('Invalid Gemini embedding dimensions');
    }
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (!vector) throw new Error('Gemini embedding response omitted the vector');
    return vector;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    // Separate calls prevent Gemini Embedding 2 from aggregating multiple inputs into one vector.
    for (const text of texts) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: { 'x-goog-api-key': this.config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text: sanitizeForEmbedding(text) }] },
            embedContentConfig: { outputDimensionality: this.dimensions, autoTruncate: false },
          }),
        },
      ).catch(() => {
        throw new Error('Gemini embedding transport failed');
      });
      if (!response.ok)
        throw new Error(`Gemini embedding request failed (HTTP ${response.status})`);
      const data = (await response.json().catch(() => {
        throw new Error('Gemini embedding response was not valid JSON');
      })) as { embedding?: { values?: unknown } } | null;
      const values: unknown = data?.embedding?.values;
      if (
        !Array.isArray(values) ||
        values.length !== this.dimensions ||
        values.some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
        !values.some((value) => value !== 0)
      ) {
        throw new Error('Gemini embedding response violated the vector contract');
      }
      vectors.push(values as number[]);
    }
    return vectors;
  }
}
