import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIMITS, SourceSchema, ResultSchema, validateInput } from '@codelens/validation-executor';
import { z } from 'zod';

const Request = z
  .object({
    protocol: z.literal('codelens-validation-v1'),
    nonce: z.string().uuid(),
    issuedAt: z.number().int().safe(),
    deadlineAt: z.number().int().safe(),
    input: SourceSchema,
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const mac = (key: Buffer, body: unknown) => {
  if (key.length !== 32) throw new Error('VALIDATION_KEY_REQUIRED');
  return createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
};
export function signRequest(key: Buffer, nonce: string, input: unknown, issuedAt = Date.now()) {
  const normalized = validateInput(input).input;
  const body = {
    protocol: 'codelens-validation-v1' as const,
    nonce,
    issuedAt,
    deadlineAt: issuedAt + LIMITS.operationMs,
    input: normalized,
  };
  return Request.parse({ ...body, mac: mac(key, body) });
}
export function authenticate(key: Buffer, raw: unknown, now = Date.now()) {
  const value = Request.parse(raw);
  const { mac: supplied, ...body } = value;
  if (
    Math.abs(now - value.issuedAt) > 60000 ||
    value.deadlineAt <= now ||
    value.deadlineAt !== value.issuedAt + LIMITS.operationMs ||
    !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(mac(key, body), 'hex'))
  )
    throw new Error('AUTHENTICATION_REJECTED');
  validateInput(value.input);
  return value;
}
export function signResult(key: Buffer, nonce: string, result: unknown) {
  const body = {
    protocol: 'codelens-validation-result-v1' as const,
    nonce,
    result: ResultSchema.parse(result),
  };
  return { ...body, mac: mac(key, body) };
}
export function verifyResult(key: Buffer, nonce: string, raw: unknown) {
  const value = z
    .object({
      protocol: z.literal('codelens-validation-result-v1'),
      nonce: z.string().uuid(),
      result: ResultSchema,
      mac: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(raw);
  const { mac: supplied, ...body } = value;
  if (
    value.nonce !== nonce ||
    !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(mac(key, body), 'hex'))
  )
    throw new Error('RESPONSE_REJECTED');
  return value.result;
}
