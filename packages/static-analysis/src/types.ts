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
