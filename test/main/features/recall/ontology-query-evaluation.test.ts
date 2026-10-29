import { describe, expect, it } from 'vitest';

import {
  assessOntologyJevRollout,
  collectOntologyEvaluationDataset,
  evaluateOntologyQueryDataset,
  ONTOLOGY_EVALUATION_SCENARIOS,
  type OntologyEvaluationDataset,
  type OntologyEvaluationRoute,
} from '../../../../src/main/features/recall/ontology-query-evaluation';

function run(
  route: OntologyEvaluationRoute,
  selectedAssetIds: string[],
  overrides: Partial<OntologyEvaluationDataset['runs'][number]> = {},
): OntologyEvaluationDataset['runs'][number] {
  return {
    caseId: 'case-1',
    route,
    status: selectedAssetIds.length ? 'selected' : 'none',
    selectedAssetIds,
    latencyMs: route === 'ontology_jev' ? 180 : 40,
    ...overrides,
  };
}

function dataset(): OntologyEvaluationDataset {
  return {
    schemaVersion: 1,
    cases: [{
      caseId: 'case-1',
      query: '脱敏后的关系查询',
      scenarios: [...ONTOLOGY_EVALUATION_SCENARIOS],
      expectedAssetIds: ['aa-good'],
      blockedAssetIds: ['aa-blocked'],
      expectedIntent: { route: 'ontology', relationKind: 'depends_on', direction: 'incoming', maxHops: 1 },
    }],
    runs: [
      run('semantic', ['aa-blocked']),
      run('ontology', ['aa-good'], {
        intent: { route: 'ontology', relationKind: 'depends_on', direction: 'incoming', maxHops: 1 },
        evidenceComplete: true,
        relationDirectionCorrect: true,
        directnessCorrect: true,
      }),
      run('ontology_jev', ['aa-good'], {
        intent: { route: 'ontology', relationKind: 'depends_on', direction: 'incoming', maxHops: 1 },
        evidenceComplete: true,
        relationDirectionCorrect: true,
        directnessCorrect: true,
        jevCalls: 3,
        jevFallbacks: 0,
        jevLatencyMs: 120,
        estimatedCostUsd: 0.002,
        jevStages: ['intent', 'candidate_suitability', 'result_validation'],
      }),
    ],
  };
}

describe('ontology query A/B/C evaluation', () => {
  it('computes retrieval, governance, intent, evidence, latency and Jev metrics', () => {
    const report = evaluateOntologyQueryDataset(dataset());

    expect(report.caseCount).toBe(1);
    expect(report.completeCaseCount).toBe(1);
    expect(report.coverage.missing).toEqual([]);
    expect(report.routes.semantic).toMatchObject({
      precision: 0, recall: 0, f1: 0, errorInjectionRate: 1,
    });
    expect(report.routes.ontology_jev).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      mrr: 1,
      intentAccuracy: 1,
      evidenceCompleteRate: 1,
      relationDirectionAccuracy: 1,
      directnessAccuracy: 1,
      hardGateViolations: 0,
      jevSuccessRate: 1,
      averageJevCalls: 3,
      averageEstimatedCostUsd: 0.002,
      latencyP95Ms: 180,
    });
    expect(report.comparisons.cVsA.f1Delta).toBe(1);
    expect(report.comparisons.cVsB.f1Delta).toBe(0);
  });

  it('handles a correct none case without NaN metrics', () => {
    const value = dataset();
    value.cases[0].expectedAssetIds = [];
    value.runs = value.runs.map((item) => ({ ...item, status: 'none', selectedAssetIds: [] }));
    const report = evaluateOntologyQueryDataset(value);

    expect(report.routes.ontology_jev).toMatchObject({ precision: 1, recall: 1, f1: 1, noneAccuracy: 1 });
  });

  it('marks missing route executions instead of treating them as zero-quality runs', () => {
    const value = dataset();
    value.runs = value.runs.filter((item) => item.route !== 'ontology_jev');
    const report = evaluateOntologyQueryDataset(value);

    expect(report.completeCaseCount).toBe(0);
    expect(report.missingRuns).toEqual([{ caseId: 'case-1', route: 'ontology_jev' }]);
  });

  it('collects all A/B/C routes and records executor failures explicitly', async () => {
    const source = dataset();
    const collected = await collectOntologyEvaluationDataset(source.cases, async (_item, route) => {
      if (route === 'ontology_jev') throw new Error('Jev unavailable');
      return { status: 'selected', selectedAssetIds: ['aa-good'] };
    });

    expect(collected.runs).toHaveLength(3);
    expect(collected.runs.find((item) => item.route === 'ontology_jev')).toMatchObject({
      status: 'error', selectedAssetIds: [], fallback: true,
    });
  });

  it('allows rollout only when every configured safety and quality threshold passes', () => {
    const assessment = assessOntologyJevRollout(evaluateOntologyQueryDataset(dataset()), {
      minimumCases: 1,
      minimumF1GainOverSemantic: 0.5,
      requiredScenarios: [...ONTOLOGY_EVALUATION_SCENARIOS],
    });

    expect(assessment).toMatchObject({ status: 'ready', reasons: [] });
  });

  it('derives hard-governance violations from blocked selections', () => {
    const value = dataset();
    const c = value.runs.find((item) => item.route === 'ontology_jev')!;
    c.selectedAssetIds = ['aa-good', 'aa-blocked'];
    const assessment = assessOntologyJevRollout(evaluateOntologyQueryDataset(value), {
      minimumCases: 1,
      minimumF1GainOverSemantic: 0.5,
      requiredScenarios: [...ONTOLOGY_EVALUATION_SCENARIOS],
    });

    expect(assessment.status).toBe('not_ready');
    expect(assessment.reasons).toContain('C 出现 1 次硬治理绕过');
  });

  it('does not approve a C route that never actually called Jev', () => {
    const value = dataset();
    const c = value.runs.find((item) => item.route === 'ontology_jev')!;
    c.jevCalls = 0;
    c.jevStages = [];
    const assessment = assessOntologyJevRollout(evaluateOntologyQueryDataset(value), {
      minimumCases: 1,
      minimumF1GainOverSemantic: 0.5,
      requiredScenarios: [...ONTOLOGY_EVALUATION_SCENARIOS],
    });

    expect(assessment.status).toBe('not_ready');
    expect(assessment.reasons).toContain('C 没有足够的真实 Jev 调用样本');
  });

  it('rejects duplicate runs and runs that reference unknown cases', () => {
    const value = dataset();
    value.runs.push({ ...value.runs[0] });
    value.runs.push({ ...value.runs[1], caseId: 'case-unknown' });

    expect(() => evaluateOntologyQueryDataset(value)).toThrow();
  });
});
