import { describe, expect, it } from 'vitest';
import { diffRevision, patchAvailability } from './diff-provenance';

const file = {
  patch: '@@ -1 +1 @@\n-old\n+new',
  patchTruncated: false,
  additions: 1,
  deletions: 1,
};
const row = {
  baseSha: 'b',
  headSha: 'h',
  changedFiles: 1,
  diffBaseSha: 'b',
  diffHeadSha: 'h',
  diffMergeBaseSha: 'm',
  diffVerifiedAt: new Date(),
  files: [file],
};
describe('published diff read semantics', () => {
  it('exposes a matching revision independently of current metadata', () => {
    expect(diffRevision(row)).toEqual({
      provenance: 'VERIFIED',
      baseSha: 'b',
      headSha: 'h',
      mergeBaseSha: 'm',
      fileSet: 'COMPLETE',
      patches: 'COMPLETE',
    });
    expect(diffRevision({ ...row, headSha: 'other' }).provenance).toBe('UNVERIFIED');
  });
  it('does not manufacture provenance for historical rows', () => {
    expect(
      diffRevision({
        ...row,
        diffBaseSha: null,
        diffHeadSha: null,
        diffMergeBaseSha: null,
        diffVerifiedAt: null,
      }),
    ).toMatchObject({
      provenance: 'UNVERIFIED',
      baseSha: null,
      headSha: null,
      patches: 'UNVERIFIED',
      fileSet: 'UNVERIFIED',
    });
  });
  it('distinguishes unavailable patches without asserting binary', () => {
    expect(patchAvailability({ ...file, patch: null }, true)).toBe('UNAVAILABLE');
    expect(diffRevision({ ...row, files: [{ ...file, patch: null }] }).patches).toBe('UNAVAILABLE');
  });
  it('does not call a prefix, malformed hunk or incomplete file set complete', () => {
    expect(patchAvailability({ ...file, patchTruncated: true }, true)).toBe('PARTIAL');
    expect(patchAvailability({ ...file, patch: '@@ -1,2 +1,2 @@\n-old\n+new' }, true)).toBe(
      'PARTIAL',
    );
    expect(patchAvailability({ ...file, additions: 2 }, true)).toBe('PARTIAL');
    expect(diffRevision({ ...row, changedFiles: 301 }).fileSet).toBe('PARTIAL');
  });
  it('represents a verified zero-file diff without fabricating missing content', () => {
    expect(diffRevision({ ...row, files: [], changedFiles: 0 })).toMatchObject({
      provenance: 'VERIFIED',
      fileSet: 'COMPLETE',
      patches: 'COMPLETE',
    });
  });
});
