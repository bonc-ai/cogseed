import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  startEvolutionRun, stepEvolutionRun, readEvolutionRun,
} from '../../../../src/main/features/evolution/orchestrator-bridge';

vi.mock('../../../../src/main/features/evolution/llm-bridge', () => ({
  buildLlmComplete: () => async (p: string) => ({ text: p.includes('改进') ? '改进正文' : '{"passed":true}', degraded: false }),
}));
// engine-loader 返回真引擎语义的最小编排器实现（start 建 7 步，step 逐步推进）。
vi.mock('../../../../src/main/features/evolution/engine-loader', () => {
  const STEPS = ['Capture', 'Attribution', 'Propose', 'Evaluate', 'Govern', 'Apply', 'Evolve'];
  class FakeOrch {
    private runs = new Map<string, any>();
    constructor(private deps: { llm?: (p: string) => Promise<{ text: string; degraded: boolean }> }) {}
    start(o: any) {
      const run = { runId: o.runId, skillId: o.skillId, status: 'running', currentStep: 0,
        startedAt: 't', updatedAt: 't', steps: STEPS.map((name, i) => ({ step: i + 1, name, status: 'pending' })),
        _content: o.currentContent };
      this.runs.set(o.runId, run); return run;
    }
    async step(id: string) {
      const run = this.runs.get(id); const s = run.steps[run.currentStep];
      s.status = 'done';
      if (s.name === 'Propose') s.output = (await this.deps.llm!('改进：' + run._content)).text;
      run.currentStep++; return run;
    }
    abort(id: string) { const r = this.runs.get(id); r.status = 'aborted'; return r; }
  }
  return { loadEngine: async () => ({ EvolutionOrchestrator: FakeOrch }) };
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

const episode = { episode_id: 'ep', situation: 's', task: 't', action_hat: '', result_hat: '', actual_action: '', actual_result: '', delta_r: 0.8, delta_a: 0 };

describe('orchestrator-bridge', () => {
  it('startEvolutionRun 落盘初始状态机', async () => {
    const run = await startEvolutionRun('u1', { skillId: 'sk1', episode, currentContent: '原文' });
    const disk = await readEvolutionRun('u1', run.runId);
    expect(disk?.steps).toHaveLength(7);
    expect(disk?.status).toBe('running');
  });

  it('stepEvolutionRun 推进并持久化每步输出', async () => {
    const run = await startEvolutionRun('u1', { skillId: 'sk1', episode, currentContent: '原文' });
    await stepEvolutionRun('u1', run.runId); // Capture
    await stepEvolutionRun('u1', run.runId); // Attribution
    const after = await stepEvolutionRun('u1', run.runId); // Propose
    expect(after.steps[2].status).toBe('done');
    const disk = await readEvolutionRun('u1', run.runId);
    expect(String(disk?.steps[2].output)).toContain('改进');
  });
});
