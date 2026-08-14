import { describe, expect, it } from 'vitest';
import {
  recomputeCandidateScore,
  selectWorldModelCandidate,
  validateWorldModelCandidate,
} from '../../../../src/main/features/recall/world-model-scoring';

const base = {
  id: 'path-a',
  plan: ['Inspect callback', 'Run tests'],
  expectedTools: ['read_file', 'exec_command'],
  expectedActors: ['commander'],
  predictedResult: {
    summary: 'Callback is fixed and verified.',
    acceptanceSignals: ['OAuth callback test passes'],
    predictedFiles: ['src/auth/callback.ts'],
  },
  causalLinks: [{ interventionIndex: 0, mechanism: 'Inspection locates the invalid state check.', ruleRefs: ['rule:asset-a:1'], assumptions: ['Source is readable'] }],
  assumptions: ['Tests are available'],
  riskRuleRefs: ['rule:asset-a:1'],
  score: { goalFit: 0.8, feasibility: 0.8, observability: 0.8, causalSupport: 0.8, riskPenalty: 0.2, total: 1 },
};

const context = {
  allowedTools: new Set(['read_file', 'exec_command']),
  allowedRuleRefs: new Set(['rule:asset-a:1']),
  predictedRisks: [{
    ruleId: 'rule:asset-a:1', cause: 'Missing state validation', effect: 'Invalid callback',
    mitigation: 'Validate state', severity: 'high' as const, deltaR: -0.8,
  }],
};

describe('world-model candidate scoring', () => {
  it('recomputes total locally instead of trusting the model total', () => {
    expect(recomputeCandidateScore(base.score)).toEqual({
      goalFit: 0.8,
      feasibility: 0.8,
      observability: 0.8,
      causalSupport: 0.8,
      riskPenalty: 0.2,
      total: 0.75,
    });
  });

  it('rejects unknown rule refs and unavailable tools', () => {
    expect(() => validateWorldModelCandidate({ ...base, expectedTools: ['delete_everything'] }, context, 0))
      .toThrow(/unavailable_tool/);
    expect(() => validateWorldModelCandidate({
      ...base,
      causalLinks: [{ ...base.causalLinks[0], ruleRefs: ['rule:unknown:1'] }],
    }, context, 0)).toThrow(/invalid_rule_ref/);
  });

  it('selects highest score then lower risk then higher observability', () => {
    const first = validateWorldModelCandidate(base, context, 0);
    const second = validateWorldModelCandidate({
      ...base,
      id: 'path-b',
      score: { ...base.score, goalFit: 0.9, riskPenalty: 0.1 },
    }, context, 1);
    expect(selectWorldModelCandidate([first, second]).id).toBe('path-b');
  });
});
