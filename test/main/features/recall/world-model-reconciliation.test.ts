import { describe, expect, it } from 'vitest';
import { reconcileWorldModel } from '../../../../src/main/features/recall/world-model-reconciliation';

const forecast = {
  aHat: {
    plan: ['Inspect callback', 'Write fix', 'Run tests'],
    expectedTools: ['read_file', 'write_file', 'exec_command'],
    expectedActors: ['commander'],
  },
  rHat: {
    summary: 'OAuth callback is fixed',
    acceptanceSignals: ['OAuth tests pass', 'External conversion improves'],
    predictedFiles: ['src/auth/callback.ts'],
  },
  causalLinks: [{ interventionIndex: 1, mechanism: 'State validation prevents invalid callbacks', ruleRefs: ['rule:asset-a:1'], assumptions: [] }],
  assumptions: [],
  predictedRisks: [],
};

function episode(overrides: Record<string, unknown> = {}): any {
  return {
    a: {
      toolCalls: [
        { sequence: 0, actor: 'commander', name: 'read_file', status: 'ok' },
        { sequence: 1, actor: 'commander', name: 'write_file', status: 'ok' },
        { sequence: 2, actor: 'commander', name: 'exec_command', status: 'ok' },
      ],
      agentActions: [
        { sequence: 0, actor: 'commander', action: 'Inspect callback', status: 'ok' },
        { sequence: 1, actor: 'commander', action: 'Write fix', status: 'ok' },
        { sequence: 2, actor: 'commander', action: 'Run tests', status: 'ok' },
      ],
    },
    r: {
      status: 'completed',
      finalText: 'Done',
      producedFiles: ['src/auth/callback.ts'],
      verification: { checks: { 'OAuth tests pass': true } },
    },
    ...overrides,
  };
}

describe('world-model reconciliation detail', () => {
  it('keeps the result signal when a predicted tool is missing (no veto)', () => {
    const current = episode();
    current.a.toolCalls = current.a.toolCalls.filter((call: any) => call.name !== 'write_file');
    const result = reconcileWorldModel(forecast, current);
    expect(result.deltaA).toBeLessThan(0);
    // P1-3: execution deviation no longer erases the (positive) result.
    expect(result.deltaR).toBe(0);
    expect(result.attribution).toBe('execution_gap');
    expect(result.actionDelta.missingTools).toEqual(['write_file']);
  });

  it('keeps the result signal for failed actions, wrong actor, and wrong order (no veto)', () => {
    const current = episode();
    current.a.toolCalls[0].actor = 'agent-a';
    current.a.toolCalls[1].status = 'error';
    current.a.toolCalls = [current.a.toolCalls[1], current.a.toolCalls[0], current.a.toolCalls[2]];
    current.a.toolCalls.forEach((call: any, index: number) => { call.sequence = index; });
    const result = reconcileWorldModel(forecast, current);
    // Result measurement survives the execution deviation.
    expect(result.deltaR).toBe(0);
    expect(result.actionDelta.failedActions).toContain('write_file');
    expect(result.actionDelta.unexpectedActors).toContain('agent-a');
    expect(result.actionDelta.orderMismatch).toBe(true);
  });

  it('evaluates every acceptance signal and predicted file with evidence', () => {
    const result = reconcileWorldModel(forecast, episode());
    expect(result.deltaA).toBe(0);
    expect(result.resultDelta.acceptanceSignals).toEqual([
      expect.objectContaining({ signal: 'OAuth tests pass', status: 'met' }),
      expect.objectContaining({ signal: 'External conversion improves', status: 'unknown' }),
    ]);
    expect(result.resultDelta.missingPredictedFiles).toEqual([]);
    expect(result.deltaR).toBe(0);
  });

  it('does not use finalText alone as success evidence', () => {
    const current = episode();
    current.r.verification = undefined;
    current.r.producedFiles = [];
    const result = reconcileWorldModel({
      ...forecast,
      rHat: { ...forecast.rHat, predictedFiles: [] },
    }, current);
    expect(result.deltaA).toBe(0);
    expect(result.deltaR).toBe('unknown');
    expect(result.attribution).toBe('unclear');
  });

  it('does not guess attribution from selected asset types (honest unclear fallback)', () => {
    const current = episode();
    current.r.producedFiles = [];
    current.r.verification = { checks: { 'OAuth tests pass': false } };
    const result = reconcileWorldModel(forecast, current, {
      selectedAssetTypes: ['rule'],
    });
    expect(result.deltaA).toBe(0);
    expect(result.deltaR).toBeLessThan(0);
    // P1-4: the deterministic path measures but must NOT fake the cause.
    expect(result.attribution).toBe('unclear');
  });

  it('preserves the result signal when the execution deviates (no veto)', () => {
    const current = episode();
    current.r.verification = { checks: { 'OAuth tests pass': true } };
    // Introduce an execution deviation: predicted tool not actually used.
    current.a.toolCalls = [{ name: 'write_file', status: 'ok' }];
    const result = reconcileWorldModel({
      ...forecast,
      aHat: { ...forecast.aHat, expectedTools: ['read_file', 'write_file'] },
    }, current);
    expect(result.deltaA).toBeLessThan(0);
    // The result signal is NOT thrown away: verification passed → deltaR 0.
    expect(result.deltaR).toBe(0);
    expect(result.attribution).toBe('execution_gap');
    expect(result.resultDelta.acceptanceSignals).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'met' })]),
    );
  });
});
