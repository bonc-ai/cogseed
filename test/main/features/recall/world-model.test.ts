import { describe, expect, it } from 'vitest';
import { applyCausalRules, normalizeCausalRule } from '../../../../src/main/features/recall/world-model';
import type { WorldModelSnapshot } from '../../../../src/main/features/recall/world-model-types';

function snapshot(overrides: Partial<WorldModelSnapshot> = {}): WorldModelSnapshot {
  return {
    schemaVersion: 1,
    ownerId: 'user-a',
    id: 'snap-1',
    taskRunId: 'task-1',
    environment: {
      workspace: { ok: true, path: '/ws' },
      model: { configured: true, profile: 'cp-1' },
      tools: { fileSystem: true, bash: true },
    },
    core: {
      groupChat: { status: 'idle' },
      kstar: { requirementStatus: 'open' },
      recall: { projectionStatus: 'preview' },
    },
    skills: { total: 12, categories: ['general'], status: 'ok' },
    ontology: { totalAssets: 8, activeAssets: 5, totalRules: 6 },
    createdAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

const rule = (overrides: Record<string, unknown> = {}) => ({
  cause: 'Workspace unavailable',
  predicateKey: 'workspace_unavailable',
  effect: 'File tools fail',
  mitigation: 'Check workspace path',
  severity: 'high',
  deltaR: -0.8,
  ...overrides,
});

describe('recall world-model causal rules', () => {
  it('normalizes a valid causal rule', () => {
    expect(normalizeCausalRule(rule())).toMatchObject({
      cause: 'Workspace unavailable',
      predicateKey: 'workspace_unavailable',
      effect: 'File tools fail',
      mitigation: 'Check workspace path',
      severity: 'high',
      deltaR: -0.8,
    });
  });

  it('rejects unknown predicate keys', () => {
    expect(() => normalizeCausalRule(rule({ predicateKey: 'nope' }))).toThrow(/predicate/i);
  });

  it('rejects out-of-range deltaR', () => {
    expect(() => normalizeCausalRule(rule({ deltaR: 2 }))).toThrow(/deltaR/i);
  });

  it('matches workspace_unavailable when the snapshot workspace is down', () => {
    const risks = applyCausalRules(
      snapshot({ environment: { ...snapshot().environment, workspace: { ok: false } } }),
      [normalizeCausalRule(rule()) as any],
    );
    expect(risks).toEqual([expect.objectContaining({ cause: 'Workspace unavailable', severity: 'high' })]);
  });

  it('does not fire a rule whose predicate is satisfied', () => {
    const risks = applyCausalRules(snapshot(), [normalizeCausalRule(rule()) as any]);
    expect(risks).toEqual([]);
  });

  it('skips rules without a predicate key in the deterministic pass', () => {
    const risks = applyCausalRules(
      snapshot({ environment: { ...snapshot().environment, workspace: { ok: false } } }),
      [normalizeCausalRule(rule({ predicateKey: undefined })) as any],
    );
    expect(risks).toEqual([]);
  });

  it('fires too_few_rules when ontology has fewer than five rules', () => {
    const risks = applyCausalRules(
      snapshot({ ontology: { totalAssets: 2, activeAssets: 1, totalRules: 3 } }),
      [normalizeCausalRule(rule({ cause: 'Too few rules', predicateKey: 'too_few_rules', severity: 'low', deltaR: -0.2 })) as any],
    );
    expect(risks).toEqual([expect.objectContaining({ cause: 'Too few rules' })]);
  });
});
