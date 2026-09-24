/**
 * Deterministic file classification.
 *
 * Every changed file in a PR is tagged with zero or more {@link FileFlag}s.
 * Those tags feed three consumers:
 *
 *   1. ML features  — `auth_file_changed`, `test_files_changed`, ...
 *   2. Org policy   — "PRs touching PAYMENT require two reviewers"
 *   3. Review UI    — badges on the file tree
 *
 * This is intentionally rule-based rather than model-based. A reviewer being
 * told "this touches auth" must be able to see exactly why, and the answer has
 * to be identical on every run.
 */

import { FileFlag } from './enums';

/** Patterns are matched against the POSIX-normalized, lowercased path. */
interface FlagRule {
  readonly flag: FileFlag;
  readonly patterns: readonly RegExp[];
}

const FLAG_RULES: readonly FlagRule[] = [
  {
    flag: FileFlag.TEST,
    patterns: [
      /(^|\/)__tests__\//,
      /(^|\/)tests?\//,
      /(^|\/)spec\//,
      /(^|\/)e2e\//,
      /(^|\/)cypress\//,
      /\.(test|spec)\.[cm]?[jt]sx?$/,
      /_test\.(py|go|rb|java|rs)$/,
      /test_[^/]+\.py$/,
      /Tests?\.(cs|java|kt)$/,
    ],
  },
  {
    flag: FileFlag.DEPENDENCY,
    patterns: [
      /(^|\/)package\.json$/,
      /(^|\/)package-lock\.json$/,
      /(^|\/)pnpm-lock\.yaml$/,
      /(^|\/)yarn\.lock$/,
      /(^|\/)requirements[^/]*\.txt$/,
      /(^|\/)poetry\.lock$/,
      /(^|\/)pyproject\.toml$/,
      /(^|\/)pipfile(\.lock)?$/,
      /(^|\/)go\.(mod|sum)$/,
      /(^|\/)cargo\.(toml|lock)$/,
      /(^|\/)gemfile(\.lock)?$/,
      /(^|\/)pom\.xml$/,
      /(^|\/)build\.gradle(\.kts)?$/,
      /(^|\/)composer\.(json|lock)$/,
    ],
  },
  {
    flag: FileFlag.AUTH,
    patterns: [
      /auth/,
      /(^|[/_.-])session/,
      /(^|[/_.-])token/,
      /(^|[/_.-])login/,
      /(^|[/_.-])logout/,
      /(^|[/_.-])signup/,
      /password/,
      /credential/,
      /permission/,
      /(^|[/_.-])rbac/,
      /(^|[/_.-])acl($|[/_.-])/,
      /(^|[/_.-])jwt/,
      /oauth/,
      /(^|[/_.-])saml/,
      /(^|[/_.-])sso($|[/_.-])/,
      /guard/,
      /middleware\/.*(auth|protect)/,
      /crypt/,
    ],
  },
  {
    flag: FileFlag.DATABASE,
    patterns: [
      /(^|\/)migrations?\//,
      /schema\.prisma$/,
      /\.sql$/,
      /(^|\/)repositor(y|ies)\//,
      /(^|\/)entit(y|ies)\//,
      /(^|\/)models?\//,
      /(^|[/_.-])dao($|[/_.-])/,
      /(^|[/_.-])orm($|[/_.-])/,
      /knexfile/,
      /typeorm/,
      /sequelize/,
      /(^|[/_.-])query(builder)?\./,
    ],
  },
  {
    flag: FileFlag.MIGRATION,
    patterns: [/(^|\/)migrations?\//, /(^|\/)alembic\//, /\d{8,}[_-].*\.(sql|ts|js|py)$/],
  },
  {
    flag: FileFlag.CONFIG,
    patterns: [
      /(^|\/)\.env/,
      /(^|\/)config[^/]*\.(json|ya?ml|toml|ini|js|ts)$/,
      /(^|\/)config\//,
      /(^|\/)settings\.(py|json|ya?ml|ts)$/,
      /(^|\/)next\.config\.[cm]?[jt]s$/,
      /(^|\/)tsconfig[^/]*\.json$/,
      /(^|\/)webpack\.config/,
      /(^|\/)vite\.config/,
      /(^|\/)nest-cli\.json$/,
      /(^|\/)tailwind\.config/,
      /\.(eslintrc|prettierrc)/,
    ],
  },
  {
    flag: FileFlag.PAYMENT,
    patterns: [
      /payment/,
      /billing/,
      /invoice/,
      /checkout/,
      /stripe/,
      /paypal/,
      /razorpay/,
      /braintree/,
      /subscription/,
      /(^|[/_.-])refund/,
      /(^|[/_.-])pricing/,
      /(^|[/_.-])coupon/,
      /(^|[/_.-])tax($|[/_.-])/,
      /(^|[/_.-])ledger/,
    ],
  },
  {
    flag: FileFlag.INFRA,
    patterns: [
      /(^|\/)dockerfile/,
      /docker-compose[^/]*\.ya?ml$/,
      /\.tf$/,
      /\.tfvars$/,
      /(^|\/)k8s\//,
      /(^|\/)kubernetes\//,
      /(^|\/)helm\//,
      /(^|\/)charts?\//,
      /(^|\/)terraform\//,
      /(^|\/)ansible\//,
      /(^|\/)infra(structure)?\//,
      /serverless\.ya?ml$/,
      /(^|\/)nginx/,
    ],
  },
  {
    flag: FileFlag.CI,
    patterns: [
      /(^|\/)\.github\/workflows\//,
      /(^|\/)\.gitlab-ci\.ya?ml$/,
      /(^|\/)\.circleci\//,
      /(^|\/)jenkinsfile/,
      /azure-pipelines\.ya?ml$/,
      /(^|\/)\.buildkite\//,
    ],
  },
  {
    flag: FileFlag.DOCS,
    patterns: [/\.mdx?$/, /(^|\/)docs?\//, /(^|\/)adr\//, /license/, /changelog/, /contributing/],
  },
  {
    flag: FileFlag.GENERATED,
    patterns: [
      /(^|\/)dist\//,
      /(^|\/)build\//,
      /(^|\/)\.next\//,
      /(^|\/)node_modules\//,
      /(^|\/)coverage\//,
      /\.min\.(js|css)$/,
      /\.generated\./,
      /(^|\/)__generated__\//,
      /\.pb\.(go|ts|js)$/,
      /_pb2\.py$/,
      /\.d\.ts$/,
      /(^|\/)prisma\/generated\//,
    ],
  },
  {
    flag: FileFlag.API_SURFACE,
    patterns: [
      /(^|\/)routes?\//,
      /(^|\/)controllers?\//,
      /(^|\/)handlers?\//,
      /(^|\/)endpoints?\//,
      /(^|\/)resolvers?\//,
      /(^|\/)api\//,
      /\.controller\.[jt]s$/,
      /\.resolver\.[jt]s$/,
      /(^|\/)app\/api\/.*\/route\.[jt]s$/,
      /openapi[^/]*\.(ya?ml|json)$/,
      /swagger[^/]*\.(ya?ml|json)$/,
      /\.proto$/,
      /schema\.graphql$/,
    ],
  },
];

/** Normalize to forward slashes and lowercase for stable matching. */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Classify a single path.
 *
 * Note that flags are not mutually exclusive by design:
 * `apps/api/src/auth/auth.controller.spec.ts` is legitimately TEST + AUTH +
 * API_SURFACE, and the policy engine wants all three.
 */
export function classifyFile(filePath: string): FileFlag[] {
  const normalized = normalizePath(filePath);
  const flags: FileFlag[] = [];

  for (const rule of FLAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      flags.push(rule.flag);
    }
  }
  return flags;
}

/** True when any path in the set carries the flag. */
export function anyFileHasFlag(filePaths: readonly string[], flag: FileFlag): boolean {
  return filePaths.some((p) => classifyFile(p).includes(flag));
}

export function countFilesWithFlag(filePaths: readonly string[], flag: FileFlag): number {
  return filePaths.reduce((acc, p) => (classifyFile(p).includes(flag) ? acc + 1 : acc), 0);
}

// ---------------------------------------------------------------- language

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  prisma: 'prisma',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  tf: 'terraform',
  dockerfile: 'dockerfile',
};

