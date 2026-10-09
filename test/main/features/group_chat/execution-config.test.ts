// Unified execution entry — per-task execution config validation contract.
//
// The renderer's execution_config (model / reasoning-effort picks from the
// composer) is advisory at the business boundary: `_validatedExecutionConfig`
// shape-checks it, drops unknown enum values, keeps the CLI-agent
// model-only shape, and collapses all-empty objects to null. These tests pin
// that contract so a renderer regression can never push a malformed override
// into the turn pipeline (where it would either crash resolution or silently
// reroute a turn).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-exec-cfg';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-exec-cfg-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function loadFacade() {
  return import('../../../../src/main/features/group_chat/index');
}

describe('group_chat › _validatedExecutionConfig (unified execution entry)', () => {
  it('keeps a full provider+model pair with effort', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      effort: 'high',
    })).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', effort: 'high' });
  });

  it('keeps a model-only override (CLI-agent shape) and drops a provider-only one', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ model: 'claude-sonnet-4-6' }))
      .toEqual({ model: 'claude-sonnet-4-6' });
    // Provider without model is meaningless — collapses to null (unless an
    // effort rides along, which then survives on its own).
    expect(facade._validatedExecutionConfig({ provider: 'zai' })).toBeNull();
    expect(facade._validatedExecutionConfig({ provider: 'zai', effort: 'low' }))
      .toEqual({ effort: 'low' });
  });

  it('keeps a bare effort override', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ effort: 'off' })).toEqual({ effort: 'off' });
  });

  it('drops unknown effort enum values', async () => {
    const facade = await loadFacade();
    // 'auto' never travels down this path (renderer omits the field); an
    // explicit 'auto' or garbage enum must not sneak through.
    expect(facade._validatedExecutionConfig({ effort: 'auto' })).toBeNull();
    expect(facade._validatedExecutionConfig({ effort: 'ultra' as any })).toBeNull();
  });

  it('collapses empty / non-object / blank-field payloads to null', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig(null)).toBeNull();
    expect(facade._validatedExecutionConfig(undefined)).toBeNull();
    expect(facade._validatedExecutionConfig('model')).toBeNull();
    expect(facade._validatedExecutionConfig({})).toBeNull();
    expect(facade._validatedExecutionConfig({ provider: '  ', model: '  ' })).toBeNull();
  });

  it('trims whitespace around ids', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ provider: ' zai ', model: ' glm-5 ' }))
      .toEqual({ provider: 'zai', model: 'glm-5' });
  });

  it('rejects control characters and oversized provider/model strings', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfig({ model: 'glm-5\nforged' })).toBeNull();
    expect(facade._validatedExecutionConfig({ provider: `zai\u0000`, model: 'glm-5' })).toBeNull();
    expect(facade._validatedExecutionConfig({ model: `glm-5\u0085forged` })).toBeNull();
    expect(facade._validatedExecutionConfig({ model: '模型-α' })).toEqual({ model: '模型-α' });
    expect(facade._validatedExecutionConfig({ model: 'm'.repeat(257) })).toBeNull();
  });
});

describe('group_chat › _validatedExecutionConfigMap (多 Agent 按来源配置)', () => {
  it('keeps one validated config per source key', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfigMap({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
      'agent-codex-1': { model: 'gpt-5.6-sol' },
    })).toEqual({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
      'agent-codex-1': { model: 'gpt-5.6-sol' },
    });
  });

  it('rejects forged source keys instead of silently accepting a partial map', async () => {
    const facade = await loadFacade();
    expect(() => facade._validateExecutionConfigMapForSources({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      'agent-not-selected': { model: 'gpt-5.6-sol' },
    }, {
      internal: {
        kind: 'internal',
        models: [{ provider: 'deepseek', model: 'deepseek-v4-pro', effort: true }],
      },
      'agent-codex-1': {
        kind: 'external', model: true, effort: true, effortOff: false,
        models: ['gpt-5.6-sol'],
      },
    })).toThrow('invalid execution config source');
  });

  it('rejects unsupported provider, model, and effort capabilities as one unit', async () => {
    const facade = await loadFacade();
    const capabilities = {
      internal: {
        kind: 'internal' as const,
        models: [{ provider: 'deepseek', model: 'deepseek-v4-pro', effort: false }],
      },
      'agent-codex-1': {
        kind: 'external' as const, model: true, effort: true, effortOff: false,
        models: ['gpt-5.6-sol'],
      },
    };
    expect(() => facade._validateExecutionConfigMapForSources({
      internal: { provider: 'forged', model: 'deepseek-v4-pro' },
    }, capabilities)).toThrow('unsupported provider/model');
    expect(() => facade._validateExecutionConfigMapForSources({
      'agent-codex-1': { model: 'not-in-catalog' },
    }, capabilities)).toThrow('unsupported model');
    expect(() => facade._validateExecutionConfigMapForSources({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
    }, capabilities)).toThrow('unsupported effort');
    expect(() => facade._validateExecutionConfigMapForSources({
      'agent-codex-1': { model: 'gpt-5.6-sol', effort: 'off' },
    }, capabilities)).toThrow('unsupported effort');
  });

  it('rejects malformed provider/model strings even for a free-form external catalog', async () => {
    const facade = await loadFacade();
    const capabilities = {
      'agent-codex-1': {
        kind: 'external' as const, model: true, effort: false, effortOff: false,
        models: [],
      },
    };
    expect(() => facade._validateExecutionConfigMapForSources({
      'agent-codex-1': { model: 'free-form\nmodel' },
    }, capabilities)).toThrow('invalid execution config');
    expect(() => facade._validateExecutionConfigMapForSources({
      'agent-codex-1': { model: 'm'.repeat(257) },
    }, capabilities)).toThrow('invalid execution config');
  });

  it('keeps the complete map only when every server-owned source and capability is valid', async () => {
    const facade = await loadFacade();
    expect(facade._validateExecutionConfigMapForSources({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
      'agent-codex-1': { model: 'gpt-5.6-sol', effort: 'high' },
    }, {
      internal: {
        kind: 'internal',
        models: [{ provider: 'deepseek', model: 'deepseek-v4-pro', effort: true }],
      },
      'agent-codex-1': {
        kind: 'external', model: true, effort: true, effortOff: false,
        models: ['gpt-5.6-sol'],
      },
    })).toEqual({
      internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
      'agent-codex-1': { model: 'gpt-5.6-sol', effort: 'high' },
    });
  });

  it('collapses non-object payloads to null', async () => {
    const facade = await loadFacade();
    expect(facade._validatedExecutionConfigMap(null)).toBeNull();
    expect(facade._validatedExecutionConfigMap([])).toBeNull();
    expect(facade._validatedExecutionConfigMap('internal')).toBeNull();
  });
});

