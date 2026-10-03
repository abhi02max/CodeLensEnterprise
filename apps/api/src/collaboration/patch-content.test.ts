import { describe, it, expect } from 'vitest';
import type { ExactGitFile } from '@codelens/github';
import { PatchIntentSchema } from '@codelens/shared';
import { canonicalPatch, constructPatchFile, normalizePatch, patchHash } from './patch-content';
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40),
  blob = 'c'.repeat(40);
const source: ExactGitFile = {
  revision: headSha,
  path: 'src/a.ts',
  kind: 'REGULAR_FILE',
  mode: '100644',
  objectSha: blob,
  components: [],
  content: 'one\ntwo\nthree\n',
  contentHash: patchHash('one\ntwo\nthree\n'),
  modificationEligible: true,
};
const intent = () => ({
  summary: 'Proposed change',
  rationale: 'Observed context',
  limitations: 'Not applied or tested',
  files: [
    {
      operation: 'MODIFY' as const,
      path: source.path,
      expectedBlobSha: blob,
      edits: [{ startLine: 2, endLine: 2, expectedText: 'two', replacement: 'new' }],
      evidenceIds: ['e1'],
    },
  ],
});
describe('immutable in-memory patch construction', () => {
  it('generates canonical server diff and leaves input source untouched', () => {
    const result = constructPatchFile(intent().files[0]!, source);
    expect(result.newContentHash).toBe(patchHash('one\nnew\nthree\n'));
    expect(result.diff).toContain('-two\n+new');
    expect(result.changedLines).toBe(2);
    expect(source.content).toBe('one\ntwo\nthree\n');
  });
  it('applies multiple ranges using original offsets and preserves newline semantics', () => {
    const file = intent().files[0]!;
    file.edits = [
      { startLine: 1, endLine: 1, expectedText: 'one', replacement: 'first\nextra' },
      { startLine: 3, endLine: 3, expectedText: 'three', replacement: 'last' },
    ];
    expect(constructPatchFile(file, source).newContentHash).toBe(
      patchHash('first\nextra\ntwo\nlast\n'),
    );
  });
  it('retains CRLF exactly rather than fuzzy normalization', () => {
    const file = intent().files[0]!;
    file.edits[0]!.expectedText = 'two\r';
    file.edits[0]!.replacement = 'new\r';
    expect(constructPatchFile(file, { ...source, content: 'one\r\ntwo\r\n' }).newContentHash).toBe(
      patchHash('one\r\nnew\r\n'),
    );
  });
  it('has deterministic normalized multi-file digest', () => {
    const a = intent();
    a.files.push({ ...a.files[0]!, path: 'src/b.ts' });
    const b = { ...a, files: [...a.files].reverse() };
    const digest = (raw: typeof a) => {
      const normalized = normalizePatch(raw);
      return canonicalPatch(
        { headSha, baseSha },
        normalized,
        normalized.files.map((f) => constructPatchFile(f, { ...source, path: f.path })),
      ).digest;
    };
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['SYMLINK', 'SUBMODULE', 'DIRECTORY', 'UNSUPPORTED'] as const)(
    'rejects %s objects',
    (kind) => {
      expect(() =>
        constructPatchFile(intent().files[0]!, { ...source, kind, modificationEligible: false }),
      ).toThrow();
    },
  );
  it.each(['100755', '120000', '160000', '040000', '100664'])(
    'rejects mode %s even with falsely eligible input',
    (mode) => {
      expect(() => constructPatchFile(intent().files[0]!, { ...source, mode })).toThrow();
    },
  );
  it.each([
    { content: null },
    { contentHash: null },
    { objectSha: 'd'.repeat(40) },
    { path: 'other.ts' },
    { modificationEligible: false },
  ])('rejects failed exact precondition %j', (change) => {
    expect(() => constructPatchFile(intent().files[0]!, { ...source, ...change })).toThrow();
  });
  it.each([
    { startLine: 4, endLine: 4 },
    { startLine: 2, endLine: 1 },
    { expectedText: 'wrong' },
    { replacement: 'two' },
  ])('rejects invalid edit %j', (change) => {
    const file = intent().files[0]!;
    file.edits[0] = { ...file.edits[0]!, ...change };
    expect(() => constructPatchFile(file, source)).toThrow();
  });
  it('rejects overlap without applying partial data', () => {
    const file = intent().files[0]!;
    file.edits.push({ ...file.edits[0]! });
    expect(() => constructPatchFile(file, source)).toThrow();
  });
  it.each(['binary\0replacement', 'invalid\ud800'])(
    'rejects non-text replacement',
    (replacement) => {
      const file = intent().files[0]!;
      file.edits[0]!.replacement = replacement;
      expect(() => constructPatchFile(file, source)).toThrow();
    },
  );
  it('rejects over 500 changed lines', () => {
    const raw = intent();
    const text = Array.from({ length: 251 }, () => 'old').join('\n');
    raw.files[0]!.edits = [
      {
        startLine: 1,
        endLine: 251,
        expectedText: text,
        replacement: text.replaceAll('old', 'new'),
      },
    ];
    expect(() => constructPatchFile(raw.files[0]!, { ...source, content: text })).toThrow();
  });
  it('rejects generated diff exceeding bytes even when intent fits', () => {
    const raw = intent();
    const lines = ['x'.repeat(30000), 'two', 'y'.repeat(30000), 'z'.repeat(30000)].join('\n');
    const result = constructPatchFile(raw.files[0]!, { ...source, content: lines });
    expect(() => canonicalPatch({ headSha, baseSha }, raw, [result])).toThrow();
  });
  it('enforces the changed-line budget across individually valid files', () => {
    const raw = intent();
    const text = Array(126).fill('old').join('\n');
    raw.files[0]!.edits = [
      {
        startLine: 1,
        endLine: 126,
        expectedText: text,
        replacement: text.replaceAll('old', 'new'),
      },
    ];
    raw.files.push({ ...raw.files[0]!, path: 'src/b.ts' });
    const files = raw.files.map((file) =>
      constructPatchFile(file, { ...source, path: file.path, content: text }),
    );
    expect(files.every((file) => file.changedLines === 252)).toBe(true);
    expect(() => canonicalPatch({ headSha, baseSha }, raw, files)).toThrow();
  });
});
describe('strict patch intent boundaries', () => {
  it.each(['../a', 'a/../b', '%2e%2e/a', '/absolute', 'C:/a', '\\\\host\\share', 'a\\b'])(
    'rejects path %s',
    (path) => {
      const raw = intent();
      raw.files[0]!.path = path;
      expect(PatchIntentSchema.safeParse(raw).success).toBe(false);
    },
  );
  it.each(['CREATE', 'DELETE', 'RENAME'])('rejects operation %s', (operation) => {
    const raw = intent();
    expect(
      PatchIntentSchema.safeParse({ ...raw, files: [{ ...raw.files[0], operation }] }).success,
    ).toBe(false);
  });
  it.each([
    'organizationId',
    'repositoryId',
    'command',
    'shell',
    'push',
    'accepted',
    'diff',
    'credential',
  ])('rejects injected field %s', (field) => {
    expect(PatchIntentSchema.safeParse({ ...intent(), [field]: 'untrusted' }).success).toBe(false);
  });
  it('rejects duplicate and case-colliding paths', () => {
    const raw = intent();
    raw.files.push({ ...raw.files[0]!, path: 'SRC/A.ts' });
    expect(PatchIntentSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects excessive files/replacement/evidence', () => {
    const raw = intent();
    expect(
      PatchIntentSchema.safeParse({
        ...raw,
        files: Array.from({ length: 11 }, (_, index) => ({
          ...raw.files[0]!,
          path: `src/file${index}.ts`,
        })),
      }).success,
    ).toBe(false);
    raw.files[0]!.edits[0]!.replacement = 'x'.repeat(8193);
    expect(PatchIntentSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects excess distinct evidence relationships', () => {
    const raw = intent();
    raw.files[0]!.evidenceIds = Array.from({ length: 17 }, (_, index) => `e${index}`);
    expect(PatchIntentSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects serialized intent over 64 KiB with individually bounded fields', () => {
    const raw = intent();
    const file = raw.files[0]!;
    raw.files = Array.from({ length: 5 }, (_, index) => ({
      ...file,
      path: `src/file${index}.ts`,
      edits: [
        { startLine: 1, endLine: 1, expectedText: 'x'.repeat(8192), replacement: 'y'.repeat(8192) },
      ],
    }));
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(65536);
    expect(PatchIntentSchema.safeParse(raw).success).toBe(false);
  });
});
