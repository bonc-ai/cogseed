import { describe, expect, it } from 'vitest';

describe('KSTAR forecast metadata', () => {
  it('derives confidence, risk, freshness, and creation time for new records', async () => {
    const { buildWorldModelForecastRecord } = await import('../../../../src/main/features/recall/world-model');
    const record = buildWorldModelForecastRecord('forecast-user', {
      taskRunId: 'task-a', requirementId: 'req-a', projectionId: 'projection-a',
      projectionConfirmedAt: '2026-08-31T00:00:00.000Z', assetVersions: {}, ruleRefs: [], snapshotId: 'snapshot-a',
      simulationInput: { k: { abilityAssetRefs: [], rules: [] }, s: { conversationSummary: 'test' }, t: { userGoal: 'test', constraints: [] } },
      forecast: {
        aHat: { plan: ['test'], expectedTools: [], expectedActors: [] },
        rHat: { summary: 'done', acceptanceSignals: [], predictedFiles: [] },
        predictedRisks: [{ ruleId: 'rule-a', cause: 'x', effect: 'y', mitigation: 'z', severity: 'high', deltaR: -1 }],
        candidates: [{ id: 'candidate-a', aHat: { plan: ['test'], expectedTools: [], expectedActors: [] }, rHat: { summary: 'done', acceptanceSignals: [], predictedFiles: [] }, causalLinks: [], assumptions: [], predictedRisks: [], score: { goalFit: 1, feasibility: 1, observability: 1, causalSupport: 1, riskPenalty: 0, total: 0.8 }, modelOrder: 0 }],
        selectedCandidateId: 'candidate-a',
      },
    });

    expect(record.forecast).toMatchObject({
      forecastConfidence: 0.8,
      riskLevel: 'high',
      contextFreshness: { projectionConfirmedAt: '2026-08-31T00:00:00.000Z' },
    });
    expect(record.forecast.forecastCreatedAt).toEqual(expect.any(String));
  });
});
