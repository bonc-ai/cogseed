import { describe, it, expect } from 'vitest';
import {
  buildDeepSeekModel,
  buildDoubaoModel,
  buildMoonshotModel,
  buildOpenAICompatibleModel,
  createMoonshotProvider,
  createOpenAICompatibleProvider,
} from '../../../../src/main/model/core-agent/external-providers';

describe('external-providers › buildDeepSeekModel', () => {
  it('declares image input for vision variants so pi-ai keeps image blocks (2026-09-13 OCR 降级修复)', () => {
    // 实机事故：deepseek-v4-flash-vision-exp 被硬编码 input:['text']，
    // pi-ai openai-completions 的 `model.input.includes("image")` 门把图片
    // 内容块全部丢弃——模型只能 read_file→ocr_file，多模态被降级为 OCR。
    const vision = buildDeepSeekModel('deepseek-v4-flash-vision-exp');
    expect(vision.input).toEqual(['text', 'image']);
    expect(buildDeepSeekModel('deepseek-vl-chat').input).toEqual(['text', 'image']);
    // 非 vision 模型仍为纯文本——不支持就声明不支持，不盲发图片。
    expect(buildDeepSeekModel('deepseek-v4-flash').input).toEqual(['text']);
    expect(buildDeepSeekModel('deepseek-chat').input).toEqual(['text']);
    // 既有语义不回退：v4-* 仍按 reasoner 处理。
    expect(vision.reasoning).toBe(true);
  });
});

describe('external-providers › buildMoonshotModel', () => {
  it('builds a Model for https://api.moonshot.cn/v1 using openai-completions', () => {
    const model = buildMoonshotModel('kimi-k2.5');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(model.id).toBe('kimi-k2.5');
    // pi-ai only uses provider for logs here; the type accepts arbitrary strings.
    expect(model.provider).toBe('moonshot');
  });

  it('uses known context windows and falls back to 131072 for unknown ids', () => {
    expect(buildMoonshotModel('kimi-k3').contextWindow).toBe(1048576);
    expect(buildMoonshotModel('kimi-k3').maxTokens).toBe(131072);
    expect(buildMoonshotModel('kimi-k2.7-code').contextWindow).toBe(262144);
    expect(buildMoonshotModel('kimi-k2.6').contextWindow).toBe(262144);
    expect(buildMoonshotModel('kimi-k2.5').contextWindow).toBe(262144);
    // Future Moonshot models fall back to the conservative 128k lower bound.
    // Legacy preview ids also use the fallback and remain usable until Moonshot retires them.
    expect(buildMoonshotModel('brand-new-model').contextWindow).toBe(131072);
    expect(buildMoonshotModel('kimi-k2-0905-preview').contextWindow).toBe(131072);
  });

  it('prefers curated labels and falls back to the id', () => {
    expect(buildMoonshotModel('kimi-k3').name).toBe('Kimi K3');
    expect(buildMoonshotModel('kimi-k2.7-code').name).toBe('Kimi K2.7 Code');
    // Uncurated ids fall back directly without throwing.
    expect(buildMoonshotModel('random-id').name).toBe('random-id');
  });

  it('uses K3 reasoning compatibility when the bundled runtime lacks native metadata', () => {
    const model = buildMoonshotModel('kimi-k3');
    expect(model.reasoning).toBe(true);
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    });
  });
});

describe('external-providers › buildDoubaoModel', () => {
  it('uses the current Seed 2.0 Lite limits', () => {
    expect(buildDoubaoModel('doubao-seed-2-0-lite-260428')).toMatchObject({
      contextWindow: 262144,
      maxTokens: 32768,
    });
  });
});

describe('external-providers › createMoonshotProvider', () => {
  it('throws without apiKey before pi-ai can swallow the auth failure', async () => {
    await expect(createMoonshotProvider({ apiKey: '', modelId: 'kimi-k2.5' }))
      .rejects.toThrow(/apiKey required/);
  });

  it('throws without modelId so callers must choose explicitly', async () => {
    await expect(createMoonshotProvider({ apiKey: 'sk-xxx', modelId: '' }))
      .rejects.toThrow(/modelId required/);
  });

  it('returns an LLMProvider with id and the expected methods', async () => {
    const p = await createMoonshotProvider({ apiKey: 'sk-xxx', modelId: 'kimi-k2.5' });
    expect(p.id).toBe('moonshot');
    expect(typeof p.complete).toBe('function');
    expect(typeof p.stream).toBe('function');
    expect(typeof p.validateAuth).toBe('function');
  });
});


describe('external-providers › OpenAI-compatible custom endpoint', () => {
  it('builds a custom OpenAI-compatible model with the user base URL', () => {
    expect(buildOpenAICompatibleModel('custom-chat', 'https://llm.example.test/v1')).toMatchObject({
      id: 'custom-chat',
      name: 'custom-chat',
      provider: 'openai-compatible',
      api: 'openai-completions',
      baseUrl: 'https://llm.example.test/v1',
      contextWindow: 131072,
      maxTokens: 32768,
    });
  });

  it('clamps user-configured OpenAI-compatible max output tokens to the supported range', () => {
    expect(buildOpenAICompatibleModel('custom-chat', 'https://llm.example.test/v1', 16384).maxTokens).toBe(16384);
    expect(buildOpenAICompatibleModel('custom-chat', 'https://llm.example.test/v1', 999).maxTokens).toBe(8192);
    expect(buildOpenAICompatibleModel('custom-chat', 'https://llm.example.test/v1', 999999).maxTokens).toBe(32768);
  });

  it('validates custom provider credentials before constructing the pi provider', async () => {
    await expect(createOpenAICompatibleProvider({ apiKey: '', baseUrl: 'https://llm.example.test/v1', modelId: 'm' }))
      .rejects.toThrow(/apiKey required/);
    await expect(createOpenAICompatibleProvider({ apiKey: 'sk-xxx', baseUrl: '', modelId: 'm' }))
      .rejects.toThrow(/baseUrl required/);
    await expect(createOpenAICompatibleProvider({ apiKey: 'sk-xxx', baseUrl: 'https://llm.example.test/v1', modelId: '' }))
      .rejects.toThrow(/modelId required/);
  });
});
