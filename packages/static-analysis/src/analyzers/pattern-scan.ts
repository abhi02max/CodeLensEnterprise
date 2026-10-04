import {
  Analyzer,
  AnalyzerStatus,
  FindingCategory,
  Severity,
  type AnalyzerResult,
  type StaticFinding,
} from '@codelens/shared';
import { fingerprintFinding } from '../fingerprint';
import type { AnalyzerFile, AnalyzerInput } from '../types';

/**
 * In-process pattern analyzer for partial file content.
 *
 * This exists because of a structural constraint in diff-based review, not as a substitute for a
 * real analyzer.
 *
 * Semgrep matches against an AST, which requires syntactically valid files. But reviewing a pull
 * request means reconstructing content from diff hunks, and a hunk is almost never valid
 * standalone code — a changed method body reconstructs to a method with no enclosing class, which
 * no TypeScript parser will accept. Semgrep then parses nothing and reports zero findings on a
 * diff that plainly contains problems. Measured on a real pull request: Semgrep ran successfully
 * over four files and matched none of them.
 *
 * Fetching every full file would fix parsing but costs two extra API calls per changed file and
 * is impossible for a repository the deployment cannot reach.
 *
 * So this analyzer applies line-oriented patterns that do not care about surrounding syntax. It is
 * strictly less capable than Semgrep — no dataflow, no taint tracking, no cross-function
 * reasoning — and it is intentionally limited to patterns that are unambiguous on a single line or
 * a small window. Semgrep remains the primary analyzer whenever full files are available; this
 * guarantees a floor of coverage when they are not.
 *
 * Every rule here earns its place by catching something a reviewer would genuinely want flagged,
 * and by having a very low false-positive rate on real code.
 */

interface PatternRule {
  readonly id: string;
  readonly severity: Severity;
  readonly category: FindingCategory;
  readonly message: string;
  /** Matched against a single added line. */
  readonly pattern: RegExp;
  /** Additional predicate over the surrounding window, for multi-line conditions. */
  readonly confirm?: (line: string, window: string) => boolean;
  readonly languages?: readonly string[];
  readonly helpUrl?: string;
}

