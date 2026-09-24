import {
  FileFlag,
  FindingCategory,
  Severity,
  emptyPrFeatures,
  severityAtLeast,
  truncate,
  type PrFeatures,
  type PrMetricsView,
  type StaticFinding,
} from '@codelens/shared';
import { complexityDelta } from './complexity';
import type { AnalyzerInput } from './types';

/**
 * ML feature extraction.
 *
 * This is the boundary where a pull request becomes a vector. Everything here is
 * deterministic: the same diff and the same findings always produce the same
 * features, which is what makes a stored prediction reproducible and a trained
 * model auditable.
 *
 * No language model is involved, by design. A feature vector derived from an LLM
 * would make the risk score non-reproducible and untrainable.
 */

export function extractMetrics(
  input: AnalyzerInput,
  findings: readonly StaticFinding[],
): PrMetricsView {
  const analyzable = input.files.filter((file) => file.analyzable);

  let linesAdded = 0;
  let linesDeleted = 0;
  let complexityBefore = 0;
  let complexityAfter = 0;
  let functionsChanged = 0;
  let maxFunctionComplexity = 0;
  let testLines = 0;
  let codeLines = 0;

  for (const file of analyzable) {
    linesAdded += file.additions;
    linesDeleted += file.deletions;

    const isTest = file.flags.includes(FileFlag.TEST);
    if (isTest) {
      testLines += file.additions;
    } else {
      codeLines += file.additions;
    }

    // Complexity is only meaningful for languages the estimator understands, and
    // only when there is content on at least one side of the change.
    if (!COMPLEXITY_LANGUAGES.has(file.language)) continue;
    if (!file.content && !file.previousContent) continue;

    const result = complexityDelta(file.previousContent, file.content, file.language);
    complexityBefore += result.before;
    complexityAfter += result.after;
    functionsChanged += result.functionsChanged;
    maxFunctionComplexity = Math.max(maxFunctionComplexity, result.maxFunctionComplexity);
  }

  const flagPresent = (flag: FileFlag): boolean =>
    analyzable.some((file) => file.flags.includes(flag));

  const testFilesChanged = analyzable.filter((file) => file.flags.includes(FileFlag.TEST)).length;

  // Only findings attributable to this change, and only the severe ones. A
  // count inflated by pre-existing style warnings would make the feature useless
  // as a risk signal.
  const securityFindingsCount = findings.filter(
    (finding) =>
      !finding.preexisting &&
      finding.category === FindingCategory.SECURITY &&
      severityAtLeast(finding.severity, Severity.HIGH),
  ).length;

  return {
    linesAdded,
    linesDeleted,
    filesChanged: analyzable.length,
    // Set by the caller, which owns commit data.
    commitCount: 0,
    functionsChanged,
    complexityBefore,
    complexityAfter,
    complexityDelta: complexityAfter - complexityBefore,
    maxFunctionComplexity,
    securityFindingsCount,
    testFilesChanged,
    hasTests: testFilesChanged > 0,
    dependencyChanged: flagPresent(FileFlag.DEPENDENCY),
    authFileChanged: flagPresent(FileFlag.AUTH),
    databaseFileChanged: flagPresent(FileFlag.DATABASE),
    configFileChanged: flagPresent(FileFlag.CONFIG),
    paymentFileChanged: flagPresent(FileFlag.PAYMENT),
    infraFileChanged: flagPresent(FileFlag.INFRA),
    // Requires repository history; injected by the caller.
    previousRiskyFileCount: 0,
    testToCodeRatio: codeLines === 0 ? (testLines > 0 ? 1 : 0) : testLines / codeLines,
  };
}

/**
 * Convert metrics into the model's feature vector.
 *
 * Booleans become 0/1 because they feed a numeric matrix directly. Text is passed
 * through raw for the ML service to vectorize with its own fitted TF-IDF — doing
 * it here would mean shipping vectorizer state across a service boundary and
 * guarantees train/serve skew the first time it drifts.
 */
export function toPrFeatures(params: {
  metrics: PrMetricsView;
  commitCount: number;
  previousRiskyFileCount: number;
  title: string;
  commitMessages: readonly string[];
}): PrFeatures {
  const { metrics } = params;

  return {
    ...emptyPrFeatures(),
    lines_added: metrics.linesAdded,
    lines_deleted: metrics.linesDeleted,
    files_changed: metrics.filesChanged,
    number_of_commits: params.commitCount,
    complexity_delta: metrics.complexityDelta,
    security_findings_count: metrics.securityFindingsCount,
    dependency_changed: metrics.dependencyChanged ? 1 : 0,
    test_files_changed: metrics.testFilesChanged > 0 ? 1 : 0,
    auth_file_changed: metrics.authFileChanged ? 1 : 0,
    database_file_changed: metrics.databaseFileChanged ? 1 : 0,
    config_file_changed: metrics.configFileChanged ? 1 : 0,
    payment_file_changed: metrics.paymentFileChanged ? 1 : 0,
    previous_risky_file_count: params.previousRiskyFileCount,
    title_text: normalizeText(params.title, 300),
    commit_text: normalizeText(params.commitMessages.join(' \n '), 2000),
  };
}

/**
 * Normalize text before TF-IDF.
 *
 * Commit trailers and bot noise are stripped because they appear in a large
 * fraction of commits and carry no signal about risk — left in, TF-IDF wastes
 * vocabulary slots on "Co-authored-by" and "Signed-off-by".
 */
export function normalizeText(text: string, maxLength: number): string {
  const cleaned = text
    .replace(/^(Co-authored-by|Signed-off-by|Reviewed-by|Cc):.*$/gim, '')
    .replace(/https?:\/\/\S+/g, ' ')
    // Collapse issue references to a token: the fact that one exists is signal,
    // the specific number is not.
    .replace(/#\d+/g, ' ISSUEREF ')
    .replace(/\b[0-9a-f]{7,40}\b/gi, ' SHA ')
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(cleaned, maxLength, '');
}

/**
 * Count files in this PR with a history of trouble in this repository.
 *
 * The strongest feature in the model once real data exists, because it is the
 * only one that encodes the organization's own history rather than a generic
 * heuristic. A 40-line change to a file that caused three of the last five
 * incidents is genuinely riskier than a 400-line change to a stable one, and no
 * size-based feature can express that.
 *
 * The caller supplies `riskyPaths` from review history: files that appeared in
 * reverts, hotfixes, or PRs that received CHANGES_REQUESTED.
 */
export function countPreviousRiskyFiles(
  changedPaths: readonly string[],
  riskyPaths: ReadonlySet<string>,
): number {
  return changedPaths.filter((path) => riskyPaths.has(path)).length;
}

const COMPLEXITY_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'java',
  'csharp',
  'go',
  'ruby',
  'php',
  'kotlin',
  'swift',
  'rust',
  'scala',
  'c',
  'cpp',
]);
