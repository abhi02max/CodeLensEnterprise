import { z } from 'zod';

/**
 * Environment validation.
 *
 * The API refuses to boot on invalid configuration rather than failing later at
 * the first request that happens to need a missing value. Two cases in particular
 * are worth failing hard on:
 *
 *   - ENCRYPTION_KEY of the wrong length. AES-256-GCM needs exactly 32 bytes. A
 *     short key does not fail at startup, it fails when someone connects GitHub,
 *     and by then the error is three layers deep in an OAuth callback.
 *
 *   - JWT secrets left at their placeholder values. A deployment running with
 *     `replace_me_...` as its signing key is trivially forgeable, and it would
 *     otherwise work perfectly in testing.
 */

const PLACEHOLDER_PATTERN = /^(replace_me|changeme|your_|placeholder|xxx)/i;

const secret = (name: string, minLength = 32) =>
  z
    .string({ required_error: `${name} is required` })
    .min(minLength, `${name} must be at least ${minLength} characters`)
    .refine(
      (value) => !PLACEHOLDER_PATTERN.test(value),
      `${name} is still set to a placeholder value. Generate a real secret with: ` +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );

const booleanish = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');

export const EnvSchema = z.object({
  // ---------------------------------------------------------------- runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  // ---------------------------------------------------------------- data
  DATABASE_URL: z.string().min(1).startsWith('postgres', 'DATABASE_URL must be a Postgres URL'),
  REDIS_URL: z.string().min(1).startsWith('redis', 'REDIS_URL must be a redis:// URL'),

  // ---------------------------------------------------------------- auth
  JWT_SECRET: secret('JWT_SECRET'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /**
   * AES-256-GCM key for encrypting stored GitHub tokens. Exactly 32 bytes,
   * hex-encoded, so exactly 64 hex characters.
   */
  ENCRYPTION_KEY: z
    .string({ required_error: 'ENCRYPTION_KEY is required' })
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    ),

  // ---------------------------------------------------------------- github
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GITHUB_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/v1/auth/github/callback'),
  GITHUB_OAUTH_SCOPES: z
    .string()
    .default('read:user,user:email,repo')
    .transform((value) => value.split(',').map((scope) => scope.trim()).filter(Boolean)),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),

  // ---------------------------------------------------------------- llm
  AI_PROVIDER: z.enum(['openai', 'anthropic', 'openrouter']).default('openai'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(8000),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AI_MAX_COST_CENTS_PER_RUN: z.coerce.number().int().min(1).default(50),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),

  // ---------------------------------------------------------------- rag
  EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4096).default(1536),
  RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(12),
  RAG_MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0.7),
  RAG_MAX_CONTEXT_TOKENS_PER_FILE: z.coerce.number().int().min(256).default(4000),
  RAG_MAX_INDEXED_FILES: z.coerce.number().int().min(1).default(2000),
  VECTOR_STORE: z.enum(['pgvector', 'qdrant']).default('pgvector'),

  // ---------------------------------------------------------------- ml
  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  // ---------------------------------------------------------------- analysis
  STATIC_ANALYSIS_TMP_DIR: z.string().default('./.codelens-tmp'),
  STATIC_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  ENABLE_ESLINT: booleanish(true),
  ENABLE_SEMGREP: booleanish(true),
  ENABLE_NPM_AUDIT: booleanish(true),
  SEMGREP_RULESETS: z
    .string()
    .default('p/security-audit,p/owasp-top-ten')
    .transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean)),
  SEMGREP_BIN: z.string().default('semgrep'),

  // ---------------------------------------------------------------- queues
  QUEUE_PREFIX: z.string().default('codelens'),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** When false this process serves HTTP only and runs no workers. */
  RUN_WORKERS_IN_API: booleanish(true),

  // ---------------------------------------------------------------- observability
  SENTRY_DSN: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate `process.env` and return a typed config object.
 *
 * Errors are aggregated so a misconfigured deployment reports every problem at
 * once instead of surfacing them one restart at a time.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the required values.`,
    );
  }

  const env = result.data;

  // ---- cross-field checks
  //
  // These cannot be expressed per-field but catch configurations that validate
  // individually while being unusable together.
  const warnings: string[] = [];

  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_SECRET and JWT_REFRESH_SECRET must differ. Sharing one key means a leaked ' +
        'access token can be replayed as a refresh token, defeating short access TTLs.',
    );
  }

  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    warnings.push(
      'AI_PROVIDER is "openai" but OPENAI_API_KEY is empty. Reviews will run static ' +
        'analysis and ML risk only, and the AI review stage will be skipped.',
    );
  }
  if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    warnings.push('AI_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is empty.');
  }
  if (env.AI_PROVIDER === 'openrouter' && !env.OPENROUTER_API_KEY) {
    warnings.push('AI_PROVIDER is "openrouter" but OPENROUTER_API_KEY is empty.');
  }

  if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    warnings.push(
      'EMBEDDING_PROVIDER is "openai" but OPENAI_API_KEY is empty. Repository indexing ' +
        'will fail, and reviews will run without repository context.',
    );
  }

  // text-embedding-3-small is 1536-dimensional and the RagChunk column is
  // vector(1536). A mismatch fails on insert inside a background job, which is a
  // bad place to discover it.
  if (env.EMBEDDING_PROVIDER === 'local' && env.EMBEDDING_DIMENSIONS === 1536) {
    warnings.push(
      'EMBEDDING_PROVIDER is "local" but EMBEDDING_DIMENSIONS is 1536. Local ' +
        'sentence-transformers models are typically 384-dimensional; a mismatch with the ' +
        'RagChunk.embedding column will fail on insert.',
    );
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    warnings.push(
      'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set. GitHub sign-in and ' +
        'repository access will be unavailable.',
    );
  }

  if (env.NODE_ENV === 'production') {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      warnings.push(
        'GITHUB_WEBHOOK_SECRET is empty in production. Inbound webhooks cannot be ' +
          'verified and will be rejected.',
      );
    }
    if (env.CORS_ORIGINS.some((origin) => origin.includes('localhost'))) {
      warnings.push(`CORS_ORIGINS contains localhost in production: ${env.CORS_ORIGINS.join(', ')}`);
    }
  }

  for (const warning of warnings) {
    // Written directly rather than through the Nest logger: this runs before the
    // application context exists.
    console.warn(`[config] ${warning}`);
  }

  return env;
}
