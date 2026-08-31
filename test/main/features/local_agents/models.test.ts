import { describe, it, expect } from 'vitest';

import {
  defaultModel, listModels, execControlFor, contextWindowForCliModel,
} from '../../../../src/main/features/local_agents/models';

describe('local_agents/models', () => {
  it('returns curated catalogs and defaults for first-party CLI types', () => {
    const claude = listModels('claude');
    const codex = listModels('codex');

    // claude 静态目录与 CLI `/model` 本地命令披露的别名集对齐（运行时扫描
    // 的兜底镜像）；codex 保持完整 id 目录（窗口走公共目录解析）。
    expect(claude.map((model) => model.id)).toEqual([
      'default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]',
    ]);
    expect(codex.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    expect(defaultModel('claude')).toBe('default');
    expect(defaultModel('codex')).toBe('gpt-5.6-sol');
    // 静态条目携带窗口（会话统计 ctx 分母的数据源之一）。
    expect(claude.find((m) => m.id === 'sonnet[1m]')?.contextWindow).toBe(1_048_576);
    expect(codex.find((m) => m.id === 'gpt-5.6-sol')?.contextWindow).toBe(272_000);
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
      expect(execControlFor('claude')).toEqual({ model: true, effort: true });
      expect(execControlFor('codex')).toEqual({ model: true, effort: true });
    });

    it('degrades every other CLI to read-only (no fake switches)', () => {
      for (const cli of ['openclaw', 'opencode', 'hermes', 'workbuddy', 'gemini', 'aider', '', 'unknown-cli']) {
        expect(execControlFor(cli), `capability for ${cli || '(empty)'}`).toEqual({ model: false, effort: false });
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
