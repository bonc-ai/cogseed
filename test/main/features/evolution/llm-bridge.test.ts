import { describe, it, expect, vi } from 'vitest';
import { buildLlmComplete } from '../../../../src/main/features/evolution/llm-bridge';

const assertDispatchableMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../../../src/main/features/agent-dispatch-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/agent-dispatch-policy')>();
  return { ...actual, assertAgentChatDispatchable: assertDispatchableMock };
});

// 降级路径复用引擎 ruleFallbackComplete，mock engine-loader 避免依赖 dist 细节。
vi.mock('../../../../src/main/features/evolution/engine-loader', () => ({
  loadEngine: async () => ({ ruleFallbackComplete: async () => ({ text: '[规则降级]占位', degraded: true }) }),
}));

describe('buildLlmComplete', () => {
  it('runner 返回非空文本 → degraded:false', async () => {
    const fakeBuild = vi.fn().mockResolvedValue({ runner: { runReflection: async () => '真实结果' } });
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    const r = await llm('提示');
    expect(r.text).toBe('真实结果');
    expect(r.degraded).toBe(false);
  });

  it('runner 返回空串 → degraded:true 且给规则兜底文本', async () => {
    const fakeBuild = vi.fn().mockResolvedValue({ runner: { runReflection: async () => '' } });
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    const r = await llm('提示');
    expect(r.degraded).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('buildRunner 抛错 → degraded:true 不外抛', async () => {
    const fakeBuild = vi.fn().mockRejectedValue(new Error('无可用模型'));
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    const r = await llm('提示');
    expect(r.degraded).toBe(true);
  });

  it('每次调用生成独立 evolution- 前缀 sessionId', async () => {
    const seen: string[] = [];
    const fakeBuild = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      seen.push(sessionId);
      return { runner: { runReflection: async () => 'x' } };
    });
    const llm = buildLlmComplete({ userId: 'u1', agentId: '', buildRunnerFn: fakeBuild });
    await llm('a'); await llm('b');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every(s => s.startsWith('evolution-'))).toBe(true);
  });

  it('拒绝 management-only Agent，不允许规则降级绕过边界', async () => {
    assertDispatchableMock.mockRejectedValueOnce(Object.assign(
      new Error('management-only'),
      { code: 'E_AGENT_MANAGEMENT_ONLY' },
    ));
    const fakeBuild = vi.fn();
    const llm = buildLlmComplete({ userId: 'u1', agentId: 'expense-agent', buildRunnerFn: fakeBuild });
    await expect(llm('提示')).rejects.toMatchObject({ code: 'E_AGENT_MANAGEMENT_ONLY' });
    expect(assertDispatchableMock).toHaveBeenCalledWith('u1', 'expense-agent');
    expect(fakeBuild).not.toHaveBeenCalled();
  });
});
