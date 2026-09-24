import {
  retry,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
} from '@codelens/shared';

/**
 * LLM provider adapters.
 *
 * One interface, three implementations, plus a router that falls back between
 * them. The router matters operationally: a provider returning 429 for ten
 * minutes should not take every review in the queue down with it, and an
 * organization that switches models should not require a deployment.
 *
 * Cost is computed per call and recorded on the ToolRun, because "how much did
 * this review cost" is a question every enterprise buyer asks and a per-request
 * estimate is the only way to answer it.
 */

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Per-million-token pricing, used for cost accounting. */
  pricing?: { promptPerMillion: number; completionPerMillion: number };
}

/**
 * Pricing table in USD per million tokens.
 *
 * Deliberately conservative and explicitly a snapshot: provider pricing changes,
 * and a wrong number here produces misleading cost reports rather than a failure,
 * which is the more dangerous kind of wrong. Organizations can override it.
 */
const DEFAULT_PRICING: Record<string, { promptPerMillion: number; completionPerMillion: number }> = {
  'gpt-4o': { promptPerMillion: 2.5, completionPerMillion: 10 },
  'gpt-4o-mini': { promptPerMillion: 0.15, completionPerMillion: 0.6 },
  'gpt-4.1': { promptPerMillion: 2, completionPerMillion: 8 },
  'gpt-4.1-mini': { promptPerMillion: 0.4, completionPerMillion: 1.6 },
  'claude-sonnet-4': { promptPerMillion: 3, completionPerMillion: 15 },
  'claude-3-5-sonnet-latest': { promptPerMillion: 3, completionPerMillion: 15 },
  'claude-3-5-haiku-latest': { promptPerMillion: 0.8, completionPerMillion: 4 },
};

function resolvePricing(model: string, override?: ProviderConfig['pricing']) {
  if (override) return override;

  // Match the longest known prefix so versioned model ids still resolve.
  const match = Object.keys(DEFAULT_PRICING)
    .filter((key) => model.includes(key))
    .sort((a, b) => b.length - a.length)[0];

  return match ? DEFAULT_PRICING[match]! : { promptPerMillion: 1, completionPerMillion: 4 };
}

function computeCostCents(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
  override?: ProviderConfig['pricing'],
): number {
  const pricing = resolvePricing(model, override);
  const dollars =
    (usage.promptTokens / 1_000_000) * pricing.promptPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.completionPerMillion;

  // Rounded up to whole cents: under-reporting spend is worse than over-reporting.
  return Math.ceil(dollars * 100);
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly provider: string,
    /**
     * A short machine code from the provider, such as `invalid_api_key` or
     * `context_length_exceeded`. Safe to show a user: it is an enum value, not content.
     */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

// ---------------------------------------------------------------- openai

export class OpenAiProvider implements LlmProvider {
  readonly name = 'OPENAI';

  constructor(private readonly config: ProviderConfig) {}

  async complete(params: {
    messages: LlmMessage[];
    temperature?: number;
    maxOutputTokens?: number;
    jsonMode?: boolean;
    signal?: AbortSignal;
  }): Promise<LlmCompletion> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';

    return retry(
      async () => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: params.messages,
            temperature: params.temperature ?? 0.2,
            max_tokens: params.maxOutputTokens ?? 8000,
            // Guarantees syntactically valid JSON. It does not guarantee the
            // shape, which is why every response still goes through Zod.
            ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          ...(params.signal ? { signal: params.signal } : {}),
        });

        if (!response.ok) {
          throw await toProviderError(response, this.name);
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string | null }; finish_reason: string }>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          model: string;
        };

        const choice = data.choices[0];
        if (!choice) throw new LlmProviderError('No completion returned', null, true, this.name);

        const usage = {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        };

        return {
          content: choice.message.content ?? '',
          usage,
          model: data.model,
          finishReason: choice.finish_reason,
          costCents: computeCostCents(data.model, usage, this.config.pricing),
        };
      },
      {
        attempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 30_000,
        shouldRetry: (error) => error instanceof LlmProviderError && error.retryable,
      },
    );
  }
}

// ---------------------------------------------------------------- anthropic

export class AnthropicProvider implements LlmProvider {
  readonly name = 'ANTHROPIC';

  constructor(private readonly config: ProviderConfig) {}

  async complete(params: {
    messages: LlmMessage[];
    temperature?: number;
    maxOutputTokens?: number;
    jsonMode?: boolean;
    signal?: AbortSignal;
  }): Promise<LlmCompletion> {
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com';

    // Anthropic takes the system prompt as a top-level field rather than a message.
    const system = params.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const conversation = params.messages.filter((message) => message.role !== 'system');

    return retry(
      async () => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: params.maxOutputTokens ?? 8000,
            temperature: params.temperature ?? 0.2,
            ...(system ? { system } : {}),
            messages: conversation.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            // No JSON mode: prefilling the assistant turn with "{" is the
            // documented way to force a JSON object, and it works reliably.
            ...(params.jsonMode
              ? { messages: [...conversation, { role: 'assistant', content: '{' }] }
              : {}),
          }),
          ...(params.signal ? { signal: params.signal } : {}),
        });

        if (!response.ok) {
          throw await toProviderError(response, this.name);
        }

        const data = (await response.json()) as {
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens: number; output_tokens: number };
          model: string;
          stop_reason: string;
        };

        const text = data.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        const usage = {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        };

        return {
          // Re-attach the prefilled brace so the result parses as JSON.
          content: params.jsonMode && !text.trimStart().startsWith('{') ? `{${text}` : text,
          usage,
          model: data.model,
          finishReason: data.stop_reason,
          costCents: computeCostCents(data.model, usage, this.config.pricing),
        };
      },
      {
        attempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 30_000,
        shouldRetry: (error) => error instanceof LlmProviderError && error.retryable,
      },
    );
  }
}

