/** Renderer read ordering and in-flight state contracts.
 * Block generations discard stale responses from overlapping refresh/reload.
 * Migration status reads preserve current transient state, avoid re-entry and
 * cannot overwrite a newer run outcome. Deferred IPC uses the real change rail. */
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

function deferred<T = unknown>() {
  let settled!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settled = resolve; });
  return { promise, resolve: settled };
}

/** 打满 microtask：invoke→api.call→fetcher→Promise.all→落地有多层 await，
 *  时序用例里靠固定次数的 await Promise.resolve() 排空调度。 */
async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('详情缓存读取身份', () => {
  it.each([
    ['versions', 'loadAssetVersions', 'assetVersions', 'recall.assets.versions.list', { versions: [{ version: 'new' }] }],
    ['timeline', 'loadAssetTimeline', 'assetTimeline', 'recall.timeline.forAsset', { items: [{ id: 'new' }], realUsageKinds: ['usage_recorded'] }],
    ['adoption', 'loadAdoptionReceipts', 'adoptionReceipts', 'recall.assets.adoptionReceipts', { receipts: [{ id: 'new' }] }],
  ])('same-id %s requests cannot overwrite a newer success with an old success or failure', async (_label, loader, key, channel, body) => {
    for (const stale of [{ ok: true, versions: [], items: [], receipts: [], realUsageKinds: [] }, { ok: false, error: 'old failure' }]) {
      const old = deferred();
      let count = 0;
      const { ns, store } = loadCognitionAssets({}, {}, { cogseed: { invoke: vi.fn(async (name: string) => {
        if (name === channel && ++count === 1) return old.promise;
        return { ok: true, ...(body as object) };
      }) } });
      const first = ns[String(loader)]('same-asset', true);
      await ns[String(loader)]('same-asset', true);
      const current = store[String(key)];
      old.resolve(stale);
      await first;
      expect(store[String(key)]).toBe(current);
      expect(store[String(key)].failed).toBe(false);
      if (key === 'assetTimeline') expect(store.realUsageKinds).toEqual(['usage_recorded']);
    }
  });

  it.each(['success', 'failure'])('reload discards an old evidence %s without notifying or ending the replacement request', async outcome => {
    const old = deferred(), current = deferred();
    let calls = 0;
    const { ns, store } = loadCognitionAssets({}, {}, { cogseed: { invoke: vi.fn(async (channel: string) => {
      if (channel === 'recall.reviewEvidence.read') return ++calls === 1 ? old.promise : current.promise;
      return { ok: true, assets: [], candidates: [] };
    }) } });
    const first = ns.loadReviewEvidence('asset', 'same-asset');
    await ns.reload();
    const replacement = ns.loadReviewEvidence('asset', 'same-asset');
    const latest = store.reviewEvidence['asset:same-asset'];
    const notified = vi.fn(); ns.onChange(notified);
    old.resolve(outcome === 'success' ? { ok: true, items: [{ id: 'old' }] } : { ok: false, error: 'old failure' });
    await first;
    expect(store.reviewEvidence['asset:same-asset']).toBe(latest);
    expect(latest).toMatchObject({ loading: true, loaded: false, items: [], error: '' });
    expect(notified).not.toHaveBeenCalled();
    current.resolve({ ok: true, items: [{ id: 'new' }] });
    await replacement;
    expect(latest).toMatchObject({ loading: false, loaded: true, items: [{ id: 'new' }] });
  });
});

describe('区块读取世代号：drain 与 reload 双飞乱序，旧响应作废', () => {
  it('旧响应后到不覆盖新数据（已删资产不复活显示）', async () => {
    const firstTrip = deferred();
    let assetsListCalls = 0;
    let pushEvent: ((notice: unknown) => void) | null = null;
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'recall.assets.list') {
            assetsListCalls += 1;
            // 第一次（drain 发出的旧请求）：挂起，稍后才回旧数据。
            if (assetsListCalls === 1) return firstTrip.promise;
            // 第二次（reload/snapshot 的新请求）：立刻回新数据（资产已删）。
            return { ok: true, assets: [{ id: 'aa-after-delete', title: '剩下的一条' }] };
          }
          return { ok: true };
        }),
        onPushEvent: (_channel: string, cb: (notice: unknown) => void) => { pushEvent = cb; },
      },
    });
    ns.setupChangeRail(() => true);

    // 广播资产变更 → drain 发起 assets 读取（gen=1，挂起在途）。
    pushEvent!({ collection: 'ability-assets' });
    await settle();
    expect(assetsListCalls).toBe(1);

    // drain 在途时用户打开面板触发全量 reload → snapshot 再发 assets 读取
    //（gen=2），立刻拿到删除后的新数据并落地。
    const reloading = ns.reload();
    await settle();
    expect(assetsListCalls).toBe(2);
    expect(store.assets.map((a: { id: string }) => a.id)).toEqual(['aa-after-delete']);

    // 旧响应此刻才回（删除前的旧名单）：世代已过，作废不落地。
    firstTrip.resolve({ ok: true, assets: [{ id: 'aa-deleted-ghost', title: '已被删除的资产' }] });
    await settle();
    await reloading;
    await settle();
    expect(store.assets.map((a: { id: string }) => a.id)).toEqual(['aa-after-delete']);
  });

  it('对照组：无并发时（单次读取）响应照常落地——世代号不吞正常路径', async () => {
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: { invoke: vi.fn(async () => ({ ok: true, assets: [{ id: 'aa-only' }] })) },
    });
    await ns.reload();
    expect(store.assets.map((a: { id: string }) => a.id)).toEqual(['aa-only']);
  });

  it('错误响应同样受世代守卫：旧请求的失败不把新成功盖成错误态（候选分区）', async () => {
    const firstTrip = deferred();
    let inboxCalls = 0;
    let pushEvent: ((notice: unknown) => void) | null = null;
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'recall.candidates.list') {
            inboxCalls += 1;
            // 第一次（旧请求）挂起，最终以失败返回。
            if (inboxCalls === 1) return firstTrip.promise;
            // 第二次（新请求）立刻成功。
            return { ok: true, candidates: [{ id: 'in-1' }] };
          }
          return { ok: true };
        }),
        onPushEvent: (_channel: string, cb: (notice: unknown) => void) => { pushEvent = cb; },
      },
    });
    ns.setupChangeRail(() => true);
    // cleanup-reports 映射 inbox 区块：drain 发起旧请求（gen=1，挂起）。
    pushEvent!({ collection: 'candidates' });
    await settle();
    expect(inboxCalls).toBe(1);
    // reload/snapshot 再发 inbox 请求（gen=2）：立刻成功落地。
    const reloading = ns.reload();
    await settle();
    expect(inboxCalls).toBe(2);
    expect(store.candidates.map((row: { id: string }) => row.id)).toEqual(['in-1']);
    // 旧请求此刻以失败返回（ok:false）：世代已过，作废——不落错误态、不清数据。
    firstTrip.resolve({ ok: false, error: 'stale failure' });
    await settle();
    await reloading;
    await settle();
    expect(store.candidatesError).toBe('');
    expect(store.candidates.map((row: { id: string }) => row.id)).toEqual(['in-1']);
  });
});

