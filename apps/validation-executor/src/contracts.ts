import { createHash } from 'node:crypto';
import { z } from 'zod';
export { readFrame, encodeFrame } from './frame';

export const LIMITS = Object.freeze({
  files: 1000,
  fileBytes: 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
  frameBytes: 24 * 1024 * 1024,
  pathBytes: 240,
  depth: 16,
  streamBytes: 1024 * 1024,
  reportBytes: 65536,
  excerptBytes: 8192,
  resultBytes: 65536,
  operationMs: 120000,
  executionMs: 30000,
  cleanupMs: 30000,
});
export const ProfileId = z.enum(['typescript-typecheck-v1', 'vitest-unit-v1']);
export const SourceSchema = z
  .object({
    version: z.literal(1),
    profile: ProfileId,
    files: z
      .array(z.object({ path: z.string().min(1).max(240), content: z.string() }).strict())
      .min(1)
      .max(LIMITS.files),
  })
  .strict();
export type ValidationInput = z.infer<typeof SourceSchema>;
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validPath(path: string) {
  const parts = path.split('/');
  return (
    Buffer.byteLength(path) <= LIMITS.pathBytes &&
    parts.length <= LIMITS.depth &&
    /^[A-Za-z0-9_.\-/]+$/.test(path) &&
    !path.startsWith('/') &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/^(?:\.git|\.husky|hooks|node_modules)$/i.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
        !part.endsWith('.'),
    )
  );
}
/** Byte identity is independent of incoming file order; no host path is accepted. */
export function validateInput(raw: unknown) {
  const input = SourceSchema.parse(raw);
  let total = 0;
  const names = new Map<string, string>();
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of files) {
    if (!validPath(file.path)) throw new Error('INPUT_PATH_REJECTED');
    const parts = file.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/'),
        lower = prefix.toLowerCase();
      if (names.has(lower) && names.get(lower) !== prefix) throw new Error('INPUT_CASE_COLLISION');
      names.set(lower, prefix);
    }
    const bytes = Buffer.from(file.content, 'utf8');
    if (
      bytes.length > LIMITS.fileBytes ||
      file.content.includes('\0') ||
      bytes.toString('utf8') !== file.content
    )
      throw new Error('INPUT_ENCODING_OR_BOUND');
    total += bytes.length;
  }
  const paths = new Set(files.map((file) => file.path));
  if (
    paths.size !== files.length ||
    files.some((file) =>
      file.path
        .split('/')
        .slice(0, -1)
        .some((_part, n, parts) => paths.has(parts.slice(0, n + 1).join('/'))),
    )
  )
    throw new Error('INPUT_DUPLICATE_OR_PARENT');
  if (
    total > LIMITS.sourceBytes ||
    Buffer.byteLength(JSON.stringify(input)) > LIMITS.frameBytes - 4096
  )
    throw new Error('INPUT_BOUND');
  const digest = hash(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        hash: hash(file.content),
        bytes: Buffer.byteLength(file.content),
      })),
    ),
  );
  return { input: { ...input, files }, digest };
}
/** The first closure intentionally has no project dependencies or project lockfiles. */
export function checkCompatibility(input: ValidationInput) {
  if (
    input.files.some(
      (file) =>
        /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|(?:vite|vitest)\.(?:config|workspace|projects)\.[^/]+|tsconfig[^/]*\.json|\.npmrc|\.pnpmfile\.[^/]+)$/.test(
          file.path,
        ) || /@vitest-(?:environment|pool)/.test(file.content),
    )
  )
    throw new Error('UNSUPPORTED');
  const manifests = input.files.filter((file) => /(?:^|\/)package\.json$/.test(file.path));
  if (manifests.length !== 1 || manifests[0]?.path !== 'package.json')
    throw new Error('UNSUPPORTED');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifests[0].content) as Record<string, unknown>;
  } catch {
    throw new Error('UNSUPPORTED');
  }
  if (!pkg || Array.isArray(pkg) || typeof pkg !== 'object') throw new Error('UNSUPPORTED');
  const allowed = new Set([
    'name',
    'version',
    'private',
    'description',
    'type',
    'scripts',
    'dependencies',
    'devDependencies',
  ]);
  if (Object.keys(pkg).some((key) => !allowed.has(key))) throw new Error('UNSUPPORTED');
  if (pkg['type'] !== undefined && pkg['type'] !== 'module' && pkg['type'] !== 'commonjs')
    throw new Error('UNSUPPORTED');
  const closure: Record<string, string> = {
    typescript: '5.7.3',
    vitest: '2.1.8',
    '@types/node': '22.10.5',
  };
  for (const key of ['dependencies', 'devDependencies']) {
    const deps = pkg[key] ?? {};
    if (
      !deps ||
      typeof deps !== 'object' ||
      Array.isArray(deps) ||
      Object.entries(deps).some(([name, version]) => closure[name] !== version)
    )
      throw new Error('UNSUPPORTED');
  }
  // Scripts are inert data. Unknown imports cannot trigger acquisition: there is no package manager.
}
export const RunnerReportSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['typecheck', 'tests']),
    passed: z.number().int().min(0).max(10000),
    failed: z.number().int().min(0).max(10000),
    total: z.number().int().min(0).max(10000),
  })
  .strict()
  .refine((v) => v.passed + v.failed === v.total);
export const ResultSchema = z
  .object({
    version: z.literal(1),
    profile: ProfileId,
    profileVersion: z.literal(1),
    policyVersion: z.literal('validation-local-v1'),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    correlation: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['VALIDATION_EXECUTED', 'INFRASTRUCTURE_FAILED', 'UNSUPPORTED', 'CANCELLED']),
    observed: z
      .object({
        started: z.boolean(),
        exitCode: z.number().int().nullable(),
        termination: z.enum(['EXITED', 'TIMEOUT', 'OUTPUT_LIMIT', 'CANCELLED', 'INFRASTRUCTURE']),
        oom: z.boolean(),
        durationMs: z.number().int().min(0),
        cleanup: z.enum(['DISPOSED', 'UNCERTAIN']),
        stdout: z
          .object({
            digest: z.string(),
            capturedBytes: z.number().int().min(0),
            excerpt: z.string().max(8192),
            complete: z.boolean(),
          })
          .strict(),
        stderr: z
          .object({
            digest: z.string(),
            capturedBytes: z.number().int().min(0),
            excerpt: z.string().max(8192),
            complete: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    runnerReported: z
      .object({
        trusted: z.literal(false),
        status: z.enum(['VALID', 'MISSING', 'REJECTED']),
        report: RunnerReportSchema.nullable(),
        reportDigest: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type ValidationResult = z.infer<typeof ResultSchema>;
