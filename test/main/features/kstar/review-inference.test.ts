import { describe, expect, it, vi } from 'vitest';
import type { KstarEpisodeRecord } from '../../../../src/main/features/kstar/types';

function episode(overrides: Partial<KstarEpisodeRecord> = {}): KstarEpisodeRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'kse-run-a',
    sessionId: 'gconv-cid-a',
    taskRunId: 'run-a',
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { workspaceId: 'workspace-a' },
    t: { userGoal: 'Fix the login bug and make the tests pass.', constraints: [] },
    a: {
      toolCalls: [
        { name: 'read_file', status: 'ok' },
        { name: 'write_file', status: 'ok' },
      ],
      agentActions: [],
    },
    r: {
      status: 'completed',
      finalText: 'Fixed the login bug.',
      producedFiles: ['auth.ts'],
    },
    evidenceRefs: [{ kind: 'execution', id: 'run-a' }],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:01:00.000Z',
    ...overrides,
  };
}

describe('KSTAR review inference', () => {
  it('builds an objective met-expectation review from recorded verification evidence without a model', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => { throw new Error('must not run'); });

    const result = await inference.inferKstarReview('user-a', episode({
      r: {
        status: 'completed',
        finalText: 'Fixed the login bug and all tests pass.',
        producedFiles: ['auth.ts', 'auth.test.ts'],
        verification: { command: 'npm test', passed: true },
      },
    }), { runModel });

    expect(runModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reviewState: 'inferred',
      inferenceMethod: 'deterministic',
      needsConfirmation: false,
      review: {
        expectedResult: 'Fix the login bug and make the tests pass.',
        outcome: 'met_expected',
        deltaR: 0,
        deltaA: 0,
        confidence: 0.95,
      },
    });
    expect(result.review.actualResult).toContain('Fixed the login bug');
    expect(result.review.actualResult).toContain('auth.test.ts');
  });

  it('uses strict model analysis for a completed task without objective verification', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => JSON.stringify({
      outcome: 'worse_than_expected',
      attribution: 'skill_gap',
      deltaR: -0.4,
      deltaA: -0.2,
      reason: 'The implementation was completed, but no verification was recorded.',
      confidence: 0.82,
      needsConfirmation: false,
    }));

    const result = await inference.inferKstarReview('user-a', episode(), { runModel });

    expect(runModel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reviewState: 'inferred',
      inferenceMethod: 'model',
      needsConfirmation: false,
      review: {
        outcome: 'worse_than_expected',
        attribution: 'skill_gap',
        deltaR: -0.4,
        deltaA: -0.2,
        confidence: 0.82,
      },
    });
  });

  it('degrades malformed or unavailable model analysis to a conservative inferred review without pausing the user', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');

    for (const text of [
      '```json\n{"outcome":"met_expected"}\n```',
      '{"outcome":"invented","attribution":"skill_gap","deltaR":0,"deltaA":0,"reason":"x","confidence":1,"needsConfirmation":false}',
      '{"outcome":"met_expected","attribution":"unclear","deltaR":0,"deltaA":0,"reason":"","confidence":1,"needsConfirmation":false}',
    ]) {
      const result = await inference.inferKstarReview('user-a', episode(), { runModel: async () => text });
      expect(result).toMatchObject({
        reviewState: 'inferred',
        inferenceMethod: 'unknown',
        needsConfirmation: false,
        review: { outcome: 'unclear', deltaR: 'unknown', deltaA: 'unknown', confidence: 0 },
      });
    }
  });

  it('reasons attribution and lesson via the model when a forecast exists (gap → cause → reusable asset)', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => JSON.stringify({
      outcome: 'worse_than_expected',
      attribution: 'rule_gap',
      deltaR: -0.5,
      deltaA: -0.3,
      reason: 'The forecast expected a state check that the execution skipped.',
      confidence: 0.85,
      needsConfirmation: false,
      lesson: 'OAuth callbacks must exchange the code only after validating state, otherwise invalid sessions are accepted.',
    }));

    const result = await inference.inferKstarReview('user-a', episode(), {
      forecast: {
        aHat: { plan: ['Check state', 'Exchange code'], expectedTools: ['read_file'], expectedActors: ['commander'] },
        rHat: { summary: 'Login fixed and tests pass', acceptanceSignals: ['tests pass'], predictedFiles: ['auth.ts'] },
        predictedRisks: [],
        selectedCandidateId: 'cand-a',
      },
      selectedAssetTypes: ['rule'],
      runModel,
    });

    expect(runModel).toHaveBeenCalledTimes(1);
    const message = JSON.parse(runModel.mock.calls[0][0].message);
    expect(message.delta).toMatchObject({ deltaA: expect.any(Number) });
    expect(message.forecast.predictedResult.acceptanceSignals).toEqual(['tests pass']);
    expect(result).toMatchObject({
      reviewState: 'inferred',
      inferenceMethod: 'model',
      needsConfirmation: false,
      review: {
        attribution: 'rule_gap',
        reason: 'The forecast expected a state check that the execution skipped.',
        lesson: 'OAuth callbacks must exchange the code only after validating state, otherwise invalid sessions are accepted.',
      },
    });
  });

  it('drops an English lesson from a Chinese task at the language gate', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => JSON.stringify({
      outcome: 'better_than_expected',
      attribution: 'unclear',
      deltaR: 0.3,
      deltaA: 0.2,
      reason: 'Task completed faster than predicted.',
      confidence: 0.8,
      needsConfirmation: false,
      lesson: 'For well-known factual city profiles, skip explicit information-gathering plan steps.',
    }));

    const result = await inference.inferKstarReview('user-a', episode({
      t: { userGoal: '帮我写一份广州城市的资料，500 字', constraints: [] },
    }), {
      forecast: {
        aHat: { plan: ['Gather', 'Write'], expectedTools: ['read_file'], expectedActors: ['commander'] },
        rHat: { summary: 'City profile written', acceptanceSignals: [], predictedFiles: [] },
        predictedRisks: [],
        selectedCandidateId: 'cand-a',
      },
      selectedAssetTypes: ['rule'],
      runModel,
    });

    // 语言硬闸：中文任务产出的英文 lesson 被丢弃，绝不进候选池。
    expect(result).toMatchObject({ reviewState: 'inferred', inferenceMethod: 'model' });
    expect(result.review.lesson).toBeUndefined();
    expect(result.review.reason).toBe('Task completed faster than predicted.');
  });

  it('keeps a same-language lesson from the model', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => JSON.stringify({
      outcome: 'better_than_expected',
      attribution: 'unclear',
      deltaR: 0.3,
      deltaA: 0.2,
      reason: '任务比预期更快完成。',
      confidence: 0.8,
      needsConfirmation: false,
      lesson: '写城市资料时应先收集数据再成文，避免编造。',
    }));

    const result = await inference.inferKstarReview('user-a', episode({
      t: { userGoal: '帮我写一份广州城市的资料，500 字', constraints: [] },
    }), {
      forecast: {
        aHat: { plan: ['Gather', 'Write'], expectedTools: ['read_file'], expectedActors: ['commander'] },
        rHat: { summary: 'City profile written', acceptanceSignals: [], predictedFiles: [] },
        predictedRisks: [],
        selectedCandidateId: 'cand-a',
      },
      selectedAssetTypes: ['rule'],
      runModel,
    });

    expect(result.review.lesson).toBe('写城市资料时应先收集数据再成文，避免编造。');
  });

  it('falls back to deterministic reconciliation when the model is unavailable', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => { throw new Error('model down'); });

    const result = await inference.inferKstarReview('user-a', episode(), {
      forecast: {
        aHat: { plan: ['Check state', 'Exchange code'], expectedTools: ['read_file'], expectedActors: ['commander'] },
        rHat: { summary: 'Login fixed and tests pass', acceptanceSignals: ['tests pass'], predictedFiles: ['auth.ts'] },
        predictedRisks: [],
        selectedCandidateId: 'cand-a',
      },
      selectedAssetTypes: ['rule'],
      runModel,
    });

    expect(result.inferenceMethod).toBe('deterministic');
    expect(result.review).toMatchObject({ deltaR: 0, deltaA: 0, outcome: 'met_expected' });
  });

  it('classifies failed terminal status deterministically and never needs model self-judgment', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');
    const runModel = vi.fn(async () => { throw new Error('must not run'); });
    const result = await inference.inferKstarReview('user-a', episode({
      r: { status: 'failed', producedFiles: [], failureKind: 'tool', failureCode: 'E_WRITE' },
    }), { runModel });

    expect(runModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reviewState: 'inferred',
      inferenceMethod: 'deterministic',
      review: {
        outcome: 'worse_than_expected',
        attribution: 'execution_gap',
        deltaR: -1,
        confidence: 0.95,
      },
    });
  });
});
