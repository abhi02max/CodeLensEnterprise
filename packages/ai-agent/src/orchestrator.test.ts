import { describe, expect, it } from 'vitest';
import { Role, ToolName } from '@codelens/shared';
import { REVIEW_PIPELINE, ReviewOrchestrator, topologicalSort } from './orchestrator';
import type { McpToolRegistry } from './registry';

describe('review pipeline ordering', () => {
  it('waits for available deterministic evidence before generating the AI review', () => {
    const order = topologicalSort(REVIEW_PIPELINE).map((node) => node.tool);
    const ai = order.indexOf(ToolName.GENERATE_AI_REVIEW);

    for (const evidence of [
      ToolName.GET_PR_DIFF,
      ToolName.RUN_STATIC_ANALYSIS,
      ToolName.PREDICT_PR_RISK,
      ToolName.RETRIEVE_CODE_CONTEXT,
    ]) {
      expect(order.indexOf(evidence)).toBeLessThan(ai);
    }
  });

  it('keeps ML and RAG independent and runs AI after both have failed', async () => {
    const ml = REVIEW_PIPELINE.find((node) => node.tool === ToolName.PREDICT_PR_RISK)!;
    const rag = REVIEW_PIPELINE.find((node) => node.tool === ToolName.RETRIEVE_CODE_CONTEXT)!;
    expect(ml.dependsOn).not.toContain(ToolName.RETRIEVE_CODE_CONTEXT);
    expect(rag.dependsOn).not.toContain(ToolName.PREDICT_PR_RISK);

    const invoked: ToolName[] = [];
    const registry = {
      invoke: async (tool: ToolName) => {
        invoked.push(tool);
        if (tool === ToolName.PREDICT_PR_RISK || tool === ToolName.RETRIEVE_CODE_CONTEXT) {
          return { ok: false, error: { code: 'EXECUTION_ERROR', message: 'unavailable' } };
        }
        return {
          ok: true,
          value: {
            output: tool === ToolName.GET_REPO_METADATA ? { indexed: true } : {},
            meta: { durationMs: 0, cacheHit: false, tokenUsage: null, costCents: 0 },
          },
        };
      },
    } as unknown as McpToolRegistry;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const orchestrator = new ReviewOrchestrator(registry, {
      persistToolRun: async () => 'tool-run-id',
      onStageChange: async () => {},
      buildInput: async () => ({}),
      logger,
    });

    const result = await orchestrator.run({
      organizationId: 'org-1',
      userId: null,
      userRole: Role.OWNER,
      reviewRunId: 'run-1',
      traceId: 'trace-1',
      dryRun: false,
      budgetCents: 100,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('PARTIAL');
    expect(invoked).toContain(ToolName.GENERATE_AI_REVIEW);
    expect(invoked.indexOf(ToolName.GENERATE_AI_REVIEW)).toBeGreaterThan(invoked.indexOf(ToolName.PREDICT_PR_RISK));
    expect(invoked.indexOf(ToolName.GENERATE_AI_REVIEW)).toBeGreaterThan(invoked.indexOf(ToolName.RETRIEVE_CODE_CONTEXT));
  });
});
