import { describe, expect, it, vi } from 'vitest';
import { ReportWriter } from './report-writer.service';
import type { RunState } from './run-scratchpad';
import type { PrismaService } from '../prisma/prisma.service';
import type { RagService } from '../rag/rag.service';

function setup(prediction = true) {
  const tx = {
    staticFinding: { deleteMany: vi.fn() },
    mlPrediction: { deleteMany: vi.fn(), create: vi.fn() },
    pullRequest: { update: vi.fn() },
  };
  const prisma = {
    unscoped: { $transaction: async (fn: (client: unknown) => Promise<void>) => fn(tx) },
  };
  const writer = new ReportWriter(prisma as unknown as PrismaService, {} as RagService);
  const state: RunState = {
    organizationId: 'org',
    repositoryId: 'repo',
    pullRequestId: 'pr',
    createdAt: 0,
  };
  if (prediction)
    state.prediction = {
      response: {
        risk_score: 91.1,
        risk_level: 'HIGH',
        probability: 0.911,
        confidence: 0.3,
        model_name: 'xgboost',
        model_version: 'bootstrap-v1',
        is_baseline: true,
        top_risk_reasons: [],
        warnings: [],
      },
      reviewTimeMinutes: null,
      reviewTimeRange: null,
      similar: [],
      degradedReason: 'LOW_CONFIDENCE',
    };
  return { writer, tx, state };
}
describe('legacy ML band persistence', () => {
  it('preserves authoritative HIGH while retaining legacy integer storage', async () => {
    const { writer, tx, state } = setup();
    const result = await writer.persist({
      organizationId: 'org',
      reviewRunId: 'run',
      pullRequestId: 'pr',
      staticAnalysisToolRunId: null,
      state,
    });
    expect(result).toMatchObject({ riskScore: 91.1, riskLevel: 'HIGH' });
    expect(tx.mlPrediction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ riskScore: 91, riskLevel: 'HIGH' }),
    });
    expect(tx.pullRequest.update).toHaveBeenCalledWith({
      where: { id: 'pr' },
      data: { latestRiskScore: 91, latestRiskLevel: 'HIGH' },
    });
  });
  it('does not store unavailable as zero', async () => {
    const { writer, tx, state } = setup(false);
    expect(
      await writer.persist({
        organizationId: 'org',
        reviewRunId: 'run',
        pullRequestId: 'pr',
        staticAnalysisToolRunId: null,
        state,
      }),
    ).toMatchObject({ riskScore: null, riskLevel: null });
    expect(tx.mlPrediction.create).not.toHaveBeenCalled();
    expect(tx.pullRequest.update).not.toHaveBeenCalled();
  });
});
