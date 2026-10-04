import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { BROKER_POLICY_VERSION, signBrokerResponse, verifyBrokerProof } from './protocol';

it('authenticates deployment identity and correlation without accepting caller launch options', () => {
  const key = Buffer.alloc(32, 7),
    nonce = randomUUID();
  const result = { version: 1, status: 'FAILED', code: 'BROKER_DEADLINE' };
  const deployment = {
    executorImage: 'sha256:' + 'a'.repeat(64),
    policyVersion: BROKER_POLICY_VERSION,
  };
  const signed = signBrokerResponse(key, nonce, result, deployment);
  expect(verifyBrokerProof(key, nonce, signed)).toEqual({ result, deployment });
  expect(() =>
    verifyBrokerProof(key, nonce, {
      ...signed,
      deployment: { ...deployment, executorImage: 'sha256:' + 'b'.repeat(64) },
    }),
  ).toThrow('AUTHENTICATION');
  expect(() => verifyBrokerProof(key, randomUUID(), signed)).toThrow('AUTHENTICATION');
  expect(() =>
    signBrokerResponse(key, nonce, result, { ...deployment, policyVersion: 'other' } as never),
  ).toThrow();
  expect(() => verifyBrokerProof(key, nonce, { ...signed, command: ['sh'] })).toThrow();
  expect(
    verifyBrokerProof(key, nonce, signBrokerResponse(key, nonce, result)).deployment,
  ).toBeUndefined();
});
