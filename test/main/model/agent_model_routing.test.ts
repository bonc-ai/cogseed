// 伪装模型 ID 路由（cli/<type>@<model>）编码契约：两段严格格式、未知前缀/
// 多 @ 段/空段全部透传（null）、伪 provider 前缀识别、CLI 通道解码改写与
// in-process 通道防御剥离（D6 红线：伪装 ID 绝不进凭证过滤）。

import { describe, expect, it } from 'vitest';
import {
  AGENT_MODEL_PREFIX,
  bareModelFor,
  cliTypeFromPseudoProvider,
  decodeAgentModel,
  encodeAgentModel,
  isAgentModel,
  isPseudoCliProvider,
  isKnownCliType,
  pseudoProviderFor,
  resolveMaskedCliExecConfig,
  stripMaskedForInProcess,
} from '../../../src/main/model/agent_model_routing';

describe('agent_model_routing › encode/decode', () => {
  it('round-trips a masked id', () => {
    expect(encodeAgentModel('claude', 'claude-sonnet-5')).toBe('cli/claude@claude-sonnet-5');
    expect(decodeAgentModel('cli/claude@claude-sonnet-5')).toEqual({
      cliType: 'claude',
      modelId: 'claude-sonnet-5',
    });
    expect(decodeAgentModel(encodeAgentModel('workbuddy', 'glm-5.3'))).toEqual({
      cliType: 'workbuddy',
      modelId: 'glm-5.3',
    });
  });

  it('normalises the cli type segment to lowercase', () => {
    expect(decodeAgentModel('cli/Claude@sonnet')).toEqual({ cliType: 'claude', modelId: 'sonnet' });
  });

  it('rejects non-masked shapes with null (pass-through contract)', () => {
    expect(decodeAgentModel('claude-sonnet-5')).toBeNull();          // bare id
    expect(decodeAgentModel('cli/claude')).toBeNull();               // no @
    expect(decodeAgentModel('cli/claude@')).toBeNull();              // empty model
    expect(decodeAgentModel('cli/@sonnet')).toBeNull();              // empty cli type
    expect(decodeAgentModel('cli/claude@sonnet@extra')).toBeNull();  // extra segment
    expect(decodeAgentModel('cli/unknown-cli@sonnet')).toBeNull();   // outside LOCAL_CLI_TYPES
    expect(decodeAgentModel('')).toBeNull();
    expect(decodeAgentModel(null)).toBeNull();
    expect(decodeAgentModel(123)).toBeNull();
    expect(decodeAgentModel('clix/claude@x')).toBeNull();            // near-miss prefix
  });

  it('isAgentModel / bareModelFor keep unknowns untouched', () => {
    expect(isAgentModel('cli/claude@opus')).toBe(true);
    expect(isAgentModel('cli/nope@opus')).toBe(false);
    expect(bareModelFor('cli/claude@claude-sonnet-5')).toBe('claude-sonnet-5');
    // 旧裸 id 覆盖继续按原值生效（兼容不迁移）。
    expect(bareModelFor('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(bareModelFor(undefined)).toBe('');
  });

  it('pseudo provider helpers map both directions', () => {
    expect(pseudoProviderFor('claude')).toBe('cli-claude');
    expect(cliTypeFromPseudoProvider('cli-claude')).toBe('claude');
    expect(cliTypeFromPseudoProvider('cli-nope')).toBeNull();
    expect(cliTypeFromPseudoProvider('cp:foo')).toBeNull();
    expect(cliTypeFromPseudoProvider('openai')).toBeNull();
    expect(isPseudoCliProvider('cli-workbuddy')).toBe(true);
    expect(isPseudoCliProvider('cli-')).toBe(false);
    expect(isKnownCliType('CLAUDE')).toBe(true);
  });
});

describe('agent_model_routing › resolveMaskedCliExecConfig (CLI path rewrite)', () => {
  it('decodes the masked model and reports the original as transportModel', () => {
    const out = resolveMaskedCliExecConfig({ model: 'cli/claude@claude-sonnet-5', effort: 'low' });
    expect(out.config).toEqual({ model: 'claude-sonnet-5', effort: 'low' });
    expect(out.transportModel).toBe('cli/claude@claude-sonnet-5');
  });

  it('keeps provider when present (masked override with a provider pair)', () => {
    const out = resolveMaskedCliExecConfig({ provider: 'cli-claude', model: 'cli/claude@opus' });
    expect(out.config).toEqual({ provider: 'cli-claude', model: 'opus' });
  });

  it('passes bare and undefined configs through untouched', () => {
    expect(resolveMaskedCliExecConfig({ model: 'gpt-5.6-sol' })).toEqual({
      config: { model: 'gpt-5.6-sol' },
    });
    expect(resolveMaskedCliExecConfig(undefined)).toEqual({ config: undefined });
    // 未知 cli 前缀不解码（透传契约）。
    expect(resolveMaskedCliExecConfig({ model: 'cli/unknown@x' }).config).toEqual({ model: 'cli/unknown@x' });
  });
});

describe('agent_model_routing › stripMaskedForInProcess (D6 guard)', () => {
  it('drops a masked model + pseudo provider pair, keeps effort', () => {
    const out = stripMaskedForInProcess({ provider: 'cli-claude', model: 'cli/claude@opus', effort: 'high' });
    expect(out.stripped).toBe(true);
    expect(out.config).toEqual({ effort: 'high' });
  });

  it('flags a pseudo provider even with a bare model (defensive)', () => {
    const out = stripMaskedForInProcess({ provider: 'cli-codex', model: 'gpt-5.6-sol' });
    expect(out.stripped).toBe(true);
    expect(out.config).toBeUndefined();
  });

  it('flags a masked model even without a provider', () => {
    const out = stripMaskedForInProcess({ model: 'cli/claude@sonnet' });
    expect(out.stripped).toBe(true);
    expect(out.config).toBeUndefined();
  });

  it('never touches legitimate API configs', () => {
    expect(stripMaskedForInProcess({ provider: 'anthropic', model: 'claude-sonnet-5' }).stripped).toBe(false);
    expect(stripMaskedForInProcess({ provider: 'cp:mine', model: 'my-model' }).stripped).toBe(false);
    // 注意：真实 provider 不会叫 cli-<已知类型>，但“模型名以 cli/ 开头”的
    // 自定义 id 属于透传契约之外——decode 只认 LOCAL_CLI_TYPES 前缀。
    expect(stripMaskedForInProcess(undefined).stripped).toBe(false);
  });

  it('prefix constants stay in sync (renderer copy is pinned by its own test)', () => {
    expect(AGENT_MODEL_PREFIX).toBe('cli/');
  });
});
