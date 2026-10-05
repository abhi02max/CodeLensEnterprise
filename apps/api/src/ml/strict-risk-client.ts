import { createHash } from 'node:crypto';
import {
  ML_CONTRACT,
  ML_REQUEST_BYTES,
  ML_RESPONSE_BYTES,
  StrictRiskPairRequestSchema,
  StrictRiskPairResponseSchema,
  type StrictRiskPairRequest,
  type StrictRiskPairResponse,
} from '@codelens/shared';

export function canonicalRiskJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRiskJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalRiskJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const riskDigest = (value: unknown) =>
  createHash('sha256').update(canonicalRiskJson(value)).digest('hex');

/** Internal only: no controller exposes caller-authored assessment features. */
export async function requestStrictRiskPair(
  baseUrl: string,
  input: StrictRiskPairRequest,
  timeoutMs: number,
  expectedArtifactDigest?: string,
): Promise<StrictRiskPairResponse> {
  const failure = (
    category:
      | 'INVALID_REQUEST'
      | 'REQUEST_BOUND'
      | 'TIMEOUT'
      | 'RESPONSE_BOUND'
      | 'RESPONSE_INVALID'
      | 'SERVICE_UNAVAILABLE'
      | 'IDENTITY_MISMATCH',
  ): StrictRiskPairResponse => ({ status: 'UNAVAILABLE', contractVersion: ML_CONTRACT, category });
  const parsed = StrictRiskPairRequestSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_REQUEST');
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body) > ML_REQUEST_BYTES) return failure('REQUEST_BOUND');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 100), 15000));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${baseUrl}/internal/risk/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!response.body) return failure('RESPONSE_INVALID');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ML_RESPONSE_BYTES) return failure('RESPONSE_BOUND');
      chunks.push(value);
    }
    const result = StrictRiskPairResponseSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    if (!result.success) return failure('RESPONSE_INVALID');
    if (result.data.status === 'UNAVAILABLE') return result.data;
    if (!response.ok) return failure('RESPONSE_INVALID');
    const { resultDigest, ...observation } = result.data;
    if (
      riskDigest(observation) !== resultDigest ||
      riskDigest(parsed.data.original) !== result.data.original.featureDigest ||
      riskDigest(parsed.data.patched) !== result.data.patched.featureDigest
    )
      return failure('RESPONSE_INVALID');
    if (
      (expectedArtifactDigest && result.data.identity.artifactDigest !== expectedArtifactDigest) ||
      (result.data.identity.bundleScope === 'ORGANIZATION' &&
        result.data.identity.organizationId !== parsed.data.organizationId)
    )
      return failure('IDENTITY_MISMATCH');
    return result.data;
  } catch {
    return failure(controller.signal.aborted ? 'TIMEOUT' : 'SERVICE_UNAVAILABLE');
  } finally {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    clearTimeout(timer);
  }
}
