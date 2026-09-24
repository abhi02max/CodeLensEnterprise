import type { AuthResponse } from './types';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:4000/api/v1';

/**
 * A structured API error.
 *
 * The API returns `{ statusCode, code, message, errors?, traceId }` for every failure, so the UI
 * branches on `code` and shows `message`. `traceId` is surfaced in error states because it is the
 * only thing that lets someone correlate what they saw with the server logs.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string[]> | null = null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * Access token storage: in memory only.
 *
 * Not localStorage, and the difference is not academic. A token in localStorage is readable by any
 * script that ends up on the page, so one bad dependency turns into a stolen session that outlives
 * the tab. Keeping it in a module variable means an XSS has to exfiltrate it during the session
 * rather than finding it lying around later.
 *
 * The cost is that a hard reload loses it — which is fine, because the refresh token lives in an
 * httpOnly cookie the API set, and `localhost:3000` and `localhost:4000` are the same site (ports
 * are not part of the site definition), so the cookie is sent on same-site XHR. `bootstrap()`
 * trades it for a fresh access token on load.
 */
let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/**
 * Single in-flight refresh.
 *
 * Without this, a page that fires six queries on mount against an expired token issues six
 * refreshes; each rotates the refresh cookie, and the losers of that race end up presenting a
 * token the server has already invalidated — which logs the user out in the middle of a working
 * session for no reason.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) return false;

      const body = (await response.json()) as AuthResponse;
      accessToken = body.tokens.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so concurrent callers awaiting this promise all observe the same
      // result before a new attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Extra headers. Used for the share-link passphrase. */
  headers?: Record<string, string>;
  /** False for endpoints that must not carry or refresh credentials, such as a share link. */
  authenticated?: boolean;
  signal?: AbortSignal;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'Request failed';
  let fieldErrors: Record<string, string[]> | null = null;
  let traceId: string | null = null;

  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      errors?: Record<string, string[]>;
      traceId?: string;
    };

    if (body.code) code = body.code;
    if (body.message) message = body.message;
    if (body.errors) fieldErrors = body.errors;
    if (body.traceId) traceId = body.traceId;
  } catch {
    // Non-JSON error, most likely the API being unreachable. The status line is all there is.
  }

  return new ApiError(response.status, code, message, fieldErrors, traceId);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const authenticated = options.authenticated ?? true;

  const send = async (): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      // Always included: the refresh cookie has to travel on /auth/refresh, and sending it
      // elsewhere is harmless because the API authenticates from the bearer header only.
      credentials: 'include',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

  let response: Response;

  try {
    response = await send();
  } catch (error) {
    // A network-level failure, almost always the API not running. Reported as a distinct code so
    // the UI can say "the API is unreachable" instead of "something went wrong".
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      `Could not reach the CodeLens API at ${API_URL}. Is it running?`,
      null,
      null,
    );
  }

  // One retry after a refresh. Access tokens live 15 minutes, so an open tab will hit this.
  if (response.status === 401 && authenticated) {
    if (await refreshAccessToken()) {
      response = await send();
    } else {
      accessToken = null;
      onUnauthenticated?.();
      throw await toApiError(response);
    }
  }

  if (!response.ok) throw await toApiError(response);

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

/** Recover a session on page load using the refresh cookie. */
export async function bootstrapSession(): Promise<boolean> {
  return refreshAccessToken();
}
