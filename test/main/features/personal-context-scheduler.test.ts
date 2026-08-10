import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SyncResult } from '../../../src/main/features/personal_context/contract';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pc-scheduler-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    providerId: 'feishu',
    added: 1,
    updated: 0,
    unchanged: 0,
    processedEventIds: [],
    nextCursor: { watermarks: { calendar_event: '2026-08-02T00:00:00.000Z' }, eventIdempotency: [], updatedAt: '2026-08-02T00:00:00.000Z' },
    at: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

async function loadScheduler() {
  const { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS } = await import('../../../src/main/features/personal_context/sync-scheduler');
  return { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS };
}

describe('同步调度器基础 tick', () => {
  it('已连接（runner 返回结果）→ ran，记录 lastRunAt 与统计', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    const scheduler = new PersonalContextSyncScheduler({ runner: { runSync: async () => result({ added: 3 }) } });
    const tick = await scheduler.tick(UID);
    expect(tick.outcome).toBe('ran');
    expect(tick.summary).toEqual({ added: 3, updated: 0, unchanged: 0 });
    expect(scheduler.lastRunAt(UID)).toBe('2026-08-02T00:00:00.000Z');
    expect(scheduler.lastError(UID)).toBeUndefined();
  });

  it('未连接（runner 返回 null）→ skipped_not_connected，不产生 lastRunAt', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    const scheduler = new PersonalContextSyncScheduler({ runner: { runSync: async () => null } });
    const tick = await scheduler.tick(UID);
    expect(tick.outcome).toBe('skipped_not_connected');
    expect(scheduler.lastRunAt(UID)).toBeUndefined();
  });

  it('runner 抛错 → failed + lastError，不抛出到调用方', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { throw new Error('feishu api 500'); } },
    });
    const tick = await scheduler.tick(UID);
    expect(tick.outcome).toBe('failed');
    expect(tick.error).toBe('feishu api 500');
    expect(scheduler.lastError(UID)).toBe('feishu api 500');
    expect(scheduler.lastRunAt(UID)).toBeUndefined();
  });

  it('同步失败 → 游标不落盘（真实 provider + 注册表集成）', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    const { PersonalContextRegistry, PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const { createFeishuProvider } = await import('../../../src/main/features/personal_context/feishu/provider');
    const registry = new PersonalContextRegistry();
    const cursors = new PersonalContextCursorStore();
    const failingClient = {
      listCalendars: async () => [],
      listCalendarEvents: async () => { throw new Error('feishu api 500'); },
      listDriveFiles: async () => [],
      listWikiNodes: async () => [],
      listChats: async () => [],
      healthCheck: async () => ({ ok: true }),
    };
    const provider = createFeishuProvider(failingClient, { tenant: 't-1', unionId: 'on_me', registry, cursors });
    // 已勾选一个日历
    await registry.upsert(UID, {
      resourceId: 'feishu:t-1:calendar:cal_001', resourceType: 'calendar', title: '主日历',
      observedAt: '2026-08-01T00:00:00.000Z', accessLabel: 'personal', retentionPolicy: 'source-linked',
    });
    await registry.setSelection(UID, 'feishu:t-1:calendar:cal_001', true);

    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => provider.sync({ uid: UID, providerId: 'feishu' }) },
    });
    const tick = await scheduler.tick(UID);
    expect(tick.outcome).toBe('failed');
    // 失败不落水位：游标保持空
    expect(await cursors.get(UID, 'feishu')).toBeNull();
  });

  it('重入保护：单轮在途时再次 tick → already_running，不并发执行', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    const gate = deferred<SyncResult>();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { calls += 1; return gate.promise; } },
    });

    const first = scheduler.tick(UID);
    expect(scheduler.isInFlight(UID)).toBe(true);
    const second = await scheduler.tick(UID);
    expect(second.outcome).toBe('already_running');

    gate.resolve(result());
    expect((await first).outcome).toBe('ran');
    expect(calls).toBe(1);
  });
});

describe('同步调度器定时触发', () => {
  it('start 后按间隔触发 tick；stop 后不再触发', async () => {
    const { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS } = await loadScheduler();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { calls += 1; return result(); } },
    });

    scheduler.start(UID);
    expect(scheduler.isRunning(UID)).toBe(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 2);
    expect(calls).toBe(2);

    scheduler.stop(UID);
    expect(scheduler.isRunning(UID)).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 3);
    expect(calls).toBe(2);
  });

  it('start 幂等：重复 start 不重复建定时器', async () => {
    const { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS } = await loadScheduler();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { calls += 1; return result(); } },
    });
    scheduler.start(UID);
    scheduler.start(UID);
    scheduler.start(UID);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 2);
    expect(calls).toBe(2);
  });

  it('间隔可配置（intervalMs）', async () => {
    const { PersonalContextSyncScheduler } = await loadScheduler();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { calls += 1; return result(); } },
      intervalMs: 5 * 60 * 1000,
    });
    scheduler.start(UID);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(calls).toBe(6);
  });

  it('定时 tick 中 runner 抛错不打断后续轮次（失败可重试）', async () => {
    const { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS } = await loadScheduler();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: {
        runSync: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient failure');
          return result();
        },
      },
    });
    scheduler.start(UID);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 2);
    expect(calls).toBe(2);
    expect(scheduler.lastError(UID)).toBeUndefined(); // 第二轮成功清空错误
    expect(scheduler.lastRunAt(UID)).toBe('2026-08-02T00:00:00.000Z');
  });

  it('未连接轮次被跳过（runner 返回 null）且定时器继续', async () => {
    const { PersonalContextSyncScheduler, DEFAULT_SYNC_INTERVAL_MS } = await loadScheduler();
    let calls = 0;
    const scheduler = new PersonalContextSyncScheduler({
      runner: { runSync: async () => { calls += 1; return null; } },
    });
    scheduler.start(UID);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 3);
    expect(calls).toBe(3);
    expect(scheduler.lastRunAt(UID)).toBeUndefined();
  });
});