describe('group_chat › _normalizeRunSourceConfigs (运行快照单来源兼容)', () => {
  it('把单套配置归到内部共享来源或唯一外接实例', async () => {
    const facade = await loadFacade();
    const config = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' as const };
    expect(facade._normalizeRunSourceConfigs(config, null, ['agent-task'], []))
      .toEqual({ internal: config });
    expect(facade._normalizeRunSourceConfigs(config, null, ['agent-codex'], ['agent-codex']))
      .toEqual({ 'agent-codex': config });
    expect(facade._normalizeRunSourceConfigs(config, null, [], []))
      .toEqual({ internal: config });
  });

  it('多来源只能使用按来源配置，不能把单套配置广播出去', async () => {
    const facade = await loadFacade();
    const single = { model: 'gpt-5.6-sol' };
    expect(() => facade._normalizeRunSourceConfigs(
      single,
      null,
      ['agent-task', 'agent-codex'],
      ['agent-codex'],
    )).toThrow('execution_configs required for multiple sources');
    expect(facade._normalizeRunSourceConfigs(
      single,
      { internal: { model: 'internal-model' }, 'agent-codex': single },
      ['agent-task', 'agent-codex'],
      ['agent-codex'],
    )).toEqual({ internal: { model: 'internal-model' }, 'agent-codex': single });
  });
});

describe('group_chat › resolveSourceExecConfig (按来源下发，FR-007/SC-002)', () => {
  const internal = { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' as const };
  const codex = { model: 'gpt-5.6-sol' };
  const map = { internal, 'agent-codex-1': codex };

  const scope = { external_ids: ['agent-codex-1'] };

  it('外接实例拿自己那份，其余收件人拿内部共享那份', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const params: any = { memberConfigs: map, memberConfigScope: scope };
    expect(bus.resolveSourceExecConfig('agent-codex-1', params)).toEqual(codex);
    expect(bus.resolveSourceExecConfig('commander', params)).toEqual(internal);
    expect(bus.resolveSourceExecConfig('agent-task-9', params)).toEqual(internal);
  });

  it('外接实例没配模型时跟随自身默认，绝不回落成内部共享配置', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const params: any = { memberConfigs: { internal }, memberConfigScope: scope };
    expect(bus.resolveSourceExecConfig('agent-codex-1', params)).toBeUndefined();
    // 同一份载荷里的内部收件人仍然拿到共享配置。
    expect(bus.resolveSourceExecConfig('agent-task-9', params)).toEqual(internal);
  });

  it('没有 scope 信息时退回旧行为（按 exact 键再回落 internal）', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const params: any = { memberConfigs: map };
    expect(bus.resolveSourceExecConfig('agent-codex-1', params)).toEqual(codex);
    expect(bus.resolveSourceExecConfig('commander', params)).toEqual(internal);
  });

  it('没有按来源配置时回落到既有单套 execution_config', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const single = { provider: 'anthropic', model: 'claude-opus-4-8' };
    expect(bus.resolveSourceExecConfig('agent-codex-1', { executionConfig: single } as any)).toEqual(single);
    expect(bus.resolveSourceExecConfig('agent-codex-1', {} as any)).toBeUndefined();
  });
});
