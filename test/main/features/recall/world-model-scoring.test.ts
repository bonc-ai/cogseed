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
  causalLinks: [{
    interventionIndex: 0,
    mechanism: 'Inspection locates the invalid state check.',
    ruleRefs: ['rule:asset-a:1'],
    assumptions: ['Source is readable'],
  }],
  assumptions: ['Tests are available'],
  riskRuleRefs: ['rule:asset-a:1'],
  score: {
    goalFit: 0.8,
    feasibility: 0.8,
    observability: 0.8,
    causalSupport: 0.8,
    riskPenalty: 0.2,
    total: 1,
  },
};

const context = {
  allowedTools: new Set(['read_file', 'exec_command']),
  allowedRuleRefs: new Set(['rule:asset-a:1']),
  predictedRisks: [{
    ruleId: 'rule:asset-a:1',
    cause: 'Missing state validation',
    effect: 'Invalid callback',
    mitigation: 'Validate state',
    severity: 'high' as const,
    deltaR: -0.8,
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
    expect(() => validateWorldModelCandidate({
      ...base,
      expectedTools: ['delete_everything'],
    }, context, 0)).toThrow(/unavailable_tool/);
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

  it('accepts a candidate whose expectedTools array is empty', () => {
    expect(validateWorldModelCandidate({
      ...base,
      expectedTools: [],
    }, context, 0).aHat.expectedTools).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['malformed item', [42]],
  ])('rejects expectedTools when %s', (_label, expectedTools) => {
    const candidate: Record<string, unknown> = { ...base };
    if (expectedTools === undefined) delete candidate.expectedTools;
    else candidate.expectedTools = expectedTools;

    expect(() => validateWorldModelCandidate(candidate, context, 0))
      .toThrow('invalid_candidate_expected_tools');
  });

  it('keeps plan, expectedActors, and acceptanceSignals non-empty', () => {
    expect(() => validateWorldModelCandidate({ ...base, plan: [] }, context, 0))
      .toThrow('invalid_candidate_plan');
    expect(() => validateWorldModelCandidate({ ...base, expectedActors: [] }, context, 0))
      .toThrow('invalid_candidate_expected_actors');
    expect(() => validateWorldModelCandidate({
      ...base,
      predictedResult: { ...base.predictedResult, acceptanceSignals: [] },
    }, context, 0)).toThrow('invalid_candidate_acceptance_signals');
  });

  it('accepts flattened string shapes (deepseek flattens nested arrays/objects)', () => {
    // plan/expectedTools/expectedActors as single strings.
    const flattened = validateWorldModelCandidate({
      ...base,
      plan: 'Inspect callback then run tests',
      expectedTools: 'read_file',
      expectedActors: 'commander',
    }, context, 0);
    expect(flattened.aHat.plan).toEqual(['Inspect callback then run tests']);
    expect(flattened.aHat.expectedTools).toEqual(['read_file']);
    expect(flattened.aHat.expectedActors).toEqual(['commander']);

    // predictedResult as a plain string → { summary }.
    const stringResult = validateWorldModelCandidate({
      ...base,
      predictedResult: 'Callback is fixed and verified.',
    }, context, 0);
    expect(stringResult.rHat.summary).toBe('Callback is fixed and verified.');
    expect(stringResult.rHat.acceptanceSignals).toEqual([]);

    // missing id → stable generated id, never empty.
    const noId: Record<string, unknown> = { ...base };
    delete noId.id;
    expect(validateWorldModelCandidate(noId, context, 2).id).toBe('candidate-3');
  });
});
