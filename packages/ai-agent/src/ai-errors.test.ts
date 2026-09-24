import { describe, expect, it } from 'vitest';
import { AiReviewFailure, classifyAiFailure } from './ai-errors';
import { LlmProviderError } from './providers';

/**
 * Classification is the part of the AI failure path that decides what a reviewer is told and
 * whether they are invited to re-run. Two of these cases are impractical to drive end to end —
 * an abort needs the tool's 300-second budget to elapse, and a raw DOMException cannot be
 * produced from the provider side — so they are pinned here instead.
 */
describe('classifyAiFailure', () => {
  it('passes an already-classified failure through unchanged', () => {
    const original = new AiReviewFailure('SCHEMA_INVALID', 'nope', false);
    expect(classifyAiFailure(original)).toBe(original);
  });

  describe('provider HTTP status', () => {
    const cases: Array<[number, string, boolean]> = [
      [401, 'UNAUTHORIZED', false],
      [403, 'UNAUTHORIZED', false],
      [404, 'MODEL_NOT_FOUND', false],
      [429, 'RATE_LIMITED', true],
      [500, 'PROVIDER_UNAVAILABLE', true],
      [503, 'PROVIDER_UNAVAILABLE', true],
      [400, 'REQUEST_REJECTED', false],
      [422, 'REQUEST_REJECTED', false],
    ];

    for (const [status, kind, retryable] of cases) {
      it(`maps HTTP ${status} to ${kind} (retryable=${retryable})`, () => {
        const failure = classifyAiFailure(
          new LlmProviderError(`failed with HTTP ${status}`, status, status === 429 || status >= 500, 'OPENAI'),
        );

        expect(failure.kind).toBe(kind);
        expect(failure.retryable).toBe(retryable);
      });
    }
  });

  describe('aborts and timeouts', () => {
    it('maps an AbortError by name, not by message', () => {
      // Undici does not guarantee the message text across runtimes, so the name is what the
      // classifier has to key on.
      const abort = new Error('');
      abort.name = 'AbortError';

      const failure = classifyAiFailure(abort);

      expect(failure.kind).toBe('TIMED_OUT');
      expect(failure.retryable).toBe(true);
      expect(failure.message).toMatch(/did not respond within the time budget/i);
    });

    it('maps the tool registry timeout message', () => {
      const failure = classifyAiFailure(new Error('generate_ai_review timed out after 300000ms'));
      expect(failure.kind).toBe('TIMED_OUT');
      expect(failure.retryable).toBe(true);
    });
  });

  describe('response validation', () => {
    it('distinguishes unparseable output from a shape mismatch', () => {
      // These two used to collapse into one message. They point at different fixes: JSON mode
      // being ignored versus the prompt and schema drifting apart.
      const unparseable = classifyAiFailure(
        new Error('Response was not parseable JSON: Unexpected token S'),
      );
      const wrongShape = classifyAiFailure(
        new Error('AI response failed schema validation: executiveSummary: Required'),
      );

      expect(unparseable.kind).toBe('MALFORMED_RESPONSE');
      expect(wrongShape.kind).toBe('SCHEMA_INVALID');
      expect(unparseable.retryable).toBe(false);
      expect(wrongShape.retryable).toBe(false);
    });
  });

  it('treats an unrecognised failure as transient', () => {
    // Conservative on purpose: telling someone to re-run costs one run, whereas telling them to
    // fix a configuration error that does not exist costs an afternoon.
    const failure = classifyAiFailure(new Error('socket hang up mid-stream'));

    expect(failure.kind).toBe('UNKNOWN');
    expect(failure.retryable).toBe(true);
  });

  describe('message safety', () => {
    it('never repeats the provider response body', () => {
      // LlmProviderError already withholds the body; this pins that the classifier does not
      // reintroduce it from the message it was given.
      const leaky = new LlmProviderError(
        'OPENAI request failed with HTTP 400. Offending content: FILE: src/secrets.ts sk-live-abc',
        400,
        false,
        'OPENAI',
        'context_length_exceeded',
      );

      const failure = classifyAiFailure(leaky);

      expect(failure.message).not.toContain('sk-live-abc');
      expect(failure.message).not.toContain('src/secrets.ts');
      // The machine-readable code is safe and useful, so it is kept.
      expect(failure.message).toContain('context_length_exceeded');
    });

    it('keeps the unsanitized cause available for server-side logging', () => {
      const cause = new Error('internal detail with prompt text');
      const failure = classifyAiFailure(cause);

      expect(failure.cause).toBe(cause);
      expect(failure.message).not.toContain('prompt text');
    });
  });
});
