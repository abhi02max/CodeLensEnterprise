import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { EmbeddingCache } from '@codelens/rag-engine';
import { AppConfigService } from '../config/app-config.service';

/**
 * Redis client, cache helpers and the embedding cache implementation.
 *
 * Every cache operation is failure-tolerant by design. Redis is a performance and
 * cost optimization here, never a correctness dependency: if it is down, diffs are
 * refetched from GitHub and embeddings are recomputed. The product gets slower and
 * more expensive, but it keeps working. A cache that can take the service down is
 * worse than no cache.
 *
 * Also implements {@link EmbeddingCache} so `packages/rag-engine` can reuse the same
 * connection. Embedding caching keyed on content hash is the single largest cost
 * lever in the indexing pipeline.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy, EmbeddingCache {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  /** Set after repeated failures so a dead Redis stops adding latency to requests. */
  private degraded = false;
  private consecutiveFailures = 0;

  constructor(private readonly config: AppConfigService) {
    this.client = new Redis(config.redisUrl, {
      // This is the best-effort cache client, not BullMQ's blocking connection.
      maxRetriesPerRequest: 1,
      commandTimeout: 5000,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    this.client.on('error', (error) => {
      // Logged at warn, not error: a reconnect loop should not read as an outage.
      this.logger.warn(`Redis error: ${error.message}`);
    });

    this.client.on('ready', () => {
      this.degraded = false;
      this.consecutiveFailures = 0;
      this.logger.log('Redis connected');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      this.degraded = true;
      this.logger.warn(
        `Redis unavailable at startup; caching and background jobs are degraded. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  // ---------------------------------------------------------------- generic cache

  async getJson<T>(key: string): Promise<T | null> {
    return this.guard(async () => {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    }, null);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.guard(async () => {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    }, false);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.guard(() => this.client.del(...keys), 0);
  }

  /**
   * Fixed-window rate limit counter.
   *
   * Used for expensive operations that Nest's ThrottlerGuard cannot express
   * because the limit is per organization rather than per IP — a single org should
   * not be able to enqueue a hundred analysis runs and starve every other tenant.
   *
   * Fails open: if Redis is unavailable the request proceeds. Blocking legitimate
   * work because the rate limiter is down is the wrong trade for this product.
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetInSeconds: number }> {
    return this.guard(
      async () => {
        const pipeline = this.client.multi();
        pipeline.incr(key);
        pipeline.ttl(key);
        const results = await pipeline.exec();

        const count = Number(results?.[0]?.[1] ?? 0);
        let ttl = Number(results?.[1]?.[1] ?? -1);

        if (ttl < 0) {
          await this.client.expire(key, windowSeconds);
          ttl = windowSeconds;
        }

        return {
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          resetInSeconds: ttl,
        };
      },
      { allowed: true, remaining: limit, resetInSeconds: 0 },
    );
  }

  /**
   * Best-effort distributed lock.
   *
   * Prevents two workers from analysing the same pull request concurrently, which
   * would duplicate LLM spend and race on the same ToolRun rows. Not a consensus
   * lock and does not need to be: the idempotency key on ReviewRun is the real
   * correctness guarantee, and this only avoids obvious waste.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    return this.guard(async () => {
      const result = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
      return result === 'OK' ? token : null;
    }, token);
  }

  async releaseLock(key: string, token: string): Promise<void> {
    try {
      await this.client.eval(
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
        1, key, token,
      );
    } catch {
      this.logger.warn('Could not release analysis lock; its TTL will expire');
    }
  }

  // ---------------------------------------------------------------- EmbeddingCache

  async get(key: string): Promise<number[] | null> {
    return this.guard(async () => {
      // Stored as a packed Float32 buffer rather than JSON. A 1536-dimensional
      // vector is ~6 KB packed versus ~20 KB as a JSON array of decimals, and it
      // skips parse cost on every hit.
      const buffer = await this.client.getBuffer(key);
      if (!buffer || buffer.length % 4 !== 0) return null;

      const floats = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / 4,
      );
      return Array.from(floats);
    }, null);
  }

  async set(key: string, value: number[], ttlSeconds: number): Promise<void> {
    await this.guard(async () => {
      const floats = new Float32Array(value);
      const buffer = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
      await this.client.set(key, buffer, 'EX', ttlSeconds);
      return true;
    }, false);
  }

  // ---------------------------------------------------------------- health

  async isHealthy(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();

    try {
      const pong = await this.client.ping();
      return { ok: pong === 'PONG', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Run a Redis operation, returning a fallback on failure.
   *
   * After five consecutive failures the service marks itself degraded, which the
   * health endpoint surfaces. Callers never see an exception from the cache layer.
   */
  private async guard<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const result = await operation();
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;

      if (this.consecutiveFailures >= 5 && !this.degraded) {
        this.degraded = true;
        this.logger.warn(
          `Redis marked degraded after ${this.consecutiveFailures} consecutive failures: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return fallback;
    }
  }
}
