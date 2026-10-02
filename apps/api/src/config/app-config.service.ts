import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed configuration accessor.
 *
 * Wraps Nest's ConfigService so the rest of the codebase reads
 * `config.encryptionKey` rather than `configService.get<string>('ENCRYPTION_KEY')`.
 * That removes the two failure modes of raw string lookups: a typo'd key silently
 * returning undefined, and a caller inventing its own type for a value.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  // ---------------------------------------------------------------- runtime
  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }
  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }
  get port(): number {
    return this.get('API_PORT');
  }
  get apiUrl(): string {
    return this.get('API_URL');
  }
  get webUrl(): string {
    return this.get('WEB_URL');
  }
  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS');
  }

  // ---------------------------------------------------------------- data
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }
  get redisUrl(): string {
    return this.get('REDIS_URL');
  }

  // ---------------------------------------------------------------- auth
  get jwtSecret(): string {
    return this.get('JWT_SECRET');
  }
  get jwtAccessTtl(): string {
    return this.get('JWT_ACCESS_TTL');
  }
  get jwtRefreshSecret(): string {
    return this.get('JWT_REFRESH_SECRET');
  }
  get jwtRefreshTtl(): string {
    return this.get('JWT_REFRESH_TTL');
  }
  get encryptionKey(): string {
    return this.get('ENCRYPTION_KEY');
  }

  // ---------------------------------------------------------------- github
  get github(): {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    scopes: string[];
    webhookSecret: string;
    configured: boolean;
  } {
    const clientId = this.get('GITHUB_CLIENT_ID');
    const clientSecret = this.get('GITHUB_CLIENT_SECRET');

    return {
      clientId,
      clientSecret,
      callbackUrl: this.get('GITHUB_CALLBACK_URL'),
      scopes: this.get('GITHUB_OAUTH_SCOPES'),
      webhookSecret: this.get('GITHUB_WEBHOOK_SECRET'),
      configured: Boolean(clientId && clientSecret),
    };
  }

  // ---------------------------------------------------------------- llm
  get ai(): {
    provider: 'openai' | 'anthropic' | 'openrouter';
    model: string;
    maxOutputTokens: number;
    temperature: number;
    maxCostCentsPerRun: number;
    apiKeys: { openai: string; anthropic: string; openrouter: string };
    baseUrls: { openai: string; anthropic: string; openrouter: string };
    configured: boolean;
  } {
    const provider = this.get('AI_PROVIDER');
    const apiKeys = {
      openai: this.get('OPENAI_API_KEY'),
      anthropic: this.get('ANTHROPIC_API_KEY'),
      openrouter: this.get('OPENROUTER_API_KEY'),
    };

    return {
      provider,
      model: this.get('AI_MODEL'),
      maxOutputTokens: this.get('AI_MAX_OUTPUT_TOKENS'),
      temperature: this.get('AI_TEMPERATURE'),
      maxCostCentsPerRun: this.get('AI_MAX_COST_CENTS_PER_RUN'),
      apiKeys,
      baseUrls: {
        openai: this.get('OPENAI_BASE_URL'),
        anthropic: this.get('ANTHROPIC_BASE_URL'),
        openrouter: this.get('OPENROUTER_BASE_URL'),
      },
      configured: Boolean(apiKeys[provider]),
    };
  }

  // ---------------------------------------------------------------- rag
  get rag(): {
    embeddingProvider: 'openai' | 'local' | 'gemini';
    geminiApiKey: string;
    embeddingModel: string;
    embeddingDimensions: number;
    topK: number;
    mmrLambda: number;
    maxContextTokensPerFile: number;
    maxIndexedFiles: number;
    vectorStore: 'pgvector' | 'qdrant';
  } {
    return {
      embeddingProvider: this.get('EMBEDDING_PROVIDER'),
      geminiApiKey: this.get('GEMINI_API_KEY'),
      embeddingModel: this.get('EMBEDDING_MODEL'),
      embeddingDimensions: this.get('EMBEDDING_DIMENSIONS'),
      topK: this.get('RAG_TOP_K'),
      mmrLambda: this.get('RAG_MMR_LAMBDA'),
      maxContextTokensPerFile: this.get('RAG_MAX_CONTEXT_TOKENS_PER_FILE'),
      maxIndexedFiles: this.get('RAG_MAX_INDEXED_FILES'),
      vectorStore: this.get('VECTOR_STORE'),
    };
  }

  // ---------------------------------------------------------------- ml
  get ml(): { url: string; timeoutMs: number } {
    return {
      url: this.get('ML_SERVICE_URL').replace(/\/$/, ''),
      timeoutMs: this.get('ML_SERVICE_TIMEOUT_MS'),
    };
  }

  // ---------------------------------------------------------------- analysis
  get analysis(): {
    tmpDir: string;
    timeoutMs: number;
    enableEslint: boolean;
    enableSemgrep: boolean;
    enableNpmAudit: boolean;
    semgrepRulesets: string[];
    semgrepBinary: string;
  } {
    return {
      tmpDir: this.get('STATIC_ANALYSIS_TMP_DIR'),
      timeoutMs: this.get('STATIC_ANALYSIS_TIMEOUT_MS'),
      enableEslint: this.get('ENABLE_ESLINT'),
      enableSemgrep: this.get('ENABLE_SEMGREP'),
      enableNpmAudit: this.get('ENABLE_NPM_AUDIT'),
      semgrepRulesets: this.get('SEMGREP_RULESETS'),
      semgrepBinary: this.get('SEMGREP_BIN'),
    };
  }

  // ---------------------------------------------------------------- queues
  get queue(): {
    prefix: string;
    concurrency: number;
    maxAttempts: number;
    runWorkersInApi: boolean;
    shutdownDrainMs: number;
  } {
    return {
      prefix: this.get('QUEUE_PREFIX'),
      concurrency: this.get('QUEUE_CONCURRENCY'),
      maxAttempts: this.get('QUEUE_MAX_ATTEMPTS'),
      runWorkersInApi: this.get('RUN_WORKERS_IN_API'),
      shutdownDrainMs: this.get('SHUTDOWN_DRAIN_MS'),
    };
  }

  get sentryDsn(): string {
    return this.get('SENTRY_DSN');
  }
}
