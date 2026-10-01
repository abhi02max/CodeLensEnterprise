import { SECRET_PATTERNS } from './secret-patterns';

const SENSITIVE_KEY = /^(?:code|state|authorization|cookie|set-cookie|.*token.*|.*secret.*|.*password.*|.*passphrase.*|api[_-]?key|key)$/i;

export function sensitiveDiagnosticKey(key: string): boolean {
  if (/^(?:tokenUsage|promptTokens|completionTokens|totalTokens|tokenCount|tokensEmbedded|tokenGeneration)$/i.test(key)) return false;
  return SENSITIVE_KEY.test(key);
}

/** Diagnostics are not a transport for credentials, even in development. */
export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const value of [secret, encodeURIComponent(secret)]) safe = safe.split(value).join('[redacted]');
  }
  safe = safe.replace(/(\/review-sessions\/share\/|\/shared\/)[^\s/?#"'<>]+/gi, '$1[redacted]');
  safe = safe.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_./+=:-]+/gi, '$1 [redacted]');
  safe = safe.replace(/([?&#](?:code|state|[^=&#\s]*token[^=&#\s]*|api[_-]?key|key|[^=&#\s]*secret[^=&#\s]*|password|passphrase)=)[^&#\s"'<>]*/gi, '$1[redacted]');
  safe = safe.replace(/(["']?(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passphrase|state|code|key)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&#]+)/gi, '$1[redacted]');
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(new RegExp(pattern.pattern.source, pattern.pattern.flags), '[redacted]');
  }
  return safe;
}

export function sanitizeDiagnosticValue(value: unknown, secrets: readonly string[] = [], seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticText(value, secrets);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item, secrets, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      sanitizeDiagnosticText(key, secrets),
      sensitiveDiagnosticKey(key) ? '[redacted]' : sanitizeDiagnosticValue(item, secrets, seen),
    ]));
  }
  return value;
}

export function diagnosticPath(originalUrl: string): string {
  // Query values have no diagnostic value at this boundary; also discard fragments.
  return sanitizeDiagnosticText(originalUrl.split(/[?#]/, 1)[0] ?? '/');
}
