import { describe, expect, it } from 'vitest';
import { mergeUsage } from '../src/agent/session.js';
import type { Usage } from '../src/shared/types.js';

const bare: Usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };
const cached: Usage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 30, totalTokens: 155 };
const zero: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

describe('session cache accounting', () => {
  it('sums all known buckets and preserves explicit zero', () => {
    expect(mergeUsage(cached, cached)).toStrictEqual({
      inputTokens: 40, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 60, totalTokens: 310,
    });
    expect(mergeUsage(zero, zero)).toStrictEqual(zero);
  });

  it('does not invent cache counts when both observations omit them', () => {
    expect(mergeUsage(bare, bare)).toStrictEqual({ inputTokens: 40, outputTokens: 10, totalTokens: 50 });
  });

  it.each([[bare, cached], [cached, bare], [bare, zero], [zero, bare]])(
    'keeps an incomplete bucket unknown in either merge order: %j', (left, right) => {
      const result = mergeUsage(left, right);
      expect(result).not.toHaveProperty('cacheReadTokens');
      expect(result).not.toHaveProperty('cacheWriteTokens');
      expect(mergeUsage(result, cached)).not.toHaveProperty('cacheReadTokens');
      expect(mergeUsage(cached, result)).not.toHaveProperty('cacheWriteTokens');
    },
  );

  it('treats absence of an entire contribution as an identity without assuming unknown fields are zero', () => {
    expect(mergeUsage()).toStrictEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(mergeUsage(undefined, cached)).toStrictEqual(cached);
    expect(mergeUsage(cached)).toStrictEqual(cached);
    expect(mergeUsage(undefined, bare)).toStrictEqual(bare);
    // Real-shape legacy input can have a null/missing usage object.
    expect(mergeUsage(null as unknown as Usage, null as unknown as Usage)).toStrictEqual({
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
  });

  it('keeps cache bucket completeness independent for partial usage objects', () => {
    const left = Object.freeze({ ...cached, cacheReadTokens: 0 });
    const right = Object.freeze({ outputTokens: 3, cacheReadTokens: 0 });
    expect(mergeUsage(left, right)).toStrictEqual({ outputTokens: 8, cacheReadTokens: 0 });
    expect(left).toStrictEqual({ ...cached, cacheReadTokens: 0 });
    expect(right).toStrictEqual({ outputTokens: 3, cacheReadTokens: 0 });
    expect(mergeUsage(cached, {})).toStrictEqual({});
  });
});

describe('presence-aware input/output totals', () => {
  it('keeps a successful usage-less response unknown across repeated accumulation and JSON persistence', () => {
    for (const known of [zero, cached, { ...cached, totalInputTokens: 150 }]) {
      for (const [left, right] of [[known, {}], [{}, known], [{}, {}]] as const) {
        const merged = mergeUsage(left, right);
        expect(merged).toStrictEqual({});
        const persisted = JSON.parse(JSON.stringify(merged));
        expect(mergeUsage(persisted, known)).toStrictEqual({});
        expect(mergeUsage(known, persisted)).toStrictEqual({});
      }
    }
    expect(mergeUsage(undefined, {})).toStrictEqual({});
    expect(mergeUsage({})).toStrictEqual({});
  });

  it('tracks the completeness of input, output and total independently', () => {
    expect(mergeUsage({ outputTokens: 0 }, { ...cached, outputTokens: 0 })).toStrictEqual({ outputTokens: 0 });
    expect(mergeUsage({ inputTokens: 0 }, zero)).toStrictEqual({ inputTokens: 0 });
    expect(mergeUsage({ totalTokens: 0 }, cached)).toStrictEqual({ totalTokens: 155 });
    expect(mergeUsage({ totalInputTokens: 150 }, { totalInputTokens: 0 })).toStrictEqual({ totalInputTokens: 150 });
  });

  it.each([-1, 0.5, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1])('omits invalid numeric totals instead of poisoning later totals: %s', invalid => {
    const malformed = { inputTokens: invalid, outputTokens: invalid, totalTokens: invalid } as unknown as Usage;
    expect(mergeUsage(undefined, malformed)).toStrictEqual({});
    expect(mergeUsage(malformed, cached)).toStrictEqual({});
    expect(mergeUsage(cached, malformed)).toStrictEqual({});
  });

  it('never resurrects unsafe input/output/total sums as exact after a zero response', () => {
    const edge = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER };
    const one = { inputTokens: 1, outputTokens: 1, totalTokens: 1 };
    const overflow = mergeUsage(edge, one);
    expect(overflow).toStrictEqual({});
    expect(mergeUsage(overflow, zero)).toStrictEqual({});
  });
});

describe('cache count validity in shared usage merging', () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, '0', '100', Number.MAX_SAFE_INTEGER + 1])('sanitizes an invalid bucket even with no other contribution: %s', (invalid) => {
    const malformed = { ...cached, cacheReadTokens: invalid } as unknown as Usage;
    expect(mergeUsage(undefined, malformed)).toStrictEqual({ ...bare, totalTokens: 155, cacheWriteTokens: 30 });
    expect(mergeUsage(malformed)).toStrictEqual({ ...bare, totalTokens: 155, cacheWriteTokens: 30 });
    for (const result of [mergeUsage(malformed, zero), mergeUsage(zero, malformed)]) {
      expect(result).not.toHaveProperty('cacheReadTokens');
      expect(result.cacheWriteTokens).toBe(30);
    }
  });

  it('does not emit unsafe cache sums or later resurrect them as exact', () => {
    const edge = { ...zero, cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: Number.MAX_SAFE_INTEGER };
    expect(mergeUsage(edge, zero)).toStrictEqual(edge);
    const overflow = mergeUsage(edge, { ...zero, cacheReadTokens: 1, cacheWriteTokens: 1 });
    expect(overflow).toStrictEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(mergeUsage(overflow, zero)).toStrictEqual(overflow);
  });
});

