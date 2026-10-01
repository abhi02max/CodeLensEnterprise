import { RequestError } from '@octokit/request-error';

/**
 * GitHub failure classification.
 *
 * The distinction that matters operationally: a 403 from GitHub can mean "you
 * lack permission" or "you are rate limited", and those demand opposite
 * responses. Permission failures should surface to the user immediately; rate
 * limits should back off and retry. Octokit does not separate them, so we do.
 */

export type GithubErrorKind =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SECONDARY_RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    message: string,
    readonly status: number | null,
    /** Unix seconds when the rate limit resets. Only set for rate-limit kinds. */
    readonly retryAfterSeconds: number | null = null,
    readonly documentationUrl: string | null = null,
  ) {
    super(message);
    this.name = 'GithubError';
  }

  /** Whether a retry could plausibly succeed without user intervention. */
  get retryable(): boolean {
    return (
      this.kind === 'RATE_LIMITED' ||
      this.kind === 'SECONDARY_RATE_LIMITED' ||
      this.kind === 'SERVER_ERROR' ||
      this.kind === 'NETWORK_ERROR'
    );
  }

  /** Whether the user must reconnect their GitHub account. */
  get requiresReauth(): boolean {
    return this.kind === 'UNAUTHORIZED' || this.kind === 'TOKEN_EXPIRED';
  }
}

export function classifyGithubError(error: unknown): GithubError {
  if (error instanceof GithubError) return error;

  if (error instanceof RequestError) {
    const status = error.status;
    const headers = error.response?.headers ?? {};
    const message = error.message;
    const docUrl = extractDocumentationUrl(error);

    if (status === 401) {
      // A revoked or expired OAuth token reads as 401 with this message.
      const expired = /bad credentials|token expired/i.test(message);
      return new GithubError(
        expired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
        'GitHub rejected the access token. Reconnect the GitHub account.',
        status,
        null,
        docUrl,
      );
    }

    if (status === 403 || status === 429) {
      const remaining = Number(headers['x-ratelimit-remaining'] ?? '1');
      const reset = Number(headers['x-ratelimit-reset'] ?? '0');
      const retryAfter = Number(headers['retry-after'] ?? '0');

      // Primary limit: the remaining counter has hit zero.
      if (remaining === 0 && reset > 0) {
        const waitSeconds = Math.max(0, reset - Math.floor(Date.now() / 1000));
        return new GithubError(
          'RATE_LIMITED',
          `GitHub API rate limit exhausted. Resets in ${waitSeconds}s.`,
          status,
          waitSeconds,
          docUrl,
        );
      }

      // Secondary limit: abuse detection. Honours Retry-After when present.
      if (retryAfter > 0 || /secondary rate limit|abuse detection/i.test(message)) {
        return new GithubError(
          'SECONDARY_RATE_LIMITED',
          'GitHub secondary rate limit hit. Slow down and retry.',
          status,
          retryAfter > 0 ? retryAfter : 60,
          docUrl,
        );
      }

      return new GithubError(
        'FORBIDDEN',
        'The GitHub token lacks the required scope or repository permission. ' +
          'Private repositories need the "repo" scope.',
        status,
        null,
        docUrl,
      );
    }

    if (status === 404) {
      // 404 also masks "exists but you cannot see it", which is GitHub
      // deliberately not leaking private repo names.
      return new GithubError(
        'NOT_FOUND',
        'Resource not found, or the token cannot access it.',
        status,
        null,
        docUrl,
      );
    }

    if (status === 409) {
      return new GithubError('CONFLICT', 'GitHub reported a resource conflict', status, null, docUrl);
    }

    if (status === 422) {
      return new GithubError(
        'VALIDATION_FAILED',
        'GitHub rejected the request (HTTP 422)',
        status,
        null,
        docUrl,
      );
    }

    if (status >= 500) {
      return new GithubError('SERVER_ERROR', `GitHub server error (HTTP ${status})`, status, 5, docUrl);
    }

    return new GithubError('UNKNOWN', `GitHub request failed (HTTP ${status})`, status, null, docUrl);
  }

  if (error instanceof Error) {
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(error.message)) {
      return new GithubError('NETWORK_ERROR', 'Network error reaching GitHub', null, 5);
    }
    return new GithubError('UNKNOWN', 'GitHub request failed', null);
  }

  return new GithubError('UNKNOWN', 'GitHub request failed', null);
}

function extractDocumentationUrl(error: RequestError): string | null {
  const data = (error.response?.data ?? {}) as { documentation_url?: unknown };
  if (typeof data.documentation_url !== 'string') return null;
  try {
    const url = new URL(data.documentation_url);
    return url.origin === 'https://docs.github.com' ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}
