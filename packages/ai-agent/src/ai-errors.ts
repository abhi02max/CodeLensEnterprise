import { toErrorMessage } from '@codelens/shared';
import { LlmProviderError } from './providers';

/**
 * Why an AI review did not happen.
 *
 * Every value is safe to show a reviewer and safe to persist on a ToolRun, which is the
 * constraint that shapes this file. `ToolRun.error` is returned by `/review-runs/:id`, embedded
 * in the review workspace, and surfaced as a degradation note — so anything that reaches it is
 * effectively public to the tenant, and must not carry provider response bodies, prompt text, or
 * model output.
 */
export type AiFailureKind =
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMED_OUT'
  | 'REQUEST_REJECTED'
  | 'MODEL_NOT_FOUND'
  | 'MALFORMED_RESPONSE'
  | 'SCHEMA_INVALID'
  | 'UNKNOWN';

/**
 * A classified AI-path failure.
 *
 * `message` is deliberately the reviewer-facing reason, because that is the field the tool
 * registry copies into `ToolRun.error`. The unsanitized cause is kept on `cause` for logging and
 * never formatted into the message.
 */
export class AiReviewFailure extends Error {
  constructor(
    readonly kind: AiFailureKind,
    message: string,
    /** Whether running the identical request again could plausibly succeed. */
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiReviewFailure';
  }
}

/**
 * Map any throwable from the review generator onto a reason worth showing a reviewer.
 *
 * The distinction that earns its keep here is `retryable`. A 429 or a 502 will probably succeed
 * on the next run, so the note tells the reader to re-run. A 401 or a response that failed the
 * schema twice will fail identically forever, so the note tells them what to change instead.
 * Collapsing both into "the AI review could not be generated" — which is what this code did
 * before — leaves the reader unable to tell a transient blip from a broken deployment.
 */
export function classifyAiFailure(error: unknown): AiReviewFailure {
  if (error instanceof AiReviewFailure) return error;

  if (error instanceof LlmProviderError) {
    const status = error.status;

    if (status === 401 || status === 403) {
      return new AiReviewFailure(
        'UNAUTHORIZED',
        `The ${error.provider} API key was rejected (HTTP ${status}). AI review is disabled ` +
          `until a valid key is configured. Other analysis results are reported separately.`,
        false,
        error,
      );
    }

    if (status === 404) {
      return new AiReviewFailure(
        'MODEL_NOT_FOUND',
        `The configured model is not available on ${error.provider} (HTTP 404). Check AI_MODEL ` +
          `or the organization's AI settings.`,
        false,
        error,
      );
    }

    if (status === 429) {
      return new AiReviewFailure(
        'RATE_LIMITED',
        `${error.provider} rate-limited this review after several attempts. Re-run the analysis ` +
          `in a few minutes.`,
        true,
        error,
      );
    }

    if (status !== null && status >= 500) {
      return new AiReviewFailure(
        'PROVIDER_UNAVAILABLE',
        `${error.provider} returned a server error (HTTP ${status}) after several attempts. ` +
          `Re-run the analysis. Other analysis results are reported separately.`,
        true,
        error,
      );
    }

    // 400 and anything else in the 4xx range. Usually the request itself: too many tokens for
    // the model's window, or an unsupported parameter. The provider's explanation is not
    // repeated, because a 400 body frequently quotes the offending input — which here is the
    // diff and the prompt.
    return new AiReviewFailure(
      'REQUEST_REJECTED',
      `${error.provider} rejected the review request` +
        (status === null ? '' : ` (HTTP ${status})`) +
        `${error.detail ? `: ${error.detail}` : ''}. This usually means the diff exceeded the ` +
        `model's context window. Other analysis results are reported separately.`,
      false,
      error,
    );
  }

  const message = toErrorMessage(error);

  /**
   * Fallbacks for validation failures raised without a typed error.
   *
   * `ReviewGenerator` now throws `AiReviewFailure` directly and is returned above, so these only
   * catch a path that has not been converted. Order matters: an unparseable response also
   * produces a message mentioning schema validation, so the narrower test has to run first.
   * Getting this backwards reported "not valid JSON" cases as shape mismatches, which sends the
   * reader at the prompt instead of at JSON mode.
   */
  if (/not parseable JSON/i.test(message)) {
    return new AiReviewFailure(
      'MALFORMED_RESPONSE',
      'The model returned output that was not valid JSON and could not be repaired. Nothing was ' +
        'saved. Other analysis results are reported separately.',
      false,
      error,
    );
  }

  if (/failed schema validation/i.test(message)) {
    return new AiReviewFailure(
      'SCHEMA_INVALID',
      'The model returned a review that did not match the required structure, twice. Nothing was ' +
        'saved rather than storing a partial review. Other analysis results are reported separately.',
      false,
      error,
    );
  }

  if (isAbortLike(message, error)) {
    return new AiReviewFailure(
      'TIMED_OUT',
      'The AI provider did not respond within the time budget for this review. Re-run the ' +
        'analysis. Other analysis results are reported separately.',
      true,
      error,
    );
  }

  return new AiReviewFailure(
    'UNKNOWN',
    'The AI review could not be generated. Other analysis results are reported separately.',
    // Conservative: an unrecognised failure is assumed transient, so the reader is told to
    // re-run rather than to go looking for a configuration error that may not exist.
    true,
    error,
  );
}

function isAbortLike(message: string, error: unknown): boolean {
  if (/abort|timed out|timeout|ETIMEDOUT/i.test(message)) return true;

  // Undici surfaces an aborted fetch as a DOMException whose name is AbortError, and its
  // message ("This operation was aborted") is not guaranteed across runtimes.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
