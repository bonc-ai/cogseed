/**
 * Persistent runtime — adapter registry + backend wrapper.
 *
 * Wiring rule: the ONE-SHOT backend modules wrap themselves:
 *
 *   export const opencodeBackend = wrapPersistentBackend(
 *     'opencode', opencodeOneShotBackend);
 *
 * That keeps runner.ts and the bus untouched (zero contract change):
 * the wrapper is an ordinary LocalBackend that routes each `run`
 * through the manager when persistent mode is on and an adapter is
 * registered, and transparently delegates to the one-shot backend
 * otherwise (COGSEED_PERSISTENT=0, adapter unsupported, or shutdown).
 */

import type { LocalBackend, LocalEvent } from '../backends/base.js';
import type { LocalCliType } from '../registry.js';
import { getPersistentRuntimeManager } from './manager.js';
import type { PersistentAdapter } from './types.js';

export {
  persistentEnabled,
  resolveIdleReclaimMs,
  PersistentRuntimeManager,
  getPersistentRuntimeManager,
} from './manager.js';
export type {
  PersistentAdapter,
  PersistentWindow,
  PersistentAcquireOpts,
  PersistentSendOpts,
  PersistentTurnResult,
  PersistentCancelReason,
} from './types.js';
export { WindowDiedError } from './types.js';

/**
 * Adapter registry. Populated by the adapter modules themselves
 * (registerPersistentAdapter at import time) — importing a backend
 * file is what activates its persistent path. CLIs with no entry
 * (hermes, gemini, codex today — see the phase-0 probe report) stay
 * on the one-shot path with zero overhead.
 */
const ADAPTERS: Partial<Record<LocalCliType, PersistentAdapter>> = {};

export function registerPersistentAdapter(adapter: PersistentAdapter): void {
  ADAPTERS[adapter.cli] = adapter;
}

/** Test hook — clear registrations between suites. */
export function _clearPersistentAdaptersForTest(): void {
  for (const k of Object.keys(ADAPTERS)) delete ADAPTERS[k as LocalCliType];
}

/** Route marker so the log line "persistent window reused" can be
 *  attributed; also the single place that knows the manager exists. */
export function wrapPersistentBackend(cli: LocalCliType, oneShot: LocalBackend): LocalBackend {
  return {
    async run(opts): Promise<void> {
      const adapter = ADAPTERS[cli];
      if (!adapter || !adapter.supported) return oneShot.run(opts);
      return getPersistentRuntimeManager().run(opts, adapter, oneShot);
    },
  };
}

/** Re-exported for adapters that want to emit the same shape of
 *  reuse/process log events the manager does. */
export function persistentLogEvent(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): LocalEvent {
  return { type: 'log', level, message, source: 'persistent' };
}
