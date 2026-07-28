import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/main/features/evolution/engine-loader', () => ({
  loadEngine: async () => ({ ruleFallbackComplete: async () => ({ text: '[规则降级：未接入模型] 占位', degraded: true }) }),
}));

import { buildLlmComplete } from '../../../../src/main/features/evolution/llm-bridge';

describe('降级贯穿', () => {
  it('buildRunner 空返回 → llm degraded:true 且文本非空', async () => {
    const fakeBuild = vi.fn().mockResolvedValue({ runner: { runReflection: async () => '' } });
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    const r = await llm('生成改进');
    expect(r.degraded).toBe(true);
    expect(r.text).toContain('规则降级');
  });

  it('buildRunner 抛错 → llm 不外抛，仍降级', async () => {
    const fakeBuild = vi.fn().mockRejectedValue(new Error('无可用模型'));
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    const r = await llm('生成改进');
    expect(r.degraded).toBe(true);
  });
});
