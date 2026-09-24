import {
  Analyzer,
  AnalyzerStatus,
  FileFlag,
  FindingCategory,
  SEVERITY_RANK,
  Severity,
  countBy,
  severityAtLeast,
  type AnalyzerResult,
  type StaticAnalysisSummary,
  type StaticFinding,
} from '@codelens/shared';
import { runEslint } from './analyzers/eslint';
import { runNpmAudit } from './analyzers/npm-audit';
import { runPatternScan } from './analyzers/pattern-scan';
import { runSecretScan } from './analyzers/secret-scan';
import { runSemgrep } from './analyzers/semgrep';
import { extractMetrics } from './features';
import { AnalysisSandbox } from './sandbox';
import {
  DEFAULT_STATIC_ANALYSIS_OPTIONS,
  type AnalyzerInput,
  type StaticAnalysisOptions,
} from './types';

/**
 * Static analysis orchestration.
 *
 * Every analyzer is optional and independently degradable. If Semgrep is not
 * installed, ESLint has no config, and the registry is unreachable, this still
 * returns a usable summary containing metrics and secret-scan results — the
 * review continues with a recorded gap rather than failing.
 *
 * That property is what makes the product deployable. An analysis pipeline that
 * requires five external tools to all be present and healthy will be down more
 * often than it is up.
 */

export async function runStaticAnalysis(
  input: AnalyzerInput,
  options: Partial<StaticAnalysisOptions> & Pick<StaticAnalysisOptions, 'tmpDir' | 'runId'>,
): Promise<StaticAnalysisSummary> {
  const config: StaticAnalysisOptions = { ...DEFAULT_STATIC_ANALYSIS_OPTIONS, ...options };
  const sandbox = await AnalysisSandbox.create(config.tmpDir, config.runId);
  const results: AnalyzerResult[] = [];

  // The secret scan runs first and in-process. Its outcome gates whether diff
  // content may be sent to an external model, so it must not depend on the
  // sandbox or any external binary succeeding.
  const secretResult = config.enableSecretScan
    ? runSecretScan(input)
    : {
        analyzer: Analyzer.SECRET_SCAN,
        status: AnalyzerStatus.SKIPPED,
        findings: [],
        durationMs: 0,
        error: 'Secret scanning disabled by configuration',
        version: null,
        filesAnalyzed: 0,
        hits: [],
      };

  results.push(stripHits(secretResult));

  // The in-process pattern analyzer runs unconditionally and needs no external tooling.
  //
  // It guarantees a floor of coverage: Semgrep is strictly more capable but requires
  // syntactically valid files, and content reconstructed from diff hunks usually is not. Without
  // this, a diff containing obvious raw-SQL interpolation yields zero findings whenever full file
  // content is unavailable. Deduplication downstream collapses anything Semgrep also reports.
  const patternResult = runPatternScan(input);
  results.push(patternResult);

  try {
    // Materialize only the changed files, never a full clone.
    await sandbox.writeFiles(
      input.files
        .filter((file) => file.analyzable && file.content.length > 0)
        .map((file) => ({ path: file.path, content: file.content })),
    );

    // Config files the analyzers need in order to respect project conventions.
    for (const [name, content] of Object.entries(input.manifests)) {
      await sandbox.writeConfig(name, content);
    }

    // Analyzers are independent, so run them concurrently. Each already has its
    // own timeout, and a rejected promise here would mean a bug in a runner
    // rather than an analyzer failure, hence allSettled.
    const tasks: Array<Promise<AnalyzerResult>> = [];

    if (config.enableEslint) {
      tasks.push(runEslint(sandbox, input, { timeoutMs: config.timeoutMs }));
    }
    if (config.enableSemgrep) {
      tasks.push(
        runSemgrep(sandbox, input, {
          binary: config.semgrepBinary,
          rulesets: config.semgrepRulesets,
          timeoutMs: config.timeoutMs,
        }),
      );
    }
    if (config.enableNpmAudit) {
      tasks.push(runNpmAudit(sandbox, input, { timeoutMs: config.timeoutMs }));
    }

    const settled = await Promise.allSettled(tasks);

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        results.push({
          analyzer: Analyzer.ESLINT,
          status: AnalyzerStatus.FAILED,
          findings: [],
          durationMs: 0,
          error: `Analyzer crashed: ${String(outcome.reason).slice(0, 300)}`,
          version: null,
          filesAnalyzed: 0,
        });
      }
    }
  } finally {
    await sandbox.destroy();
  }

  // ---- post-processing

  const allFindings = results.flatMap((result) => result.findings);
  const scoped = markPreexisting(allFindings, input);
  const filtered = scoped.filter((finding) => severityAtLeast(finding.severity, config.minSeverity));
  const deduped = dedupeFindings(filtered);

  const metrics = extractMetrics(input, deduped);

  return {
    results: results.map((result) => ({
      ...result,
      findings: deduped.filter((finding) => finding.analyzer === result.analyzer),
    })),
    metrics,
    totalFindings: deduped.length,
    newFindings: deduped.filter((f) => !f.preexisting).length,
    preexistingFindings: deduped.filter((f) => f.preexisting).length,
    countsBySeverity: countBySeverity(deduped),
    countsByCategory: countByCategory(deduped),
    secretsDetected: secretResult.hits.map((hit) => ({
      path: hit.path,
      line: hit.line,
      kind: hit.kind,
    })),
  };
}

