import { Logger } from '@nestjs/common';
import { sanitizeDiagnosticText, sanitizeDiagnosticValue, type ToolLogger } from '@codelens/shared';

/**
 * Adapter from the Nest logger to the {@link ToolLogger} interface the packages
 * expect.
 *
 * Exists so `packages/ai-agent` and `packages/static-analysis` stay free of any Nest
 * dependency — they are plain TypeScript libraries and should remain usable from a
 * CLI or a test harness. Binding traceId and reviewRunId here means every line a
 * tool emits is automatically correlated without the tool having to care.
 */
export class NestToolLogger implements ToolLogger {
  private readonly logger: Logger;

  constructor(
    context: string,
    private readonly bindings: Record<string, unknown> = {},
  ) {
    this.logger = new Logger(context);
  }

  /** Derive a logger carrying additional context. */
  child(bindings: Record<string, unknown>): NestToolLogger {
    return new NestToolLogger('Tool', { ...this.bindings, ...bindings });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(this.format(message, meta));
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logger.log(this.format(message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logger.warn(this.format(message, meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logger.error(this.format(message, meta));
  }

  private format(message: string, meta?: Record<string, unknown>): string {
    const secrets = Object.entries(process.env).filter(([key]) => /(?:SECRET|TOKEN|API_KEY|ENCRYPTION_KEY|PASSWORD)$/.test(key)).map(([, value]) => value ?? '');
    message = sanitizeDiagnosticText(message, secrets);
    const merged = sanitizeDiagnosticValue({ ...this.bindings, ...meta }, secrets) as Record<string, unknown>;
    const keys = Object.keys(merged);

    if (keys.length === 0) return message;

    const rendered = keys
      .map((key) => `${key}=${stringify(merged[key])}`)
      .join(' ');

    return `${message} | ${rendered}`;
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '[unserializable]';
  }
}
