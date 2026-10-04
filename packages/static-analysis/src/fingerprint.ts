import { createHash } from 'node:crypto';

/** Legacy review identity; validation uses a separate occurrence identity. */
export function fingerprintFinding(params: {
  analyzer: string;
  ruleId: string;
  path: string | null;
  message: string;
}): string {
  const normalizedMessage = params.message
    .toLowerCase()
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return createHash('sha256')
    .update(`${params.analyzer}|${params.ruleId}|${params.path ?? ''}|${normalizedMessage}`)
    .digest('hex')
    .slice(0, 32);
}
