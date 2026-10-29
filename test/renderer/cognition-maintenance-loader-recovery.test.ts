import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const core = readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf8');
function setup() {
  let fail = true;
  const invoke = vi.fn(async (channel: string) => {
    if (fail) throw new Error('backend unavailable');
    if (channel === 'recall.inspection.settings') return { ok: true, settings: { enabled: true } };
    if (channel === 'recall.inspection.list') return { ok: true, runs: [{ id: 'inspection-1' }] };
    return { ok: true, reports: [{ id: 'cleanup-1' }] };
  });
  const window: any = { cogseed: { invoke } };
  runInNewContext(core, { window, setTimeout, clearTimeout });
  const NS = window.CogAssets;
  // 与 app.onChange 相同：每次通知都会再次调用按需 loader。
  let notifications = 0;
  NS.onChange(() => {
    // 给旧循环设置测试保险丝，回归时会以请求次数断言失败而非饿死计时器。
    if (++notifications > 30) return;
    void NS.loadInspection(); void NS.loadCleanupReports();
  });
  return { NS, invoke, recover: () => { fail = false; } };
}

describe('维护读取失败的缓存与显式恢复', () => {
  it('巡检失败后的 onChange 不形成重读循环，force 成功后恢复实际状态', async () => {
    const { NS, invoke, recover } = setup();
    await NS.loadInspection();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(NS.store.inspection).toMatchObject({ loading: false, failed: true, stale: true });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.inspection.settings')).toHaveLength(1);
    for (let n = 0; n < 5; n++) NS.notify();
    await Promise.resolve();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.inspection.settings')).toHaveLength(1);
    recover();
    await NS.loadInspection(true);
    expect(NS.store.inspection).toMatchObject({ failed: false, stale: false, settings: { enabled: true }, latestRun: { id: 'inspection-1' } });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.inspection.settings')).toHaveLength(2);
  });

  it('整理报告失败后的 onChange 不形成重读循环，force 成功后恢复报告', async () => {
    const { NS, invoke, recover } = setup();
    await NS.loadCleanupReports();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(NS.store.cleanupReports).toMatchObject({ loading: false, failed: true, stale: true });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.cleanup.list')).toHaveLength(1);
    for (let n = 0; n < 5; n++) NS.notify();
    await Promise.resolve();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.cleanup.list')).toHaveLength(1);
    recover();
    await NS.loadCleanupReports(true);
    expect(NS.store.cleanupReports).toMatchObject({ failed: false, stale: false, reports: [{ id: 'cleanup-1' }] });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.cleanup.list')).toHaveLength(2);
  });
});
