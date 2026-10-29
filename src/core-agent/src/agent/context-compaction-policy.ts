/**
 * Context-compaction policy core: bounded tool-result pruning, an explicit
 * retained-tail ratio, and the "may we compact again yet" decision.
 *
 * Why this exists (diagnosis, 2026-10-18): a session with a ~30K usable window
 * compacted at 82%, dropping 24,765 → 7,059 tokens — and then re-crossed the
 * trigger after a couple of operations, because a single inline tool result can
 * be 16K tokens, i.e. more than half the window. The trigger itself is fine; the
 * retained tail was dominated by one oversized result, so summarising freed
 * almost nothing and every few operations paid for another compaction (196 s in
 * the observed run).
 *
 * The fix is structural, not a threshold tweak:
 *   - prune large tool results to head + tail + marker while the tail is kept,
 *     so no single result can dominate the retained window;
 *   - state the retained fraction explicitly and refuse to load a configuration
 *     whose retained fraction is not below its trigger (the comparison is the
 *     invariant, not a number);
 *   - require genuinely new volume before compacting the same history again,
 *     on top of the existing fingerprint dedup.
 *
 * Kept pure and dependency-free so the runner/session wiring can be tested
 * through these decisions without a provider or a live model.
 */

/** Defaults follow the shape proven by the reference harness: results beyond 8K
 *  characters become 4K of head, a marker, and 1K of tail. */
export interface ToolResultPruneConfig {
  /** Results longer than this (code points) are pruned. */
  thresholdChars: number;
  /** Verbatim characters kept from the start after pruning. */
  headChars: number;
  /** Verbatim characters kept from the end after pruning. */
  tailChars: number;
}

export const DEFAULT_TOOL_RESULT_PRUNE: Readonly<ToolResultPruneConfig> = Object.freeze({
  // Real-run calibration (2026-10-18, active_checkpoint path): four compactions in
  // three minutes with a shrinking saving (15.6K → 11.4K → 10.3K tokens) showed the
  // retained tail dominating the window, so the 8K character threshold left too
  // many oversized results in place. Halved: results over 4K characters keep 2K
  // head + marker + 512 tail.
  thresholdChars: 4_096,
  headChars: 2_048,
  tailChars: 512,
});

export const TOOL_RESULT_PRUNE_MARKER = '\n…[middle omitted to save context; re-read the source if exact bytes are needed]…\n';

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** Validate a prune config; throws on values that cannot express the rule. */
export function resolveToolResultPruneConfig(config: Partial<ToolResultPruneConfig> = {}): ToolResultPruneConfig {
  const resolved: ToolResultPruneConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULT_TOOL_RESULT_PRUNE.thresholdChars,
    headChars: config.headChars ?? DEFAULT_TOOL_RESULT_PRUNE.headChars,
    tailChars: config.tailChars ?? DEFAULT_TOOL_RESULT_PRUNE.tailChars,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`ToolResultPruneConfig: ${key} (${value}) must be a non-negative integer`);
    }
  }
  if (resolved.thresholdChars <= 0) {
    throw new Error(`ToolResultPruneConfig: thresholdChars (${resolved.thresholdChars}) must be positive`);
  }
  const emitted = resolved.headChars + codePointLength(TOOL_RESULT_PRUNE_MARKER) + resolved.tailChars;
  if (emitted > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: head + marker + tail (${emitted}) must be at most thresholdChars (${resolved.thresholdChars})`,
    );
  }
  return resolved;
}

/** Prune one tool-result string to head + marker + tail. Text at or below the
 *  threshold is returned unchanged (`pruned: false`) so callers can skip writes. */
export function pruneToolResultContent(
  text: string,
  config: ToolResultPruneConfig = DEFAULT_TOOL_RESULT_PRUNE,
): { text: string; pruned: boolean } {
  if (typeof text !== 'string') return { text: '', pruned: false };
  const resolved = config;
  if (codePointLength(text) <= resolved.thresholdChars) return { text, pruned: false };
  const chars = [...text];
  const head = chars.slice(0, resolved.headChars).join('');
  const tail = resolved.tailChars > 0 ? chars.slice(chars.length - resolved.tailChars).join('') : '';
  return { text: head + TOOL_RESULT_PRUNE_MARKER + tail, pruned: true };
}

/** Retained-tail fraction of the usable window. Explicit so a change to it is a
 *  reviewable number instead of an emergent property of `keptTailTokens`. */
export const CONTEXT_RETAIN_TAIL_RATIO = 0.16;

/** The retained fraction must stay below the trigger, or retention itself would
 *  keep the session above the line and cause the re-compaction loop. */
export function assertRetainRatioBelowTrigger(retainRatio: number, triggerRatio: number): void {
  if (!(retainRatio > 0 && retainRatio < 1)) {
    throw new Error(`retainRatio (${retainRatio}) must be between 0 and 1`);
  }
  if (!(triggerRatio > 0 && triggerRatio <= 1)) {
    throw new Error(`triggerRatio (${triggerRatio}) must be in (0, 1]`);
  }
  if (retainRatio >= triggerRatio) {
    throw new Error(`retainRatio (${retainRatio}) must be less than triggerRatio (${triggerRatio})`);
  }
}

/** Default new-volume requirement before the same history may be compacted again. */
export const MIN_NEW_VOLUME_RATIO = 0.25;

/** True when the model view has NOT grown enough since the last compaction to
 *  justify compacting the same history again. `lastApplied === null` means the
 *  run has not compacted yet, so nothing is declined (first compaction always
 *  allowed). Non-finite inputs are treated as "no evidence" and also allowed. */
export function noNewVolumeSince(
  tokensNow: number,
  lastApplied: number | null,
  minRatio: number = MIN_NEW_VOLUME_RATIO,
): boolean {
  if (lastApplied === null || !Number.isFinite(lastApplied) || !Number.isFinite(tokensNow)) return false;
  return tokensNow - lastApplied < Math.max(1, Math.trunc(lastApplied * minRatio));
}

export interface LastCompactionFact {
  /** Input tokens measured right after the last compaction finished. */
  tokensAfter: number;
  /** Turn index the compaction happened in. */
  turnIndex: number;
}

/**
 * Whether the same history may be compacted again.
 *
 * Compaction at the trigger is correct; compacting again after a couple of
 * operations is not, because the tail that survived the first pass is still what
 * fills the window. Require either a different turn AND genuinely new volume
 * (the request grew by `minNewVolumeRatio` over the post-compaction level), or a
 * real overflow (the caller's ContextOverflowError path stays untouched).
 */
export function shouldReCompact(input: {
  tokensBefore: number;
  usableInputTokens: number;
  triggerRatio: number;
  currentTurnIndex: number;
  lastCompaction?: LastCompactionFact | null;
  /** New volume required, as a fraction of the post-compaction level. */
  minNewVolumeRatio?: number;
}): boolean {
  const triggerTokens = input.usableInputTokens * input.triggerRatio;
  if (!(input.tokensBefore > triggerTokens)) return false;
  const last = input.lastCompaction;
  if (!last) return true;
  if (input.currentTurnIndex <= last.turnIndex) return false;
  const minNewVolume = Math.max(1, Math.trunc(last.tokensAfter * (input.minNewVolumeRatio ?? 0.25)));
  return input.tokensBefore - last.tokensAfter >= minNewVolume;
}
