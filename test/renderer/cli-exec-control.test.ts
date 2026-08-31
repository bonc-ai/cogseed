import { describe, it, expect } from 'vitest';
// 渲染层经典 script 走 CJS 测试桥；主进程 TS 直接 import（先例：
// auto-title-parity.test.ts）。本测试的核心职责之一是把两份能力表钉死——
// 经典 script 无 import 能力只能复制，一致性靠测试守住（漂移即红）。
const cliExecControl = require('../../src/renderer/modules/cli-exec-control.js') as {
  CLI_EXEC_CONTROL: Record<string, { model: boolean; effort: boolean }>;
  execControlFor: (cli: string) => { model: boolean; effort: boolean };
  contextWindowForCliModel: (cli: string, modelId: string, entry?: unknown) => number | null;
  mergedCliModels: (cli: string, entry?: unknown) => Array<{ id: string; label: string; source: string; contextWindow?: number }>;
  customModelsFor: (cli: string) => string[];
  rememberCustomModel: (cli: string, id: string) => void;
};
import { execControlFor as mainExecControlFor, contextWindowForCliModel as mainWindowFor } from '../../src/main/features/local_agents/models';

describe('cli-exec-control capability table parity (renderer vs main)', () => {
  it('renderer CLI_EXEC_CONTROL matches the main-process table for every known CLI', () => {
    const known = ['claude', 'codex', 'opencode', 'openclaw', 'hermes', 'workbuddy', 'gemini', 'aider'];
    for (const cli of known) {
      expect(cliExecControl.execControlFor(cli), `capability mismatch for ${cli}`).toEqual(mainExecControlFor(cli));
    }
  });

  it('unknown CLIs degrade to read-only (no fake switches)', () => {
    expect(cliExecControl.execControlFor('')).toEqual({ model: false, effort: false });
    expect(cliExecControl.execControlFor('something-new')).toEqual({ model: false, effort: false });
  });
});

describe('cli-exec-control context window resolution', () => {
  it('maps claude aliases to public window specs on both layers', () => {
    expect(cliExecControl.contextWindowForCliModel('claude', 'sonnet')).toBe(200_000);
    expect(cliExecControl.contextWindowForCliModel('claude', 'opus')).toBe(200_000);
    expect(cliExecControl.contextWindowForCliModel('claude', 'sonnet[1m]')).toBe(1_048_576);
    expect(cliExecControl.contextWindowForCliModel('claude', 'claude-sonnet-5[1M]')).toBe(1_048_576);
    // 与主进程映射同值（claude 分支一致性）。
    for (const id of ['sonnet', 'opus', 'sonnet[1m]', 'claude-sonnet-5[1M]']) {
      expect(cliExecControl.contextWindowForCliModel('claude', id)).toBe(mainWindowFor('claude', id));
    }
  });

  it('falls back to scanned/static entries, then null (honest omission)', () => {
    const entry = {
      models: [{ id: 'opencode/claude-opus-5', label: 'claude-opus-5' }],
      staticModels: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 272_000 }],
    };
    expect(cliExecControl.contextWindowForCliModel('opencode', 'gpt-5.6-sol', entry)).toBe(272_000);
    expect(cliExecControl.contextWindowForCliModel('opencode', 'unknown-model', entry)).toBeNull();
    // codex 完整 id 在主进程侧走公共目录。
    expect(mainWindowFor('codex', 'gpt-5.6-sol')).toBe(272_000);
  });
});

describe('cli-exec-control merged model view', () => {
  it('unions scan ∪ static ∪ custom, first source wins on duplicate ids', () => {
    const entry = {
      models: [{ id: 'sonnet', label: 'Sonnet (扫描)' }],
      staticModels: [
        { id: 'sonnet', label: 'Sonnet (内置)' },
        { id: 'opus', label: 'Opus', contextWindow: 200_000 },
      ],
    };
    const merged = cliExecControl.mergedCliModels('claude', entry);
    expect(merged.find((m) => m.id === 'sonnet')?.source).toBe('scan');
    expect(merged.find((m) => m.id === 'opus')?.contextWindow).toBe(200_000);
    expect(merged.filter((m) => m.id === 'sonnet')).toHaveLength(1);
  });

  it('keeps manual entries (localStorage bridge is a no-op outside browsers)', () => {
    // Node 环境 localStorage 不可用 → customModelsFor 安全返回 []，
    // merged 视图不因手输记忆缺失而崩。
    expect(cliExecControl.customModelsFor('claude')).toEqual([]);
    expect(() => cliExecControl.rememberCustomModel('claude', 'x')).not.toThrow();
    const merged = cliExecControl.mergedCliModels('claude', null);
    expect(Array.isArray(merged)).toBe(true);
  });
});
