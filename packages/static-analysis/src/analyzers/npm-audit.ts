import {
  Analyzer,
  AnalyzerStatus,
  FileFlag,
  FindingCategory,
  Severity,
  type AnalyzerResult,
  type StaticFinding,
} from '@codelens/shared';
import { fingerprintFinding, type AnalysisSandbox } from '../sandbox';
import type { AnalyzerInput } from '../types';

/**
 * Dependency vulnerability audit.
 *
 * Only runs when the PR actually changes a manifest or lockfile. Auditing on
 * every PR would report the same pre-existing advisories over and over, which
 * trains reviewers to skip the section entirely — the audit is useful precisely
 * because its presence means *this* PR changed the dependency surface.
 *
 * `--package-lock-only` avoids a real install: no postinstall scripts from
 * untrusted dependencies execute, which matters a great deal when the whole point
 * is reviewing an unfamiliar dependency change.
 */

interface NpmAuditVulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  isDirect: boolean;
  via: Array<string | { title?: string; url?: string; cwe?: string[]; source?: number; cvss?: { score?: number } }>;
  effects: string[];
  range: string;
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: Record<string, number>;
    dependencies?: Record<string, number>;
  };
}

export async function runNpmAudit(
  sandbox: AnalysisSandbox,
  input: AnalyzerInput,
  options: { timeoutMs?: number } = {},
): Promise<AnalyzerResult> {
  const startedAt = Date.now();

  const base = (): Omit<AnalyzerResult, 'status' | 'error'> => ({
    analyzer: Analyzer.NPM_AUDIT,
    findings: [],
    durationMs: Date.now() - startedAt,
    version: null,
    filesAnalyzed: 0,
  });

  const dependencyChanged = input.files.some((file) => file.flags.includes(FileFlag.DEPENDENCY));
  if (!dependencyChanged) {
    return {
      ...base(),
      status: AnalyzerStatus.SKIPPED,
      error: 'No dependency manifest changed in this pull request',
    };
  }

  const packageJson = input.manifests['package.json'];
  if (!packageJson) {
    return {
      ...base(),
      status: AnalyzerStatus.SKIPPED,
      error: 'Dependency change detected but no package.json was available to audit',
    };
  }

  await sandbox.writeConfig('package.json', packageJson);

  // A lockfile is required for --package-lock-only. npm can synthesize one,
  // but that needs network access to the registry.
  const lockfile =
    input.manifests['package-lock.json'] ?? input.manifests['npm-shrinkwrap.json'] ?? null;

  if (lockfile) {
    await sandbox.writeConfig('package-lock.json', lockfile);
  }

  const args = [
    'audit',
    '--json',
    '--audit-level=info',
    ...(lockfile ? ['--package-lock-only'] : []),
  ];

  const result = await sandbox.exec('npm', args, { timeoutMs: options.timeoutMs ?? 90_000 });

  if (result.spawnFailed) {
    return { ...base(), status: AnalyzerStatus.NOT_INSTALLED, error: 'npm is not available' };
  }

  if (result.timedOut) {
    return { ...base(), status: AnalyzerStatus.TIMED_OUT, error: 'npm audit exceeded its time budget' };
  }

  let parsed: NpmAuditOutput;
  try {
    parsed = JSON.parse(result.stdout || '{}') as NpmAuditOutput;
  } catch {
    return {
      ...base(),
      status: AnalyzerStatus.FAILED,
      error:
        'npm audit output could not be parsed. This usually means the registry was ' +
        `unreachable. stderr: ${result.stderr.slice(0, 300)}`,
    };
  }

  const vulnerabilities = parsed.vulnerabilities ?? {};
  const findings: StaticFinding[] = [];

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    // `via` mixes advisory objects with names of other vulnerable packages;
    // only the objects carry advisory detail.
    const advisories = vulnerability.via.filter(
      (entry): entry is Exclude<typeof entry, string> => typeof entry !== 'string',
    );

    const title = advisories[0]?.title ?? `Vulnerable dependency: ${packageName}`;
    const url = advisories[0]?.url ?? null;
    const cvss = advisories[0]?.cvss?.score;

    const fixNote = describeFix(vulnerability.fixAvailable);
    const transitiveNote = vulnerability.isDirect
      ? 'This is a direct dependency.'
      : `Reached transitively via ${vulnerability.effects.slice(0, 3).join(', ') || 'another package'}.`;

    const message = [
      title,
      `Affected range: ${vulnerability.range}.`,
      transitiveNote,
      fixNote,
      cvss !== undefined ? `CVSS ${cvss}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const ruleId = `npm-audit/${packageName}`;

    findings.push({
      id: '',
      analyzer: Analyzer.NPM_AUDIT,
      ruleId,
      severity: mapAuditSeverity(vulnerability.severity, vulnerability.isDirect),
      category: FindingCategory.DEPENDENCY,
      message,
      // Attributed to package.json so the finding anchors to a real diff line.
      path: 'package.json',
      line: findDependencyLine(packageJson, packageName),
      endLine: null,
      column: null,
      helpUrl: url,
      snippet: null,
      fingerprint: fingerprintFinding({
        analyzer: Analyzer.NPM_AUDIT,
        ruleId,
        path: 'package.json',
        message: title,
      }),
      preexisting: false,
      sourceToolRunId: '',
    });
  }

  return {
    analyzer: Analyzer.NPM_AUDIT,
    status: AnalyzerStatus.SUCCESS,
    findings,
    durationMs: Date.now() - startedAt,
    error: null,
    version: null,
    filesAnalyzed: 1,
  };
}

/**
 * Map npm severity, downgrading transitive findings by one level.
 *
 * A critical advisory in a direct dependency is the author's decision to fix. The
 * same advisory four levels deep is often unreachable from the application and
 * unfixable without upstream action, so treating both as equally blocking makes
 * the gate unusable.
 */
export function mapAuditSeverity(severity: string, isDirect: boolean): Severity {
  const direct: Record<string, Severity> = {
    critical: Severity.CRITICAL,
    high: Severity.HIGH,
    moderate: Severity.MEDIUM,
    low: Severity.LOW,
    info: Severity.INFO,
  };

  const transitive: Record<string, Severity> = {
    critical: Severity.HIGH,
    high: Severity.MEDIUM,
    moderate: Severity.LOW,
    low: Severity.INFO,
    info: Severity.INFO,
  };

  const table = isDirect ? direct : transitive;
  return table[severity.toLowerCase()] ?? Severity.INFO;
}

function describeFix(fixAvailable: NpmAuditVulnerability['fixAvailable']): string {
  if (fixAvailable === false) return 'No fix is currently available.';
  if (fixAvailable === true) return 'A fix is available via npm audit fix.';

  return fixAvailable.isSemVerMajor
    ? `Fixed in ${fixAvailable.name}@${fixAvailable.version}, which is a breaking major upgrade.`
    : `Fixed in ${fixAvailable.name}@${fixAvailable.version}.`;
}

/** Locate a dependency's line in package.json so the finding can anchor to it. */
function findDependencyLine(packageJson: string, packageName: string): number | null {
  const lines = packageJson.split('\n');
  const needle = `"${packageName}"`;

  for (const [index, line] of lines.entries()) {
    if (line.includes(needle)) return index + 1;
  }
  return null;
}
