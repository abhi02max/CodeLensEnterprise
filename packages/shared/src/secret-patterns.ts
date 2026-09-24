/**
 * Secret detection over diffs.
 *
 * This runs *before* any diff content is sent to an LLM provider. Shipping a
 * leaked credential to a third party while reviewing the commit that leaked it
 * would be an unusually bad outcome, so the scan is a hard gate rather than an
 * advisory check.
 *
 * Pure regex on purpose: no dependencies, runs in both the API and the browser,
 * and every hit is explainable to the developer who triggered it.
 */

export interface SecretPattern {
  readonly kind: string;
  readonly pattern: RegExp;
  /** High = specific prefix, few false positives. Low = entropy-based guess. */
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'AWS Access Key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, confidence: 'HIGH' },
  {
    kind: 'AWS Secret Access Key',
    pattern: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    confidence: 'HIGH',
  },
  { kind: 'GitHub Token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, confidence: 'HIGH' },
  {
    kind: 'GitHub App Token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
    confidence: 'HIGH',
  },
  { kind: 'OpenAI API Key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, confidence: 'HIGH' },
  { kind: 'Anthropic API Key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, confidence: 'HIGH' },
  { kind: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: 'HIGH' },
  { kind: 'Slack Token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, confidence: 'HIGH' },
  { kind: 'Stripe Secret Key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g, confidence: 'HIGH' },
  { kind: 'Twilio Key', pattern: /\bSK[0-9a-fA-F]{32}\b/g, confidence: 'MEDIUM' },
  { kind: 'SendGrid Key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, confidence: 'HIGH' },
  {
    kind: 'Private Key Block',
    pattern: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)? ?PRIVATE KEY-----/g,
    confidence: 'HIGH',
  },
  {
    kind: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: 'MEDIUM',
  },
  {
    kind: 'Database Connection String',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
    confidence: 'HIGH',
  },
  {
    kind: 'Generic Assigned Secret',
    // Catches `API_SECRET = "..."` style assignments with a long opaque value.
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password)\s*[=:]\s*['"]([A-Za-z0-9/+_=-]{16,})['"]/gi,
    confidence: 'LOW',
  },
];

/**
 * Values that look like secrets but are conventional placeholders. Flagging these
 * would train people to ignore the scanner, which is worse than not having one.
 */
const PLACEHOLDER_VALUES = [
  'your_api_key_here',
  'changeme',
  'replace_me',
  'placeholder',
  'example',
  'xxxxxxxx',
  'dummy',
  'redacted',
  'notarealkey',
  'test_key',
  'fake',
  'sample',
  '000000',
  '123456',
];

const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_VALUES.join('|'), 'i');

/** Test fixtures and docs legitimately contain secret-shaped strings. */
const IGNORED_PATH_RE =
  /(\.test\.|\.spec\.|__tests__\/|__mocks__\/|fixtures?\/|\.example$|\.env\.example|\.sample$|(^|\/)docs?\/|\.md$|\.snap$)/i;

export interface SecretHit {
  kind: string;
  confidence: SecretPattern['confidence'];
  path: string;
  /** Line number within the new version of the file. */
  line: number;
  /** Masked excerpt safe to store and display. */
  maskedExcerpt: string;
}

/** Keep the first and last 3 characters so a human can identify the value. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.min(value.length - 6, 24))}${value.slice(-3)}`;
}

/**
 * Scan added lines only.
 *
 * Deletions are intentionally skipped: a PR that *removes* a hardcoded key is
 * exactly what we want people to do, and blocking it would be perverse.
 */
export function scanAddedLinesForSecrets(
  path: string,
  addedLines: ReadonlyArray<{ line: number; content: string }>,
): SecretHit[] {
  if (IGNORED_PATH_RE.test(path)) return [];

  const hits: SecretHit[] = [];

  for (const { line, content } of addedLines) {
    if (content.length > 2000) continue;

    for (const { kind, pattern, confidence } of SECRET_PATTERNS) {
      // Patterns are module-level and carry /g, so reset before reuse.
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(content)) !== null) {
        const captured = match[1] ?? match[0];
        if (PLACEHOLDER_RE.test(captured)) continue;
        if (confidence === 'LOW' && shannonEntropy(captured) < 3.2) continue;

        hits.push({
          kind,
          confidence,
          path,
          line,
          maskedExcerpt: maskSecret(captured),
        });
        break; // one hit per pattern per line is enough signal
      }
    }
  }

  return hits;
}

/**
 * Shannon entropy in bits per character. Used to suppress low-confidence hits on
 * values that are clearly not random, like `password = "admin"`.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Redact every detected secret from arbitrary text before it leaves the system.
 * Applied to diffs when `redactSecretsBeforeSend` is enabled, so a review can
 * still proceed on a diff that contains a credential.
 */
export function redactSecrets(text: string): { redacted: string; count: number } {
  let redacted = text;
  let count = 0;

  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (full, captured?: string) => {
      const value = captured ?? full;
      if (PLACEHOLDER_RE.test(value)) return full;
      count += 1;
      return full.replace(value, '[REDACTED_SECRET]');
    });
  }

  return { redacted, count };
}
