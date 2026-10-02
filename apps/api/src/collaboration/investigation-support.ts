import { createHash } from 'node:crypto';
import { redactSecrets, type EvidenceProvenance, type InvestigationStatus } from '@codelens/shared';

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function clip(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  // Remove an incomplete trailing UTF-8 sequence rather than manufacturing source text.
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
export class InvestigationFailure extends Error {
  constructor(public readonly category: string) {
    super(category);
  }
}
export interface Observation {
  sourceType: string;
  sourceId?: string;
  provenance: EvidenceProvenance;
  observedRevision?: string;
  indexRevision?: string;
  path?: string;
  side?: string;
  startLine?: number;
  endLine?: number;
  contentHash: string;
  blobHash?: string;
  payloadHash: string;
  excerpt: string;
  truncated: boolean;
  redacted: boolean;
  method: string;
  metadata: Record<string, unknown>;
}
export function observe(
  text: string,
  fields: Partial<Observation> & Pick<Observation, 'sourceType' | 'provenance' | 'method'>,
  maxBytes = 16384,
): Observation {
  const redaction = redactSecrets(text);
  const excerpt = clip(redaction.redacted, maxBytes);
  return {
    contentHash: hash(text),
    payloadHash: hash(text),
    excerpt,
    truncated: Buffer.byteLength(redaction.redacted) > maxBytes,
    redacted: redaction.count > 0,
    metadata: {},
    ...fields,
  };
}
export interface ToolObservation {
  status: InvestigationStatus;
  coverage: string;
  evidence: Observation[];
  nextCursor: number | null;
  failureCategory?: string;
}
export function boundedResult(result: ToolObservation, maxBytes = 60000): ToolObservation {
  let bytes = 1000;
  const evidence: Observation[] = [];
  for (const item of result.evidence.slice(0, 50)) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + 300;
    if (bytes > maxBytes)
      return {
        ...result,
        status: 'LIMITED',
        evidence,
        coverage: result.coverage + '; output byte budget reached',
        nextCursor: null,
        failureCategory: 'LIMIT',
      };
    evidence.push(item);
  }
  return {
    ...result,
    status:
      result.status === 'SUCCESS' &&
      (result.nextCursor !== null || evidence.some((item) => item.truncated))
        ? 'PARTIAL'
        : result.status,
    evidence,
  };
}
