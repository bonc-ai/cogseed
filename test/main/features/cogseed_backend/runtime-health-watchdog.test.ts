import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';
import {
  classifyCogSeedRuntimeHealth,
  createCogSeedRuntimeHealthWatchdog,
  type CogSeedExecutionProcessHealth,
} from '../../../../src/main/features/cogseed_backend/runtime-health-watchdog';

const USER = 'runtime-watchdog-user';

function task(taskId: string, overrides: Partial<CogSeedTaskRecord> = {}): CogSeedTaskRecord {
  return {
    schemaVersion: 1,
    taskId,
    sessionId: `cogseed-session-${taskId}`,
    runtimeSessionId: `mruntime-${taskId}`,
    executionId: `cogseed-exec-${taskId}`,
    runtimeWorkerId: 'cogseed-worker-test',
    requestId: `request-${taskId}`,
    ownerId: USER,
    status: 'running',
    task: 'Health check fixture.',
    executionKind: 'local-cli',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as CogSeedTaskRecord;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CogSeed Runtime health watchdog', () => {
  it('classifies the active / slow-but-alive / stale / orphaned matrix without treating age as death', () => {
    const base = {
      updatedAtMs: 1_000,
      observedAtMs: 11_000,
      orphanGraceMs: 5_000,
      slowThresholdMs: 2_000,
    };

    expect(classifyCogSeedRuntimeHealth({
      ...base,
      updatedAtMs: 10_500,
      controllerOwnsTask: true,
      processHealth: 'unknown',
    })).toMatchObject({ state: 'active', recoverable: false, effectiveOwnership: true });
    expect(classifyCogSeedRuntimeHealth({
      ...base,
      controllerOwnsTask: true,
      processHealth: 'unknown',
    })).toMatchObject({ state: 'slow-but-alive', recoverable: false, effectiveOwnership: true });
    expect(classifyCogSeedRuntimeHealth({
      ...base,
      controllerOwnsTask: false,
      processHealth: 'alive',
    })).toMatchObject({ state: 'slow-but-alive', recoverable: false });
    expect(classifyCogSeedRuntimeHealth({
      ...base,
      controllerOwnsTask: false,
      processHealth: 'unknown',
    })).toMatchObject({ state: 'stale', recoverable: false, reason: 'process-unknown' });
    expect(classifyCogSeedRuntimeHealth({
      ...base,
      controllerOwnsTask: false,
      processHealth: 'missing',
      missingSinceMs: 7_000,
    })).toMatchObject({ state: 'stale', recoverable: false, reason: 'process-grace' });
    expect(classifyCogSeedRuntimeHealth({
      ...base,
      controllerOwnsTask: false,
      processHealth: 'invalid',
      missingSinceMs: 6_000,
    })).toMatchObject({ state: 'orphaned', recoverable: true, reason: 'process-gone' });
  });

  it('requires ownership loss, confirmed process disappearance, and a fresh grace period before recovery', async () => {
    let now = 10_000;
    const row = task('lost-process');
    const tasks = [row];
    let owns = false;
    let processHealth: CogSeedExecutionProcessHealth = 'alive';
    const recoverTask = vi.fn(async (_userId: string, current: CogSeedTaskRecord) => {
      current.status = 'recoverable';
      return true;
    });
    const watchdog = createCogSeedRuntimeHealthWatchdog({
      listTasks: async () => tasks,
      controllerOwnsTask: async () => owns,
      probeProcess: async () => processHealth,
      recoverTask,
      now: () => now,
      orphanGraceMs: 1_000,
    });
    watchdog.watchUser(USER);
    watchdog.start();

    await expect(watchdog.scanNow()).resolves.toMatchObject({
      recoveredCount: 0,
      states: { 'slow-but-alive': 1 },
    });
    processHealth = 'missing';
    await expect(watchdog.scanNow()).resolves.toMatchObject({ recoveredCount: 0, states: { stale: 1 } });
    now += 999;
    await expect(watchdog.scanNow()).resolves.toMatchObject({ recoveredCount: 0, states: { stale: 1 } });
    owns = true;
    processHealth = 'alive';
    await expect(watchdog.scanNow()).resolves.toMatchObject({ recoveredCount: 0, states: { active: 1 } });
    owns = false;
    processHealth = 'missing';
    await watchdog.scanNow();
    now += 1_000;
    await expect(watchdog.scanNow()).resolves.toMatchObject({ recoveredCount: 1, states: { orphaned: 1 } });
    expect(recoverTask).toHaveBeenCalledOnce();
    await watchdog.shutdown();
  });

  it('single-flights overlapping scans', async () => {
    let release!: (rows: CogSeedTaskRecord[]) => void;
    const pending = new Promise<CogSeedTaskRecord[]>((resolve) => { release = resolve; });
    const listTasks = vi.fn(() => pending);
    const watchdog = createCogSeedRuntimeHealthWatchdog({
      listTasks,
      controllerOwnsTask: async () => false,
      probeProcess: async () => 'unknown',
      recoverTask: async () => false,
    });
    watchdog.watchUser(USER);
    watchdog.start();

    const first = watchdog.scanNow();
    const second = watchdog.scanNow();
    expect(second).toBe(first);
    release([]);
    await expect(first).resolves.toMatchObject({ scannedCount: 0 });
    expect(listTasks).toHaveBeenCalledOnce();
    await watchdog.shutdown();
  });

  it('stops periodic scheduling and prevents a shutdown-overlapping scan from recovering', async () => {
    vi.useFakeTimers();
    let release!: (rows: CogSeedTaskRecord[]) => void;
    const pending = new Promise<CogSeedTaskRecord[]>((resolve) => { release = resolve; });
    const recoverTask = vi.fn(async () => true);
    const listTasks = vi.fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending);
    const watchdog = createCogSeedRuntimeHealthWatchdog({
      listTasks,
      controllerOwnsTask: async () => false,
      probeProcess: async () => 'missing',
      recoverTask,
      intervalMs: 100,
      orphanGraceMs: 0,
    });
    watchdog.watchUser(USER);
    watchdog.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(listTasks).toHaveBeenCalledTimes(1);
    const scan = watchdog.scanNow();
    const stopping = watchdog.shutdown();
    release([task('shutdown-race')]);
    await Promise.all([scan, stopping]);
    expect(recoverTask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('isolates per-task probe and recovery-store failures', async () => {
    const rows = [task('probe-failure'), task('store-failure'), task('healthy-recovery')];
    const recoverTask = vi.fn(async (_userId: string, current: CogSeedTaskRecord) => {
      if (current.taskId === 'store-failure') throw new Error('simulated store failure');
      current.status = 'recoverable';
      return true;
    });
    const watchdog = createCogSeedRuntimeHealthWatchdog({
      listTasks: async () => rows,
      controllerOwnsTask: async () => false,
      probeProcess: async (_userId, current) => {
        if (current.taskId === 'probe-failure') throw new Error('simulated probe failure');
        return 'missing';
      },
      recoverTask,
      orphanGraceMs: 0,
    });
    watchdog.watchUser(USER);
    watchdog.start();

    await expect(watchdog.scanNow()).resolves.toMatchObject({
      scannedCount: 3,
      recoveredCount: 1,
      failedCount: 2,
      states: { stale: 1, orphaned: 2 },
    });
    expect(recoverTask.mock.calls.map(([, current]) => current.taskId)).toEqual([
      'store-failure',
      'healthy-recovery',
    ]);
    await watchdog.shutdown();
  });

  it('lets completion and cancellation win recovery races and remains idempotent on repeated scans', async () => {
    const completed = task('completion-race');
    const cancelled = task('cancellation-race');
    const rows = [completed, cancelled];
    const recoverTask = vi.fn(async (_userId: string, current: CogSeedTaskRecord) => {
      current.status = current.taskId === completed.taskId ? 'completed' : 'cancelled';
      return false;
    });
    const watchdog = createCogSeedRuntimeHealthWatchdog({
      listTasks: async () => rows,
      controllerOwnsTask: async () => false,
      probeProcess: async () => 'missing',
      recoverTask,
      orphanGraceMs: 0,
    });
    watchdog.watchUser(USER);
    watchdog.start();

    await expect(watchdog.scanNow()).resolves.toMatchObject({ scannedCount: 2, recoveredCount: 0 });
    await expect(watchdog.scanNow()).resolves.toMatchObject({ scannedCount: 0, recoveredCount: 0 });
    expect(recoverTask).toHaveBeenCalledTimes(2);
    await watchdog.shutdown();
  });
});
