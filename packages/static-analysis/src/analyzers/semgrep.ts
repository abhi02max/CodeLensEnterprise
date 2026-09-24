import {
  Analyzer,
  AnalyzerStatus,
  FindingCategory,
  Severity,
  type AnalyzerResult,
  type StaticFinding,
} from '@codelens/shared';
import { fingerprintFinding, type AnalysisSandbox } from '../sandbox';
import type { AnalyzerInput } from '../types';
import { BUILTIN_RULES_FILENAME, BUILTIN_SEMGREP_RULES } from './builtin-rules';

/**
 * Semgrep runner.
 *
 * Semgrep is the most valuable of the analyzers here because it is semantic
 * rather than syntactic: it matches code patterns across languages and ships
 * curated security rulesets, so it catches the classes of bug that matter in a
 * review (injection, hardcoded secrets, unsafe deserialization) rather than
 * formatting.
 *
 * Registry rulesets (`p/...`) require network access on first run to download.
 * That is the one place the sandbox's isolation is relaxed, and it is why a
 * failure here degrades to SKIPPED instead of failing the review.
 */

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    lines?: string;
    metadata?: {
      category?: string;
      cwe?: string | string[];
      owasp?: string | string[];
      references?: string[];
      confidence?: string;
      impact?: string;
      'semgrep.dev'?: { rule?: { url?: string } };
    };
  };
}

interface SemgrepOutput {
  results?: SemgrepResult[];
  errors?: Array<{ message?: string; level?: string }>;
  version?: string;
}

