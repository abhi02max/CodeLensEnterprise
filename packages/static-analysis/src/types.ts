import type { FileFlag, Severity } from '@codelens/shared';

/** One changed file, as handed to an analyzer. */
export interface AnalyzerFile {
  path: string;
  /** Post-change content, reconstructed from the diff or fetched from GitHub. */
  content: string;
  /** Pre-change content, when available. Empty for added files. */
  previousContent: string;
  language: string;
  flags: FileFlag[];
  /** False for generated files and lockfiles. */
  analyzable: boolean;
  /** Line numbers in the new file that this PR touched. */
  touchedLines: Set<number>;
  additions: number;
  deletions: number;
  /**
   * New-file line number for each line of `content`, parallel to `content.split('\n')`.
   *
   * Required to report *where* a matched line is. When `content` is reconstructed from diff hunks
   * it is a fragment: its index 0 is wherever the first hunk starts, so an index is not a line
   * number and the two differ by however much of the file the diff skipped. Absent when `content`
   * is a whole file, in which case index + 1 is already correct.
   *
   * A plain number array rather than the richer `ReconstructedLine` from `@codelens/github`: this
   * package deliberately does not depend on the GitHub client, and the only thing an analyzer needs
   * is the position.
   */
  contentLineNumbers?: readonly (number | null)[];
}

export interface AnalyzerInput {
  files: AnalyzerFile[];
  /** Config filenames present at the repository root, used for capability checks. */
  repoConfigFiles: string[];
  /** Raw content of manifests needed by dependency analyzers. */
  manifests: Record<string, string>;
  /** Extra Semgrep rulesets from organization policy. */
  extraSemgrepRulesets: string[];
}

export interface StaticAnalysisOptions {
  tmpDir: string;
  runId: string;
  timeoutMs: number;
  enableEslint: boolean;
  enableSemgrep: boolean;
  enableNpmAudit: boolean;
  enableSecretScan: boolean;
  semgrepBinary: string;
  semgrepRulesets: string[];
  /** Findings below this severity are discarded before persistence. */
  minSeverity: Severity;
}

export const DEFAULT_STATIC_ANALYSIS_OPTIONS: Omit<StaticAnalysisOptions, 'tmpDir' | 'runId'> = {
  timeoutMs: 120_000,
  enableEslint: true,
  enableSemgrep: true,
  enableNpmAudit: true,
  enableSecretScan: true,
  semgrepBinary: 'semgrep',
  semgrepRulesets: ['p/security-audit', 'p/owasp-top-ten'],
  minSeverity: 'INFO',
};
