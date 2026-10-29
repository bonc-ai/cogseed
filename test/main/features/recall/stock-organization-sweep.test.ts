import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const mocks = vi.hoisted(() => ({ stock: vi.fn(), scheduled: vi.fn(), listConversations: vi.fn() }));
vi.mock('../../../../src/main/features/recall/stock-organization', () => ({ runStockOrganization: mocks.stock, readStockOrganizationSavedCount: async () => 0 }));
vi.mock('../../../../src/main/features/chats', () => ({ listConversations: mocks.listConversations, getMessagesPage: async () => ({ history: [], nextCursor: null }) }));
vi.mock('../../../../src/main/features/group_chat/bus', () => ({ isQuiescent: () => true, subscribeTaskTerminals: () => () => {}, subscribe: () => () => {} }));
vi.mock('../../../../src/main/util/boot_init', () => ({ scheduleBootBackground: mocks.scheduled, registerDeferred: () => {} }));
let root: string, previous: string | undefined;
const user = 'stock-sweep-user';
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 19, 3));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-sweep-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  mocks.listConversations.mockResolvedValue([]);
  mocks.scheduled.mockImplementation((name, fn) => {
    if (name !== 'recall:stock-organization') return { cancel: vi.fn(), promise: new Promise(() => {}) };
    const controller = new AbortController(); let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    queueMicrotask(() => { if (!controller.signal.aborted) Promise.resolve(fn(controller.signal)).finally(finish).catch(() => {}); });
    return { promise, cancel: () => { controller.abort(); finish(); } };
  });
});
afterEach(async () => {
  (await import('../../../../src/main/features/recall/capture-service')).startRecallCaptureOrchestrator()();
  vi.useRealTimers(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
it.each(['manual', 'nightly'])('%s scanning includes saved content without a separate opt-in and respects the main switch', async (trigger) => {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const store = await import('../../../../src/main/features/recall/store');
  const defaults = await settings.readRecallCaptureSettings(user);
  // Reproduce an existing installation that had not enabled the retired scope.
  await store.writeRecallJsonRecord(user, 'capture-settings', 'settings', { ...defaults, stockOrganizationEnabled: false });
  const service = await import('../../../../src/main/features/recall/capture-service');
  service.startRecallCaptureOrchestrator();
  mocks.stock.mockResolvedValue(undefined);
  const run = async () => trigger === 'manual' ? service.runManualCaptureSweep(user)
    : service.runNightlyCaptureSweep(user, new Date().toISOString(), await settings.readRecallCaptureSettings(user));
  expect(await run()).toMatchObject({ ran: true, scanned: 0 });
  expect(mocks.stock).toHaveBeenCalledTimes(1);
  await settings.updateRecallCaptureSettings(user, { enabled: false });
  expect(await run()).toMatchObject({ ran: false, reason: 'disabled' });
  expect(mocks.stock).toHaveBeenCalledTimes(1);
});

it('keeps no-conversation scans running through model cancellation, blocks same-window self-resume, and permits explicit resumption', async () => {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  await settings.updateRecallCaptureSettings(user, { autoApproval: true });
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const unwound = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal;
  mocks.stock.mockImplementation(async (_uid, _settings, abort, report) => {
    signal = abort;
    await report({ phase: 'organizing', total: 1, checked: 0, proposed: 0, saved: 0, remaining: 1, noChange: 0, insufficient: 0, failed: 0, candidateIds: [] });
    started(); await unwound;
    await report({ phase: 'stopped', total: 1, checked: 0, proposed: 0, saved: 0, remaining: 1, noChange: 0, insufficient: 0, failed: 0, candidateIds: [] });
  });
  const service = await import('../../../../src/main/features/recall/capture-service');
  service.startRecallCaptureOrchestrator();
  const running = service.runManualCaptureSweep(user); await ready;
  expect(service.readRecallNightlySweepRuntime(user).running).toBe(true);
  expect(await service.runManualCaptureSweep(user)).toMatchObject({ ran: false, reason: 'sweep_in_flight' });
  expect(await service.stopRecallCaptureSweep(user)).toEqual({ stopped: true });
  expect(signal!.aborted).toBe(true);
  expect(service.readRecallNightlySweepRuntime(user).running).toBe(true);
  release(); await running;
  expect(service.readRecallNightlySweepRuntime(user).running).toBe(false);
  expect(await settings.readRecallCaptureSettings(user)).toMatchObject({ enabled: true, autoApproval: true });
  expect(await service.runNightlyCaptureSweep(user, new Date().toISOString(), await settings.readRecallCaptureSettings(user)))
    .toMatchObject({ ran: false, reason: 'stopped_for_window' });
  // Restart discards runtime maps, but not the persisted stop for this window.
  vi.resetModules();
  const restarted = await import('../../../../src/main/features/recall/capture-service');
  expect(await restarted.runNightlyCaptureSweep(user, new Date().toISOString(), await settings.readRecallCaptureSettings(user)))
    .toMatchObject({ ran: false, reason: 'stopped_for_window' });
  mocks.stock.mockResolvedValue(undefined);
  expect(await restarted.runManualCaptureSweep(user)).toMatchObject({ ran: true });
  expect(mocks.stock).toHaveBeenCalledTimes(2);
});
it('exposes an interrupted stock task as a failed run, rather than a completed scan', async () => {
  mocks.stock.mockRejectedValue(new Error('Synthetic inventory read error'));
  const service = await import('../../../../src/main/features/recall/capture-service');
  service.startRecallCaptureOrchestrator();
  expect(await service.runManualCaptureSweep(user)).toMatchObject({ ran: true, error: 'scan_task_failed' });
  expect(await service.readRecallNightlySweep(user)).toMatchObject({ phase: 'failed' });
});
it('persists a model failure pause without self-resuming, and explicit retry clears only the failure guard', async () => {
  const budget = await import('../../../../src/main/features/recall/capture-model-budget');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const service = await import('../../../../src/main/features/recall/capture-service');
  service.startRecallCaptureOrchestrator();
  const context = { jobId: 'synthetic-failed-job', stage: 'extraction' as const };
  mocks.stock.mockImplementationOnce(async () => {
    for (let i = 0; i < 3; i++) {
      await budget.withCaptureModelBudget(user, context, 10, async () => ({}));
      await budget.recordCaptureModelOutcome(user, context, 'connection');
    }
  });
  await service.runManualCaptureSweep(user);
  expect(await service.readRecallNightlySweep(user)).toMatchObject({ phase: 'failure_held' });
  expect(await service.runNightlyCaptureSweep(user, new Date().toISOString(), await settings.readRecallCaptureSettings(user)))
    .toMatchObject({ ran: false, reason: 'model_failure_held' });
  expect(mocks.stock).toHaveBeenCalledTimes(1);
  mocks.stock.mockImplementationOnce(async (_user, _settings, _signal, _report, _continue, options) => {
    expect(options.retryFailed).toBe(true);
    expect(await budget.readCaptureModelBudget(user)).toMatchObject({ calls: 3, failureGuard: { held: false } });
  });
  expect(await service.runManualCaptureSweep(user)).toMatchObject({ ran: true });
  expect(await service.readRecallNightlySweep(user)).toMatchObject({ phase: 'complete' });
});

async function useRealScheduler() {
  const boot = await vi.importActual<typeof import('../../../../src/main/util/boot_init')>('../../../../src/main/util/boot_init');
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(2026, 9, 19, 3));
  boot._resetForTests();
  mocks.scheduled.mockImplementation(boot.scheduleBootBackground);
  return boot;
}

it.each(['complete', 'loop stop', 'user stop'])('nightly coordinator outlives the admission slice and retains ownership until %s settles', async outcome => {
  const service = await import('../../../../src/main/features/recall/capture-service');
  const boot = await useRealScheduler();
  service.startRecallCaptureOrchestrator();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | undefined;
  mocks.stock.mockImplementation(async (_uid, _settings, abort, report) => {
    signal = abort;
    const progress = { total: 1, checked: 0, proposed: 0, saved: 0, remaining: 1,
      noChange: 0, insufficient: 0, failed: 0, candidateIds: [] };
    await report({ ...progress, phase: 'organizing' });
    await pending;
    await report(abort.aborted ? { ...progress, phase: 'stopped' }
      : { ...progress, phase: 'complete', checked: 1, remaining: 0, noChange: 1 });
  });
  const loop = service.startNightlyCaptureSweepLoop(user);
  const admissions = () => mocks.scheduled.mock.calls.filter(call => call[0] === 'recall:nightly-sweep');
  try {
    // The real idle gate waits before admission, then real model-lane work starts.
    await vi.waitFor(() => expect(mocks.stock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(service.readRecallNightlySweepRuntime(user).running).toBe(true);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(signal!.aborted).toBe(false);
    // A model wait must not retain the disk lane or schedule another sweep.
    const diskWork = vi.fn();
    const disk = boot.scheduleBootBackground('synthetic:disk-read', diskWork, 0, { resourceClass: 'disk' });
    await vi.advanceTimersByTimeAsync(1);
    await disk.promise;
    expect(diskWork).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(admissions()).toHaveLength(1);
    expect(mocks.stock).toHaveBeenCalledTimes(1);
    expect(await service.runManualCaptureSweep(user)).toMatchObject({ ran: false, reason: 'sweep_in_flight' });

    if (outcome === 'loop stop') loop.stop();
    if (outcome === 'user stop') expect(await service.stopRecallCaptureSweep(user)).toEqual({ stopped: true });
    expect(signal!.aborted).toBe(outcome !== 'complete');
    // Scheduler cancellation resolves its handle before model cleanup; the
    // business scan must remain owned until that cleanup and its writes finish.
    expect(service.readRecallNightlySweepRuntime(user).running).toBe(true);
    expect(admissions()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(service.readRecallNightlySweepRuntime(user).running).toBe(false));
    expect(await service.readRecallNightlySweep(user)).toMatchObject(outcome === 'complete'
      ? { phase: 'complete', stock: { checked: 1, remaining: 0 } }
      : { phase: 'stopped', stock: { checked: 0, remaining: 1 } });
    if (outcome === 'loop stop') {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(admissions()).toHaveLength(1);
    } else {
      await vi.waitFor(() => expect(admissions()).toHaveLength(2));
      expect(admissions()[1][2]).toBe(15 * 60_000);
      if (outcome === 'user stop') {
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        // The next admission reads the persisted hold, and must not run models.
        await vi.waitFor(() => expect(admissions()).toHaveLength(3));
        expect(mocks.stock).toHaveBeenCalledTimes(1);
      }
    }
  } finally {
    loop.stop(); release();
    await vi.waitFor(() => expect(service.readRecallNightlySweepRuntime(user).running).toBe(false));
    boot._resetForTests();
  }
});

it.each(['window ended', 'next night', 'loop stopped'])('does not start a stale admitted sweep after idle waiting: %s', async condition => {
  const service = await import('../../../../src/main/features/recall/capture-service');
  const boot = await useRealScheduler();
  service.startRecallCaptureOrchestrator();
  let busy = false;
  boot.configureBootAdmission({ isRuntimeBusy: () => busy });
  mocks.scheduled.mockImplementation((name, ...args) => {
    // A conversation starts between the disk check and long-task admission.
    if (name === 'recall:nightly-sweep-run') busy = true;
    return boot.scheduleBootBackground(name, ...args);
  });
  const loop = service.startNightlyCaptureSweepLoop(user);
  try {
    await vi.waitFor(() => expect(mocks.scheduled.mock.calls.some(call => call[0] === 'recall:nightly-sweep-run')).toBe(true), { timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.stock).not.toHaveBeenCalled();
    if (condition === 'loop stopped') loop.stop();
    else vi.setSystemTime(new Date(2026, 9, condition === 'next night' ? 20 : 19, condition === 'next night' ? 3 : 6));
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.stock).not.toHaveBeenCalled();
    expect(service.readRecallNightlySweepRuntime(user).running).toBe(false);
  } finally {
    loop.stop(); boot._resetForTests();
  }
});
