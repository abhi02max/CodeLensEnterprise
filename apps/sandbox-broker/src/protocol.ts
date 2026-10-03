import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  MaterializationRequestSchema,
  MaterializationResultSchema,
  PatchCoreError,
} from '@codelens/patch-core';
import { BROKER_POLICY } from './policy';

const Envelope = z
  .object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    issuedAt: z.number().int(),
    deadlineAt: z.number().int(),
    payload: MaterializationRequestSchema,
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (value) =>
      value.deadlineAt > value.issuedAt &&
      value.deadlineAt <= value.issuedAt + BROKER_POLICY.deadlineMs,
    'Invalid operation deadline',
  );
export function signBrokerRequest(
  key: Buffer,
  nonce: string,
  issuedAt: number,
  payload: unknown,
  deadlineAt = issuedAt + BROKER_POLICY.deadlineMs,
) {
  if (key.length !== 32) throw new Error('BROKER_KEY_REQUIRED');
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= issuedAt ||
    deadlineAt > issuedAt + BROKER_POLICY.deadlineMs
  )
    throw new Error('BROKER_DEADLINE');
  const body = {
    version: 1 as const,
    nonce,
    issuedAt,
    deadlineAt,
    payload: MaterializationRequestSchema.parse(payload),
  };
  return { ...body, mac: createHmac('sha256', key).update(JSON.stringify(body)).digest('hex') };
}
export class BrokerAuthenticator {
  private readonly consumed = new Map<string, number>();
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('BROKER_KEY_REQUIRED');
  }
  consume(raw: unknown, now = Date.now()) {
    const request = Envelope.parse(raw);
    if (request.deadlineAt <= now) throw new Error('BROKER_DEADLINE');
    if (Math.abs(now - request.issuedAt) > BROKER_POLICY.authenticationAgeMs)
      throw new Error('BROKER_AUTHENTICATION_FAILED');
    const signed = signBrokerRequest(
      this.key,
      request.nonce,
      request.issuedAt,
      request.payload,
      request.deadlineAt,
    );
    if (!timingSafeEqual(Buffer.from(signed.mac, 'hex'), Buffer.from(request.mac, 'hex')))
      throw new Error('BROKER_AUTHENTICATION_FAILED');
    for (const [nonce, expiry] of this.consumed) if (expiry < now) this.consumed.delete(nonce);
    if (this.consumed.has(request.nonce)) throw new Error('BROKER_REPLAY_REJECTED');
    if (this.consumed.size >= BROKER_POLICY.nonceCapacity) throw new Error('BROKER_NONCE_CAPACITY');
    this.consumed.set(request.nonce, request.issuedAt + BROKER_POLICY.authenticationAgeMs);
    return request.payload;
  }
}

const FailureCode = z.enum([
  'CLEANUP_UNCERTAIN',
  'DAEMON_OPERATION_FAILED',
  'DAEMON_ATTACH_FAILED',
  'DAEMON_IDENTITY_INVALID',
  'DAEMON_UNAVAILABLE',
  'EXECUTOR_RESULT_REJECTED',
  'EXECUTOR_OUTPUT_REJECTED',
  'BROKER_NONCE_STORE_FAILED_OR_REPLAY',
  'BROKER_NONCE_STORE_INVALID',
  'BROKER_NONCE_CAPACITY',
  'BROKER_DEADLINE',
  'BROKER_BUSY_OR_CLEANUP_UNCERTAIN',
  'REQUEST_SCHEMA_REJECTED',
  'MATERIALIZATION_VALIDATION_FAILED',
  'BROKER_INTERNAL_ERROR',
]);
export const BrokerResultSchema = z.union([
  z
    .object({
      version: z.literal(1),
      status: z.literal('MATERIALIZED'),
      result: MaterializationResultSchema,
    })
    .strict(),
  z.object({ version: z.literal(1), status: z.literal('FAILED'), code: FailureCode }).strict(),
]);
export function safeBrokerFailure(error: unknown): z.infer<typeof FailureCode> {
  const message = error instanceof Error ? error.message : '';
  if (message === 'BROKER_CLEANUP_UNCERTAIN') return 'CLEANUP_UNCERTAIN';
  const safe = FailureCode.safeParse(message);
  if (safe.success) return safe.data;
  if (error instanceof z.ZodError) return 'REQUEST_SCHEMA_REJECTED';
  if (error instanceof PatchCoreError) return 'MATERIALIZATION_VALIDATION_FAILED';
  return 'BROKER_INTERNAL_ERROR';
}
export function signBrokerResponse(key: Buffer, nonce: string, result: unknown) {
  if (key.length !== 32) throw new Error('BROKER_KEY_REQUIRED');
  const body = { version: 1, nonce, result: BrokerResultSchema.parse(result) };
  return { ...body, mac: createHmac('sha256', key).update(JSON.stringify(body)).digest('hex') };
}
export function verifyBrokerResponse(
  key: Buffer,
  nonce: string,
  raw: unknown,
): z.infer<typeof BrokerResultSchema> {
  const value = z
    .object({
      version: z.literal(1),
      nonce: z.string().uuid(),
      result: BrokerResultSchema,
      mac: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(raw);
  if (
    value.nonce !== nonce ||
    !timingSafeEqual(
      Buffer.from(value.mac, 'hex'),
      Buffer.from(signBrokerResponse(key, nonce, value.result).mac, 'hex'),
    )
  )
    throw new Error('BROKER_RESPONSE_AUTHENTICATION_FAILED');
  return value.result;
}