// Wire prompt totals remain useful even when cache-write presence is unknown.
describe('explicit total input accounting', () => {
  const wire = { ...bare, totalInputTokens: 120 };

  it('uses explicit totals without requiring cache bucket presence', () => {
    expect(mergeUsage(wire, wire)).toStrictEqual({ inputTokens: 40, outputTokens: 10, totalTokens: 50, totalInputTokens: 240 });
    expect(mergeUsage(wire, cached).totalInputTokens).toBe(270);
    expect(mergeUsage(cached, wire).totalInputTokens).toBe(270);
  });

  it('keeps an absent contribution an identity and explicit zero meaningful', () => {
    expect(mergeUsage(wire)).toStrictEqual(wire);
    expect(mergeUsage(undefined, wire)).toStrictEqual(wire);
    expect(mergeUsage({ ...zero, totalInputTokens: 0 }, wire).totalInputTokens).toBe(120);
  });

  it.each([[wire, bare], [bare, wire], [wire, {}]])('omits the aggregate when a contributing total cannot be known: %j', (left, right) => {
    expect(mergeUsage(left as Usage, right)).not.toHaveProperty('totalInputTokens');
  });

  it('omits unsafe explicit and fallback sums', () => {
    const edge = { ...bare, totalInputTokens: Number.MAX_SAFE_INTEGER };
    expect(mergeUsage(edge, { ...bare, totalInputTokens: 1 })).not.toHaveProperty('totalInputTokens');
    const unsafeFallback = { ...cached, cacheReadTokens: Number.MAX_SAFE_INTEGER };
    expect(mergeUsage(wire, unsafeFallback)).not.toHaveProperty('totalInputTokens');
    for (const invalid of [-1, 0.5, NaN, Infinity, '120']) {
      expect(mergeUsage({ ...bare, totalInputTokens: invalid } as unknown as Usage)).not.toHaveProperty('totalInputTokens');
    }
  });

  it.each([null, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('does not replace an explicitly invalid wire total with complete legacy buckets: %s', (totalInputTokens) => {
    const invalid = { ...cached, totalInputTokens } as unknown as Usage;
    expect(mergeUsage(invalid, wire)).not.toHaveProperty('totalInputTokens');
    expect(mergeUsage(wire, invalid)).not.toHaveProperty('totalInputTokens');
  });

  it('does not resurrect an incomplete historical denominator after a later complete wire response', () => {
    const incomplete = mergeUsage(wire, bare);
    expect(mergeUsage(incomplete, wire)).not.toHaveProperty('totalInputTokens');
    expect(mergeUsage(wire, incomplete)).not.toHaveProperty('totalInputTokens');
    const legacyComplete = mergeUsage(cached, cached);
    expect(mergeUsage(legacyComplete, wire).totalInputTokens).toBe(420);
  });
});
