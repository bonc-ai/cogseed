import { describe, expect, it, vi } from 'vitest';

import { createJevClientForGateFromEnvironment } from '../../../../src/main/features/jev/adapter';
import { resolveJevRollout } from '../../../../src/main/features/jev/rollout';

describe('Jev gate rollout', () => {
  it('keeps every gate disabled when the global feature switch is off', () => {
    expect(resolveJevRollout('intent', false, 'user-a', {
      COGSEED_JEV_GATES: 'intent', COGSEED_JEV_ROLLOUT_PERCENT: '100',
    })).toMatchObject({ enabled: false, reason: 'global_disabled' });
  });

  it('defaults an enabled deployment to all gates at 100 percent', () => {
    expect(resolveJevRollout('result_validation', true, undefined, {})).toMatchObject({
      enabled: true,
      reason: 'enabled',
      percent: 100,
      enabledGates: ['intent', 'candidate_suitability', 'result_validation'],
    });
  });

  it('enforces the explicit gate allow-list', () => {
    expect(resolveJevRollout('candidate_suitability', true, 'user-a', {
      COGSEED_JEV_GATES: 'intent,result_validation',
    })).toMatchObject({ enabled: false, reason: 'gate_disabled' });
  });

  it('requires a stable key for partial rollout and keeps the same key stable', () => {
    expect(resolveJevRollout('intent', true, undefined, {
      COGSEED_JEV_ROLLOUT_PERCENT: '25',
    })).toMatchObject({ enabled: false, reason: 'missing_rollout_key' });

    const first = resolveJevRollout('intent', true, 'stable-user', {
      COGSEED_JEV_ROLLOUT_PERCENT: '25',
    });
    const second = resolveJevRollout('intent', true, 'stable-user', {
      COGSEED_JEV_ROLLOUT_PERCENT: '25',
    });
    expect(second).toEqual(first);
    expect(first.enabled).toBe((first.bucket || 0) < 2_500);
  });

  it('does not call HTTP when this gate is outside the rollout policy', async () => {
    const fetchImpl = vi.fn();
    const client = createJevClientForGateFromEnvironment(
      'candidate_suitability',
      'user-a',
      {
        COGSEED_SEMANTICA_ENABLED: 'true',
        COGSEED_JEV_ENABLED: 'true',
        COGSEED_JEV_ENDPOINT: 'https://jev.example/evaluate',
        COGSEED_JEV_API_KEY: 'secret',
        COGSEED_JEV_GATES: 'intent',
      },
      { fetch: fetchImpl },
    );

    await expect(client.evaluate({
      requestId: 'rollout-request',
      gate: 'candidate_suitability',
      question: { id: 'rollout-question', kind: 'choice', text: '选择候选' },
      query: '脱敏问题',
      candidates: [{ id: 'aa-candidate', summary: '脱敏候选', source: 'semantic' }],
    })).resolves.toEqual({ status: 'fallback', reason: 'disabled', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses HTTP when global, gate and cohort policies all allow the call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        decision: {
          type: 'choice',
          choice: 'candidate_0',
          confidence: 0.99,
          probabilities: { candidate_0: 0.99, none: 0.01 },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createJevClientForGateFromEnvironment(
      'candidate_suitability',
      'user-a',
      {
        COGSEED_SEMANTICA_ENABLED: 'true',
        COGSEED_JEV_ENABLED: 'true',
        COGSEED_JEV_ENDPOINT: 'https://jev.example/evaluate',
        COGSEED_JEV_API_KEY: 'secret',
        COGSEED_JEV_GATES: 'candidate_suitability',
        COGSEED_JEV_ROLLOUT_PERCENT: '100',
        COGSEED_JEV_MAX_RETRIES: '0',
      },
      { fetch: fetchImpl },
    );

    await expect(client.evaluate({
      requestId: 'rollout-request',
      gate: 'candidate_suitability',
      question: { id: 'rollout-question', kind: 'choice', text: '选择候选' },
      query: '脱敏问题',
      candidates: [{ id: 'aa-candidate', summary: '脱敏候选', source: 'semantic' }],
    })).resolves.toMatchObject({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
