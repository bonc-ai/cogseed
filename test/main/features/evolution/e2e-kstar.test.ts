import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/evolution/llm-bridge', () => ({
  buildLlmComplete: () => async (p: string) => ({ text: p.includes('改进') ? '改进正文' : '{"passed":true}', degraded: false }),
}));
vi.mock('../../../../src/main/features/evolution/engine-loader', () => {
  const STEPS = ['Capture', 'Attribution', 'Propose', 'Evaluate', 'Govern', 'Apply', 'Evolve'];
  class Orch {
    private runs = new Map<string, any>();
    constructor(private deps: any) {}
    start(o: any) {
      const run = { runId: o.runId, skillId: o.skillId, status: 'running', currentStep: 0, startedAt: 't', updatedAt: 't',
        steps: STEPS.map((name, i) => ({ step: i + 1, name, status: 'pending' })), _c: o.currentContent };
      this.runs.set(o.runId, run); return run;
    }
    async step(id: string) {
      const r = this.runs.get(id); if (r.currentStep >= 7) return r;
      const s = r.steps[r.currentStep]; s.status = 'done';
      if (s.name === 'Propose') s.output = (await this.deps.llm('改进：' + r._c)).text;
      r.currentStep++; if (r.currentStep >= 7) r.status = 'done'; return r;
    }
    abort(id: string) { const r = this.runs.get(id); r.status = 'aborted'; return r; }
  }
  return { loadEngine: async () => ({ EvolutionOrchestrator: Orch }) };
});

import { startEvolutionRun, stepEvolutionRun, readEvolutionRun } from '../../../../src/main/features/evolution/orchestrator-bridge';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-')); process.env.ORKAS_WORKSPACE_ROOT = dir; });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

const episode = { episode_id: 'ep', situation: 's', task: 't', action_hat: '', result_hat: '', actual_action: '', actual_result: '', delta_r: 0.8, delta_a: 0 };

describe('KSTAR 端到端', () => {
  it('start 后推进 7 步到 done，每步落盘', async () => {
    const run = await startEvolutionRun('u1', { skillId: 'sk1', episode, currentContent: '原文' });
    for (let i = 0; i < 7; i++) await stepEvolutionRun('u1', run.runId);
    const disk = await readEvolutionRun('u1', run.runId);
    expect(disk?.status).toBe('done');
    expect(disk?.steps.every(s => s.status === 'done')).toBe(true);
    expect(String(disk?.steps[2].output)).toContain('改进');
  });
});