// ---------------------------------------------------------------- openrouter

/**
 * OpenRouter speaks the OpenAI wire format, so it reuses that implementation and
 * only adds the attribution headers OpenRouter expects.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = 'OPENROUTER';

  private readonly inner: OpenAiProvider;

  constructor(config: ProviderConfig) {
    this.inner = new OpenAiProvider({
      ...config,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
    });
  }

  complete(params: Parameters<LlmProvider['complete']>[0]): Promise<LlmCompletion> {
    return this.inner.complete(params);
  }
}

// ---------------------------------------------------------------- router

/**
 * Provider router with fallback.
 *
 * Tries the organization's configured provider, then any configured alternatives
 * in order. Only retryable failures trigger a fallback: an invalid API key or a
 * malformed request would fail identically everywhere, and masking that as a
 * fallback would hide a configuration error behind a surprise bill on a second
 * provider.
 */
export class ProviderRouter implements LlmProvider {
  readonly name = 'ROUTER';

  constructor(
    private readonly providers: LlmProvider[],
    private readonly onFallback?: (from: string, to: string, reason: string) => void,
  ) {
    if (providers.length === 0) {
      throw new Error('ProviderRouter requires at least one configured provider');
    }
  }

  async complete(params: Parameters<LlmProvider['complete']>[0]): Promise<LlmCompletion> {
    let lastError: unknown;

    for (const [index, provider] of this.providers.entries()) {
      try {
        return await provider.complete(params);
      } catch (error) {
        lastError = error;

        const isRetryable = error instanceof LlmProviderError && error.retryable;
        const next = this.providers[index + 1];

        if (!isRetryable || !next) throw error;

        this.onFallback?.(
          provider.name,
          next.name,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    throw lastError;
  }
}

/**
 * Turn a failed HTTP response into an error, without carrying the response body.
 *
 * The body is deliberately dropped. This error's message ends up on `ToolRun.error`, which the
 * API returns in the review workspace and in run detail — and a 400 from OpenAI or Anthropic
 * routinely quotes the offending input back, which here is the diff and the assembled prompt.
 * Echoing it would publish repository content and the internal prompt through an error field.
 *
 * What is extracted instead is the provider's machine-readable `code` or `type`, which is an
 * enum value (`invalid_api_key`, `context_length_exceeded`) and tells the operator what to fix
 * without reproducing anything that was sent.
 */
async function toProviderError(response: Response, provider: string): Promise<LlmProviderError> {
  const body = await response.text().catch(() => '');
  const detail = extractProviderErrorCode(body);

  // 429 and 5xx are transient. 400/401/403 indicate a configuration problem and
  // retrying only wastes time and quota.
  const retryable = response.status === 429 || response.status >= 500;

  return new LlmProviderError(
    `${provider} request failed with HTTP ${response.status}` +
      (detail ? ` (${detail})` : '') +
      '. Response body withheld: provider errors can echo the submitted prompt.',
    response.status,
    retryable,
    provider,
    detail,
  );
}

/**
 * Pull the provider's error code out of a JSON error body, if there is one.
 *
 * Constrained on purpose: only a short, identifier-shaped value from a known field is accepted.
 * A provider that returns prose in `code` gets nothing extracted rather than having prose
 * forwarded into a persisted error field.
 */
function extractProviderErrorCode(body: string): string | null {
  if (!body) return null;

  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; type?: unknown };
      type?: unknown;
    };

    const candidate =
      firstString(parsed.error?.code) ?? firstString(parsed.error?.type) ?? firstString(parsed.type);

    if (candidate && /^[a-z0-9_.-]{1,60}$/i.test(candidate)) return candidate;
  } catch {
    // Not JSON, or an unexpected shape. Either way there is nothing safe to extract.
  }

  return null;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Build a provider from organization settings. */
export function createProvider(params: {
  provider: 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER';
  model: string;
  apiKeys: { openai?: string; anthropic?: string; openrouter?: string };
  baseUrls?: { openai?: string; anthropic?: string; openrouter?: string };
}): LlmProvider {
  switch (params.provider) {
    case 'ANTHROPIC': {
      if (!params.apiKeys.anthropic) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }
      return new AnthropicProvider({
        apiKey: params.apiKeys.anthropic,
        model: params.model,
        ...(params.baseUrls?.anthropic ? { baseUrl: params.baseUrls.anthropic } : {}),
      });
    }
    case 'OPENROUTER': {
      if (!params.apiKeys.openrouter) {
        throw new Error('OPENROUTER_API_KEY is not configured');
      }
      return new OpenRouterProvider({
        apiKey: params.apiKeys.openrouter,
        model: params.model,
        ...(params.baseUrls?.openrouter ? { baseUrl: params.baseUrls.openrouter } : {}),
      });
    }
    case 'OPENAI':
    default: {
      if (!params.apiKeys.openai) {
        throw new Error('OPENAI_API_KEY is not configured');
      }
      return new OpenAiProvider({
        apiKey: params.apiKeys.openai,
        model: params.model,
        ...(params.baseUrls?.openai ? { baseUrl: params.baseUrls.openai } : {}),
      });
    }
  }
}
