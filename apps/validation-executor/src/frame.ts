import type { Readable } from 'node:stream';
export function encodeFrame(value: unknown, limit: number) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > limit) throw new Error('FRAME_BOUND');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function readFrame(stream: Readable, limit: number): Promise<unknown> {
  // Returning from a for-await iterator destroys a socket; preserve it for the signed reply.
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const detach = () => {
      stream.off('data', data);
      stream.off('end', ended);
      stream.off('close', ended);
      stream.off('error', ended);
    };
    const ended = () => {
      detach();
      reject(new Error('FRAME_INCOMPLETE'));
    };
    const data = (chunk: Buffer) => {
      try {
        if (bytes.length + chunk.length > limit + 4) throw new Error('FRAME_BOUND');
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4) return;
        const length = bytes.readUInt32BE(0);
        if (length > limit || bytes.length > length + 4) throw new Error('FRAME_BOUND');
        if (bytes.length === length + 4) {
          const value: unknown = JSON.parse(bytes.subarray(4).toString('utf8'));
          detach();
          resolve(value);
        }
      } catch {
        detach();
        reject(new Error('FRAME_REJECTED'));
      }
    };
    stream.on('data', data);
    stream.once('end', ended);
    stream.once('close', ended);
    stream.once('error', ended);
  });
}
