import { describe, it, expect, afterEach, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => loggerMocks,
}));

async function loadBootInit() {
  vi.resetModules();
  const boot = await import('../../../src/main/util/boot_init');
  boot._resetForTests();
  return boot;
}

afterEach(() => {
  vi.useRealTimers();
  loggerMocks.debug.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();
});

describe('util/boot_init', () => {
  it('treats serial tasks as barriers after in-flight parallel work', async () => {
    const boot = await loadBootInit();
    const order: string[] = [];
    let releaseParallel!: () => void;

    boot.registerImmediate('parallel-a', async () => {
      order.push('parallel-start');
      await new Promise<void>((resolve) => { releaseParallel = resolve; });
      order.push('parallel-end');
    });
    boot.registerImmediate('serial-b', () => {
      order.push('serial');
    }, 'serial');

    const run = boot.runBootPhases(60_000);
    await Promise.resolve();

    expect(order).toEqual(['parallel-start']);
    releaseParallel();
    await run;

    expect(order).toEqual(['parallel-start', 'parallel-end', 'serial']);
  });

  it('contains immediate task failures and continues the batch', async () => {
    const boot = await loadBootInit();
    const order: string[] = [];

    boot.registerImmediate('bad', () => {
      order.push('bad');
      throw new Error('boom');
    }, 'serial');
    boot.registerImmediate('good', () => {
      order.push('good');
    }, 'serial');

    await expect(boot.runBootPhases(60_000)).resolves.toBeUndefined();
    expect(order).toEqual(['bad', 'good']);
  });

  it('runs deferred tasks only after the configured delay', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const order: string[] = [];

    boot.registerDeferred('deferred', () => {
      order.push('deferred');
    });

    await boot.runBootPhases(25);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(24);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(order).toEqual(['deferred']);
  });

  it('keeps post-startup cohorts behind their additional offset', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const order: string[] = [];

    boot.registerDeferred('regular', () => { order.push('regular'); });
    boot.registerDeferred('post-startup', () => { order.push('post-startup'); }, 'serial', 35_000);

    await boot.runBootPhases(6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(order).toEqual(['regular']);

    await vi.advanceTimersByTimeAsync(34_999);
    expect(order).toEqual(['regular']);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['regular', 'post-startup']);
  });

  it('waits for a recent interaction window before starting idle-preferred work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const boot = await loadBootInit();
    const order: string[] = [];
    boot.noteBootUserActivity();
    boot.registerDeferred('idle-disk', () => { order.push('ran'); }, 'serial', 0, {
      resourceClass: 'disk',
      preferIdle: true,
      recentActivityMs: 100,
      maxUserDeferralMs: 1_000,
      admissionPollMs: 10,
    });

    await boot.runBootPhases(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['ran']);
  });

  it('never admits idle work while a conversation runtime is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const boot = await loadBootInit();
    let runtimeBusy = true;
    let ran = false;
    boot.configureBootAdmission({ isRuntimeBusy: () => runtimeBusy });
    boot.registerDeferred('runtime-aware', () => { ran = true; }, 'serial', 0, {
      resourceClass: 'disk',
      preferIdle: true,
      recentActivityMs: 1,
      maxUserDeferralMs: 20,
      admissionPollMs: 10,
    });

    await boot.runBootPhases(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toBe(false);
    runtimeBusy = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toBe(true);
  });

  it('serializes tasks that share a resource class across a parallel cohort', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const order: string[] = [];
    let release!: () => void;
    let finishSecond!: () => void;
    const secondDone = new Promise<void>((resolve) => { finishSecond = resolve; });
    boot.registerDeferred('disk-a', async () => {
      order.push('a-start');
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('a-end');
    }, 'parallel', 0, { resourceClass: 'disk' });
    boot.registerDeferred('disk-b', () => {
      order.push('b');
      finishSecond();
    }, 'parallel', 0, {
      resourceClass: 'disk',
    });

    await boot.runBootPhases(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['a-start']);
    release();
    await secondDone;
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('uses standalone delays only as eligibility and still waits for admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const boot = await loadBootInit();
    let runtimeBusy = true;
    let ran = false;
    boot.configureBootAdmission({ isRuntimeBusy: () => runtimeBusy });
    const scheduled = boot.scheduleBootBackground('connector', () => { ran = true; }, 25, {
      resourceClass: 'process',
      preferIdle: true,
      recentActivityMs: 1,
      admissionPollMs: 10,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(ran).toBe(false);
    runtimeBusy = false;
    await vi.advanceTimersByTimeAsync(10);
    await scheduled.promise;
    expect(ran).toBe(true);
  });

  it('cancels standalone work while it is waiting for an idle window', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    boot.configureBootAdmission({ isRuntimeBusy: () => true });
    let ran = false;
    const scheduled = boot.scheduleBootBackground('stale-account', () => { ran = true; }, 1, {
      resourceClass: 'network',
      preferIdle: true,
      admissionPollMs: 10,
    });

    await vi.advanceTimersByTimeAsync(1);
    scheduled.cancel();
    await scheduled.promise;
    await vi.runAllTimersAsync();
    expect(ran).toBe(false);
  });

  it('signals a cooperative cancellation when a background slice overruns', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    let aborted = false;
    const scheduled = boot.scheduleBootBackground('bounded-scan', async (signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
    }, 0, { maxSliceMs: 20 });

    await vi.advanceTimersByTimeAsync(20);
    await scheduled.promise;
    expect(aborted).toBe(true);
  });
});

describe('util/boot_init task logging', () => {
  it('logs slow only for completed tasks', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const { SLOW_WARN_MS } = await import('../../../src/main/util/boot_init');
    vi.setSystemTime(0);

    await boot.runBootTaskForTest('completed', async () => {
      vi.setSystemTime(SLOW_WARN_MS + 1);
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(expect.stringContaining('task slow'));

    loggerMocks.warn.mockClear();
    const controller = new AbortController();
    await boot.runBootTaskForTest('aborted', async () => {
      controller.abort();
      vi.setSystemTime(SLOW_WARN_MS + 1);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }, { signal: controller.signal });
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('task slow'));
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(expect.stringContaining('task threw'));
  });

  it('uses slice exceeded as the single warning for a slice abort', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const { SLOW_WARN_MS } = await import('../../../src/main/util/boot_init');
    vi.setSystemTime(0);

    const pending = boot.runBootTaskForTest('slice', (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        vi.setSystemTime(SLOW_WARN_MS + 1);
        reject(Object.assign(new Error('slice aborted'), { name: 'AbortError' }));
      }, { once: true });
    }), { maxSliceMs: 10 });
    await vi.runAllTimersAsync();
    await pending;

    const warnings = loggerMocks.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.filter((message) => message.includes('task slice exceeded'))).toHaveLength(1);
    expect(warnings.some((message) => message.includes('task slow'))).toBe(false);
    expect(warnings.some((message) => message.includes('task threw'))).toBe(false);
  });
});
