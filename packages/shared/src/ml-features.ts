/**
 * The ML feature contract.
 *
 * This file is the boundary between the TypeScript extractor
 * (`packages/static-analysis`) and the Python model service
 * (`apps/ml-service`). Both sides must agree on names, order and types or
 * predictions silently become garbage — a column-order mismatch does not throw,
 * it just produces confident nonsense.
 *
 * `apps/ml-service/app/features.py` mirrors NUMERIC_FEATURES exactly and there
 * is a test on the Python side asserting the lists match.
 *
 * Adding a feature is a breaking change: bump FEATURE_SCHEMA_VERSION, add the
 * column on both sides, and retrain. Old `MlPrediction` rows keep their original
 * version so historical scores stay interpretable.
 */

import { z } from 'zod';

export const FEATURE_SCHEMA_VERSION = 1;

/**
 * Numeric feature names in canonical order.
 *
 * Order matters: the Python `ColumnTransformer` is constructed from this list,
 * so reordering it invalidates every trained artifact.
 */
export const NUMERIC_FEATURES = [
  'lines_added',
  'lines_deleted',
  'files_changed',
  'number_of_commits',
  'complexity_delta',
  'security_findings_count',
  'dependency_changed',
  'test_files_changed',
  'auth_file_changed',
  'database_file_changed',
  'config_file_changed',
  'payment_file_changed',
  'previous_risky_file_count',
] as const;

export type NumericFeatureName = (typeof NUMERIC_FEATURES)[number];

/** Free-text features vectorized with TF-IDF inside the ML service. */
export const TEXT_FEATURES = ['title_text', 'commit_text'] as const;
export type TextFeatureName = (typeof TEXT_FEATURES)[number];

export const PrFeaturesSchema = z.object({
  // ---- size
  lines_added: z.number().int().min(0),
  lines_deleted: z.number().int().min(0),
  files_changed: z.number().int().min(0),
  number_of_commits: z.number().int().min(0),

  /**
   * Net change in summed cyclomatic complexity across changed functions
   * (after − before). Can be negative: a refactor that simplifies code lowers
   * risk, and the model should be allowed to learn that.
   */
  complexity_delta: z.number(),

  /**
   * Count of CRITICAL + HIGH static findings on lines this PR actually touched.
   * Pre-existing findings are excluded so an author is not penalized for debt
   * they inherited.
   */
  security_findings_count: z.number().int().min(0),

  // ---- binary flags (0/1 rather than boolean: these go straight into a matrix)
  dependency_changed: z.union([z.literal(0), z.literal(1)]),
  test_files_changed: z.union([z.literal(0), z.literal(1)]),
  auth_file_changed: z.union([z.literal(0), z.literal(1)]),
  database_file_changed: z.union([z.literal(0), z.literal(1)]),
  config_file_changed: z.union([z.literal(0), z.literal(1)]),
  payment_file_changed: z.union([z.literal(0), z.literal(1)]),

  /**
   * How many files in this PR have a history of trouble in *this* repository —
   * appearing in reverts, hotfixes, or PRs that received CHANGES_REQUESTED.
   *
   * This is the only feature that encodes org-specific history rather than a
   * generic heuristic, and it is consistently the strongest signal once a repo
   * has accumulated review data.
   */
  previous_risky_file_count: z.number().int().min(0),

  // ---- text
  //
  // Required rather than `.default('')`. A Zod default makes the schema's input and output
  // types diverge (`string | undefined` vs `string`), and because this schema is embedded in
  // the MCP tool IO contracts that divergence propagates into every consumer as a spurious
  // "possibly undefined". Callers use `emptyPrFeatures()` when they need blanks.
  title_text: z.string(),
  commit_text: z.string(),
});

export type PrFeatures = z.infer<typeof PrFeaturesSchema>;

/** Zeroed vector, used as a safe fallback and as the base for test fixtures. */
export function emptyPrFeatures(): PrFeatures {
  return {
    lines_added: 0,
    lines_deleted: 0,
    files_changed: 0,
    number_of_commits: 0,
    complexity_delta: 0,
    security_findings_count: 0,
    dependency_changed: 0,
    test_files_changed: 0,
    auth_file_changed: 0,
    database_file_changed: 0,
    config_file_changed: 0,
    payment_file_changed: 0,
    previous_risky_file_count: 0,
    title_text: '',
    commit_text: '',
  };
}

/** Project to a plain numeric array in canonical order (for KNN, debugging). */
export function toNumericVector(features: PrFeatures): number[] {
  return NUMERIC_FEATURES.map((name) => features[name]);
}

// ---------------------------------------------------------------- human labels

/**
 * Display metadata for the UI. Keeping it beside the schema means a new feature
 * cannot ship without someone deciding how to explain it to a reviewer.
 */
export const FEATURE_LABELS: Record<NumericFeatureName, { label: string; help: string }> = {
  lines_added: { label: 'Lines added', help: 'Added lines across all non-generated files.' },
  lines_deleted: { label: 'Lines deleted', help: 'Deleted lines across all non-generated files.' },
  files_changed: { label: 'Files changed', help: 'Analyzable files touched by this PR.' },
  number_of_commits: {
    label: 'Commits',
    help: 'Commit count. Very high counts often indicate an unsquashed or meandering branch.',
  },
  complexity_delta: {
    label: 'Complexity delta',
    help: 'Net cyclomatic complexity change. Negative values mean the PR simplified the code.',
  },
  security_findings_count: {
    label: 'Security findings',
    help: 'Critical and high severity findings on lines this PR touched.',
  },
  dependency_changed: {
    label: 'Dependencies changed',
    help: 'A manifest or lockfile changed, introducing supply-chain surface.',
  },
  test_files_changed: {
    label: 'Tests changed',
    help: 'Whether any test file was touched. Absence on a large PR raises risk.',
  },
  auth_file_changed: {
    label: 'Auth code changed',
    help: 'Authentication, authorization, session or crypto code was modified.',
  },
  database_file_changed: {
    label: 'Database code changed',
    help: 'Migrations, schema, or data access layer was modified.',
  },
  config_file_changed: {
    label: 'Config changed',
    help: 'Configuration or environment handling changed, which can affect all environments.',
  },
  payment_file_changed: {
    label: 'Payment code changed',
    help: 'Billing, checkout or payment provider integration changed.',
  },
  previous_risky_file_count: {
    label: 'Historically risky files',
    help: 'Files in this PR previously involved in reverts, hotfixes, or rejected reviews.',
  },
};
