import { describe, expect, it, vi } from 'vitest';

/**
 * 摘要拉取的请求语义（2026-09-18）：
 *  - 缺席 id 必须记为 settled 并停止重复请求（此前它永远进不了缓存，
 *    每次 notify 都会重发同一次 IPC）；
 *  - 资产详情拉摘要要把版本快照里的 kse id 一并纳入（此前只读资产级
 *    evidenceRefs，而版本块渲染读的正是 snapshot.evidenceRefs）。
 *
 * core.js 是 IIFE：require 一次即挂到 window.CogAssets，唯一的 IPC 出口是
 * window.cogseed.invoke —— 这里只装配它需要的两个全局，记录请求次数与载荷。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
type Call = { channel: string; payload: Record<string, unknown> };
const calls: Call[] = [];
let summaryResponse: Array<Record<string, unknown>> = [];

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: {
      invoke: async (channel: string, payload: Record<string, unknown>) => {
        calls.push({ channel, payload });
        if (channel === 'recall.kstar.episodes.summaries') return { ok: true, summaries: summaryResponse };
        return { ok: true };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    loadKstarEpisodeSummaries: (assetId: string) => Promise<void>;
    loadKstarEpisodeSummariesByIds: (ids: string[]) => Promise<void>;
  };
})();

const askedIds = (): string[][] => calls
  .filter((entry) => entry.channel === 'recall.kstar.episodes.summaries')
  .map((entry) => (entry.payload.ids as string[]) || []);

describe('KSTAR 摘要拉取（2026-09-18）', () => {
  it('响应里缺席的 id 记为 settled，之后不再重复请求', async () => {
    calls.length = 0;
    summaryResponse = [{ id: 'kse-have', goal: '存在的复盘' }];
    await NS.loadKstarEpisodeSummariesByIds(['kse-have', 'kse-gone']);
    expect(askedIds()).toHaveLength(1);
    expect([...askedIds()[0]].sort()).toEqual(['kse-gone', 'kse-have']);
    expect((NS.store.kstarSummaries as Record<string, Record<string, unknown>>)['kse-have']).toMatchObject({ goal: '存在的复盘' });
    // 缺席 = 确实没有：记 settled，供 chip 显示「来源记录不可用」。
    expect(NS.store.kstarSummariesSettled).toEqual(['kse-gone']);
    // 二次请求同一批：有摘要的命中缓存、缺席的已 settled → 一次 IPC 都不再发。
    calls.length = 0;
    await NS.loadKstarEpisodeSummariesByIds(['kse-have', 'kse-gone']);
    expect(calls).toHaveLength(0);
  });

  it('资产详情把版本快照里的 kse id 一并纳入请求', async () => {
    calls.length = 0;
    summaryResponse = [];
    NS.store.assets = [{ id: 'aa-x', title: 't', evidenceRefs: [{ kind: 'execution', id: 'kse-asset-level' }] }];
    NS.store.assetVersions = {
      assetId: 'aa-x',
      usage: [],
      versions: [{ version: '1', snapshot: { evidenceRefs: [{ kind: 'execution', id: 'kse-in-snapshot' }] } }],
    };
    await NS.loadKstarEpisodeSummaries('aa-x');
    expect(askedIds()).toHaveLength(1);
    expect([...askedIds()[0]].sort()).toEqual(['kse-asset-level', 'kse-in-snapshot']);
  });

  it('接口失败不记 settled：读不到 ≠ 不存在，下次仍会重试', async () => {
    calls.length = 0;
    const failing = NS.store;
    globalScope.window = {
      CogAssets: NS as unknown as Record<string, unknown>,
      cogseed: { invoke: async () => ({ ok: false, error: 'kstar episodes unavailable', code: 'E_IO' }) },
    };
    await NS.loadKstarEpisodeSummariesByIds(['kse-retry-later']);
    expect(failing.kstarSummariesSettled).not.toContain('kse-retry-later');
    // 恢复正常的 IPC 后仍会发起请求（而不是被永久判定为不存在）。
    calls.length = 0;
    globalScope.window = {
      CogAssets: NS as unknown as Record<string, unknown>,
      cogseed: {
        invoke: async (channel: string, payload: Record<string, unknown>) => {
          calls.push({ channel, payload });
          return { ok: true, summaries: [{ id: 'kse-retry-later', goal: '后来有了' }] };
        },
      },
    };
    await NS.loadKstarEpisodeSummariesByIds(['kse-retry-later']);
    expect(askedIds()).toHaveLength(1);
  });

  it('模型挂着标记的加载不得自我触发重画（2026-09-18 P0 回归）', async () => {
    let projectionsCalls = 0;
    globalScope.window = {
      CogAssets: NS as unknown as Record<string, unknown>,
      cogseed: {
        invoke: async (channel: string) => {
          if (channel === 'recall.projections.list') {
            projectionsCalls += 1;
            return { ok: true, projections: [{ authorization: 'model_selected', assetIds: ['aa-x', 'aa-y'] }] };
          }
          return { ok: true };
        },
      },
    };
    const before = (NS.store as Record<string, unknown>).modelSelectedAssetIds;
    await (NS as unknown as { loadModelSelectedAssets: () => Promise<void> }).loadModelSelectedAssets();
    expect((NS.store as Record<string, unknown>).modelSelectedAssetIds).toEqual(['aa-x', 'aa-y']);
    // 第二次（同样的数据）：不得再写状态、也不得再触发重画——否则 onChange 会
    // 再调它，形成"加载→重画→再加载"死循环（真机把整页拖死的那一个）。
    const notifySpy = vi.fn();
    (NS as unknown as { notify: () => void }).notify = notifySpy;
    await (NS as unknown as { loadModelSelectedAssets: () => Promise<void> }).loadModelSelectedAssets();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(projectionsCalls).toBe(2);
    // 数据真的变了才允许再画。
    globalScope.window = {
      CogAssets: NS as unknown as Record<string, unknown>,
      cogseed: {
        invoke: async () => ({ ok: true, projections: [{ authorization: 'model_selected', assetIds: ['aa-x', 'aa-z'] }] }),
      },
    };
    await (NS as unknown as { loadModelSelectedAssets: () => Promise<void> }).loadModelSelectedAssets();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect((NS.store as Record<string, unknown>).modelSelectedAssetIds).toEqual(['aa-x', 'aa-z']);
    void before;
  });
});
