import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PatchIntentSchema } from '@codelens/shared';
import { snapshotDigest, type ExactSnapshot } from '@codelens/github/dist/exact-git-snapshot';
import { validateExactGitPath } from '@codelens/github/dist/exact-git-file';
import {
  canonicalPatch,
  materializePatchFile,
  normalizePatch,
  patchHash,
  PatchCoreError,
} from './patch';

export const MATERIALIZATION_LIMITS = Object.freeze({
  inputBytes: 24 * 1024 * 1024,
  outputBytes: 256 * 1024,
  candidateBytes: 20 * 1024 * 1024,
  deadlineMs: 150000,
});
const sha = z.string().regex(/^[a-f0-9]{40}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MaterializationRequestSchema = z
  .object({
    version: z.literal(1),
    snapshot: z
      .object({
        version: z.literal(1),
        repository: z
          .string()
          .max(256)
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        revision: sha,
        digest: hash,
        files: z
          .array(
            z
              .object({
                path: z.string().max(500),
                blobSha: sha,
                content: z.string().max(1024 * 1024),
                contentHash: hash,
                byteLength: z
                  .number()
                  .int()
                  .min(0)
                  .max(1024 * 1024),
              })
              .strict(),
          )
          .max(1000),
      })
      .strict(),
    proposal: z
      .object({ headSha: sha, baseSha: sha, digest: hash, intent: PatchIntentSchema })
      .strict(),
  })
  .strict();
export type MaterializationRequest = z.infer<typeof MaterializationRequestSchema>;
export const MaterializationResultSchema = z
  .object({
    version: z.literal(1),
    snapshotDigest: hash,
    proposalDigest: hash,
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            contentHash: hash,
            byteLength: z.number().int().min(0).max(MATERIALIZATION_LIMITS.candidateBytes),
          })
          .strict(),
      )
      .max(1000),
    digest: hash,
  })
  .strict();
function reject(): never {
  throw new PatchCoreError('Materialization preconditions failed.');
}

/** Independently verify every source byte; no mutable PR lookup or executable intent. */
export function materializeCandidate(raw: unknown) {
  const request = MaterializationRequestSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(request)) > MATERIALIZATION_LIMITS.inputBytes) reject();
  const snapshot: ExactSnapshot = request.snapshot;
  if (
    snapshot.revision !== request.proposal.headSha ||
    snapshotDigest(snapshot) !== snapshot.digest
  )
    reject();
  let total = 0,
    previous = '';
  const components = new Map<string, { path: string; file: boolean }>();
  for (const file of snapshot.files) {
    validateExactGitPath(file.path);
    if (previous && previous >= file.path) reject();
    previous = file.path;
    const parts = file.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const path = parts.slice(0, n).join('/'),
        key = path.toLowerCase(),
        isFile = n === parts.length;
      const existing = components.get(key);
      if (existing && (existing.path !== path || existing.file || isFile)) reject();
      components.set(key, { path, file: isFile });
    }
    if (components.size > 2000) reject();
    const bytes = Buffer.from(file.content, 'utf8');
    if (
      bytes.toString('utf8') !== file.content ||
      file.content.includes('\0') ||
      bytes.length !== file.byteLength ||
      bytes.length > 1024 * 1024 ||
      patchHash(file.content) !== file.contentHash ||
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !==
        file.blobSha
    )
      reject();
    total += bytes.length;
    if (total > 16 * 1024 * 1024) reject();
  }
  const intent = normalizePatch(request.proposal.intent);
  const candidates = new Map(snapshot.files.map((file) => [file.path, file.content]));
  const patchFiles = intent.files.map((file) => {
    const source = snapshot.files.find((source) => source.path === file.path);
    if (!source) return reject();
    const result = materializePatchFile(file, {
      revision: snapshot.revision,
      path: source.path,
      kind: 'REGULAR_FILE',
      mode: '100644',
      objectSha: source.blobSha,
      content: source.content,
      contentHash: source.contentHash,
      components: [],
      modificationEligible: true,
    });
    candidates.set(source.path, result.content);
    return result.file;
  });
  if (
    canonicalPatch(
      { headSha: request.proposal.headSha, baseSha: request.proposal.baseSha },
      intent,
      patchFiles,
    ).digest !== request.proposal.digest
  )
    reject();
  total = 0;
  const files = snapshot.files.map((source) => {
    const content = candidates.get(source.path)!;
    const byteLength = Buffer.byteLength(content);
    total += byteLength;
    return { path: source.path, content, contentHash: patchHash(content), byteLength };
  });
  if (total > MATERIALIZATION_LIMITS.candidateBytes) reject();
  const manifest = {
    version: 1 as const,
    snapshotDigest: snapshot.digest,
    proposalDigest: request.proposal.digest,
    files: files.map(({ path, contentHash, byteLength }) => ({ path, contentHash, byteLength })),
  };
  const result = { ...manifest, digest: patchHash(JSON.stringify(manifest)) };
  if (Buffer.byteLength(JSON.stringify(result)) > MATERIALIZATION_LIMITS.outputBytes) reject();
  return { originals: snapshot.files, candidates: files, result };
}