/**
 * Mark findings that sit on lines the PR did not touch.
 *
 * This is the difference between a review a developer accepts and one they
 * resent. Running a linter over a legacy file surfaces every latent issue in it;
 * attributing those to whoever happened to edit one line is both unfair and
 * actively harmful, because it buries the findings that *are* about this change.
 *
 * Pre-existing findings are kept and shown separately, and excluded from
 * `security_findings_count` in the ML feature vector.
 */
export function markPreexisting(
  findings: readonly StaticFinding[],
  input: AnalyzerInput,
): StaticFinding[] {
  const touchedByPath = new Map(input.files.map((file) => [file.path, file.touchedLines]));

  return findings.map((finding) => {
    // Repository-level findings (dependency advisories) have no line to scope by
    // and are always attributable to the change that triggered the audit.
    if (finding.path === null || finding.line === null) {
      return { ...finding, preexisting: false };
    }

    const touched = touchedByPath.get(finding.path);
    if (!touched || touched.size === 0) {
      return { ...finding, preexisting: true };
    }

    // Treat a finding as in-scope if it overlaps the touched range at all, not
    // just on its start line: a multi-line finding whose body the PR edited is
    // this PR's concern.
    const start = finding.line;
    const end = finding.endLine ?? finding.line;

    for (let line = start; line <= end; line += 1) {
      if (touched.has(line)) return { ...finding, preexisting: false };
    }

    return { ...finding, preexisting: true };
  });
}

/**
 * Collapse duplicate findings across analyzers.
 *
 * ESLint and Semgrep both flag the same unsafe pattern reasonably often. Showing
 * it twice does not make it twice as important, and it makes the report look
 * careless. The higher-severity copy wins.
 */
export function dedupeFindings(findings: readonly StaticFinding[]): StaticFinding[] {
  const byLocation = new Map<string, StaticFinding>();

  for (const finding of findings) {
    // Same file, same line, same category is treated as the same problem.
    const key = `${finding.path ?? ''}:${finding.line ?? 0}:${finding.category}`;
    const existing = byLocation.get(key);

    if (!existing) {
      byLocation.set(key, finding);
      continue;
    }

    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      byLocation.set(key, finding);
    }
  }

  // Stable ordering: severity first, then file and line, so the report reads
  // predictably rather than in analyzer-completion order.
  return [...byLocation.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;

    const byPath = (a.path ?? '').localeCompare(b.path ?? '');
    if (byPath !== 0) return byPath;

    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function countBySeverity(findings: readonly StaticFinding[]): Record<Severity, number> {
  const counts = countBy(findings, (f) => f.severity);
  return {
    CRITICAL: counts.CRITICAL ?? 0,
    HIGH: counts.HIGH ?? 0,
    MEDIUM: counts.MEDIUM ?? 0,
    LOW: counts.LOW ?? 0,
    INFO: counts.INFO ?? 0,
  };
}

function countByCategory(findings: readonly StaticFinding[]): Record<FindingCategory, number> {
  const counts = countBy(findings, (f) => f.category);
  return {
    BUG: counts.BUG ?? 0,
    SECURITY: counts.SECURITY ?? 0,
    PERFORMANCE: counts.PERFORMANCE ?? 0,
    MAINTAINABILITY: counts.MAINTAINABILITY ?? 0,
    TESTING: counts.TESTING ?? 0,
    STYLE: counts.STYLE ?? 0,
    DEPENDENCY: counts.DEPENDENCY ?? 0,
    TYPE_SAFETY: counts.TYPE_SAFETY ?? 0,
  };
}

function stripHits(result: AnalyzerResult & { hits?: unknown }): AnalyzerResult {
  const { hits: _hits, ...rest } = result;
  return rest;
}

/** Whether policy should block on the secret scan result. */
export function shouldBlockOnSecrets(
  summary: StaticAnalysisSummary,
  blockOnSecretDetection: boolean,
): boolean {
  if (!blockOnSecretDetection) return false;
  return summary.secretsDetected.length > 0;
}

/** Whether any finding meets the organization's blocking threshold. */
export function blockingFindings(
  summary: StaticAnalysisSummary,
  threshold: Severity,
): StaticFinding[] {
  return summary.results
    .flatMap((result) => result.findings)
    .filter((finding) => !finding.preexisting && severityAtLeast(finding.severity, threshold));
}

/** Sensitive-area flags present in the change, for policy escalation. */
export function sensitiveFlags(input: AnalyzerInput): FileFlag[] {
  const sensitive: ReadonlySet<FileFlag> = new Set<FileFlag>([
    FileFlag.AUTH,
    FileFlag.PAYMENT,
    FileFlag.DATABASE,
    FileFlag.INFRA,
  ]);

  const present = new Set<FileFlag>();

  for (const file of input.files) {
    for (const flag of file.flags) {
      if (sensitive.has(flag)) present.add(flag);
    }
  }

  return [...present];
}
