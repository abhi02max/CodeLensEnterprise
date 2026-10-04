import { expect, it } from 'vitest';
import { StaticFindingsQuerySchema } from '@codelens/shared';
import {
  analyzeStaticSource,
  compareStaticOccurrences,
} from '@codelens/static-analysis/dist/validation-static';
import { verifyStaticResults } from './validation-static-content';
const sources = {
  ORIGINAL: [{ path: 'src/a.ts', content: 'eval(input);' }],
  PATCHED: [{ path: 'src/a.ts', content: 'eval(input);' }],
};
const results = () =>
  compareStaticOccurrences(
    analyzeStaticSource(sources.ORIGINAL, 'ORIGINAL', []),
    analyzeStaticSource(sources.PATCHED, 'PATCHED', []),
    [],
  );
it('accepts bound normalized paired findings', () => {
  expect(verifyStaticResults(results(), sources).ORIGINAL.findings.length).toBe(1);
});
it.each(['inputDigest', 'identity', 'findings'] as const)(
  'rejects malformed or unbound %s',
  (key) => {
    const r = results();
    if (key === 'inputDigest') r.ORIGINAL.inputDigest = 'a'.repeat(64);
    else if (key === 'identity')
      r.ORIGINAL.identity = { ...r.ORIGINAL.identity, configurationDigest: 'a'.repeat(64) };
    else r.ORIGINAL.findings[0]!.endLine = 99;
    expect(() => verifyStaticResults(r, sources)).toThrow();
  },
);
it('rejects a secret-bearing message even from internal worker output', () => {
  const r = results();
  r.ORIGINAL.findings[0]!.message = 'ghp_' + 'K9q7Bm2Nj6Rx8Vz4Cs1De5Fg3Hu0Wp6Yt8Aa';
  expect(() => verifyStaticResults(r, sources)).toThrow();
});
it('rejects external executable/config/scope controls and bounds readback', () => {
  for (const extra of ['command', 'environment', 'organizationId', 'ruleFile', 'config', 'network'])
    expect(StaticFindingsQuerySchema.safeParse({ [extra]: 'unsafe' }).success).toBe(false);
  expect(StaticFindingsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  expect(StaticFindingsQuerySchema.safeParse({ afterId: 'foreign-invalid' }).success).toBe(false);
  expect(
    StaticFindingsQuerySchema.parse({ side: 'ORIGINAL', classification: 'CHANGED', limit: 1 }),
  ).toMatchObject({ limit: 1 });
});
