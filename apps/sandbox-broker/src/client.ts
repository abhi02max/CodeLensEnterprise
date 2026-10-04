import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  encodeFrame,
  readFrame,
  MATERIALIZATION_LIMITS,
  type MaterializationRequest,
} from '@codelens/patch-core';
import { signBrokerRequest, verifyBrokerProof } from './protocol';

// Future worker integration uses only this local typed channel, never Docker authority.
export async function requestMaterialization(
  socketPath: string,
  key: Buffer,
  payload: MaterializationRequest,
  signal?: AbortSignal,
  deadlineAt = Date.now() + MATERIALIZATION_LIMITS.deadlineMs,
) {
  return (await requestMaterializationProof(socketPath, key, payload, signal, deadlineAt)).result;
}

export async function requestMaterializationProof(
  socketPath: string,
  key: Buffer,
  payload: MaterializationRequest,
  signal?: AbortSignal,
  deadlineAt = Date.now() + MATERIALIZATION_LIMITS.deadlineMs,
  nonce: string = randomUUID(),
) {
  if (signal?.aborted) throw new Error('BROKER_CANCELLED');
  const frame = encodeFrame(
    signBrokerRequest(key, nonce, Date.now(), payload, deadlineAt),
    MATERIALIZATION_LIMITS.inputBytes,
  );
  if (signal?.aborted || deadlineAt <= Date.now()) throw new Error('BROKER_CANCELLED');
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  const cancel = () => socket.destroy(new Error('BROKER_CANCELLED'));
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(
    () => socket.destroy(new Error('BROKER_TIMEOUT')),
    Math.min(MATERIALIZATION_LIMITS.deadlineMs, deadlineAt - Date.now()),
  );
  try {
    const response = readFrame(socket, MATERIALIZATION_LIMITS.outputBytes);
    socket.end(frame);
    return verifyBrokerProof(key, nonce, await response);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    socket.destroy();
  }
}