describe('经验迁移状态读取：保留现值+在途守卫', () => {
  function migrationState() {
    return {
      preview: { items: [{ id: 'pv-1' }] },
      previewLoading: false,
      previewFailed: false,
      running: true,
      lastRun: { migrationId: 'mig-1', status: 'done' },
      statusLoading: false,
    };
  }

  it('读取在途：running 与旧 lastRun 不被抹掉（迁移在途提示不消失）', async () => {
    const trip = deferred();
    const { ns, store } = loadCognitionAssets({ experienceMigration: migrationState() }, {}, {
      cogseed: { invoke: vi.fn(async () => trip.promise) },
    });
    const reading = ns.loadExperienceMigrationStatus();
    await Promise.resolve();
    // 修前：进入即抹 lastRun=null、丢 running——常驻入口的「迁移在途」提示
    // 消失、界面重现旧清单。修后：只加 statusLoading，其余现值保留。
    expect(store.experienceMigration.running).toBe(true);
    expect(store.experienceMigration.preview.items).toEqual([{ id: 'pv-1' }]);
    expect(store.experienceMigration.lastRun).toEqual({ migrationId: 'mig-1', status: 'done' });
    expect(store.experienceMigration.statusLoading).toBe(true);

    trip.resolve({ ok: true, migrationId: 'mig-2', status: 'done' });
    await reading;
    expect(store.experienceMigration.lastRun.migrationId).toBe('mig-2');
    expect(store.experienceMigration.running).toBe(true);
    expect(store.experienceMigration.statusLoading).toBe(false);
  });

  it('在途不重入：第二次调用直接返回，不发第二个 IPC', async () => {
    const trip = deferred();
    const invoke = vi.fn(async () => trip.promise);
    const { ns } = loadCognitionAssets({ experienceMigration: migrationState() }, {}, {
      cogseed: { invoke },
    });
    const first = ns.loadExperienceMigrationStatus();
    await Promise.resolve();
    await ns.loadExperienceMigrationStatus();
    expect(invoke).toHaveBeenCalledTimes(1);
    trip.resolve({ ok: true });
    await first;
  });

  it('读失败保留现值：旧 lastRun 不被伪装成「还没执行过」', async () => {
    const { ns, store } = loadCognitionAssets({ experienceMigration: migrationState() }, {}, {
      cogseed: { invoke: vi.fn(async () => { throw new Error('status read failed'); }) },
    });
    await ns.loadExperienceMigrationStatus();
    expect(store.experienceMigration.lastRun).toEqual({ migrationId: 'mig-1', status: 'done' });
    expect(store.experienceMigration.statusLoading).toBe(false);
  });

  it('落地前被 run 终态接管：status 响应不覆盖 run 的结果', async () => {
    const trip = deferred();
    const { ns, store } = loadCognitionAssets({ experienceMigration: migrationState() }, {}, {
      cogseed: { invoke: vi.fn(async () => trip.promise) },
    });
    const reading = ns.loadExperienceMigrationStatus();
    await Promise.resolve();
    // 等待期间迁移完成：run 终态写入（不带 statusLoading）。
    store.experienceMigration = {
      preview: null,
      previewLoading: false,
      previewFailed: false,
      lastRun: { migrationId: 'mig-run-final', status: 'done' },
    };
    trip.resolve({ ok: true, migrationId: 'mig-stale-read', status: 'done' });
    await reading;
    expect(store.experienceMigration.lastRun.migrationId).toBe('mig-run-final');
  });

  it('迁移预览读取同样保留 running 瞬态，不整体替换', async () => {
    const trip = deferred();
    const { ns, store } = loadCognitionAssets({ experienceMigration: migrationState() }, {}, {
      cogseed: { invoke: vi.fn(async () => trip.promise) },
    });
    const reading = ns.loadExperienceMigrationPreview(true);
    await Promise.resolve();
    expect(store.experienceMigration.running).toBe(true);
    expect(store.experienceMigration.lastRun.migrationId).toBe('mig-1');
    trip.resolve({ ok: true, items: [], sources: [] });
    await reading;
    expect(store.experienceMigration.previewLoading).toBe(false);
    expect(store.experienceMigration.running).toBe(true);
  });
});
