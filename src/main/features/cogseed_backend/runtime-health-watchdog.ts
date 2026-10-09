import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { isCogSeedTaskActiveStatus } from './lifecycle';
import type { CogSeedTaskRecord } from './types';

const log = createLogger('cogseed-backend:runtime-health-watchdog');

export const DEFAULT_COGSEED_RUNTIME_WATCHDOG_INTERVAL_MS = 15_000;
export const DEFAULT_COGSEED_RUNTIME_ORPHAN_GRACE_MS = 60_000;
export const DEFAULT_COGSEED_RUNTIME_SLOW_THRESHOLD_MS = 2 * 60_000;

export type CogSeedExecutionProcessHealth = 'alive' | 'missing' | 'invalid' | 'unknown';
export type CogSeedRuntimeHealthState = 'active' | 'slow-but-alive' | 'stale' | 'orphaned';

export interface CogSeedRuntimeHealthDecision {
  state: CogSeedRuntimeHealthState;
  effectiveOwnership: boolean;
  recoverable: boolean;
  reason: 'owned' | 'process-alive' | 'process-unknown' | 'process-grace' | 'process-gone';
}

export interface CogSeedRuntimeHealthObservation {
  controllerOwnsTask: boolean;
  processHealth: CogSeedExecutionProcessHealth;
  updatedAtMs: number;
  observedAtMs: number;
  missingSinceMs?: number;
  orphanGraceMs: number;
  slowThresholdMs: number;
}

/**
 * Runtime health matrix. `updatedAt` only distinguishes normal activity from a
 * quiet-but-live run; it is never sufficient evidence for recovery.
 */
export function classifyCogSeedRuntimeHealth(
  observation: CogSeedRuntimeHealthObservation,
): CogSeedRuntimeHealthDecision {
  const processGone = observation.processHealth === 'missing' || observation.processHealth === 'invalid';
  const effectiveOwnership = observation.controllerOwnsTask && !processGone;
  const ageMs = Number.isFinite(observation.updatedAtMs)
    ? Math.max(0, observation.observedAtMs - observation.updatedAtMs)
    : Number.POSITIVE_INFINITY;

  if (effectiveOwnership) {
    return {
      state: ageMs > observation.slowThresholdMs ? 'slow-but-alive' : 'active',
      effectiveOwnership: true,
      recoverable: false,
      reason: 'owned',
    };
  }
  if (observation.processHealth === 'alive') {
    return {
      state: 'slow-but-alive',
      effectiveOwnership: false,
      recoverable: false,
      reason: 'process-alive',
    };
  }
  if (!processGone) {
    return {
      state: 'stale',
      effectiveOwnership: false,
      recoverable: false,
      reason: 'process-unknown',
    };
  }

  const graceElapsed = observation.missingSinceMs !== undefined
    && observation.observedAtMs - observation.missingSinceMs >= observation.orphanGraceMs;
  return graceElapsed
    ? {
        state: 'orphaned',
        effectiveOwnership: false,
        recoverable: true,
        reason: 'process-gone',
      }
    : {
        state: 'stale',
        effectiveOwnership: false,
        recoverable: false,
        reason: 'process-grace',
      };
}

export interface CogSeedRuntimeHealthScanReport {
  scannedCount: number;
  recoveredCount: number;
  failedCount: number;
  states: Record<CogSeedRuntimeHealthState, number>;
}

export interface CogSeedRuntimeHealthWatchdog {
  watchUser(userId: string): void;
  start(): void;
  scanNow(): Promise<CogSeedRuntimeHealthScanReport>;
  shutdown(): Promise<void>;
}

