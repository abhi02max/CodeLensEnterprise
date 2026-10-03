import type { Readable } from 'node:stream';
import { PatchCoreError } from './patch';

export function encodeFrame(value: unknown, maximum: number): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > maximum) throw new PatchCoreError('Frame bound exceeded.');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Exactly one length-prefixed UTF-8 JSON message terminated by channel EOF. */
export async function readFrame(stream: Readable, maximum: number): Promise<unknown> {
  const header = Buffer.alloc(4);
  let total = 0,
    headerBytes = 0,
    length: number | undefined,
    body: Buffer | undefined,
    bodyBytes = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + bytes.length > maximum + 4) throw new PatchCoreError('Frame bound exceeded.');
    total += bytes.length;
    let offset = 0;
    if (headerBytes < 4) {
      const copied = Math.min(4 - headerBytes, bytes.length);
      bytes.copy(header, headerBytes, 0, copied);
      headerBytes += copied;
      offset = copied;
    }
    if (headerBytes === 4 && length === undefined) {
      length = header.readUInt32BE();
      if (length === 0 || length > maximum) throw new PatchCoreError('Frame bound exceeded.');
      body = Buffer.alloc(length);
    }
    if (length !== undefined && total > length + 4)
      throw new PatchCoreError('Trailing frame data.');
    if (body && offset < bytes.length) {
      bodyBytes += bytes.copy(body, bodyBytes, offset);
    }
  }
  if (length === undefined || total !== length + 4) throw new PatchCoreError('Incomplete frame.');
  const bytes = body!,
    text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new PatchCoreError('Invalid frame encoding.');
  return JSON.parse(text);
}
