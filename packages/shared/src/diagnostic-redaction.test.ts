import { expect, it } from 'vitest';
import { diagnosticPath, sanitizeDiagnosticText, sanitizeDiagnosticValue } from './diagnostic-redaction';

it('redacts credential URLs, assignments, authorization and structured metadata while retaining ordinary text', () => {
  const marker = 'SECRET_MARKER';
  for (const text of [`?code=${marker}&state=${marker}`, `Authorization: Bearer ${marker}`, `access_token=${marker}`, `api_key="${marker}"`, `/shared/${marker}`, `/review-sessions/share/${marker}`]) {
    expect(sanitizeDiagnosticText(text)).not.toContain(marker);
  }
  expect(diagnosticPath(`/auth/github/callback?key=${marker}`)).toBe('/auth/github/callback');
  expect(sanitizeDiagnosticText(`ordinary validation failure: ${marker}`, [marker])).toBe('ordinary validation failure: [redacted]');
  expect(JSON.stringify(sanitizeDiagnosticValue({ nested: { api_key: marker }, note: 'safe' }))).not.toContain(marker);
  expect(sanitizeDiagnosticValue({ tokenUsage: { totalTokens: 123 } })).toEqual({ tokenUsage: { totalTokens: 123 } });
});