const RULES: readonly PatternRule[] = [
  {
    id: 'codelens/raw-sql-interpolation',
    severity: Severity.CRITICAL,
    category: FindingCategory.SECURITY,
    message:
      'Raw SQL is built with string interpolation. A value concatenated into the statement can ' +
      'alter the query, which is SQL injection. Use a parameterized query or the ORM query ' +
      'builder instead.',
    // Raw-query call whose argument contains a template placeholder, on this line or nearby.
    pattern: /\$(?:execute|query)Raw(?:Unsafe)?\s*\(/,
    confirm: (_line, window) => /\$\{[^}]+\}/.test(window) || /['"]\s*\+\s*\w/.test(window),
    languages: ['typescript', 'javascript'],
    helpUrl: 'https://cwe.mitre.org/data/definitions/89.html',
  },
  {
    id: 'codelens/raw-sql-without-tenant-scope',
    severity: Severity.HIGH,
    category: FindingCategory.SECURITY,
    message:
      'A raw SQL statement bypasses the ORM tenant-scoping layer and does not filter on ' +
      'organizationId. In a multi-tenant system this is a cross-tenant data access path.',
    pattern: /\$(?:execute|query)Raw(?:Unsafe)?\s*\(/,
    confirm: (_line, window) => !/organization_?id/i.test(window),
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/shell-injection',
    severity: Severity.CRITICAL,
    category: FindingCategory.SECURITY,
    message:
      'A shell command is constructed from interpolated values. Pass arguments as an array with ' +
      'the shell disabled so an input value cannot become a command.',
    pattern: /\b(?:exec|execSync)\s*\(\s*[`'"].*\$\{/,
    languages: ['typescript', 'javascript'],
    helpUrl: 'https://cwe.mitre.org/data/definitions/78.html',
  },
  {
    id: 'codelens/shell-true',
    severity: Severity.HIGH,
    category: FindingCategory.SECURITY,
    message:
      'A child process is spawned with shell: true, so its arguments pass through a shell. Any ' +
      'interpolated value becomes shell syntax.',
    pattern: /shell\s*:\s*true/,
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/eval-usage',
    severity: Severity.CRITICAL,
    category: FindingCategory.SECURITY,
    message:
      'eval or new Function executes arbitrary code. If any part of the input is externally ' +
      'influenced this is remote code execution.',
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/,
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/client-controlled-authorization',
    severity: Severity.HIGH,
    category: FindingCategory.SECURITY,
    message:
      'An authorization or bypass flag is read from request input. A caller can set it and grant ' +
      'themselves the permission. Derive the decision from server-side state instead.',
    // A negated flag guard where the flag comes from a request-shaped object.
    pattern:
      /!\s*(?:input|body|params|query|req|request|dto)\.\w*(?:allow|bypass|skip|force|override|admin|ignore)\w*/i,
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/disabled-tls-verification',
    severity: Severity.CRITICAL,
    category: FindingCategory.SECURITY,
    message:
      'TLS certificate verification is disabled, which removes protection against ' +
      'man-in-the-middle interception.',
    pattern: /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False)/,
  },
  {
    id: 'codelens/sql-migration-without-default',
    severity: Severity.MEDIUM,
    category: FindingCategory.BUG,
    message:
      'A NOT NULL column is added without a default. On a non-empty table this migration fails, ' +
      'and on a large table it can hold a write lock for the duration of the rewrite.',
    pattern: /ADD\s+COLUMN\s+.*NOT\s+NULL/i,
    confirm: (line) => !/DEFAULT/i.test(line),
    languages: ['sql'],
  },
  {
    id: 'codelens/dropped-guard-clause',
    severity: Severity.MEDIUM,
    category: FindingCategory.BUG,
    message:
      'A throw or early return appears to have been removed from a guard. Confirm the invariant ' +
      'is still enforced somewhere, since removing a guard silently widens what callers may do.',
    pattern: /^\s*(?:\/\/\s*)?(?:return\s+err\(|throw\s+new\s+\w*Error)/,
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/floating-promise',
    severity: Severity.MEDIUM,
    category: FindingCategory.BUG,
    message:
      'A promise-returning call is not awaited, returned, or explicitly voided, so a rejection ' +
      'becomes an unhandled rejection and ordering is not guaranteed.',
    pattern: /^\s*this\.\w+\.(?:create|update|delete|save|send|publish|record|write)\w*\s*\(/,
    confirm: (line) => !/\b(?:await|return|void|=)\s/.test(line),
    languages: ['typescript', 'javascript'],
  },
  {
    id: 'codelens/todo-in-sensitive-path',
    severity: Severity.LOW,
    category: FindingCategory.MAINTAINABILITY,
    message:
      'An unresolved TODO or FIXME is being introduced. Track it in an issue rather than leaving ' +
      'it only in the code.',
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/,
  },
];

/** Lines of surrounding context used to evaluate multi-line confirmations. */
const WINDOW_LINES = 4;

export const PATTERN_RULE_IDENTITY = RULES.map((rule) => ({
  id: rule.id, severity: rule.severity, category: rule.category, message: rule.message,
  pattern: rule.pattern.source, flags: rule.pattern.flags, languages: rule.languages,
  confirm: rule.confirm?.toString() ?? null,
}));

/**
 * New-file line number for a line of reconstructed content.
 *
 * `content` is usually a fragment assembled from diff hunks, so its indices are local to the
 * fragment and are not line numbers. `contentLineNumbers` carries the real position of each line,
 * built by the diff parser, which is the only place the information exists.
 *
 * Returns null when the position is genuinely unknown, which makes the finding file-level rather
 * than pointing at a line picked for being arithmetically available.
 */
function resolveLine(file: AnalyzerFile, index: number): number | null {
  // No mapping means `content` is a whole file, where the index already is the line number.
  if (file.contentLineNumbers === undefined) return index + 1;

  return file.contentLineNumbers[index] ?? null;
}

export function runPatternScan(input: AnalyzerInput): AnalyzerResult {
  const startedAt = Date.now();
  const findings: StaticFinding[] = [];
  let filesAnalyzed = 0;

  for (const file of input.files) {
    if (!file.analyzable || !file.content) continue;
    filesAnalyzed += 1;

    const lines = file.content.split('\n');

    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0 || line.length > 2000) continue;

      const window = lines
        .slice(Math.max(0, index - 1), index + WINDOW_LINES)
        .join('\n');

      for (const rule of RULES) {
        if (rule.languages && !rule.languages.includes(file.language)) continue;
        if (!rule.pattern.test(line)) continue;
        if (rule.confirm && !rule.confirm(line, window)) continue;

        // The line the pattern actually matched, mapped back through the hunk.
        //
        // This used to be `touchedLines[findings.length]` — the sorted touched-line set indexed by
        // the number of findings emitted *so far, across all files*. It was wrong in three
        // independent ways: the counter has nothing to do with which line matched, it kept
        // incrementing across file boundaries so a finding in one file renumbered findings in the
        // next, and two rules matching the same line got different numbers. On the demo pull
        // request it put a SQL-injection finding on line 60, three lines above the `$executeRawUnsafe`
        // call it was describing. Which line is scoped to the change is a separate question, and
        // `markPreexisting` answers it downstream using these numbers.
        const resolvedLine = resolveLine(file, index);

        findings.push({
          id: '',
          analyzer: Analyzer.PATTERN_SCAN,
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          message: rule.message,
          path: file.path,
          line: resolvedLine,
          endLine: null,
          column: null,
          helpUrl: rule.helpUrl ?? null,
          snippet: line.trim().slice(0, 300),
          fingerprint: fingerprintFinding({
            analyzer: 'PATTERN_SCAN',
            ruleId: rule.id,
            path: file.path,
            message: rule.message,
          }),
          preexisting: false,
          sourceToolRunId: '',
        });
      }
    }
  }

  return {
    analyzer: Analyzer.PATTERN_SCAN,
    status: AnalyzerStatus.SUCCESS,
    findings,
    durationMs: Date.now() - startedAt,
    error: null,
    version: 'pattern-scan-builtin',
    filesAnalyzed,
  };
}
