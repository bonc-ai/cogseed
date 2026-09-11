import { safeId } from '../../storage';

export const KSTAR_MAX_REUSE_TURN_IDS = 100;
export const KSTAR_MAX_REUSE_TURN_ID_LENGTH = 160;

export function isKstarReuseTurnId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= KSTAR_MAX_REUSE_TURN_ID_LENGTH
    && safeId(value);
}

export function normalizeKstarReuseTurnIds(values: readonly unknown[]): string[] {
  return retainKstarReuseTurnIds(values).reuseTurnIds;
}

/** Fixed-size retention keeps the newest authoritative receipt ids. Callers
 * must persist `truncated` so the retained suffix is never mistaken for a
 * complete ownership set. */
export function retainKstarReuseTurnIds(values: readonly unknown[]): {
  reuseTurnIds: string[];
  truncated: boolean;
} {
  const newestFirst: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!isKstarReuseTurnId(value) || seen.has(value)) continue;
    seen.add(value);
    if (newestFirst.length < KSTAR_MAX_REUSE_TURN_IDS) newestFirst.push(value);
    else truncated = true;
  }
  return { reuseTurnIds: newestFirst.reverse(), truncated };
}

export function isCanonicalKstarReuseTurnIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= KSTAR_MAX_REUSE_TURN_IDS
    && value.every(isKstarReuseTurnId)
    && new Set(value).size === value.length;
}
