/**
 * Reasoning-effort policy (Option C: per-model capabilities).
 *
 * The composer may only offer the thinking tiers a model actually declares, and the
 * backend must refuse an explicit tier the model does not support *before* the provider
 * call — an unvalidated `reasoning_effort` is either silently ignored (a dead control) or
 * turns into an opaque provider 400. The refusal rides the existing preflight channel:
 * `client.ts` classifies any throw before the runner starts as `model_preflight`, which the
 * Run Center already routes to 「配置模型」.
 *
 * Capability vocabulary is the host-visible tier set (`off` | `low` | `high`) — the only
 * values the runner/composer can express today. It is deliberately narrower than pi-ai's
 * `ThinkingLevel` (which also has `minimal`/`medium`/`xhigh`): mapping a wider vocabulary
 * would need every downstream surface widened in lockstep, which is a separate change.
 *
 * This module is pure: no user data, no imports. Both the model layer (preflight) and the
 * feature layer (capability exposure) resolve their verdicts through it, so the menu and
 * the gate can never disagree.
 */

export const HOST_REASONING_LEVELS = ['off', 'low', 'high'] as const;

export type HostReasoningLevel = (typeof HOST_REASONING_LEVELS)[number];

export interface ReasoningEffortVerdict {
  ok: boolean;
  /** Only set when `ok` is false. Mirrors the run-center failure code. */
  code?: 'model_preflight';
}

function isHostReasoningLevel(value: unknown): value is HostReasoningLevel {
  return value === 'off' || value === 'low' || value === 'high';
}

/**
 * Tiers a pi-ai model declares. `reasoning !== true` means the model has no reasoning
 * channel at all → no tiers. `thinkingLevelMap[level] === null` marks that level as
 * unsupported for this model/provider ("null marks a level as unsupported" — pi-ai
 * `ThinkingLevelMap`); a missing key means the provider default applies, i.e. supported.
 */
export function declaredReasoningLevelsFromPiModel(
  model: { reasoning?: unknown; thinkingLevelMap?: unknown } | null | undefined,
): HostReasoningLevel[] {
  if (!model || model.reasoning !== true) return [];
  const map = (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object')
    ? model.thinkingLevelMap as Record<string, unknown>
    : {};
  return HOST_REASONING_LEVELS.filter((level) => map[level] !== null);
}

/**
 * Tiers a custom provider declares through its own config. Both the ordered
 * `reasoningLevels` list and the keys of `reasoningParamsMap` are declarations; any other
 * spelling is not a host tier and is ignored (never coerced onto a nearby tier).
 */
export function declaredReasoningLevelsFromCustomDeclarations(
  declarations: { reasoningLevels?: unknown; reasoningParamsMap?: unknown } | null | undefined,
): HostReasoningLevel[] {
  const declared = new Set<string>();
  if (Array.isArray(declarations?.reasoningLevels)) {
    for (const level of declarations.reasoningLevels) {
      const text = String(level || '').trim().toLowerCase();
      if (text) declared.add(text);
    }
  }
  const paramsMap = declarations?.reasoningParamsMap;
  if (paramsMap && typeof paramsMap === 'object' && !Array.isArray(paramsMap)) {
    for (const key of Object.keys(paramsMap as Record<string, unknown>)) {
      const text = String(key || '').trim().toLowerCase();
      if (text) declared.add(text);
    }
  }
  if (!declared.size) return [];
  return HOST_REASONING_LEVELS.filter((level) => declared.has(level));
}

/**
 * The single gate. `requested` absent / `'auto'` means the caller wants the provider
 * default — nothing is sent, so there is nothing to refuse. `supported` must be an array
 * to be authoritative; `null`/`undefined` means "no declaration available", and that is
 * not a licence to refuse (the send-time capability gate already covers a model with no
 * reasoning at all).
 *
 * `'off'` is always allowed, and deliberately so: in this codebase it means "omit the
 * reasoning parameter" (`pi-provider::effectiveReasoning` maps it to `undefined`), never
 * "send the value `off`". A model that marks `off: null` in `thinkingLevelMap` therefore
 * still *runs* under `off` — it just keeps its provider default. Refusing it would turn a
 * benign no-op into a hard `model_preflight` turn failure, which is exactly what would
 * happen to the global "off" preference on the 110+ catalog models that mark it null.
 */
export function validateReasoningEffort(input: {
  model?: string;
  supported?: readonly string[] | null;
  requested?: unknown;
}): ReasoningEffortVerdict {
  const requested = input?.requested;
  if (requested === undefined || requested === null || requested === '' || requested === 'auto') {
    return { ok: true };
  }
  if (requested === 'off') return { ok: true };
  if (!isHostReasoningLevel(requested)) {
    return { ok: false, code: 'model_preflight' };
  }
  if (!Array.isArray(input?.supported)) return { ok: true };
  if (input.supported.includes(requested)) return { ok: true };
  return { ok: false, code: 'model_preflight' };
}
