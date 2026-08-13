import { describe, expect, it } from 'vitest';
import { applyCausalRules, reconcileWorldModel } from '../../../../src/main/features/recall/world-model';
import { normalizeCausalRule } from '../../../../src/main/features/recall/world-model-types';
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

describe('recall world-model reconciliation', () => {
  const forecast = {
    aHat: { plan: ['write'], expectedTools: ['write_file'], expectedActors: ['commander'] },
    rHat: { summary: 'done', acceptanceSignals: ['verified'], predictedFiles: ['report.md'] },
    predictedRisks: [],
  };

  function episode(overrides: Partial<any> = {}): any {
    return {
      a: { toolCalls: [{ name: 'write_file', status: 'ok' }], agentActions: [] },
      r: { status: 'completed', finalText: 'done', producedFiles: ['report.md'], verification: { passed: true } },
      ...overrides,
    };
  }

  it('returns execution_gap when a predicted tool was not realized (deltaA gate)', () => {
    const result = reconcileWorldModel(forecast, episode({ a: { toolCalls: [{ name: 'read_file', status: 'ok' }] } }));
    expect(result.deltaA).toBe(-1);
    expect(result.deltaR).toBe('unknown');
    expect(result.attribution).toBe('execution_gap');
  });

  it('returns clean deltaR when predicted and realized interventions match', () => {
    const result = reconcileWorldModel(forecast, episode());
    expect(result.deltaA).toBe(0);
    expect(result.deltaR).toBe(0);
  });

  it('marks deltaR polluted when tools match but predicted files are missing', () => {
    const result = reconcileWorldModel(forecast, episode({ r: { status: 'completed', finalText: 'done', producedFiles: [], verification: { passed: true } } }));
    expect(result.deltaA).toBe(0);
    expect(result.deltaR).toBe(-1);
    expect(result.attribution).toBe('knowledge_gap');
  });
});

describe('recall world-model multi-candidate simulation', () => {
  it('parses multiple candidates and freezes the locally selected pair', async () => {
    const worldModel = await import('../../../../src/main/features/recall/world-model');
    const input = {
      k: {
        projectionId: 'proj-a',
        projectionConfirmedAt: '2026-08-13T00:00:00.000Z',
        abilityAssetRefs: ['asset-a'],
        abilityAssets: [],
        assetVersions: { 'asset-a': '1' },
        rules: [{
          id: 'rule:asset-a:1', assetId: 'asset-a', assetVersion: '1',
          rule: { cause: 'Missing check', effect: 'Failure', mitigation: 'Add check', severity: 'high', deltaR: -0.8 },
        }],
      },
      s: {
        snapshotId: 'snap-a', conversationSummary: 'Fix OAuth callback',
        environment: { workspaceAvailable: true, modelConfigured: true, fileSystemAvailable: true, shellAvailable: true },
        execution: {
          groupChatStatus: 'running', availableActors: ['commander'],
          availableTools: ['read_file', 'write_file', 'exec_command'], accessConstraints: [], energyConstraints: [],
        },
        lifecycle: { projectionStatus: 'confirmed' },
        recall: { selectedAssetCount: 1, selectedRuleCount: 1 },
      },
      t: { userGoal: 'Fix OAuth callback', constraints: [], acceptanceCriteria: ['Tests pass'] },
    } as any;
    const response = JSON.stringify({
      candidates: [
        {
          id: 'path-a', plan: ['Inspect'], expectedTools: ['read_file'], expectedActors: ['commander'],
          predictedResult: { summary: 'Inspected only', acceptanceSignals: ['Inspection recorded'], predictedFiles: [] },
          causalLinks: [{ interventionIndex: 0, mechanism: 'Inspection reveals the issue', ruleRefs: ['rule:asset-a:1'], assumptions: [] }],
          assumptions: [], riskRuleRefs: ['rule:asset-a:1'],
          score: { goalFit: 0.4, feasibility: 1, observability: 0.8, causalSupport: 0.8, riskPenalty: 0.2, total: 1 },
        },
        {
          id: 'path-b', plan: ['Inspect', 'Fix', 'Test'], expectedTools: ['read_file', 'write_file', 'exec_command'], expectedActors: ['commander'],
          predictedResult: { summary: 'OAuth callback fixed', acceptanceSignals: ['Tests pass'], predictedFiles: ['src/auth/callback.ts'] },
          causalLinks: [{ interventionIndex: 1, mechanism: 'The state check prevents invalid callbacks', ruleRefs: ['rule:asset-a:1'], assumptions: [] }],
          assumptions: ['Tests reproduce the issue'], riskRuleRefs: ['rule:asset-a:1'],
          score: { goalFit: 0.95, feasibility: 0.9, observability: 0.9, causalSupport: 0.9, riskPenalty: 0.1, total: 0 },
        },
      ],
    });

    const forecast = await worldModel.simulateWorld('user-a', input, snapshot(), {
      runModel: async () => response,
    });

    expect(forecast.candidates).toHaveLength(2);
    expect(forecast.selectedCandidateId).toBe('path-b');
    expect(forecast.aHat).toEqual(forecast.candidates?.[1].aHat);
    expect(forecast.rHat).toEqual(forecast.candidates?.[1].rHat);
    expect(forecast.candidates?.[0].score.total).not.toBe(1);
  });
});
