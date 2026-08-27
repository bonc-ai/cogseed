import { describe, expect, it } from 'vitest';
import { PUBLIC_PROVIDER_MODELS, publicContextWindowFor, publicModelAbilitiesFor } from '../../../src/main/model/public_model_catalog';

describe('public model catalog', () => {
  it('contains only public providers with unique model ids', () => {
    expect(Object.keys(PUBLIC_PROVIDER_MODELS).sort()).toEqual([
      'anthropic',
      'deepseek',
      'doubao',
      'google',
      'kimi-coding',
      'minimax-cn',
      'minimax-portal',
      'minimax-portal-cn',
      'moonshot',
      'openai',
      'openai-codex',
      'openrouter',
      'zai',
    ]);
    for (const models of Object.values(PUBLIC_PROVIDER_MODELS)) {
      const ids = models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(Boolean)).toBe(true);
    }
  });

  it('keeps OpenAI and OpenAI Codex on the same GPT-5.6 generation', () => {
    const expected = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
    expect(PUBLIC_PROVIDER_MODELS.openai?.map((model) => model.id)).toEqual(expected);
    expect(PUBLIC_PROVIDER_MODELS['openai-codex']?.map((model) => model.id)).toEqual(expected);
  });

  it('declares compatibility metadata for models newer than older runtimes', () => {
    for (const provider of ['openai', 'openai-codex'] as const) {
      for (const model of PUBLIC_PROVIDER_MODELS[provider]?.slice(0, 3) || []) {
        expect(model.template).toBe('gpt-5.5');
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxTokens).toBe(128000);
      }
    }
    expect(PUBLIC_PROVIDER_MODELS['kimi-coding']?.[0]).toMatchObject({
      id: 'k3',
      template: 'kimi-for-coding',
      contextWindow: 1048576,
      maxTokens: 131072,
    });
  });
});

describe('publicContextWindowFor', () => {
  it('resolves exact ids across namespaces', () => {
    expect(publicContextWindowFor('kimi-k3')).toBe(1_048_576);
    expect(publicContextWindowFor('gpt-5.6-sol')).toBe(372_000);
  });

  it('resolves aggregator-prefixed ids to their home-namespace entry', () => {
    // deepseek/deepseek-v4-flash-vision-exp is stored only as
    // deepseek-v4-flash-vision-exp in the deepseek namespace — the window
    // belongs to the model, not the reseller (2026-08-27: suban confirmed 1M).
    expect(publicContextWindowFor('deepseek/deepseek-v4-flash-vision-exp')).toBe(1_048_576);
  });

  it('returns undefined instead of guessing for unknown or windowless ids', () => {
    expect(publicContextWindowFor('glm-5.1')).toBeUndefined(); // catalog has the id but no confirmed window
    expect(publicContextWindowFor('no-such-model')).toBeUndefined();
    expect(publicContextWindowFor('vendor/')).toBeUndefined();
    expect(publicContextWindowFor('')).toBeUndefined();
  });

  it('carries the officially verified DeepSeek V4 and GLM-5.2 specs', () => {
    // 2026-08-28 verification round: DeepSeek pricing page (1M ctx / 384K
    // out, text models are visionless) and bigmodel.cn GLM-5.2 page
    // (1M ctx / 128K out, text-model category).
    expect(publicContextWindowFor('deepseek-v4-pro')).toBe(1_048_576);
    expect(publicContextWindowFor('deepseek-v4-flash')).toBe(1_048_576);
    expect(publicModelAbilitiesFor('deepseek-v4-pro')).toEqual({
      contextWindow: 1_048_576, maxTokens: 393_216, vision: false,
    });
    expect(publicModelAbilitiesFor('glm-5.2')).toEqual({
      contextWindow: 1_048_576, maxTokens: 131_072, vision: false,
    });
    expect(publicModelAbilitiesFor('deepseek/deepseek-v4-flash')).toEqual({
      contextWindow: 1_048_576, maxTokens: 393_216, vision: false,
    });
  });
});
