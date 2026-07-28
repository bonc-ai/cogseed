import { describe, it, expect } from 'vitest';
import { EvolutionOrchestrator } from '../src/modules/evolution-orchestrator';
import type { LlmComplete } from '../src/modules/llm-port';
import type { KSTAREpisode } from '../src/types/index.js';

const episode: KSTAREpisode = {
  episode_id: 'ep-1', situation: 's', task: 't', action_hat: 'ah', result_hat: 'rh',
  actual_action: 'aa', actual_result: 'ar', delta_r: 0.8, delta_a: 0,
} as KSTAREpisode;

const mockLlm: LlmComplete = async (p) => ({ text: p.includes('改进') ? '改进后的正文' : '{"passed":true,"reason":"ok"}', degraded: false });

describe('EvolutionOrchestrator', () => {
  it('start 初始化 7 步 pending 状态机', () => {
    const o = new EvolutionOrchestrator({ llm: mockLlm });
    const run = o.start({ runId: 'r1', skillId: 'sk1', episode, currentContent: '原正文' });
    expect(run.steps).toHaveLength(7);
    expect(run.steps.every(s => s.status === 'pending')).toBe(true);
    expect(run.status).toBe('running');
  });

  it('step 逐步推进，步 3 用 llm 生成改进正文并写入 output', async () => {
    const o = new EvolutionOrchestrator({ llm: mockLlm });
    o.start({ runId: 'r2', skillId: 'sk1', episode, currentContent: '原正文' });
    await o.step('r2'); // 1 Capture
    await o.step('r2'); // 2 Attribution
    const run = await o.step('r2'); // 3 Propose
    const propose = run.steps.find(s => s.name === 'Propose')!;
    expect(propose.status).toBe('done');
    expect(String(propose.output)).toContain('改进');
    expect(propose.degraded).toBeFalsy();
  });

  it('无 llm 时步 3 降级并标记 degraded', async () => {
    const o = new EvolutionOrchestrator({}); // 不注入 llm
    o.start({ runId: 'r3', skillId: 'sk1', episode, currentContent: '原正文' });
    await o.step('r3'); await o.step('r3');
    const run = await o.step('r3');
    const propose = run.steps.find(s => s.name === 'Propose')!;
    expect(propose.status).toBe('degraded');
    expect(propose.degraded).toBe(true);
  });

  it('abort 直接置 aborted，不重试', () => {
    const o = new EvolutionOrchestrator({ llm: mockLlm });
    o.start({ runId: 'r4', skillId: 'sk1', episode, currentContent: 'x' });
    const run = o.abort('r4');
    expect(run.status).toBe('aborted');
  });
});
