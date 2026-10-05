import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyPrFeatures, ML_CONTRACT, ML_FEATURE_SCHEMA, ML_BAND_POLICY } from '@codelens/shared';
import { requestStrictRiskPair, riskDigest } from './strict-risk-client';
import { MlService } from './ml.service';
import type { AppConfigService } from '../config/app-config.service';

const features = { ...emptyPrFeatures(), files_changed: 1, lines_added: 4 };
const input = {
  contractVersion: ML_CONTRACT,
  featureSchemaVersion: ML_FEATURE_SCHEMA,
  original: features,
  patched: features,
};
const observation = {
  featureDigest: riskDigest(features),
  scoreTenths: 910,
  probabilityMicros: 910000,
  confidenceMillis: 300,
  band: 'HIGH',
  warnings: ['LOW_CONFIDENCE_CAP'],
};
function result() {
  const payload = {
    status: 'AVAILABLE',
    identity: {
      manifestVersion: 1,
      contractVersion: ML_CONTRACT,
      featureSchemaVersion: ML_FEATURE_SCHEMA,
      modelName: 'xgboost',
      modelVersion: 'bootstrap-v1',
      isBaseline: true,
      artifactDigest: 'a'.repeat(64),
      preprocessingDigest: 'b'.repeat(64),
      calibrationDigest: 'c'.repeat(64),
      inferenceImplementation: 'codelens-risk-inference-impl-v1',
      bandPolicyVersion: ML_BAND_POLICY,
      bundleScope: 'SHARED',
      organizationId: null,
      runtimeIdentity: 'local-test',
      implementationDigest: 'd'.repeat(64),
      runtimeDigest: 'e'.repeat(64),
    },
    original: observation,
    patched: observation,
  };
  return { ...payload, resultDigest: riskDigest(payload) };
}
afterEach(() => vi.unstubAllGlobals());
describe('strict risk HTTP client', () => {
  it('retains an available zero without confusing it with unavailable', async () => {
    const payload = result();
    const zero = {
      ...observation,
      scoreTenths: 0,
      probabilityMicros: 0,
      confidenceMillis: 500,
      band: 'LOW',
      warnings: [],
    };
    const available = {
      status: payload.status,
      identity: payload.identity,
      original: zero,
      patched: zero,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...available, resultDigest: riskDigest(available) })),
    );
    const response = await requestStrictRiskPair('http://internal', input, 1000);
    expect(response).toMatchObject({ status: 'AVAILABLE', original: { scoreTenths: 0 } });
  });
  it('preserves precision and authoritative capped band', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result())),
    );
    expect(await requestStrictRiskPair('http://internal', input, 1000, 'a'.repeat(64))).toEqual(
      result(),
    );
  });
  it('rejects artifact mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result())),
    );
    expect(
      await requestStrictRiskPair('http://internal', input, 1000, 'd'.repeat(64)),
    ).toMatchObject({ status: 'UNAVAILABLE', category: 'IDENTITY_MISMATCH' });
  });
  it('rejects altered feature/result/implementation identities', async () => {
    for (const payload of [
      { ...result(), resultDigest: 'f'.repeat(64) },
      { ...result(), original: { ...observation, featureDigest: 'f'.repeat(64) } },
      { ...result(), identity: { ...result().identity, inferenceImplementation: 'unknown' } },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(payload)),
      );
      expect(await requestStrictRiskPair('http://internal', input, 1000)).toMatchObject({
        status: 'UNAVAILABLE',
      });
    }
  });
  it('bounds streaming responses and sanitizes raw errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(16385))),
    );
    expect(await requestStrictRiskPair('http://internal', input, 1000)).toMatchObject({
      category: 'RESPONSE_BOUND',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('SECRET_MARKER /operator/path');
      }),
    );
    expect(await requestStrictRiskPair('http://internal', input, 1000)).toEqual({
      status: 'UNAVAILABLE',
      contractVersion: ML_CONTRACT,
      category: 'SERVICE_UNAVAILABLE',
    });
  });
  it('aborts a hung transport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('private')));
          }),
      ),
    );
    expect(await requestStrictRiskPair('http://internal', input, 100)).toMatchObject({
      category: 'TIMEOUT',
    });
  });
  it('does not fabricate a score on unavailable output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { status: 'UNAVAILABLE', contractVersion: ML_CONTRACT, category: 'ARTIFACT_UNAVAILABLE' },
          { status: 503 },
        ),
      ),
    );
    expect(await requestStrictRiskPair('http://internal', input, 1000)).not.toHaveProperty(
      'original',
    );
  });
  it('keeps legacy ReviewRun inference and the service band', async () => {
    const service = new MlService({
      ml: { url: 'http://internal', timeoutMs: 1000 },
    } as AppConfigService);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          risk_score: 91.1,
          risk_level: 'HIGH',
          probability: 0.911,
          confidence: 0.3,
          top_risk_reasons: [],
          model_name: 'xgboost',
          model_version: 'bootstrap-v1',
          is_baseline: true,
          warnings: [],
        }),
      ),
    );
    const risk = await service.predictRisk({ features });
    expect(risk).toMatchObject({
      status: 'OK',
      prediction: { risk_score: 91.1, risk_level: 'HIGH' },
    });
  });
});