export function detectLanguage(filePath: string): string {
  const normalized = normalizePath(filePath);
  const basename = normalized.split('/').pop() ?? normalized;

  if (basename.startsWith('dockerfile')) return 'dockerfile';
  if (basename.startsWith('.env')) return 'dotenv';
  if (basename === 'makefile') return 'makefile';

  const ext = basename.includes('.') ? (basename.split('.').pop() ?? '') : '';
  return EXTENSION_LANGUAGE[ext] ?? 'unknown';
}

/** Languages our ESLint/tsc analyzers can actually process. */
export const JS_TS_LANGUAGES: readonly string[] = ['typescript', 'javascript'];

export function isJsOrTs(filePath: string): boolean {
  return JS_TS_LANGUAGES.includes(detectLanguage(filePath));
}

/**
 * Files excluded from analysis and indexing. Reviewing a lockfile diff line by
 * line wastes tokens and produces noise; the DEPENDENCY flag already tells the
 * risk model what it needs to know.
 */
export function isAnalyzable(filePath: string): boolean {
  const flags = classifyFile(filePath);
  if (flags.includes(FileFlag.GENERATED)) return false;

  const normalized = normalizePath(filePath);
  const lockfiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'poetry.lock',
    'cargo.lock',
    'composer.lock',
    'gemfile.lock',
  ];
  return !lockfiles.some((lock) => normalized.endsWith(lock));
}

/**
 * Best-effort mapping from a source file to its conventional test file.
 * Used by the RAG retriever's CONVENTION strategy so the AI can see how this
 * repository actually writes tests before it suggests new ones.
 */
export function guessTestPaths(sourcePath: string): string[] {
  const normalized = sourcePath.replace(/\\/g, '/');
  const match = /^(.*)\/([^/]+)\.([cm]?[jt]sx?)$/.exec(normalized);
  if (!match) return [];

  const [, dir, base, ext] = match;
  if (dir === undefined || base === undefined || ext === undefined) return [];

  return [
    `${dir}/${base}.test.${ext}`,
    `${dir}/${base}.spec.${ext}`,
    `${dir}/__tests__/${base}.test.${ext}`,
    `${dir}/__tests__/${base}.spec.${ext}`,
    `${dir.replace(/\/src(\/|$)/, '/test$1')}/${base}.test.${ext}`,
  ];
}
