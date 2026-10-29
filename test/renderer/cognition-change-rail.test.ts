import { describe, expect, it, vi } from 'vitest';

import { loadCognitionAssets } from './helpers/cognition-renderer';

type Notice = { collection: string; generation: number; recordId?: string; op?: string };
type ResolveRead = (value: { ok: true; assets: Array<{ id: string }> }) => void;

describe('cognition change rail', () => {
  it('invalidates the whole affected detail cache when a coalesced notice names only its final record', async () => {
    let changed!: (notice: Notice) => void;
    const invoke = vi.fn(async () => ({ ok: true, assets: [], candidates: [] }));
    const { ns, store } = loadCognitionAssets({
      assetVersions: { assetId: 'asset-first', versions: [{ version: '1' }] },
      reviewEvidence: {
        'asset:asset-first': { loaded: true }, 'asset:asset-last': { loaded: true },
        'candidate:candidate-first': { loaded: true }, 'candidate:candidate-last': { loaded: true },
      },
      assetEditDrafts: { 'asset-first': { statement: '尚未保存', baseVersion: '1' } },
    }, {}, { cogseed: { invoke, onPushEvent: (_channel: string, handler: typeof changed) => { changed = handler; } } });
    ns.setupChangeRail(() => false);
    changed({ collection: 'ability-asset-versions', generation: 12, recordId: 'asset-last' });
    expect(store.assetVersions).toBeNull();
    expect(Object.keys(store.reviewEvidence)).toEqual(['candidate:candidate-first', 'candidate:candidate-last']);
    changed({ collection: 'candidates', generation: 14, recordId: 'candidate-last' });
    expect(store.reviewEvidence).toEqual({});
    expect(store.assetEditDrafts['asset-first']).toEqual({ statement: '尚未保存', baseVersion: '1' });
    expect(invoke).not.toHaveBeenCalled();
    ns.changeRailVisible(true);
    await ns.flushPendingRefresh();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['recall.assets.list', 'recall.candidates.list', 'recall.captures.stats']);
  });

  it('source pause and restore invalidate all loaded detail views, with no hidden reads', async () => {
    let changed!: (notice: Notice) => void;
    const invoke = vi.fn(async () => ({ ok: true, assets: [], candidates: [], groups: [], items: [] }));
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: { invoke, onPushEvent: (_channel: string, handler: typeof changed) => { changed = handler; } },
    });
    ns.setupChangeRail(() => false);
    for (const [generation, op] of [[1, 'pause'], [2, 'restore']] as const) {
      Object.assign(store, {
        assetVersions: { assetId: 'asset-a' }, assetTimeline: { assetId: 'asset-a' }, adoptionReceipts: { assetId: 'asset-a' },
        reviewEvidence: { 'asset:asset-a': { loaded: true }, 'candidate:candidate-b': { loaded: true } },
      });
      ns.rankingWhy = { assetId: 'asset-a' };
      changed({ collection: 'source-controls', generation, op, recordId: 'source-final' });
      expect(store.reviewEvidence).toEqual({});
      expect([store.assetVersions, store.assetTimeline, store.adoptionReceipts, ns.rankingWhy]).toEqual([null, null, null, null]);
      expect(invoke).not.toHaveBeenCalled();
    }
    ns.changeRailVisible(true);
    await ns.flushPendingRefresh();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['recall.assets.list', 'recall.candidates.list', 'recall.timeline.list']);
  });

  it('refreshes nightly status on sweep notices and queues completion behind an in-flight running read', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const pendingReads: Array<(value: unknown) => void> = [];
    const invoke = vi.fn((channel: string) => channel === 'recall.captures.stats'
      ? new Promise(resolve => pendingReads.push(resolve))
      : Promise.resolve({ ok: true }));
    const { ns, store } = loadCognitionAssets({}, { name: 'overview' }, {
      cogseed: { invoke, onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      } },
    });
    ns.setupChangeRail(() => true);
    handlers.get('cognition:changed')!({ collection: 'capture-sweep', generation: 1 });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
    handlers.get('cognition:changed')!({ collection: 'capture-sweep', generation: 2 });
    pendingReads[0]({ ok: true, runtime: { running: true } });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2));
    const completed = { ok: true, runtime: { running: false }, sweep: { lastResult: { scanned: 2, queued: 1 } } };
    pendingReads[1](completed);
    await vi.waitFor(() => expect(store.captureStats).toEqual(completed));
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['recall.captures.stats', 'recall.captures.stats']);
  });

  it('queues a second change that arrives while the same block is being read', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const pendingReads: ResolveRead[] = [];
    const invoke = vi.fn((channel: string) => {
      if (channel !== 'recall.assets.list') return Promise.resolve({ ok: true });
      return new Promise<{ ok: true; assets: Array<{ id: string }> }>((resolve) => {
        pendingReads.push(resolve);
      });
    });
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });

    ns.setupChangeRail(() => true);
    const onChanged = handlers.get('cognition:changed');
    expect(onChanged).toBeTypeOf('function');

    onChanged!({ collection: 'ability-assets', generation: 1 });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));

    // A write happens after the first read has started. The second refresh must
    // run after it finishes, otherwise the panel can stay stale indefinitely.
    onChanged!({ collection: 'ability-assets', generation: 2 });
    pendingReads[0]({ ok: true, assets: [{ id: 'before-second-write' }] });
    await vi.waitFor(() => expect(pendingReads).toHaveLength(2));

    pendingReads[1]({ ok: true, assets: [{ id: 'after-second-write' }] });
    await vi.waitFor(() => expect(store.assets).toEqual([{ id: 'after-second-write' }]));
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.assets.list')).toHaveLength(2);
  });

  it('holds notices while hidden and reads the affected block when visible again', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const invoke = vi.fn(async (channel: string) => (
      channel === 'recall.assets.list' ? { ok: true, assets: [{ id: 'asset-1' }] } : { ok: true }
    ));
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });

    let visible = false;
    ns.setupChangeRail(() => visible);
    handlers.get('cognition:changed')!({ collection: 'ability-assets', generation: 1 });
    expect(invoke).not.toHaveBeenCalled();

    visible = true;
    ns.changeRailVisible(true);
    await ns.flushPendingRefresh();
    expect(invoke).toHaveBeenCalledWith('recall.assets.list', {});
    expect(store.assets).toEqual([{ id: 'asset-1' }]);
    // 修改现行认知后，活动投影的“内容已存在”判断必须同步重算。
    expect(invoke).toHaveBeenCalledWith('recall.candidates.list', { view: 'activity-queue' });
  });

  it('keeps the renderer tree link dead: candidate/tree notices never trigger tree IPC', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'recall.candidates.list') return { ok: true, candidates: [] };
      return { ok: true };
    });
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });
    ns.setupChangeRail(() => true);

    // 认知树页面全靠现算（viewTree 从 assets/captures 现算），渲染层不再
    // 持有 store.tree / treeRequested / loadTree：candidates 变更只刷候选块，
    // tree/graph 落盘广播无映射静默忽略——主进程 recall.tree.* 服务与通道
    // 保留（tree-service.test.ts 锁定），但渲染层零调用。
    handlers.get('cognition:changed')!({ collection: 'candidates', generation: 1 });
    await ns.flushPendingRefresh();
    expect(invoke).toHaveBeenCalledWith('recall.candidates.list', { view: 'activity-queue' });

    handlers.get('cognition:changed')!({ collection: 'tree', generation: 1 });
    handlers.get('cognition:changed')!({ collection: 'graph', generation: 1 });
    await ns.flushPendingRefresh();
    await ns.reload();
    expect(invoke.mock.calls.filter(([channel]) => String(channel).startsWith('recall.tree.'))).toHaveLength(0);
    expect(store.tree).toBeUndefined();
    expect(store.treeRequested).toBeUndefined();
  });

  it('ontology notices cannot reload the retired candidate pool', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const invoke = vi.fn(async (channel: string) => (
      channel === 'recall.candidates.list' ? { ok: true, candidates: [] }
        : channel === 'personalOntology.candidates.list' ? { ok: true, candidate_updates: [] }
        : { ok: true }
    ));
    const { ns } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });
    ns.setupChangeRail(() => true);

    handlers.get('cognition:changed')!({ collection: 'ontology-candidates', generation: 1 });
    await ns.flushPendingRefresh();
    expect(invoke).toHaveBeenCalledWith('recall.candidates.list', { view: 'activity-queue' });
    expect(invoke.mock.calls.some(([channel]) => channel === 'personalOntology.candidates.list')).toBe(false);
  });
});
