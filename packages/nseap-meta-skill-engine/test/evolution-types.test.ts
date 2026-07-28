import { describe, it, expect } from 'vitest';
import { KSTAR_STEPS, type EvolutionRun, type EvolutionStep } from '../src/types/evolution';

describe('evolution types', () => {
  it('KSTAR_STEPS 固定 7 步且顺序正确', () => {
    expect(KSTAR_STEPS).toEqual(['Capture', 'Attribution', 'Propose', 'Evaluate', 'Govern', 'Apply', 'Evolve']);
  });

  it('EvolutionRun 可构造出合法状态机对象', () => {
    const step: EvolutionStep = { step: 1, name: 'Capture', status: 'pending' };
    const run: EvolutionRun = {
      runId: 'run-1', skillId: 'skill-1', status: 'running', currentStep: 1,
      startedAt: 't', updatedAt: 't', steps: [step],
    };
    expect(run.steps[0].name).toBe('Capture');
    expect(run.status).toBe('running');
  });
});
