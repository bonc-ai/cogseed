import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the real backend deps before importing welcome-message.
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  listAbilityAssets: vi.fn(async () => []),
}));
vi.mock('../../../../src/main/features/projects', () => ({
  getProject: vi.fn(async () => null),
}));
vi.mock('../../../../src/main/features/spaces', () => ({
  getSpace: vi.fn(async () => null),
}));
vi.mock('../../../../src/main/features/role_templates', () => ({
  getRoleTemplate: vi.fn(() => null),
}));
vi.mock('../../../../src/main/features/task_continuation', () => ({
  readContinuationSnapshot: vi.fn(async () => null),
}));
// Force the fixed-plan fallback by making the LLM runner throw.
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: vi.fn(async () => { throw new Error('no model'); }),
}));

import { generateWelcomeMessage } from '../../../../src/main/features/session_import/welcome-message';
import { listAbilityAssets } from '../../../../src/main/features/recall/asset-service';

describe('generateWelcomeMessage — v1.6 structured resume template', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces the three-part resume text with the fixed Action Plan fallback', async () => {
    vi.mocked(listAbilityAssets).mockResolvedValueOnce([]);
    const out = await generateWelcomeMessage({
      userId: 'u1',
      conversationId: 'c1',
      sessionSummary: '完善产品方案\n已梳理范围边界',
    });

    // 第一部分：项目介绍（真实快照数据）.
    expect(out.text).toContain('**项目**');
    expect(out.text).toContain('完善产品方案');

    // 第三部分：Action Plan（单一最该做的任务）+ 边界声明.
    expect(out.text).toContain('**建议 Action Plan**');
    expect(out.text).toContain('核对产品对象和术语');
    expect(out.plan.length).toBe(1);
    expect(out.text).toContain('我不会在运行中静默改写正式资产');
  });

  it('produces the「准备携带」strip from real confirmed assets', async () => {
    vi.mocked(listAbilityAssets).mockResolvedValueOnce([
      { id: 'a1', type: 'personal', title: '我是产品经理', statement: '偏好', status: 'active' } as any,
      { id: 'a2', type: 'skill_method', title: '方案审查', statement: '步骤', status: 'active' } as any,
    ]);
    const out = await generateWelcomeMessage({
      userId: 'u1',
      conversationId: 'c1',
      projectId: 'p1',
      sessionSummary: '',
    });

    // 第二部分：工作空间可用能力（关于我 1项 · 我的能力 1项）.
    expect(out.text).toContain('工作空间可用能力：关于我 1项 · 我的能力 1项');
    expect(out.text).toContain('只对目标任务生效');
    // 「查看依据」按钮由前端 welcome-carry 条渲染（依赖 carry 元数据）。
    expect(out.text).not.toContain('**查看依据**');
    // carry 元数据带真实来源.
    expect(out.carry.length).toBeGreaterThan(0);
    expect(out.carry.find((c) => c.kind === 'personal')?.count).toBe(1);
    expect(out.carry.find((c) => c.kind === 'ability')?.count).toBe(1);
  });

  it('uses the empty carry strip when nothing is confirmed', async () => {
    vi.mocked(listAbilityAssets).mockResolvedValueOnce([]);
    const out = await generateWelcomeMessage({ userId: 'u1', conversationId: 'c1', sessionSummary: '' });
    expect(out.text).toContain('工作空间可用能力：无');
    expect(out.carry).toEqual([]);
  });
});
