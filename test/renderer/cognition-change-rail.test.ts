import { describe, expect, it, vi } from 'vitest';

import { loadCognitionAssets } from './helpers/cognition-renderer';

type Notice = { collection: string; generation: number };
type ResolveRead = (value: { ok: true; assets: Array<{ id: string }> }) => void;

describe('cognition change rail', () => {
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
  });

  it('rebuilds the tree from changed candidates and reads a separately written tree without rebuilding it again', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'recall.candidates.list') return { ok: true, candidates: [] };
      if (channel === 'recall.tree.rebuild') return { ok: true, tree: { nodes: [{ id: 'fresh' }], edges: [] } };
      if (channel === 'recall.tree.read') return { ok: true, tree: { nodes: [{ id: 'external' }], edges: [] } };
      return { ok: true };
    });
    const { ns, store } = loadCognitionAssets({ tree: { nodes: [{ id: 'old' }], edges: [] }, treeRequested: true }, {}, {
      cogseed: {
        invoke,
        onPushEvent: (channel: string, handler: (notice: Notice) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });
    ns.setupChangeRail(() => true);

    handlers.get('cognition:changed')!({ collection: 'candidates', generation: 1 });
    await ns.flushPendingRefresh();
    expect(store.tree).toBeNull();
    expect(store.treeRequested).toBe(false);

    await ns.reload({ tree: true });
    expect(store.tree.nodes).toEqual([{ id: 'fresh' }]);
    expect(invoke).toHaveBeenCalledWith('recall.tree.rebuild', {});

    handlers.get('cognition:changed')!({ collection: 'tree', generation: 1 });
    await ns.flushPendingRefresh();
    expect(store.tree.nodes).toEqual([{ id: 'external' }]);
    expect(invoke).toHaveBeenCalledWith('recall.tree.read', {});
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.tree.rebuild')).toHaveLength(1);
  });

  it('routes ontology candidate changes to the ontology cache instead of the Recall candidate list', async () => {
    const handlers = new Map<string, (notice: Notice) => void>();
    const refreshPersonalOntology = vi.fn(async () => {});
    const invoke = vi.fn(async () => ({ ok: true }));
    const { ns } = loadCognitionAssets({}, {}, {
      refreshPersonalOntology,
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
    expect(refreshPersonalOntology).toHaveBeenCalledWith({ deferWhenHidden: true });
    expect(invoke).not.toHaveBeenCalledWith('recall.candidates.list', {});
  });
});
