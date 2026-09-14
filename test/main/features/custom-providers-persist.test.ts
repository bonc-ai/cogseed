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

  it('keeps advanced fields when an update omits them (2026-09-14 保存失效根治)', async () => {
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
      }],
    });
    if (!added.ok) throw new Error(added.error);

    // 只带基础字段的更新（自动保存/UI 重放的快照形态）——高级字段必须保留。
    const res = providers.updateCustomProviderModel(UID, added.id, 'rich-model', {
      id: 'rich-model', contextWindow: 1000000, maxTokens: 384000, input: ['text', 'image', 'video', 'pdf'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.reasoningLevels).toEqual(['low', 'high']);
    expect(res.model.capabilities).toEqual(['structured_output']);
    const model = providers.listCustomProviders(UID)[0].models.find((m) => m.id === 'rich-model');
    expect(model?.reasoningLevels).toEqual(['low', 'high']);

    // 空数组（快照形态/未渲染的等级行）同样保留——自动快照无论带 undefined
    // 还是 []，都不能清掉用户配置（2026-09-14 终版：保数据优先，清空需删模型）。
    const emptied = providers.updateCustomProviderModel(UID, added.id, 'rich-model', {
      id: 'rich-model', contextWindow: 1000000, maxTokens: 384000, input: ['text'],
      reasoningLevels: [],
      capabilities: [],
    });
    expect(emptied.ok).toBe(true);
    if (!emptied.ok) return;
    expect(emptied.model.reasoningLevels).toEqual(['low', 'high']);
    expect(emptied.model.capabilities).toEqual(['structured_output']);
  });
});
