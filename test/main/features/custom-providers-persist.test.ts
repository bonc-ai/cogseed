import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* 2026-09-14 保存失效排查：feature 层写→盘→读 的完整回路（真实磁盘 + 加密）。
 * 直调 addCustomProviderModel 写入含 reasoningLevels 的模型，再用
 * listCustomProviders 读回——此前只在内存 save hook 上验证过。 */

const UID = 'persist-model-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-provider-persist-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.resetModules();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom provider model persistence (真实磁盘回路)', () => {
  it('keeps reasoningLevels / capabilities / input across write→disk→reload', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = await providers.addCustomProvider(UID, {
      name: 'Persist Relay',
      protocol: 'openai',
      baseUrl: 'https://persist.example/v1',
      apiKey: ['persist', UID].join('-'),
      models: [{ id: 'base-model' }],
    });
    if (!added.ok) throw new Error(added.error);

    const res = providers.addCustomProviderModel(UID, added.id, {
      id: 'rich-model',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['image'],
      capabilities: ['structured_output'],
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningParamsMap: { high: { reasoning_effort: 'high' } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.reasoningLevels).toEqual(['low', 'medium', 'high']);

    // 真实磁盘读回（loadCustomProviders → loadProfilesForUser → parse）
    const listed = providers.listCustomProviders(UID);
    const model = listed[0].models.find((m) => m.id === 'rich-model');
    expect(model).toMatchObject({
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text', 'image'],
      capabilities: ['structured_output'],
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningParamsMap: { high: { reasoning_effort: 'high' } },
    });
  });

  it('keeps advanced fields an update omits, and clears them when the form says clear', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = await providers.addCustomProvider(UID, {
      name: 'Partial Relay',
      protocol: 'openai',
      baseUrl: 'https://partial.example/v1',
      apiKey: ['partial', UID].join('-'),
      models: [{
        id: 'rich-model',
        input: ['image'],
        capabilities: ['structured_output'],
        reasoningLevels: ['low', 'high'],
        reasoningParamsMap: { high: { reasoning_effort: 'high' } },
      }],
    });
    if (!added.ok) throw new Error(added.error);

    // 只带基础字段的更新（导入/草稿等旧调用方形态）：高级字段一律保留，
    // 连 input 也不降级——否则"未声明"会被读成"只剩文本"。
    const res = providers.updateCustomProviderModel(UID, added.id, 'rich-model', {
      id: 'rich-model', contextWindow: 1000000, maxTokens: 384000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.input).toEqual(['text', 'image']);
    expect(res.model.vision).toBe(true);
    expect(res.model.reasoningLevels).toEqual(['low', 'high']);
    expect(res.model.capabilities).toEqual(['structured_output']);
    expect(res.model.reasoningParamsMap).toEqual({ high: { reasoning_effort: 'high' } });
    const kept = providers.listCustomProviders(UID)[0].models.find((m) => m.id === 'rich-model');
    expect(kept?.reasoningLevels).toEqual(['low', 'high']);

    // 显式空数组/空对象 = 用户在统一表单里清空（取消勾选、删空等级行、清空
    // 参数映射）——必须照写，否则"取消了保存不生效"就是同一类表象。
    const emptied = providers.updateCustomProviderModel(UID, added.id, 'rich-model', {
      id: 'rich-model', contextWindow: 1000000, maxTokens: 384000, input: ['text'],
      reasoningLevels: [],
      capabilities: [],
      reasoningParamsMap: {},
    });
    expect(emptied.ok).toBe(true);
    if (!emptied.ok) return;
    expect(emptied.model.input).toEqual(['text']);
    expect(emptied.model.vision).toBe(false);
    expect(emptied.model.reasoningLevels).toBeUndefined();
    expect(emptied.model.capabilities).toBeUndefined();
    expect(emptied.model.reasoningParamsMap).toBeUndefined();
    const cleared = providers.listCustomProviders(UID)[0].models.find((m) => m.id === 'rich-model');
    expect(cleared?.reasoningLevels).toBeUndefined();
    expect(cleared?.capabilities).toBeUndefined();
    expect(cleared?.input).toEqual(['text']);
  });
});
