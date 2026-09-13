import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'custom-runtime-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-runtime-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom provider runtime', () => {
  it.each([
    ['anthropic', 'anthropic-messages'],
    ['openai', 'openai-completions'],
    ['gemini', 'google-generative-ai'],
  ] as const)('maps %s providers to %s', async (protocol, api) => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: `${protocol} relay`, protocol, baseUrl: `https://${protocol}.example/v1`, apiKey: 'secret',
    });
    if (!added.ok) throw new Error(added.error);
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
    const record = runtime.findCustomProvider(UID, `cp:${added.id}`);
    expect(record).toBeTruthy();
    const model = runtime.buildCustomProviderModel(record!, 'model-x');
    expect(model).toMatchObject({
      id: 'model-x', api, provider: `cp:${added.id}`, baseUrl: `https://${protocol}.example/v1`,
      contextWindow: 1000000, maxTokens: 384000,
    });
  });

  it('does not resolve unknown synthetic ids', async () => {
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
    expect(runtime.findCustomProvider(UID, 'cp:missing')).toBeUndefined();
    expect(runtime.isCustomProviderId('openai-compatible')).toBe(false);
  });

  it('uses the selected model metadata for runtime and runner catalog limits', async () => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Configured relay',
      protocol: 'openai',
      baseUrl: 'https://configured.example/v1',
      apiKey: 'secret',
      models: [{ id: 'large-model', contextWindow: 1048576, maxTokens: 65536 }],
    });
    if (!added.ok) throw new Error(added.error);
    const record = providers.listCustomProviders(UID)[0];
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');

    expect(runtime.buildCustomProviderModel(record, 'large-model')).toMatchObject({
      id: 'large-model', contextWindow: 1048576, maxTokens: 65536,
    });
    expect(runtime.buildCustomProviderModelMeta(record, 'large-model')).toEqual({
      contextWindow: 1048576, maxTokens: 65536,
    });
    expect(runtime.buildCustomProviderModel(record, 'unknown-model')).toMatchObject({
      contextWindow: 1000000, maxTokens: 384000,
    });
  });

  it('drives input/reasoning/compat from stored model config (2026-09-13)', async () => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Config-driven relay',
      protocol: 'openai',
      baseUrl: 'https://config-driven.example/v1',
      apiKey: 'secret',
      models: [{
        id: 'my-multimodal-model',
        input: ['text', 'image'],
        reasoningLevels: ['low', 'high'],
        capabilities: ['system_message', 'structured_output'],
      }],
    });
    if (!added.ok) throw new Error(added.error);
    const record = providers.listCustomProviders(UID)[0];
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');

    // 配置驱动：勾了图片 → input 含 image；声明了推理等级 → reasoning
    // 开启（识别器无输入也生效）；能力 → compat 开关。
    const model = runtime.buildCustomProviderModel(record, 'my-multimodal-model');
    expect(model.input).toEqual(['text', 'image']);
    expect(model.reasoning).toBe(true);
    expect(model.compat).toMatchObject({ supportsDeveloperRole: true, supportsStrictMode: true });

    // 未配置的模型（同 provider）：input 纯文本、reasoning 关闭（识别器
    // 不出就绝不盲发）、无 compat 覆盖。
    const plain = runtime.buildCustomProviderModel(record, 'plain-model');
    expect(plain.input).toEqual(['text']);
    expect(plain.reasoning).toBe(false);
    expect(plain.compat).toBeUndefined();
  });
});
