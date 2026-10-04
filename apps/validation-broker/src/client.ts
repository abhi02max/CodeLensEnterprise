import { createConnection } from 'node:net';
import {
  LIMITS,
  encodeFrame,
  readFrame,
  type ValidationInput,
} from '@codelens/validation-executor';
import { signRequest, verifyResult } from './protocol';

/** Product workers receive only this authenticated local channel, never daemon authority. */
export async function requestValidation(
  socketPath: string,
  key: Buffer,
  input: ValidationInput,
  nonce: string,
  signal: AbortSignal,
  deadlineAt: number,
) {
  signal.throwIfAborted();
  if (deadlineAt <= Date.now()) throw new Error('VALIDATION_DEADLINE');
  const frame = encodeFrame(signRequest(key, nonce, input), LIMITS.frameBytes);
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  const cancel = () => socket.destroy(new Error('VALIDATION_CANCELLED'));
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, Math.min(LIMITS.operationMs, deadlineAt - Date.now()));
  try {
    const response = readFrame(socket, LIMITS.resultBytes);
    socket.end(frame);
    if (signal.aborted) cancel();
    return verifyResult(key, nonce, await response);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    socket.destroy();
  }
}
