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

  it('degrades malformed or unavailable model analysis to a conservative confirmation request', async () => {
    const inference = await import('../../../../src/main/features/kstar/review-inference');

    for (const text of [
      '```json\n{"outcome":"met_expected"}\n```',
      '{"outcome":"invented","attribution":"skill_gap","deltaR":0,"deltaA":0,"reason":"x","confidence":1,"needsConfirmation":false}',
      '{"outcome":"met_expected","attribution":"unclear","deltaR":0,"deltaA":0,"reason":"","confidence":1,"needsConfirmation":false}',
    ]) {
      const result = await inference.inferKstarReview('user-a', episode(), { runModel: async () => text });
      expect(result).toMatchObject({
        reviewState: 'needs_confirmation',
        inferenceMethod: 'unknown',
        needsConfirmation: true,
        review: { outcome: 'unclear', deltaR: 'unknown', deltaA: 'unknown', confidence: 0 },
      });
    }
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