export async function runSemgrep(
  sandbox: AnalysisSandbox,
  input: AnalyzerInput,
  options: {
    binary?: string;
    rulesets?: string[];
    timeoutMs?: number;
    /** Set false to require a local binary and never shell out to Docker. */
    dockerFallback?: boolean;
    dockerImage?: string;
  } = {},
): Promise<AnalyzerResult> {
  const startedAt = Date.now();
  const targets = input.files.filter((file) => file.analyzable);

  const base = (): Omit<AnalyzerResult, 'status' | 'error'> => ({
    analyzer: Analyzer.SEMGREP,
    findings: [],
    durationMs: Date.now() - startedAt,
    version: null,
    filesAnalyzed: 0,
  });

  if (targets.length === 0) {
    return { ...base(), status: AnalyzerStatus.SKIPPED, error: 'No analyzable files changed' };
  }

  // Built-in rules are written into the sandbox so they work with no network access. Registry
  // packs are added on top and simply contribute nothing if they cannot be fetched.
  await sandbox.writeConfig(BUILTIN_RULES_FILENAME, BUILTIN_SEMGREP_RULES);

  const registryRulesets = [
    ...(options.rulesets ?? ['p/security-audit', 'p/owasp-top-ten']),
    ...input.extraSemgrepRulesets,
  ];

  const buildArgs = (includeRegistry: boolean): string[] => [
    '--json',
    '--quiet',
    '--no-git-ignore',
    // Not --error: a ruleset that fails to load must not fail the whole analysis.
    '--timeout',
    '30',
    '--max-target-bytes',
    '2000000',
    '--config',
    BUILTIN_RULES_FILENAME,
    ...(includeRegistry ? registryRulesets.flatMap((ruleset) => ['--config', ruleset]) : []),
    '.',
  ];

  const args = buildArgs(true);

  let result = await sandbox.exec(options.binary ?? 'semgrep', args, {
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  /**
   * Fall back to the official Semgrep container when the binary is absent.
   *
   * Semgrep has no native Windows build, so on a Windows host the local binary will never be
   * found no matter what the developer installs. Running it in a container is also how it tends
   * to be deployed in CI, so this is the normal path rather than a workaround.
   *
   * `--network none` is deliberate: the container gets the sandbox mounted read-only and no
   * network at all, so it cannot exfiltrate the code it is analysing. The cost is that registry
   * rulesets (`p/...`) cannot be downloaded, so only rules already baked into the image and any
   * local rule files apply.
   */
  if (result.spawnFailed && options.dockerFallback !== false) {
    const image = options.dockerImage ?? 'semgrep/semgrep:latest';

    // Local rules only: with no network the registry packs cannot be fetched, and passing them
    // would make Semgrep exit before scanning anything.
    result = await sandbox.exec(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${sandbox.root}:/src`,
        '--workdir',
        '/src',
        image,
        'semgrep',
        ...buildArgs(false),
      ],
      { timeoutMs: options.timeoutMs ?? 180_000 },
    );

    if (result.spawnFailed) {
      return {
        ...base(),
        status: AnalyzerStatus.NOT_INSTALLED,
        error:
          'Semgrep is unavailable: the binary is not on PATH and Docker could not be used as a ' +
          'fallback. Install it with `pip install semgrep` (Linux/macOS) or make Docker ' +
          'available. Security pattern analysis was skipped for this run.',
      };
    }
  }

  if (result.timedOut) {
    return { ...base(), status: AnalyzerStatus.TIMED_OUT, error: 'Semgrep exceeded its time budget' };
  }

  let parsed: SemgrepOutput;
  try {
    parsed = JSON.parse(result.stdout || '{}') as SemgrepOutput;
  } catch {
    return {
      ...base(),
      status: AnalyzerStatus.FAILED,
      error: `Semgrep output could not be parsed. stderr: ${result.stderr.slice(0, 400)}`,
    };
  }

  // Semgrep exits non-zero for both "findings present" and "rules failed to
  // load". Only the latter is a failure, and it shows up in `errors`.
  const fatalErrors = (parsed.errors ?? []).filter((e) => e.level === 'error');
  if (!parsed.results && fatalErrors.length > 0) {
    return {
      ...base(),
      status: AnalyzerStatus.FAILED,
      error: `Semgrep failed: ${fatalErrors.map((e) => e.message).join('; ').slice(0, 500)}`,
    };
  }

  const findings: StaticFinding[] = [];

  for (const item of parsed.results ?? []) {
    const path = item.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const metadata = item.extra.metadata ?? {};

    findings.push({
      id: '',
      analyzer: Analyzer.SEMGREP,
      ruleId: item.check_id,
      severity: mapSemgrepSeverity(item.extra.severity, metadata.confidence, metadata.impact),
      category: categorizeSemgrepRule(item.check_id, metadata.category),
      message: item.extra.message.trim(),
      path,
      line: item.start.line,
      endLine: item.end.line,
      column: item.start.col,
      helpUrl:
        metadata['semgrep.dev']?.rule?.url ??
        metadata.references?.[0] ??
        cweUrl(metadata.cwe) ??
        null,
      snippet: item.extra.lines?.slice(0, 500) ?? null,
      fingerprint: fingerprintFinding({
        analyzer: Analyzer.SEMGREP,
        ruleId: item.check_id,
        path,
        message: item.extra.message,
      }),
      preexisting: false,
      sourceToolRunId: '',
    });
  }

  return {
    analyzer: Analyzer.SEMGREP,
    status: AnalyzerStatus.SUCCESS,
    findings,
    durationMs: Date.now() - startedAt,
    error: null,
    version: parsed.version ?? null,
    filesAnalyzed: targets.length,
  };
}

/**
 * Map Semgrep severity to ours.
 *
 * Semgrep only has ERROR/WARNING/INFO, which is too coarse: an ERROR-level rule
 * with HIGH impact and HIGH confidence deserves CRITICAL, while the same severity
 * with LOW confidence should not block a merge. Folding metadata into the
 * decision is what keeps the blocking threshold meaningful.
 */
export function mapSemgrepSeverity(
  severity: string,
  confidence?: string,
  impact?: string,
): Severity {
  const level = severity.toUpperCase();
  const highConfidence = (confidence ?? '').toUpperCase() === 'HIGH';
  const highImpact = (impact ?? '').toUpperCase() === 'HIGH';

  if (level === 'ERROR') {
    return highConfidence && highImpact ? Severity.CRITICAL : Severity.HIGH;
  }
  if (level === 'WARNING') {
    return highConfidence ? Severity.MEDIUM : Severity.LOW;
  }
  return Severity.INFO;
}

export function categorizeSemgrepRule(checkId: string, category?: string): FindingCategory {
  const id = checkId.toLowerCase();
  const cat = (category ?? '').toLowerCase();

  if (cat === 'security' || id.includes('security') || id.includes('owasp')) {
    return FindingCategory.SECURITY;
  }
  if (/sqli|xss|csrf|ssrf|injection|deserial|path-traversal|hardcoded|crypto|jwt|cookie|cors/.test(id)) {
    return FindingCategory.SECURITY;
  }
  if (cat === 'performance' || /performance|n-plus-one|inefficient/.test(id)) {
    return FindingCategory.PERFORMANCE;
  }
  if (cat === 'correctness' || /correctness|bug|logic/.test(id)) {
    return FindingCategory.BUG;
  }
  if (/test|assert/.test(id)) {
    return FindingCategory.TESTING;
  }
  if (cat === 'best-practice' || /maintainability|complexity|duplicate/.test(id)) {
    return FindingCategory.MAINTAINABILITY;
  }

  return FindingCategory.SECURITY;
}

function cweUrl(cwe: string | string[] | undefined): string | null {
  if (!cwe) return null;
  const first = Array.isArray(cwe) ? cwe[0] : cwe;
  if (!first) return null;

  const match = /CWE-(\d+)/i.exec(first);
  return match?.[1] ? `https://cwe.mitre.org/data/definitions/${match[1]}.html` : null;
}
