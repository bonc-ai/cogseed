/**
 * Live promoted runs — the in-memory half of "promoted to background".
 *
 * `background_runs.ts` records what a promoted run *is* (durable JSON under
 * `local/background_runs`). This module holds what a record cannot: the running
 * child of THIS process, so the app can still stop it.
 *
 * Why it exists: a promoted run deliberately outlives the turn that started it,
 * which means nothing in the normal dispatch path can reach it any more. Without
 * a registry a promoted child would keep the app from exiting cleanly (Node
 * waits for the child), and the user would have no way to stop a run whose card
 * scrolled away.
 *
 * Boundaries:
 *   - Process-lifetime only, keyed by run id. A record whose process is gone is
 *     stale by definition, so persisting this would lie.
 *   - `stop()` is the caller's process-tree killer (POSIX group / Windows
 *     `taskkill`), not a raw `child.kill` — a promoted CLI has descendants.
 *   - Registering twice for one run id keeps the newest handle and stops the
 *     older one, so a respawn can never leak a second live child under one id.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../../logger';
import { killProcessTree } from './backends/base.js';

const log = createLogger('local-agents:background-registry');

export interface PromotedRunHandle {
  runId: string;
  uid: string;
  cli: string;
  pid: number | null;
  /** Stops the whole process tree. Must not throw. */
  stop: (reason: string) => void;
}

const live = new Map<string, PromotedRunHandle>();

export function registerPromotedRun(handle: PromotedRunHandle): void {
  const previous = live.get(handle.runId);
  if (previous) {
    log.warn('promoted run re-registered; stopping the previous child', {
      runId: handle.runId,
      previousPid: previous.pid,
    });
    try { previous.stop('replaced'); } catch { /* already gone */ }
  }
  live.set(handle.runId, handle);
}

/** Drop a run that has ended. Safe to call for an unknown id. */
export function settlePromotedRun(runId: string): void {
  live.delete(runId);
}

export function listPromotedRuns(): PromotedRunHandle[] {
  return [...live.values()];
}

export function getPromotedRun(runId: string): PromotedRunHandle | null {
  return live.get(runId) ?? null;
}

/** Stop every live promoted run and forget it. Returns how many were asked to
 *  stop — the app-quit path needs to know whether it must wait. */
export function killAllPromotedRuns(reason: string): number {
  const handles = [...live.values()];
  live.clear();
  for (const handle of handles) {
    try {
      handle.stop(reason);
    } catch (err) {
      log.warn('promoted run stop failed', { runId: handle.runId, reason, error: String(err) });
    }
  }
  if (handles.length) {
    log.warn('stopped promoted runs', { count: handles.length, reason, runIds: handles.map((h) => h.runId) });
  }
  return handles.length;
}

/** Register a promoted run whose child belongs to ANOTHER process — currently
 *  the p3394 gateway, which spawns and owns the CLI itself.
 *
 *  Nothing in this process can hold that child object, so `stop` works by pid
 *  through the same `killProcessTree` (POSIX process group / Windows
 *  `taskkill /t /f`): the pid comes from the record, and the gateway keeps its
 *  side of the contract by leaving the child alive exactly as the runner does.
 *  A pid is a guess about a live process, so every failure is swallowed and
 *  logged — stopping something already gone is not an error. */
export function registerPromotedRunByPid(input: {
  runId: string;
  uid: string;
  cli: string;
  pid: number;
}): void {
  const { runId, uid, cli, pid } = input;
  // `killProcessTree` only reads `pid` and `kill`; this shim is the smallest
  // object that satisfies it without pretending we own a ChildProcess.
  const shim = {
    pid,
    kill: (signal?: NodeJS.Signals | number) => {
      try {
        process.kill(pid, signal as NodeJS.Signals);
        return true;
      } catch {
        return false;
      }
    },
  } as unknown as ChildProcessWithoutNullStreams;

  registerPromotedRun({
    runId,
    uid,
    cli,
    pid,
    stop: (reason: string) => {
      try {
        void killProcessTree(shim, 'SIGKILL');
      } catch (err) {
        log.warn('promoted run pid stop failed', { runId, pid, reason, error: String(err) });
      }
    },
  });
}

/** Test seam only: forget everything without stopping it. */
export function __resetPromotedRunsForTest(): void {
  live.clear();
}
