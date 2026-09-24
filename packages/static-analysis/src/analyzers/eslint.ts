import {
  Analyzer,
  AnalyzerStatus,
  FindingCategory,
  Severity,
  isJsOrTs,
  type AnalyzerResult,
  type StaticFinding,
} from '@codelens/shared';
import { fingerprintFinding, type AnalysisSandbox } from '../sandbox';
import type { AnalyzerInput } from '../types';

/**
 * ESLint runner.
 *
 * Invoked as a subprocess with `--format json` rather than through the Node API.
 * Two reasons: ESLint's flat-config resolution behaves differently when embedded,
 * and a subprocess is the only way to enforce the sandbox's stripped environment
 * and hard timeout on a linter that will happily load a repository's own plugins.
 *
 * A repository without an ESLint config yields SKIPPED, not FAILED. Linting a
 * project with rules it never opted into produces hundreds of irrelevant findings
 * and destroys trust in the whole report.
 */

const CONFIG_FILENAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  messageId?: string;
  fix?: unknown;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

export async function runEslint(
  sandbox: AnalysisSandbox,
  input: AnalyzerInput,
  options: { binary?: string; timeoutMs?: number } = {},
): Promise<AnalyzerResult> {
  const startedAt = Date.now();
  const targets = input.files.filter((file) => file.analyzable && isJsOrTs(file.path));

  const base = (): Omit<AnalyzerResult, 'status' | 'error'> => ({
    analyzer: Analyzer.ESLINT,
    findings: [],
    durationMs: Date.now() - startedAt,
    version: null,
    filesAnalyzed: 0,
  });

  if (targets.length === 0) {
    return { ...base(), status: AnalyzerStatus.SKIPPED, error: 'No JavaScript or TypeScript files changed' };
  }

  const hasConfig = input.repoConfigFiles.some((name) => CONFIG_FILENAMES.includes(name));
  if (!hasConfig) {
    return {
      ...base(),
      status: AnalyzerStatus.SKIPPED,
      error:
        'No ESLint configuration found in the repository. Linting with defaults the project ' +
        'never opted into would produce noise, so ESLint was skipped.',
    };
  }

  const result = await sandbox.exec(
    options.binary ?? 'npx',
    [
      '--no-install',
      'eslint',
      '--format',
      'json',
      // Analyzer plugins live in the repo, which the sandbox does not install;
      // missing plugins must not abort the whole run.
      '--no-error-on-unmatched-pattern',
      ...targets.map((file) => file.path),
    ],
    { timeoutMs: options.timeoutMs ?? 90_000 },
  );

  if (result.spawnFailed) {
    return {
      ...base(),
      status: AnalyzerStatus.NOT_INSTALLED,
      error: `ESLint could not be launched: ${result.stderr.slice(0, 500)}`,
    };
  }

  if (result.timedOut) {
    return { ...base(), status: AnalyzerStatus.TIMED_OUT, error: 'ESLint exceeded its time budget' };
  }

  // Exit 1 means "lint problems found", which is success for our purposes.
  // Exit 2 means ESLint itself failed.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      ...base(),
      status: AnalyzerStatus.FAILED,
      error: `ESLint exited with ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    };
  }

  let parsed: EslintFileResult[];
  try {
    parsed = JSON.parse(result.stdout || '[]') as EslintFileResult[];
  } catch {
    return {
      ...base(),
      status: AnalyzerStatus.FAILED,
      error: 'ESLint produced output that could not be parsed as JSON',
    };
  }

  const findings: StaticFinding[] = [];

  for (const file of parsed) {
    const relativePath = toRelativePath(file.filePath, sandbox.root);

    for (const message of file.messages) {
      // Parse errors surface with a null ruleId; report them as type-safety
      // issues rather than dropping them, since a file that will not parse is
      // usually the most important thing in the diff.
      const ruleId = message.ruleId ?? 'eslint/parse-error';

      findings.push({
        id: '',
        analyzer: Analyzer.ESLINT,
        ruleId,
        severity: message.severity === 2 ? Severity.HIGH : Severity.MEDIUM,
        category: categorizeRule(ruleId),
        message: message.message,
        path: relativePath,
        line: message.line ?? null,
        endLine: message.endLine ?? null,
        column: message.column ?? null,
        helpUrl: ruleDocumentationUrl(ruleId),
        snippet: null,
        fingerprint: fingerprintFinding({
          analyzer: Analyzer.ESLINT,
          ruleId,
          path: relativePath,
          message: message.message,
        }),
        preexisting: false,
        sourceToolRunId: '',
      });
    }
  }

  return {
    analyzer: Analyzer.ESLINT,
    status: AnalyzerStatus.SUCCESS,
    findings,
    durationMs: Date.now() - startedAt,
    error: null,
    version: null,
    filesAnalyzed: targets.length,
  };
}

/**
 * Map an ESLint rule to a review category.
 *
 * Categorization drives both the risk feature vector (only SECURITY counts
 * toward `security_findings_count`) and how findings group in the UI, so a
 * formatting rule must never land in the security bucket.
 */
export function categorizeRule(ruleId: string): FindingCategory {
  const rule = ruleId.toLowerCase();

  if (/security|xss|injection|csrf|eval|unsafe|no-secrets|detect-/.test(rule)) {
    return FindingCategory.SECURITY;
  }
  if (/no-floating-promises|no-misused-promises|await|race|no-unsafe|null|undefined|eqeqeq|no-fallthrough|array-callback/.test(rule)) {
    return FindingCategory.BUG;
  }
  if (/performance|no-await-in-loop|prefer-spread|no-loop-func/.test(rule)) {
    return FindingCategory.PERFORMANCE;
  }
  if (/jest|vitest|testing-library|mocha|no-only-tests|expect/.test(rule)) {
    return FindingCategory.TESTING;
  }
  if (/@typescript-eslint\/(no-explicit-any|no-unsafe|consistent-type|explicit-)/.test(rule)) {
    return FindingCategory.TYPE_SAFETY;
  }
  if (/import\/|no-cycle|no-extraneous-dependencies/.test(rule)) {
    return FindingCategory.DEPENDENCY;
  }
  if (/complexity|max-lines|max-depth|max-params|no-duplicate|sonarjs/.test(rule)) {
    return FindingCategory.MAINTAINABILITY;
  }
  if (/indent|quotes|semi|spacing|comma|brace|prettier|padding|newline/.test(rule)) {
    return FindingCategory.STYLE;
  }

  return FindingCategory.MAINTAINABILITY;
}

function ruleDocumentationUrl(ruleId: string): string | null {
  if (ruleId.startsWith('@typescript-eslint/')) {
    return `https://typescript-eslint.io/rules/${ruleId.replace('@typescript-eslint/', '')}/`;
  }
  if (!ruleId.includes('/')) {
    return `https://eslint.org/docs/latest/rules/${ruleId}`;
  }
  return null;
}

function toRelativePath(absolutePath: string, sandboxRoot: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const root = sandboxRoot.replace(/\\/g, '/');
  return normalized.startsWith(root) ? normalized.slice(root.length + 1) : normalized;
}
