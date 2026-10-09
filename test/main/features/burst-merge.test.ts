import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEISHU_BURST_DEFAULTS, createBurstMerger } from '../../../src/main/features/messaging/burst-merge';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function collect() {
  const batches: Array<{ key: string; ids: string[]; text: string }> = [];
  const merger = createBurstMerger<number>(FEISHU_BURST_DEFAULTS, (batch) => {
    batches.push({ key: batch.key, ids: batch.ids, text: batch.text });
  });
  return { merger, batches };
}

describe('burst merge', () => {
  it('merges a burst of split messages into one batch after the window', () => {
    const { merger, batches } = collect();
    merger.push('bot-1\u0000oc_1', { id: 'm-1', text: 'part one', payload: 1 });
    merger.push('bot-1\u0000oc_1', { id: 'm-2', text: 'part two', payload: 2 });
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({ key: 'bot-1\u0000oc_1', ids: ['m-1', 'm-2'], text: 'part one\npart two' });
    expect(batches[0]).not.toHaveProperty('payload');
  });

  it('flushes immediately at the count limit and keeps the first payload', () => {
    const { merger, batches } = collect();
    for (let i = 0; i < 8; i += 1) {
      merger.push('k', { id: `m-${i}`, text: `t${i}`, payload: i });
    }
    expect(batches).toHaveLength(1);
    expect(batches[0].ids).toHaveLength(8);
    merger.push('k', { id: 'm-8', text: 't8', payload: 8 });
    expect(batches).toHaveLength(1);
    for (let i = 9; i < 16; i += 1) {
      merger.push('k', { id: `m-${i}`, text: `t${i}`, payload: i });
    }
    expect(batches).toHaveLength(2);
    expect(batches[1].ids).toHaveLength(8);
  });

  it('flushes immediately at the char limit', () => {
    const { merger, batches } = collect();
    merger.push('k', { id: 'm-1', text: 'x'.repeat(3999), payload: 1 });
    merger.push('k', { id: 'm-2', text: 'yy', payload: 2 });
    expect(batches).toHaveLength(1);
    expect(batches[0].ids).toEqual(['m-1', 'm-2']);
  });

  it('uses the longer adaptive window near the char threshold', () => {
    const { merger, batches } = collect();
    merger.push('k', { id: 'm-1', text: 'x'.repeat(3500), payload: 1 });
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1400);
    expect(batches).toHaveLength(1);
  });

  it('keeps separate groups per key', () => {
    const { merger, batches } = collect();
    merger.push('k-1', { id: 'm-1', text: 'a', payload: 1 });
    merger.push('k-2', { id: 'm-2', text: 'b', payload: 2 });
    vi.advanceTimersByTime(600);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.key).sort()).toEqual(['k-1', 'k-2']);
  });

  it('flush(key) and dispose() cancel pending timers', () => {
    const { merger, batches } = collect();
    merger.push('k-1', { id: 'm-1', text: 'a', payload: 1 });
    merger.push('k-2', { id: 'm-2', text: 'b', payload: 2 });
    merger.flush('k-1');
    expect(batches).toHaveLength(1);
    expect(batches[0].key).toBe('k-1');
    merger.dispose();
    vi.advanceTimersByTime(10_000);
    expect(batches).toHaveLength(1);
  });
});
