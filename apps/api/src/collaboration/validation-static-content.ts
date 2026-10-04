import { z } from 'zod';
import {
  RepositoryPathSchema,
  StaticClassSchema,
  StaticStatusSchema,
  redactSecrets,
} from '@codelens/shared';
import {
  STATIC_IDENTITY,
  STATIC_BOUNDS,
  staticInputDigest,
  type StaticFile,
} from '@codelens/static-analysis/dist/validation-static';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const result = z
  .object({
    status: StaticStatusSchema,
    reason: z
      .string()
      .max(64)
      .regex(/^[A-Z_]+$/)
      .nullable(),
    inputDigest: digest,
    identity: z
      .object({
        rulesetVersion: z.literal(STATIC_IDENTITY.rulesetVersion),
        fingerprintVersion: z.literal(STATIC_IDENTITY.fingerprintVersion),
        rulesetDigest: z.literal(STATIC_IDENTITY.rulesetDigest),
        configurationDigest: z.literal(STATIC_IDENTITY.configurationDigest),
      })
      .strict(),
    findings: z
      .array(
        z
          .object({
            analyzer: z.enum(['PATTERN_SCAN', 'SECRET_SCAN']),
            ruleId: z
              .string()
              .max(120)
              .regex(/^[a-zA-Z0-9/_-]+$/),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
            category: z
              .string()
              .max(40)
              .regex(/^[A-Z_]+$/),
            path: RepositoryPathSchema,
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            message: z.string().max(STATIC_BOUNDS.message),
            occurrenceFingerprint: digest,
            relevantDigest: digest,
            findingDigest: digest,
            classification: StaticClassSchema,
            comparability: z
              .string()
              .max(64)
              .regex(/^[A-Z_]+$/),
            counterpartDigest: digest.nullable(),
            diffRelation: z.enum(['EDITED_RANGE', 'CHANGED_FILE', 'UNCHANGED_FILE']),
          })
          .strict(),
      )
      .max(STATIC_BOUNDS.findings),
  })
  .strict();
export function verifyStaticResults(
  raw: unknown,
  sources: Record<'ORIGINAL' | 'PATCHED', StaticFile[]>,
) {
  const parsed = z.object({ ORIGINAL: result, PATCHED: result }).strict().parse(raw);
  for (const side of ['ORIGINAL', 'PATCHED'] as const) {
    const r = parsed[side];
    if (
      r.inputDigest !== staticInputDigest(sources[side]) ||
      (r.status !== 'COMPLETE' && r.findings.length)
    )
      throw new Error('STATIC_BINDING_REJECTED');
    for (const f of r.findings) {
      const file = sources[side].find((p) => p.path === f.path);
      if (
        !file ||
        f.endLine < f.startLine ||
        f.endLine > file.content.split('\n').length ||
        redactSecrets(f.message).redacted !== f.message ||
        redactSecrets(f.path).redacted !== f.path
      )
        throw new Error('STATIC_FINDING_REJECTED');
    }
  }
  return parsed;
}