export interface CogSeedRuntimeHealthWatchdogOptions {
  listTasks(userId: string): Promise<CogSeedTaskRecord[]>;
  controllerOwnsTask(userId: string, task: CogSeedTaskRecord): boolean | Promise<boolean>;
  probeProcess(userId: string, task: CogSeedTaskRecord): CogSeedExecutionProcessHealth | Promise<CogSeedExecutionProcessHealth>;
  recoverTask(userId: string, task: CogSeedTaskRecord): boolean | Promise<boolean>;
  intervalMs?: number;
  orphanGraceMs?: number;
  slowThresholdMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

function emptyReport(): CogSeedRuntimeHealthScanReport {
  return {
    scannedCount: 0,
    recoveredCount: 0,
    failedCount: 0,
    states: { active: 0, 'slow-but-alive': 0, stale: 0, orphaned: 0 },
  };
}

function observationKey(userId: string, task: CogSeedTaskRecord): string {
  return `${userId}:${task.taskId}:${task.executionId || ''}`;
}

export function createCogSeedRuntimeHealthWatchdog(
  options: CogSeedRuntimeHealthWatchdogOptions,
): CogSeedRuntimeHealthWatchdog {
  const watchedUsers = new Set<string>();
  const missingSince = new Map<string, number>();
  const intervalMs = options.intervalMs ?? DEFAULT_COGSEED_RUNTIME_WATCHDOG_INTERVAL_MS;
  const orphanGraceMs = options.orphanGraceMs ?? DEFAULT_COGSEED_RUNTIME_ORPHAN_GRACE_MS;
  const slowThresholdMs = options.slowThresholdMs ?? DEFAULT_COGSEED_RUNTIME_SLOW_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let started = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<CogSeedRuntimeHealthScanReport> | null = null;

  function schedule(expectedGeneration: number): void {
    if (!started || generation !== expectedGeneration || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void scanNow().finally(() => schedule(expectedGeneration));
    }, intervalMs);
    timer.unref?.();
  }

  async function scanTask(
    userId: string,
    task: CogSeedTaskRecord,
    report: CogSeedRuntimeHealthScanReport,
    scanGeneration: number,
  ): Promise<void> {
    const key = observationKey(userId, task);
    let controllerOwnsTask: boolean;
    let processHealth: CogSeedExecutionProcessHealth;
    try {
      controllerOwnsTask = await options.controllerOwnsTask(userId, task);
    } catch (error) {
      report.failedCount += 1;
      report.states.stale += 1;
      missingSince.delete(key);
      log.warn('CogSeed Runtime ownership probe failed', { error: logErrorRef(error) });
      return;
    }
    try {
      processHealth = await options.probeProcess(userId, task);
    } catch (error) {
      report.failedCount += 1;
      report.states.stale += 1;
      missingSince.delete(key);
      log.warn('CogSeed Runtime process probe failed', { error: logErrorRef(error) });
      return;
    }

    const observedAtMs = now();
    const processGone = processHealth === 'missing' || processHealth === 'invalid';
    const effectiveOwnership = controllerOwnsTask && !processGone;
    if (!effectiveOwnership && processGone) {
      if (!missingSince.has(key)) missingSince.set(key, observedAtMs);
    } else {
      missingSince.delete(key);
    }
    const updatedAtMs = Date.parse(task.updatedAt);
    const decision = classifyCogSeedRuntimeHealth({
      controllerOwnsTask,
      processHealth,
      updatedAtMs,
      observedAtMs,
      missingSinceMs: missingSince.get(key),
      orphanGraceMs,
      slowThresholdMs,
    });
    report.states[decision.state] += 1;
    if (!decision.recoverable || !started || generation !== scanGeneration) return;

    try {
      if (await options.recoverTask(userId, task)) report.recoveredCount += 1;
      missingSince.delete(key);
    } catch (error) {
      report.failedCount += 1;
      log.warn('CogSeed Runtime orphan recovery failed', { error: logErrorRef(error) });
    }
  }

  async function runScan(scanGeneration: number): Promise<CogSeedRuntimeHealthScanReport> {
    const report = emptyReport();
    for (const userId of watchedUsers) {
      let tasks: CogSeedTaskRecord[];
      try {
        tasks = await options.listTasks(userId);
      } catch (error) {
        report.failedCount += 1;
        log.warn('CogSeed Runtime health task scan failed', { error: logErrorRef(error) });
        continue;
      }
      const candidates = tasks.filter((task) => isCogSeedTaskActiveStatus(task.status));
      report.scannedCount += candidates.length;
      const candidateKeys = new Set(candidates.map((task) => observationKey(userId, task)));
      for (const key of missingSince.keys()) {
        if (key.startsWith(`${userId}:`) && !candidateKeys.has(key)) missingSince.delete(key);
      }
      for (const task of candidates) {
        await scanTask(userId, task, report, scanGeneration);
      }
    }
    return report;
  }

  function scanNow(): Promise<CogSeedRuntimeHealthScanReport> {
    if (inFlight) return inFlight;
    const scanGeneration = generation;
    const scan = runScan(scanGeneration);
    inFlight = scan;
    const clear = () => {
      if (inFlight === scan) inFlight = null;
    };
    void scan.then(clear, clear);
    return scan;
  }

  return {
    watchUser(userId) {
      watchedUsers.add(userId);
    },
    start() {
      if (started) return;
      started = true;
      generation += 1;
      schedule(generation);
    },
    scanNow,
    async shutdown() {
      started = false;
      generation += 1;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
      missingSince.clear();
    },
  };
}
