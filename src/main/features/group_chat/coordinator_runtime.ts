import type { LocalEvent } from '../local_agents/backends/base';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import {
  TurnActivityTracker,
  type CoordinatorActivityEvent,
  type CoordinatorLeaseConfig,
  type CoordinatorStallReason,
  DEFAULT_COORDINATOR_LEASES,
} from './coordinator_activity';

const log = createLogger('group-chat:coordinator-runtime');

export interface CoordinatorProcessEvent {
  stream: string;
  data?: Record<string, unknown>;
}

export interface TurnLeaseMonitor {
  observe(event: CoordinatorActivityEvent): void;
  stop(): void;
}

function normalizedLower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function optionalScalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

function firstScalarString(values: unknown[], fallback: string): string {
  for (const value of values) {
    const text = optionalScalarString(value);
    if (text !== undefined) return text;
  }
  return fallback;
}

export function probeProcessLiveness(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    const code = typeof err === 'object'
      && err !== null
      && typeof (err as NodeJS.ErrnoException).code === 'string'
      ? String((err as NodeJS.ErrnoException).code).toUpperCase()
      : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    log.warn('process liveness probe failed; assuming alive', {
      error_code: code || 'unknown',
    });
    return true;
  }
}

function deliverLeaseCallback(
  callbackKind: 'probe' | 'abort',
  callback: (...args: unknown[]) => void,
  args: unknown[],
): void {
  try {
    const result = (callback as (...callbackArgs: unknown[]) => unknown)(...args);
    if (result !== null
      && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch((err) => {
        log.warn('coordinator lease callback failed', {
          callback_kind: callbackKind,
          error: logErrorSummary(err),
        });
      });
    }
  } catch (err) {
    log.warn('coordinator lease callback failed', {
      callback_kind: callbackKind,
      error: logErrorSummary(err),
    });
  }
}

export function activityFromLocalEvent(event: LocalEvent): CoordinatorActivityEvent {
  const type = normalizedLower(event?.type);
  if (type === 'idle') return { kind: 'idle_heartbeat' };
  if (type === 'done') return { kind: 'terminal' };
  if (type === 'tool-event') {
    const phase = normalizedLower(event.phase);
    const callId = optionalScalarString(event.callId);
    const tool = firstScalarString([event.tool], 'tool');
    if (phase === 'use') {
      return {
        kind: 'tool_start',
        ...(callId ? { callId } : {}),
        tool,
        longRunning: event.longRunning === true,
      };
    }
    if (phase === 'result') {
      return {
        kind: 'tool_result',
        ...(callId ? { callId } : {}),
        tool,
      };
    }
  }
  return { kind: 'activity' };
}

export function activityFromProcessEvent(event: CoordinatorProcessEvent): CoordinatorActivityEvent {
  const stream = normalizedLower(event?.stream);
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const phase = normalizedLower(data.phase) || normalizedLower(data.status);

  if (stream === 'tool') {
    const callId = firstScalarString([data.call_id, data.callId, data.id], '');
    const tool = firstScalarString([data.name, data.toolName, data.tool], 'tool');
    if (/^(start|running|request|call|begin)$/.test(phase)) {
      return {
        kind: 'tool_start',
        ...(callId ? { callId } : {}),
        tool,
        longRunning: data.long_running === true || data.longRunning === true,
      };
    }
    if (/^(end|result|completed|done)$/.test(phase)) {
      return {
        kind: 'tool_result',
        ...(callId ? { callId } : {}),
        tool,
      };
    }
  }

  if (stream === 'approval' && phase === 'waiting') {
    return { kind: 'awaiting_user' };
  }
  if (stream === 'approval' && /^(approved|rejected|cancelled)$/.test(phase)) {
    return { kind: 'user_resumed' };
  }
  return { kind: 'activity' };
}

export function startTurnLeaseMonitor(input: {
  startedAt: number;
  config?: CoordinatorLeaseConfig;
  onProbe: (idleMs: number) => void;
  onAbort: (reason: CoordinatorStallReason, idleMs: number) => void;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): TurnLeaseMonitor {
  const now = input.now || Date.now;
  const tracker = new TurnActivityTracker(
    input.startedAt,
    input.config || DEFAULT_COORDINATOR_LEASES,
  );
  let stopped = false;
  let aborted = false;
  let timerAssigned = false;
  let clearRequested = false;
  let timerCleared = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clearIntervalFn = input.clearIntervalFn || clearInterval;

  const clearTimerOnce = () => {
    if (timerCleared) return;
    if (!timerAssigned) {
      clearRequested = true;
      return;
    }
    timerCleared = true;
    clearRequested = false;
    clearIntervalFn(timer as ReturnType<typeof setInterval>);
  };

  const tick = () => {
    if (stopped || aborted) return;
    const tickNow = now();
    const decision = tracker.evaluate(tickNow);
    if (decision.kind === 'probe') {
      deliverLeaseCallback('probe', input.onProbe, [decision.idleMs]);
      return;
    }
    if (decision.kind === 'abort') {
      aborted = true;
      tracker.observe({ kind: 'terminal' }, tickNow);
      clearTimerOnce();
      deliverLeaseCallback('abort', input.onAbort, [decision.reason, decision.idleMs]);
    }
  };

  timer = (input.setIntervalFn || setInterval)(tick, 5_000);
  timerAssigned = true;
  if (clearRequested) clearTimerOnce();
  if (!timerCleared) {
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  return {
    observe(event) {
      tracker.observe(event, now());
    },
    stop() {
      if (stopped) return;
      stopped = true;
      tracker.observe({ kind: 'terminal' }, now());
      clearTimerOnce();
    },
  };
}
