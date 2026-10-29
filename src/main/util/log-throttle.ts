/**
 * Collapse repeated identical log lines inside a rolling time window.
 *
 * Some failures arrive in bursts rather than loops: several parallel IPC calls
 * discover the same dead credential within the same second, so each one logs
 * the same line and the log stops being readable. The first occurrence of a
 * window is worth a line; later ones are counted and folded into the next emit,
 * which keeps the total recoverable without the flood.
 *
 * Callers own the message and level — this only decides whether to emit.
 */

interface ThrottleWindow {
  /** When the current window opened. */
  since: number;
  /** Occurrences dropped since the last emit. */
  suppressed: number;
}

const _windows = new Map<string, ThrottleWindow>();

export interface LogThrottleDecision {
  /** Whether the caller should emit this occurrence. */
  emit: boolean;
  /**
   * Occurrences folded into this emit since the previous one. Always 0 when
   * `emit` is false.
   */
  suppressed: number;
}

/**
 * Decide whether to emit the log line identified by `key`.
 *
 * `now` is injectable so tests do not depend on wall-clock timing.
 */
export function throttleLog(key: string, windowMs: number, now: number = Date.now()): LogThrottleDecision {
  const previous = _windows.get(key);
  if (previous && now - previous.since < windowMs) {
    previous.suppressed += 1;
    return { emit: false, suppressed: 0 };
  }
  const suppressed = previous ? previous.suppressed : 0;
  _windows.set(key, { since: now, suppressed: 0 });
  return { emit: true, suppressed };
}

/** Test-only: window state would otherwise leak across test cases. */
export function _resetLogThrottleForTest(): void {
  _windows.clear();
}
