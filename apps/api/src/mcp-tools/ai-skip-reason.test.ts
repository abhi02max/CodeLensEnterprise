import { describe, expect, it } from 'vitest';
import { aiSkippedByOrganization, aiSkippedWithoutKey } from './ai-skip-reason';

describe('AI skip explanations', () => {
  it('does not promise that another capability succeeded', () => {
    for (const reason of [aiSkippedByOrganization(), aiSkippedWithoutKey('OPENAI')]) {
      expect(reason).toContain('when their respective tools complete');
      expect(reason).not.toMatch(/static analysis|ML risk|risk score/i);
    }
  });
});
