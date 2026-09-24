import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GithubError } from './errors';

/**
 * GitHub OAuth (web application flow) and webhook signature verification.
 *
 * Written against the raw endpoints rather than a helper library because the two
 * security-relevant details here deserve to be visible in our own code: CSRF
 * protection on the `state` parameter, and constant-time comparison when
 * verifying webhook signatures.
 */

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string[];
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Signed, self-verifying `state` value.
 *
 * Rather than persisting state server-side, it carries a nonce plus an HMAC over
 * a timestamp. That makes the callback stateless while still proving the request
 * originated from us and has not expired — replaying an old authorize URL fails
 * the timestamp check.
 */
export function createOAuthState(secret: string, payload: Record<string, string> = {}): string {
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = Date.now().toString();
  const body = JSON.stringify({ nonce, issuedAt, ...payload });
  const encoded = Buffer.from(body, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export interface VerifiedOAuthState {
  nonce: string;
  issuedAt: number;
  [key: string]: unknown;
}

export function verifyOAuthState(
  state: string,
  secret: string,
  maxAgeSeconds = 600,
): VerifiedOAuthState {
  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new GithubError('VALIDATION_FAILED', 'Malformed OAuth state parameter', 400);
  }

  const [encoded, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');

  if (!safeEqual(signature, expected)) {
    throw new GithubError(
      'VALIDATION_FAILED',
      'OAuth state signature mismatch. The login attempt may have been tampered with.',
      400,
    );
  }

  let parsed: VerifiedOAuthState;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new GithubError('VALIDATION_FAILED', 'OAuth state payload is not valid JSON', 400);
  }

  const issuedAt = Number(parsed.issuedAt);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > maxAgeSeconds * 1000) {
    throw new GithubError(
      'VALIDATION_FAILED',
      'OAuth state has expired. Start the sign-in flow again.',
      400,
    );
  }

  return { ...parsed, issuedAt };
}

export function buildAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: config.scopes.join(' '),
    state,
    allow_signup: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface GithubTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  tokenType: string;
}

export async function exchangeCodeForToken(
  config: GithubOAuthConfig,
  code: string,
): Promise<GithubTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'CodeLens-Enterprise',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new GithubError(
      'UNKNOWN',
      `Token exchange failed with status ${response.status}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  // GitHub returns 200 with an `error` field rather than an HTTP error status.
  if (data.error || !data.access_token) {
    throw new GithubError(
      'UNAUTHORIZED',
      data.error_description ?? data.error ?? 'GitHub did not return an access token',
      400,
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scopes: data.scope ? data.scope.split(',').filter(Boolean) : [],
    tokenType: data.token_type ?? 'bearer',
  };
}

/**
 * Verify an inbound webhook signature.
 *
 * Must run against the **raw** request body: any JSON reserialization changes
 * byte-for-byte content and invalidates the HMAC. The API registers a raw-body
 * parser on the webhook route specifically for this.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(signatureHeader, expected);
}

/** Constant-time comparison; length is leaked but content is not. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Whether the granted scopes cover what CodeLens needs.
 *
 * Checked at connection time so a user who declined `repo` is told immediately
 * instead of discovering it when a private repository silently fails to load.
 */
export function assessScopes(granted: readonly string[]): {
  canReadProfile: boolean;
  canReadPrivateRepos: boolean;
  canWriteComments: boolean;
  missing: string[];
} {
  const set = new Set(granted);
  const hasRepo = set.has('repo');

  const missing: string[] = [];
  if (!set.has('read:user') && !set.has('user')) missing.push('read:user');
  if (!hasRepo && !set.has('public_repo')) missing.push('public_repo or repo');

  return {
    canReadProfile: set.has('read:user') || set.has('user'),
    canReadPrivateRepos: hasRepo,
    // Posting PR comments needs write access to issues, which `repo` grants.
    canWriteComments: hasRepo || set.has('public_repo'),
    missing,
  };
}
