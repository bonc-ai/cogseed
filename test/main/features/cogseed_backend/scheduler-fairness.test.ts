import { describe, expect, it } from 'vitest';

import {
  chooseRoundRobinScope,
  chooseWeightedServiceScope,
  createSchedulerFairnessState,
  createSchedulerScopeBudgetState,
  releaseSchedulerScopeBudget,
  reserveSchedulerScopeBudget,
} from '../../../../src/main/features/cogseed_backend/scheduler-fairness';

describe('CogSeed scheduler fairness primitives', () => {
  it('chooses eligible scopes with deterministic round-robin order', () => {
    let state = createSchedulerFairnessState();
    const candidates = [
      { userId: 'user-a', scopeId: 'scope-a' },
      { userId: 'user-a', scopeId: 'scope-b' },
      { userId: 'user-a', scopeId: 'scope-c' },
    ];

    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = chooseRoundRobinScope(state, { fairnessKey: 'queue-main', candidates });
      expect(result.selected).toBeTruthy();
      seen.push(result.selected!.scopeId);
      state = result.state;
    }

    expect(seen).toEqual(['scope-a', 'scope-b', 'scope-c', 'scope-a', 'scope-b']);
  });

  it('uses weighted service-share deterministically', () => {
    let state = createSchedulerFairnessState();
    const candidates = [
      { userId: 'user-a', scopeId: 'scope-a', weight: 3 },
      { userId: 'user-a', scopeId: 'scope-b', weight: 1 },
    ];
    const seen: string[] = [];

    for (let i = 0; i < 8; i++) {
      const result = chooseWeightedServiceScope(state, { fairnessKey: 'queue-main', candidates });
      expect(result.selected).toBeTruthy();
      seen.push(result.selected!.scopeId);
      state = result.state;
    }

    expect(seen.filter((scope) => scope === 'scope-a')).toHaveLength(6);
    expect(seen.filter((scope) => scope === 'scope-b')).toHaveLength(2);
    expect(seen).toEqual(['scope-a', 'scope-b', 'scope-a', 'scope-a', 'scope-a', 'scope-b', 'scope-a', 'scope-a']);
  });

  it('enforces per-scope budgets in selection and reservation helpers', () => {
    let fairness = createSchedulerFairnessState();
    let budgets = createSchedulerScopeBudgetState([
      { userId: 'user-a', scopeId: 'scope-a', limit: 1, used: 1 },
      { userId: 'user-a', scopeId: 'scope-b', limit: 1, used: 0 },
    ]);

    let result = chooseRoundRobinScope(fairness, {
      fairnessKey: 'queue-main',
      candidates: [
        { userId: 'user-a', scopeId: 'scope-a' },
        { userId: 'user-a', scopeId: 'scope-b' },
      ],
      budgets,
    });
    expect(result.selected?.scopeId).toBe('scope-b');
    fairness = result.state;

    const reserved = reserveSchedulerScopeBudget(budgets, { userId: 'user-a', scopeId: 'scope-b', amount: 1 });
    expect(reserved.reserved).toBe(true);
    budgets = reserved.state;

    result = chooseRoundRobinScope(fairness, {
      fairnessKey: 'queue-main',
      candidates: [
        { userId: 'user-a', scopeId: 'scope-a' },
        { userId: 'user-a', scopeId: 'scope-b' },
      ],
      budgets,
    });
    expect(result).toMatchObject({ selected: null, reason: 'budget_exhausted' });

    budgets = releaseSchedulerScopeBudget(budgets, { userId: 'user-a', scopeId: 'scope-a', amount: 1 }).state;
    result = chooseRoundRobinScope(fairness, {
      fairnessKey: 'queue-main',
      candidates: [
        { userId: 'user-a', scopeId: 'scope-a' },
        { userId: 'user-a', scopeId: 'scope-b' },
      ],
      budgets,
    });
    expect(result.selected?.scopeId).toBe('scope-a');
  });

  it('validates ids, duplicate candidates, weights, and budgets', () => {
    const state = createSchedulerFairnessState();
    expect(() => chooseRoundRobinScope(state, { fairnessKey: 'queue main', candidates: [{ userId: 'user-a', scopeId: 'scope-a' }] })).toThrow(/invalid/i);
    expect(() => chooseRoundRobinScope(state, { fairnessKey: 'queue-main', candidates: [{ userId: 'bad/user', scopeId: 'scope-a' }] })).toThrow(/invalid/i);
    expect(() => chooseRoundRobinScope(state, { fairnessKey: 'queue-main', candidates: [{ userId: 'user-a', scopeId: 'scope-a' }, { userId: 'user-a', scopeId: 'scope-a' }] })).toThrow(/duplicate/i);
    expect(() => chooseWeightedServiceScope(state, { fairnessKey: 'queue-main', candidates: [{ userId: 'user-a', scopeId: 'scope-a', weight: 0 }] })).toThrow(/weight/i);
    expect(() => createSchedulerScopeBudgetState([{ userId: 'user-a', scopeId: 'scope-a', limit: -1, used: 0 }])).toThrow(/budget/i);
  });
});
