import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { encodeFrame, readFrame } from './frame';
describe('bounded frames preserve reply transport', () => {
  it('reads split frames without destroying the stream', async () => {
    const stream = new PassThrough(),
      frame = encodeFrame({ ok: true }, 32);
    const received = readFrame(stream, 32);
    stream.write(frame.subarray(0, 2));
    stream.write(frame.subarray(2));
    expect(await received).toEqual({ ok: true });
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });
  it('rejects oversized, trailing, truncated and malformed frames', async () => {
    for (const bytes of [
      Buffer.from([0, 0, 1, 0]),
      Buffer.concat([encodeFrame({}, 16), Buffer.from('extra')]),
      Buffer.from([0, 0, 0, 1, 120]),
    ]) {
      const stream = new PassThrough(),
        read = readFrame(stream, 16);
      stream.end(bytes);
      await expect(read).rejects.toThrow();
    }
    const stream = new PassThrough(),
      read = readFrame(stream, 16);
    stream.end(Buffer.from([0]));
    await expect(read).rejects.toThrow();
  });
});
