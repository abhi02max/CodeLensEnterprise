import { describe, expect, it } from 'vitest';
import {
  analyzeStaticSource,
  compareStaticOccurrences,
  STATIC_BOUNDS,
  STATIC_IDENTITY,
  staticSourceBound,
  type StaticEdits,
} from './validation-static';

const file = (content: string, path = 'src/a.ts') => [{ path, content }];
const pair = (old: string, next: string, edits: StaticEdits = []) =>
  compareStaticOccurrences(
    analyzeStaticSource(file(old), 'ORIGINAL', edits),
    analyzeStaticSource(file(next), 'PATCHED', edits),
    edits,
  );
const classes = (p: ReturnType<typeof pair>, side: 'ORIGINAL' | 'PATCHED') =>
  p[side].findings.map((f) => f.classification);
it('complete zero/zero is distinct from unavailable analysis', () => {
  const r = pair('const x=1;', 'const x=2;');
  expect(r.ORIGINAL.status).toBe('COMPLETE');
  expect(r.ORIGINAL.findings).toEqual([]);
  expect(analyzeStaticSource(file('x'.repeat(2001)), 'ORIGINAL', []).status).toBe('UNSUPPORTED');
});
it('unique occurrence survives line movement without false resolved/introduced', () => {
  const r = pair('eval(input);', '\n\nconst a=1;\neval(input);', [
    {
      path: 'src/a.ts',
      edits: [{ startLine: 1, endLine: 1, replacement: '\n\nconst a=1;\neval(input);' }],
    },
  ]);
  expect(classes(r, 'ORIGINAL')).toEqual(['UNCHANGED']);
  expect(r.PATCHED.findings[0]?.startLine).toBe(4);
  expect(r.ORIGINAL.findings[0]?.occurrenceFingerprint).toBe(
    r.PATCHED.findings[0]?.occurrenceFingerprint,
  );
});
it('reports resolved and introduced only against complete other side', () => {
  expect(classes(pair('eval(input);', 'const safe=1;'), 'ORIGINAL')).toEqual(['RESOLVED']);
  expect(classes(pair('const safe=1;', 'eval(input);'), 'PATCHED')).toEqual(['INTRODUCED']);
});
it('separates exact resolved/introduced edits from unrelated ambiguous same-rule occurrences', () => {
  const old = 'eval(remove);\nconst introduce=1;\neval(duplicate);\neval(duplicate);';
  const next = '// shift\nconst remove=1;\neval(introduce);\neval(duplicate);\neval(duplicate);';
  const r = pair(old, next, [
    {
      path: 'src/a.ts',
      edits: [
        { startLine: 1, endLine: 1, replacement: '// shift\nconst remove=1;' },
        { startLine: 2, endLine: 2, replacement: 'eval(introduce);' },
      ],
    },
  ]);
  // Unequal replacement size leaves the removed occurrence conservatively ambiguous.
  expect(classes(r, 'ORIGINAL')).toEqual(['INCOMPARABLE', 'INCOMPARABLE', 'INCOMPARABLE']);
  expect(classes(r, 'PATCHED')).toEqual(['INTRODUCED', 'INCOMPARABLE', 'INCOMPARABLE']);
  const exact = pair(old, 'const remove=1;\neval(introduce);\neval(duplicate);\neval(duplicate);', [
    {
      path: 'src/a.ts',
      edits: [
        { startLine: 1, endLine: 1, replacement: 'const remove=1;' },
        { startLine: 2, endLine: 2, replacement: 'eval(introduce);' },
      ],
    },
  ]);
  expect(classes(exact, 'ORIGINAL')).toEqual(['RESOLVED', 'INCOMPARABLE', 'INCOMPARABLE']);
  expect(classes(exact, 'PATCHED')).toEqual(['INTRODUCED', 'INCOMPARABLE', 'INCOMPARABLE']);
});
it('unique disjoint exact range mapping can establish changed relevant content', () => {
  const r = pair('eval(a);', 'eval(b);', [
    { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 1, replacement: 'eval(b);' }] },
  ]);
  expect(classes(r, 'ORIGINAL')).toEqual(['CHANGED']);
  expect(r.ORIGINAL.findings[0]?.counterpartDigest).toBe(r.PATCHED.findings[0]?.findingDigest);
});
it('severity/relevant evidence changes are not reported unchanged', () => {
  const a = analyzeStaticSource(file('eval(a);'), 'ORIGINAL', []),
    b = structuredClone(a);
  b.findings[0]!.severity = 'HIGH';
  b.findings[0]!.relevantDigest = 'a'.repeat(64);
  expect(compareStaticOccurrences(a, b, []).ORIGINAL.findings[0]?.classification).toBe('CHANGED');
});
it('different constructs of the same rule are retained as individual occurrences', () => {
  const r = pair('eval(a);\neval(b);', 'eval(a);\neval(b);');
  expect(classes(r, 'ORIGINAL')).toEqual(['UNCHANGED', 'UNCHANGED']);
  expect(new Set(r.ORIGINAL.findings.map((f) => f.occurrenceFingerprint)).size).toBe(2);
});
it('identical-looking occurrences at different structural locations are conservatively incomparable', () => {
  const source = 'function a(){\neval(input);\n}\nfunction b(){\neval(input);\n}';
  const r = pair(source, source);
  expect(classes(r, 'ORIGINAL')).toEqual(['INCOMPARABLE', 'INCOMPARABLE']);
});
it('removed/moved path is not inferred to be a rename', () => {
  const a = analyzeStaticSource(file('eval(input);'), 'ORIGINAL', []),
    b = analyzeStaticSource(file('eval(input);', 'src/b.ts'), 'PATCHED', []);
  const r = compareStaticOccurrences(a, b, []);
  expect(classes(r, 'ORIGINAL')).toEqual(['RESOLVED']);
  expect(classes(r, 'PATCHED')).toEqual(['INTRODUCED']);
});
it('diff awareness keeps edited, changed-file outside-range and unchanged-file findings', () => {
  const edits = [
    { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 1, replacement: 'eval(next);' }] },
  ];
  const r = analyzeStaticSource(
    [...file('eval(input);\neval(other);'), ...file('eval(third);', 'src/c.ts')],
    'ORIGINAL',
    edits,
  );
  expect(r.findings.map((f) => f.diffRelation)).toEqual([
    'EDITED_RANGE',
    'CHANGED_FILE',
    'UNCHANGED_FILE',
  ]);
});
it.each([
  '../x.ts',
  '%2e%2e/x.ts',
  '/x.ts',
  'C:/x.ts',
  '\\\\host\\x',
  '.git/config',
  'a/../b.ts',
  'a//b.ts',
  'a\0b.ts',
])('rejects source path %s', (path) => {
  expect(staticSourceBound(file('eval(input);', path))).toBe('PATH_REJECTED');
});
it('rejects duplicate/case collision, binary and invalid UTF8 text', () => {
  expect(staticSourceBound([...file('a'), ...file('b')])).toBe('PATH_REJECTED');
  expect(staticSourceBound([...file('a', 'src/A.ts'), ...file('b', 'src/a.ts')])).toBe(
    'PATH_REJECTED',
  );
  expect(staticSourceBound(file('a\0b'))).toBe('TEXT_REJECTED');
  expect(staticSourceBound(file('\ud800'))).toBe('TEXT_REJECTED');
});
it('enforces repository/file/count/long-line limits without clean-result claims', () => {
  expect(staticSourceBound(file(' '.repeat(STATIC_BOUNDS.fileBytes + 1)))).toBe('FILE_BYTE_BOUND');
  expect(
    staticSourceBound(Array.from({ length: 101 }, (_, i) => ({ path: `${i}.txt`, content: '' }))),
  ).toBe('FILE_COUNT_BOUND');
  expect(
    staticSourceBound(
      Array.from({ length: 17 }, (_, i) => ({
        path: `${i}.txt`,
        content: ('x'.repeat(1023) + '\n').repeat(128),
      })),
    ),
  ).toBe('REPOSITORY_BYTE_BOUND');
});
it('finding cap is explicit truncated, never partial clean coverage', () => {
  const r = analyzeStaticSource(file('eval(x);\n'.repeat(501)), 'ORIGINAL', []);
  expect(r.status).toBe('TRUNCATED');
  expect(r.findings).toEqual([]);
});
it.each(['rulesetDigest', 'configurationDigest', 'fingerprintVersion'] as const)(
  'identity mismatch %s fails comparison closed',
  (key) => {
    const a = analyzeStaticSource(file('eval(a);'), 'ORIGINAL', []),
      b = structuredClone(a);
    (b.identity as Record<string, string>)[key] = 'different';
    expect(compareStaticOccurrences(a, b, []).ORIGINAL.findings[0]?.classification).toBe(
      'INCOMPARABLE',
    );
  },
);
it('failure/truncation on either side never establishes resolved', () => {
  const a = analyzeStaticSource(file('eval(a);'), 'ORIGINAL', []),
    b = { ...a, status: 'FAILED' as const, findings: [] };
  expect(compareStaticOccurrences(a, b, []).ORIGINAL.findings[0]?.classification).toBe(
    'INCOMPARABLE',
  );
});
it('secret data and masked fragments are withheld from messages/fingerprints; changed secret cannot claim unchanged', () => {
  const secret = 'ghp_' + 'K9q7Bm2Nj6Rx8Vz4Cs1De5Fg3Hu0Wp6Yt8Aa';
  const a = `const credential="${secret}";`;
  const r = pair(a, a);
  expect(r.ORIGINAL.findings.some((f) => f.analyzer === 'SECRET_SCAN')).toBe(true);
  expect(classes(r, 'ORIGINAL')).toEqual(['INCOMPARABLE']);
  const persisted = JSON.stringify(r);
  expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain('ghp');
  expect(persisted).not.toContain('8Aa');
  const b = pair(a, `const credential="${secret.replace('K9q', 'A8v')}";`);
  expect(b.ORIGINAL.findings[0]?.occurrenceFingerprint).toBe(
    r.ORIGINAL.findings[0]?.occurrenceFingerprint,
  );
});
it('same input has deterministic digests without wall time in identity', () => {
  expect(pair('eval(a);', 'eval(a);')).toEqual(pair('eval(a);', 'eval(a);'));
  expect(STATIC_IDENTITY.rulesetDigest).toMatch(/^[a-f0-9]{64}$/);
});
it('does not collapse internal string whitespace or truncate matched constructs', () => {
  const edits = [
    { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 1, replacement: 'eval("a b");' }] },
  ];
  expect(classes(pair('eval("a  b");', 'eval("a b");', edits), 'ORIGINAL')).toEqual(['CHANGED']);
  const prefix = 'eval("' + 'x'.repeat(1200);
  const a = prefix + 'A");',
    b = prefix + 'B");';
  expect(
    pair(a, b, [{ path: 'src/a.ts', edits: [{ startLine: 1, endLine: 1, replacement: b }] }])
      .ORIGINAL.findings[0]?.classification,
  ).toBe('CHANGED');
});
it('excludes the diff-removal guard rule and does not attribute existing TODOs to this patch', () => {
  const result = analyzeStaticSource(
    file('throw new Error("stop");\n// TODO handle this\n'),
    'ORIGINAL',
    [],
  );
  expect(result.findings.map((f) => f.ruleId)).toEqual(['codelens/todo-in-sensitive-path']);
  expect(result.findings[0]?.message).not.toContain('introduced');
});
it('redaction cannot produce false unchanged for a secret-bearing non-secret rule', () => {
  const token = 'ghp_' + 'K9q7Bm2Nj6Rx8Vz4Cs1De5Fg3Hu0Wp6Yt8Aa';
  const a = `eval("${token}");`,
    b = `eval("${token.replace('K9q', 'A8v')}");`;
  const result = pair(a, b, [
    { path: 'src/a.ts', edits: [{ startLine: 1, endLine: 1, replacement: b }] },
  ]);
  expect(result.ORIGINAL.findings.every((f) => f.classification === 'INCOMPARABLE')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
});
