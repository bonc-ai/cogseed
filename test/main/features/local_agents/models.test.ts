import { describe, it, expect } from 'vitest';

import {
  canonicalClaudeCurrentModel, canonicalClaudeModelId,
  defaultModel, listModels, execControlFor, contextWindowForCliModel,
} from '../../../../src/main/features/local_agents/models';

describe('local_agents/models', () => {
  it('returns curated catalogs and defaults for first-party CLI types', () => {
    const claude = listModels('claude');
    const codex = listModels('codex');

    // claude 静态目录与 Claude Code 客户端模型选择器同款公开 id 目录
    // （用户 2026-09 以客户端截图为准对齐）——CLI `/model` 披露的别名
    // （sonnet/opus[1m]…）只作扫描规范化输入，不再直接进清单。
    expect(claude.map((model) => model.id)).toEqual([
      'claude-fable-5', 'claude-fable-5[1m]',
      'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001[1m]',
      'claude-opus-4-8', 'claude-opus-4-8[1m]',
      'claude-sonnet-5', 'claude-sonnet-5[1m]',
    ]);
    // 客户端同款描述文案（菜单行副标题）。
    expect(claude.find((m) => m.id === 'claude-fable-5')?.description).toBe('For your toughest challenges');
    expect(claude.find((m) => m.id === 'claude-haiku-4-5-20251001')?.description).toBe('Fastest for quick answers');
    expect(claude.find((m) => m.id === 'claude-opus-4-8')?.description).toBe('Most capable for ambitious work');
    expect(claude.find((m) => m.id === 'claude-sonnet-5')?.description).toBe('Most efficient for everyday tasks');
    // 1M 变体：客户端以「1M context window」为副标题，窗口 1M。
    expect(claude.find((m) => m.id === 'claude-sonnet-5[1m]')?.description).toBe('1M context window');
    expect(claude.find((m) => m.id === 'claude-sonnet-5[1m]')?.contextWindow).toBe(1_048_576);
    expect(claude.find((m) => m.id === 'claude-sonnet-5')?.contextWindow).toBe(200_000);
    // 目录不标 default：客户端目录没有「默认」行（跟随 CLI 默认由菜单的
    // 「跟随 CLI」行承担），且 isDefault 排序会打乱客户端条目顺序。
    expect(claude.some((m) => m.default)).toBe(false);
    expect(defaultModel('claude')).toBeNull();
    expect(codex.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    expect(defaultModel('codex')).toBe('gpt-5.6-sol');
    // 静态条目携带窗口（会话统计 ctx 分母的数据源之一）。
    expect(codex.find((m) => m.id === 'gpt-5.6-sol')?.contextWindow).toBe(272_000);
  });

  describe('canonicalClaudeModelId — 扫描别名规范化到客户端公开 id', () => {
    it('maps CLI /model aliases to the client-catalog public ids', () => {
      expect(canonicalClaudeModelId('sonnet')).toBe('claude-sonnet-5');
      expect(canonicalClaudeModelId('opus')).toBe('claude-opus-4-8');
      expect(canonicalClaudeModelId('haiku')).toBe('claude-haiku-4-5-20251001');
      expect(canonicalClaudeModelId('fable')).toBe('claude-fable-5');
      expect(canonicalClaudeModelId('sonnet[1m]')).toBe('claude-sonnet-5[1m]');
      expect(canonicalClaudeModelId('opus[1m]')).toBe('claude-opus-4-8[1m]');
      expect(canonicalClaudeModelId('fable[1m]')).toBe('claude-fable-5[1m]');
    });

    it('passes public ids through and drops client-unknown routing aliases', () => {
      expect(canonicalClaudeModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
      expect(canonicalClaudeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
      // 客户端目录没有的 CLI 路由别名（default/best/opusplan）：剔除出
      // 合并清单（跟随默认有「跟随 CLI」行承担，其余手输仍可用）——
      // 不猜映射，保证清单与客户端所见完全一致。
      expect(canonicalClaudeModelId('default')).toBeNull();
      expect(canonicalClaudeModelId('best')).toBeNull();
      expect(canonicalClaudeModelId('opusplan')).toBeNull();
      expect(canonicalClaudeModelId('')).toBeNull();
    });

    it('canonicalizes the CLI self-reported current model display name', () => {
      expect(canonicalClaudeCurrentModel('claude-sonnet-5')).toBe('claude-sonnet-5');
      expect(canonicalClaudeCurrentModel('Sonnet 5')).toBe('claude-sonnet-5');
      expect(canonicalClaudeCurrentModel('Sonnet')).toBe('claude-sonnet-5');
      expect(canonicalClaudeCurrentModel('Opus 4.8 [1m]')).toBe('claude-opus-4-8[1m]');
      // 无法唯一映射的显示名保持原样（诚实展示 CLI 自报值）。
      expect(canonicalClaudeCurrentModel('Opusplan')).toBeNull();
      expect(canonicalClaudeCurrentModel('default')).toBeNull();
      expect(canonicalClaudeCurrentModel('Some Future Model')).toBeNull();
      expect(canonicalClaudeCurrentModel('')).toBeNull();
    });
  });

  it('keeps dynamic or account-routed CLIs in free-text mode', () => {
    expect(listModels('openclaw')).toEqual([]);
    expect(listModels('opencode')).toEqual([]);
    expect(listModels('hermes')).toEqual([]);
    expect(defaultModel('openclaw')).toBeNull();
    expect(defaultModel('opencode')).toBeNull();
    expect(defaultModel('hermes')).toBeNull();
  });

  describe('execControlFor — 外接智能体执行控制能力表', () => {
    it('enables model + effort control only for CLIs with a real gateway path', () => {
      expect(execControlFor('claude')).toEqual({ model: true, effort: true, effortOff: false });
      expect(execControlFor('codex')).toEqual({ model: true, effort: true, effortOff: false });
      // hermes --reasoning（none|…）/ openclaw --thinking（off|…）有单次
      // 覆盖参数（--help 实测）——effort 开放且「关闭」档真实可表达。
      expect(execControlFor('hermes')).toEqual({ model: true, effort: true, effortOff: true });
      expect(execControlFor('openclaw')).toEqual({ model: true, effort: true, effortOff: true });
    });

    it('keeps model control open for every CLI (runtime negotiation decides), effort stays gated', () => {
      // 新语义：模型控制权威在网关运行时协商（/p3394/models 的
      // model_controllable），本表只是冷启动兜底——model 对未知 CLI 也放开
      // （无参数通道的网关会安全忽略信封里的 model）；effort 仅表内 CLI。
      for (const cli of ['opencode', 'gemini', 'aider', 'workbuddy', '', 'unknown-cli']) {
        expect(execControlFor(cli), `effort capability for ${cli || '(empty)'}`).toEqual({ model: true, effort: false, effortOff: false });
      }
    });
  });

  describe('contextWindowForCliModel — 别名/目录/公共目录三级解析', () => {
    it('resolves claude aliases from public specs', () => {
      expect(contextWindowForCliModel('claude', 'sonnet')).toBe(200_000);
      expect(contextWindowForCliModel('claude', 'opus')).toBe(200_000);
      expect(contextWindowForCliModel('claude', 'sonnet[1m]')).toBe(1_048_576);
      expect(contextWindowForCliModel('claude', 'claude-sonnet-5[1M]')).toBe(1_048_576);
      expect(contextWindowForCliModel('claude', 'opusplan')).toBe(200_000);
    });

    it('falls through to the static catalog and the public model catalog', () => {
      expect(contextWindowForCliModel('codex', 'gpt-5.6-sol')).toBe(272_000);
      expect(contextWindowForCliModel('codex', 'gpt-5.6-terra')).toBe(272_000);
    });

    it('returns null for unknown models (honest omission, no invented numbers)', () => {
      expect(contextWindowForCliModel('claude', '')).toBeNull();
      expect(contextWindowForCliModel('codex', 'totally-unknown')).toBeNull();
      expect(contextWindowForCliModel('hermes', 'anything')).toBeNull();
    });
  });
});
