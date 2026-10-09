/**
 * Debounced merger for bursty platform traffic (mirrors Hermes'
 * `_enqueue_text_event`). Feishu splits long messages into several pushed
 * chunks; each chunk must not consume a separate agent turn. Messages are
 * grouped by an opaque key (instance + chat), joined with "\n" and flushed
 * after a quiet window, immediately at the count/char limits, or on demand.
 */

export interface BurstMergeOptions {
  /** Quiet window before a batch is flushed (ms). */
  windowMs: number;
  /** Maximum messages per batch; reaching it flushes immediately. */
  maxCount: number;
  /** Maximum accumulated characters per batch; reaching it flushes. */
  maxChars: number;
  /** Accumulated chars at which the adaptive window kicks in. */
  adaptiveThresholdChars: number;
  /** Window used once the threshold is reached (ms). */
  adaptiveWindowMs: number;
}

export interface BurstItem<T> {
  id: string;
  text: string;
  /** Opaque caller payload; every item's payload rides on the batch. */
  payload: T;
}

export interface BurstBatch<T> {
  key: string;
  /** Message ids in arrival order; the first id is the batch identity. */
  ids: string[];
  /** Items joined with "\n". */
  text: string;
  /** Every item's payload, in arrival order; the caller consumes each one
   * (e.g. resolves the per-item promise) so no enqueued caller is left
   * hanging when the batch flushes. */
  payloads: T[];
}

export interface BurstMerger<T> {
  push(key: string, item: BurstItem<T>): void;
  flush(key?: string): void;
  dispose(): void;
}

export const FEISHU_BURST_DEFAULTS: BurstMergeOptions = {
  windowMs: 600,
  maxCount: 8,
  maxChars: 4_000,
  adaptiveThresholdChars: 3_500,
  adaptiveWindowMs: 2_000,
};

interface BurstGroup<T> {
  items: BurstItem<T>[];
  chars: number;
  timer: NodeJS.Timeout | null;
}

export function createBurstMerger<T>(
  options: BurstMergeOptions,
  flush: (batch: BurstBatch<T>) => void,
): BurstMerger<T> {
  const groups = new Map<string, BurstGroup<T>>();

  const windowFor = (chars: number): number =>
    chars >= options.adaptiveThresholdChars ? options.adaptiveWindowMs : options.windowMs;

  const emit = (key: string, group: BurstGroup<T>): void => {
    if (group.timer) {
      clearTimeout(group.timer);
      group.timer = null;
    }
    groups.delete(key);
    flush({
      key,
      ids: group.items.map((item) => item.id),
      text: group.items.map((item) => item.text).join('\n'),
      payloads: group.items.map((item) => item.payload),
    });
  };

  const schedule = (key: string, group: BurstGroup<T>): void => {
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(() => emit(key, group), windowFor(group.chars));
  };

  return {
    push(key, item) {
      if (!key || !item || !item.id) return;
      const text = item.text ?? '';
      let group = groups.get(key);
      if (!group) {
        group = { items: [], chars: 0, timer: null };
        groups.set(key, group);
      }
      group.items.push(item);
      group.chars += text.length;
      if (group.items.length >= options.maxCount || group.chars >= options.maxChars) {
        emit(key, group);
        return;
      }
      schedule(key, group);
    },
    flush(key) {
      if (key !== undefined) {
        const group = groups.get(key);
        if (group) emit(key, group);
        return;
      }
      for (const [groupKey, group] of [...groups]) emit(groupKey, group);
    },
    dispose() {
      for (const group of groups.values()) {
        if (group.timer) clearTimeout(group.timer);
      }
      groups.clear();
    },
  };
}
