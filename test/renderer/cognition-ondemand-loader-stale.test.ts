import { describe, expect, it } from 'vitest';

/**
 * 按需 loader 读取失败保留 stale，使显式重试可以再次请求。
 * loadDeletedAssets / loadInspection / loadCleanupReports 成功后恢复缓存；
 * 巡检与报告失败还须记 failed，避免通知循环自动重试，改由 force 重试。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
type Invoke = (channel: string, payload: Record<string, unknown>) => Promise<unknown>;
let invokeImpl: Invoke = async () => ({ ok: true });
const ipcCounts = new Map<string, number>();
const invoke = (channel: string, payload: Record<string, unknown>) => {
  ipcCounts.set(channel, (ipcCounts.get(channel) || 0) + 1);
  return invokeImpl(channel, payload);
};
const count = (channel: string) => ipcCounts.get(channel) || 0;

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    loadInspection: (force?: boolean) => Promise<void>;
    loadCleanupReports: (force?: boolean) => Promise<void>;
    actions: {
      loadDeletedAssets: () => Promise<void>;
    };
  };
})();

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('按需 loader 失败置 stale', () => {
  it('loadDeletedAssets 失败置 stale，第二次调用自愈重拉；成功后不 stale、缓存判重照旧', async () => {
    invokeImpl = async (channel) => (channel === 'recall.assets.deleted.list'
      ? { ok: false, error: 'deleted list unreadable', code: 'E_IO' }
      : { ok: true });
    NS.store.deletedAssets = null;
    ipcCounts.delete('recall.assets.deleted.list');
    await NS.actions.loadDeletedAssets();
    await settle();
    expect(NS.store.deletedAssets).toMatchObject({ loading: false, stale: true }); // 修前：无 stale 键
    await NS.actions.loadDeletedAssets(); // 修前：守卫 !stale 判重直接 return，IPC 不再发
    await settle();
    expect(count('recall.assets.deleted.list')).toBe(2);
    // 成功路径：stale=false，后续调用走缓存。
    invokeImpl = async () => ({ ok: true, items: [{ id: 'a1' }], total: 1 });
    await NS.actions.loadDeletedAssets();
    await settle();
    expect(NS.store.deletedAssets).toMatchObject({ loading: false, stale: false, total: 1 });
    const settled = count('recall.assets.deleted.list');
    await NS.actions.loadDeletedAssets();
    await settle();
    expect(count('recall.assets.deleted.list')).toBe(settled); // 健康态缓存判重照旧
  });

  it('loadInspection 失败保留未知标记，普通调用不循环，force 可恢复', async () => {
    invokeImpl = async (channel) => ((channel === 'recall.inspection.settings' || channel === 'recall.inspection.list')
      ? { ok: false, error: 'inspection unreadable', code: 'E_IO' }
      : { ok: true });
    NS.store.inspection = null;
    ipcCounts.delete('recall.inspection.settings');
    await NS.loadInspection();
    await settle();
    expect(NS.store.inspection).toMatchObject({ loading: false, stale: true });
    await NS.loadInspection();
    await settle();
    expect(count('recall.inspection.settings')).toBe(1);
    expect(NS.store.inspection).toMatchObject({ failed: true, stale: true });
    invokeImpl = async () => ({ ok: true, settings: { enabled: true }, runs: [{ id: 'run-1' }] });
    await NS.loadInspection(true);
    expect(count('recall.inspection.settings')).toBe(2);
    expect(NS.store.inspection).toMatchObject({ failed: false, stale: false, latestRun: { id: 'run-1' } });
  });

  it('loadCleanupReports 失败保留未知标记，普通调用不循环，force 可恢复', async () => {
    invokeImpl = async (channel) => (channel === 'recall.cleanup.list'
      ? { ok: false, error: 'cleanup reports unreadable', code: 'E_IO' }
      : { ok: true });
    NS.store.cleanupReports = null;
    ipcCounts.delete('recall.cleanup.list');
    await NS.loadCleanupReports();
    await settle();
    expect(NS.store.cleanupReports).toMatchObject({ loading: false, stale: true });
    await NS.loadCleanupReports();
    await settle();
    expect(count('recall.cleanup.list')).toBe(1);
    expect(NS.store.cleanupReports).toMatchObject({ failed: true, stale: true });
    invokeImpl = async () => ({ ok: true, reports: [{ id: 'report-1' }] });
    await NS.loadCleanupReports(true);
    expect(count('recall.cleanup.list')).toBe(2);
    expect(NS.store.cleanupReports).toMatchObject({ failed: false, stale: false, reports: [{ id: 'report-1' }] });
  });
});
