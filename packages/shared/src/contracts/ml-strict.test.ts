import { describe, expect, it } from 'vitest';
import { emptyPrFeatures } from '../ml-features';
import {
  authoritativeRiskBand,
  StrictRiskFeaturesSchema,
  StrictRiskObservationSchema,
  StrictRiskPairRequestSchema,
  ML_CONTRACT,
  ML_FEATURE_SCHEMA,
} from './ml-strict';

describe('strict risk contract', () => {
  const features = { ...emptyPrFeatures(), files_changed: 1, lines_added: 4 };
  it('retains exactly the existing 15 features', () => {
    expect(Object.keys(StrictRiskFeaturesSchema.parse(features))).toEqual(Object.keys(features));
    expect(Object.keys(features)).toHaveLength(15);
  });
  for (const key of Object.keys(features))
    it(`requires ${key}`, () => {
      const input = { ...features } as Record<string, unknown>;
      delete input[key];
      expect(StrictRiskFeaturesSchema.safeParse(input).success).toBe(false);
    });
  for (const value of [NaN, Infinity, -Infinity, '1', true, null, -1, 1000001])
    it(`rejects invalid counts ${String(value)}`, () => {
      expect(StrictRiskFeaturesSchema.safeParse({ ...features, lines_added: value }).success).toBe(
        false,
      );
    });
  it('rejects extras, text bounds, contradictory changes and precision', () => {
    for (const input of [
      { ...features, command: 'exec' },
      { ...features, title_text: 'x'.repeat(301) },
      { ...features, commit_text: 'x'.repeat(2001) },
      { ...features, files_changed: 0 },
      { ...features, complexity_delta: 0.0001 },
    ])
      expect(StrictRiskFeaturesSchema.safeParse(input).success).toBe(false);
  });
  it('normalizes NFC and ASCII whitespace without defaulting missing fields', () => {
    expect(
      StrictRiskFeaturesSchema.parse({ ...features, title_text: ' e\u0301\n x ' }).title_text,
    ).toBe('é x');
  });
  it('rejects unsupported versions and authoritative scope injection', () => {
    const input = {
      contractVersion: ML_CONTRACT,
      featureSchemaVersion: ML_FEATURE_SCHEMA,
      original: features,
      patched: features,
    };
    expect(StrictRiskPairRequestSchema.safeParse(input).success).toBe(true);
    expect(StrictRiskPairRequestSchema.safeParse({ ...input, contractVersion: 'v2' }).success).toBe(
      false,
    );
    expect(StrictRiskPairRequestSchema.safeParse({ ...input, modelUrl: 'arbitrary' }).success).toBe(
      false,
    );
  });
  for (const [score, confidence, band] of [
    [34.9, 1, 'LOW'],
    [35, 1, 'MEDIUM'],
    [59.9, 1, 'MEDIUM'],
    [60, 1, 'HIGH'],
    [84.9, 1, 'HIGH'],
    [85, 0.35, 'CRITICAL'],
    [85, 0.349, 'HIGH'],
  ] as const)
    it(`validates boundary ${score}/${confidence}`, () => {
      expect(authoritativeRiskBand(score, confidence)).toBe(band);
    });
  it('represents an available real zero separately from a missing observation', () => {
    expect(
      StrictRiskObservationSchema.parse({
        featureDigest: 'a'.repeat(64),
        scoreTenths: 0,
        probabilityMicros: 0,
        confidenceMillis: 500,
        band: 'LOW',
        warnings: [],
      }).scoreTenths,
    ).toBe(0);
    expect(StrictRiskObservationSchema.safeParse({}).success).toBe(false);
  });
});
