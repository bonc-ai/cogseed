import { describe, expect, it } from 'vitest';

/**
 * 形成建议读取失败必须区别于空列表和加载中。
 * BLOCK_FETCHERS.candidates 使用错误标记表示失败，成功后清除；失败仅影响
 * 当前分区，不阻断同页其他区块。core.js 通过 mock window.cogseed.invoke
 * 装配，测试不读取真实候选。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
type Invoke = (channel: string, payload: Record<string, unknown>) => Promise<unknown>;
let invokeImpl: Invoke = async () => ({ ok: true });
const readableEmptyList = (channel: string) => {
  if (channel === 'recall.candidates.list') return { ok: true, candidates: [] };
  if (channel === 'personalOntology.candidates.list') return { ok: true, candidate_updates: [] };
  if (channel === 'recall.captures.list') return { ok: true, captures: [], counts: {} };
  if (channel === 'recall.assets.list') return { ok: true, assets: [] };
  return { ok: true };
};

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke: (channel: string, payload: Record<string, unknown>) => invokeImpl(channel, payload) },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    reload: () => Promise<void>;
  };
})();

describe('形成建议读取的失败态（BLOCK_FETCHERS.candidates）', () => {
  it('recall.candidates.list 失败：置空清单与分组、显式记 inboxError（不再 soft 降级空数组）', async () => {
    invokeImpl = async (channel) => (channel === 'recall.candidates.list'
      ? { ok: false, error: 'inbox list unavailable', code: 'E_IO' }
      : readableEmptyList(channel));
    await NS.reload();
    expect(NS.store.candidates).toEqual([]);
    // store 现在把分组归一为数组：失败时置空，而不是留 undefined。
    expect(NS.store.inboxGroups).toEqual([]);
    expect(String(NS.store.candidatesError)).toContain('inbox list unavailable');
    // 同页对照：其他区块不受这次失败影响。
    expect(NS.store.assetsError).toBe('');
  });

  it('成功：清单与分组落盘、错误标记清空（失败→重试→自愈不卡死）', async () => {
    invokeImpl = async (channel) => (channel === 'recall.candidates.list'
      ? { ok: true, candidates: [{ id: 'candidate:c1', urgency: 'confirm' }], groups: [{ category: 'other', titleKey: 'cognition.inbox_group_other', candidates: [{ id: 'candidate:c1' }] }] }
      : readableEmptyList(channel));
    await NS.reload();
    expect(NS.store.candidates).toEqual([{ id: 'candidate:c1', urgency: 'confirm' }]);
    expect(Array.isArray(NS.store.inboxGroups)).toBe(true);
    expect(NS.store.candidatesError).toBe('');
  });
});
