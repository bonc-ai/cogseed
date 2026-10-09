/**
 * Resolver slot for per-user model window / max-output overrides.
 *
 * The storage lives in `features/model_overrides.ts` (user config under
 * `cloud/config/`) — the model layer must not read user data itself. Features
 * install a resolver at boot (`installModelOverrideResolver()`); the model
 * layer only asks "did the user override this pair?" and stays storage-free.
 *
 * Semantics: a `null`/absent resolver (tests, cold paths) means "no overrides",
 * which is exactly the shipped-preset behavior.
 */

export interface ModelAbilityOverrideValue {
  contextWindow?: number;
  maxTokens?: number;
}

export type ModelAbilityOverrideResolver = (
  providerId: string,
  modelId: string,
) => ModelAbilityOverrideValue | null;

let _resolver: ModelAbilityOverrideResolver | null = null;

export function setModelAbilityOverrideResolver(resolver: ModelAbilityOverrideResolver | null): void {
  _resolver = typeof resolver === 'function' ? resolver : null;
}

/** The user's override for one (provider, model), or null when the preset applies. */
export function modelAbilityOverrideFor(
  providerId: string,
  modelId: string,
): ModelAbilityOverrideValue | null {
  if (!_resolver) return null;
  try {
    const value = _resolver(String(providerId || ''), String(modelId || ''));
    if (!value || typeof value !== 'object') return null;
    const out: ModelAbilityOverrideValue = {};
    if (typeof value.contextWindow === 'number' && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0) {
      out.contextWindow = value.contextWindow;
    }
    if (typeof value.maxTokens === 'number' && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0) {
      out.maxTokens = value.maxTokens;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    // A broken resolver must never take the model path down — fall back to the
    // shipped preset (the override is a convenience, not a dependency).
    return null;
  }
}

/** Apply the override on top of a preset-shaped entry (window / max output only). */
export function applyModelAbilityOverride<T extends { id: string; contextWindow?: number; maxTokens?: number }>(
  providerId: string,
  entry: T,
): T {
  const override = modelAbilityOverrideFor(providerId, entry.id);
  if (!override) return entry;
  return {
    ...entry,
    ...(typeof override.contextWindow === 'number' ? { contextWindow: override.contextWindow } : {}),
    ...(typeof override.maxTokens === 'number' ? { maxTokens: override.maxTokens } : {}),
  };
}
