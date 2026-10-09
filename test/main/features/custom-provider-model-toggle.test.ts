// 模型级开关（S2 语义）——主进程矩阵。
//
// 2026-09-14：供应商详情卡的行内开关。S2 = 关闭后
//   ① 选择器隐藏（auth.listModels 过滤）
//   ② 阻止新绑定（isCustomProviderModelAllowed → 条目校验失败）
//   ③ 已绑定条目按既有"不可用即跳过、兜底到下一条"机制处理
// 配置与绑定都保留，随时可拨回；改窗口等部分更新不得把开关重置。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'model-toggle-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-toggle-'));
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

async function seedProvider() {
  const providers = await import('../../../src/main/features/custom_providers');
  const added = await providers.addCustomProvider(UID, {
    name: 'Toggle Relay',
    protocol: 'openai',
    baseUrl: 'https://toggle.example/v1',
    apiKey: ['toggle', UID].join('-'),
    models: [{ id: 'm-primary' }, { id: 'm-secondary' }],
  });
  if (!added.ok) throw new Error(added.error);
  return { providers, providerId: added.id };
}

describe('自定义供应商模型级开关（S2）', () => {
  it('关闭只写 enabled:false、开启删字段，且配置与绑定都保留', async () => {
    const { providers, providerId } = await seedProvider();
    const off = providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', false);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.model.enabled).toBe(false);
    // 其余字段原样（关闭不动参数）
    expect(off.model).toMatchObject({ id: 'm-primary', contextWindow: 1000000, maxTokens: 384000 });

    providers._resetModelOverridesCacheForTest?.();
    const stored = providers.listCustomProviders(UID)[0].models.find((m) => m.id === 'm-primary');
    expect(stored?.enabled).toBe(false);

    const on = providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', true);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.model.enabled).toBeUndefined();
  });

  it('改窗口的部分更新不会把开关重置（enabled 未提供 → 保留旧值）', async () => {
    const { providers, providerId } = await seedProvider();
    providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', false);
    const res = providers.updateCustomProviderModel(UID, providerId, 'm-primary', {
      id: 'm-primary', contextWindow: 512000, maxTokens: 65536,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.enabled).toBe(false);
    expect(res.model.contextWindow).toBe(512000);
  });

  it('关闭的模型在选择器里消失，但供应商详情仍能看到（可拨回）', async () => {
    const { providers, providerId } = await seedProvider();
    const auth = await import('../../../src/main/features/auth');
    providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', false);

    const listed = await auth.listModels('cp:' + providerId);
    expect(listed.models.map((m) => m.id)).toEqual(['m-secondary']);
    // 详情卡的来源（customProviders.list）是全量清单——开关本身要看得见
    expect(providers.listCustomProviders(UID)[0].models.map((m) => m.id))
      .toEqual(['m-primary', 'm-secondary']);
  });

  it('已绑定条目变"不可用"、调度跳过并兜底；重开即恢复', async () => {
    const { providers, providerId } = await seedProvider();
    const auth = await import('../../../src/main/features/auth');

    // addCustomProvider 会自动为首个模型建一条条目
    const before = await auth.listEntries({ includeUnavailable: true });
    const bound = before.entries.find((entry) => entry.provider === 'cp:' + providerId);
    expect(bound?.model).toBe('m-primary');
    expect(bound?.modelAvailable).toBeUndefined();

    providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', false);

    // ② 条目合法性：includeUnavailable 下仍显示，但标记不可用（UI 显示"模型不可用"）
    const after = await auth.listEntries({ includeUnavailable: true });
    const stillBound = after.entries.find((entry) => entry.provider === 'cp:' + providerId);
    expect(stillBound?.modelAvailable).toBe(false);
    // 默认（不含不可用）不再返回 → ③ 调度看不到它
    const visible = await auth.listEntries();
    expect(visible.entries.some((entry) => entry.provider === 'cp:' + providerId)).toBe(false);
    const picked = await auth.pickChatEntryGroup();
    expect(picked.some((choice) => choice.provider === 'cp:' + providerId)).toBe(false);

    // 重开：条目恢复可用且参数未变（兜底机制不再需要）
    providers.setCustomProviderModelEnabled(UID, providerId, 'm-primary', true);
    const restored = await auth.listEntries();
    const entry = restored.entries.find((item) => item.provider === 'cp:' + providerId);
    expect(entry?.modelAvailable).toBeUndefined();
    expect((await auth.pickChatEntryGroup()).some((choice) => choice.provider === 'cp:' + providerId)).toBe(true);
  });

  it('关闭的模型不能再被绑成条目（阻止新绑定）', async () => {
    const { providers, providerId } = await seedProvider();
    const auth = await import('../../../src/main/features/auth');
    providers.setCustomProviderModelEnabled(UID, providerId, 'm-secondary', false);
    await expect(auth.addEntry({
      provider: 'cp:' + providerId,
      model: 'm-secondary',
      profileId: 'cp:' + providerId,
    })).rejects.toThrow();
    // 已存在的条目也不能切到关闭的模型
    const entries = await auth.listEntries({ includeUnavailable: true });
    const bound = entries.entries.find((entry) => entry.provider === 'cp:' + providerId);
    await expect(auth.updateEntryModel(bound!.entryId, 'm-secondary')).rejects.toThrow();
  });
});
