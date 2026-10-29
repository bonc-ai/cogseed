import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_RESULT_PRUNE,
  TOOL_RESULT_PRUNE_MARKER,
  assertRetainRatioBelowTrigger,
  MIN_NEW_VOLUME_RATIO,
  noNewVolumeSince,
  pruneToolResultContent,
  resolveToolResultPruneConfig,
  shouldReCompact,
} from '../../../../src/core-agent/src/agent/context-compaction-policy';

describe('core-agent › context compaction policy', () => {
  it('leaves text at or below the threshold untouched', () => {
    const text = 'x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.thresholdChars);
    expect(pruneToolResultContent(text)).toEqual({ text, pruned: false });
  });

  it('prunes a large result to head + marker + tail', () => {
    const text = 'H'.repeat(20_000) + 'T'.repeat(2_000);
    const out = pruneToolResultContent(text);
    expect(out.pruned).toBe(true);
    expect(out.text.startsWith('H'.repeat(DEFAULT_TOOL_RESULT_PRUNE.headChars))).toBe(true);
    expect(out.text).toContain(TOOL_RESULT_PRUNE_MARKER);
    expect(out.text.endsWith('T'.repeat(DEFAULT_TOOL_RESULT_PRUNE.tailChars))).toBe(true);
    // Never longer than threshold + marker: pruning must actually shrink.
    expect([...out.text].length).toBeLessThan([...text].length);
  });

  it('counts code points, not UTF-16 units, so emoji are not split', () => {
    const text = '😀'.repeat(9_000);
    const out = pruneToolResultContent(text);
    expect(out.pruned).toBe(true);
    expect(out.text.includes('\uFFFD')).toBe(false);
  });

  it('rejects a config whose parts cannot fit the threshold', () => {
    expect(() => resolveToolResultPruneConfig({ thresholdChars: 1_000 })).toThrow(/at most thresholdChars/);
    expect(() => resolveToolResultPruneConfig({ headChars: -1 })).toThrow(/non-negative/);
    expect(resolveToolResultPruneConfig({ thresholdChars: 20_000, headChars: 8_000, tailChars: 2_000 }).tailChars).toBe(2_000);
  });

  it('refuses a retained fraction that is not below the trigger', () => {
    expect(() => assertRetainRatioBelowTrigger(0.16, 0.82)).not.toThrow();
    expect(() => assertRetainRatioBelowTrigger(0.82, 0.82)).toThrow(/less than/);
    expect(() => assertRetainRatioBelowTrigger(0, 0.82)).toThrow(/between/);
  });

  it('does not re-compact in the same turn or without new volume, but allows genuine growth', () => {
    const base = { usableInputTokens: 30_000, triggerRatio: 0.82, currentTurnIndex: 5, lastCompaction: { tokensAfter: 7_000, turnIndex: 4 } };
    // below trigger → never
    expect(shouldReCompact({ ...base, tokensBefore: 20_000 })).toBe(false);
    // same turn → no
    expect(shouldReCompact({ ...base, tokensBefore: 26_000, currentTurnIndex: 4 })).toBe(false);
    // cross turn but only +10% volume → no (below the 25% new-volume floor)
    expect(shouldReCompact({ ...base, tokensBefore: 7_700 })).toBe(false);
    // cross turn with real new volume → yes
    expect(shouldReCompact({ ...base, tokensBefore: 26_000 })).toBe(true);
    // first compaction of a run is always allowed when over the trigger
    expect(shouldReCompact({ ...base, lastCompaction: null, tokensBefore: 26_000 })).toBe(true);
  });
});

/** The session-side gate's exact rule: it must decline re-compaction of the same
 *  history until the model view grows enough, and must never decline the first
 *  compaction of a run. */
describe('core-agent › noNewVolumeSince (checkpoint gate)', () => {
  it('allows the first compaction of a run and any unmeasured state', () => {
    expect(noNewVolumeSince(30_000, null)).toBe(false);
    expect(noNewVolumeSince(Number.NaN, 10_000)).toBe(false);
    expect(noNewVolumeSince(30_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('declines below the 25% floor and allows at or above it', () => {
    const last = 10_000;
    expect(noNewVolumeSince(last + 2_499, last)).toBe(true);   // +24.99% → decline
    expect(noNewVolumeSince(last + 2_500, last)).toBe(false);  // +25% exactly → allow
    expect(noNewVolumeSince(last + 9_000, last)).toBe(false);
    expect(MIN_NEW_VOLUME_RATIO).toBe(0.25);
  });

  it('honors a custom ratio and a zero/negative last level', () => {
    expect(noNewVolumeSince(1_500, 1_000, 0.6)).toBe(true);
    expect(noNewVolumeSince(1_600, 1_000, 0.6)).toBe(false);
    expect(noNewVolumeSince(0, 0)).toBe(true);   // any zero growth is still "no new volume"
  });
});
