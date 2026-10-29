import { listEntriesForUser } from '../auth';
import type { RecallCaptureModelCandidate } from './capture-settings';

export interface RecallCaptureConfiguredModel extends RecallCaptureModelCandidate {
  label: string;
  available?: boolean;
  configured: boolean;
}
export interface RecallCaptureModelSelection {
  source: 'system-first' | 'custom';
  configured: RecallCaptureConfiguredModel[];
  effective: RecallCaptureConfiguredModel[];
}
const keyOf = (item: RecallCaptureModelCandidate) => JSON.stringify([item.provider, item.model]);

/** One row per provider/model, in settings order. Credentials remain an auth
 * rotation pool, never extra fallback models. A disabled first row stays first. */
export async function readRecallCaptureModelSelection(
  userId: string, candidates: readonly RecallCaptureModelCandidate[],
): Promise<RecallCaptureModelSelection> {
  const { entries } = await listEntriesForUser(userId, { includeUnavailable: true });
  const models = new Map<string, RecallCaptureConfiguredModel>();
  for (const entry of entries) {
    if (!entry.provider || !entry.model) continue;
    const key = keyOf(entry);
    const previous = models.get(key);
    models.set(key, {
      provider: entry.provider, model: entry.model,
      label: `${entry.providerLabel || entry.provider} · ${entry.modelName || entry.model}`,
      available: previous?.available === true || entry.modelAvailable !== false,
      configured: true,
    });
  }
  const configured = [...models.values()];
  return {
    source: candidates.length ? 'custom' : 'system-first',
    configured,
    effective: candidates.length ? candidates.map(item => models.get(keyOf(item)) || {
      ...item, label: `${item.provider} · ${item.model}`, configured: false,
      // Legacy catalog-only selections retain their original auth contract.
      // Absence from the configured list alone does not prove unavailability.
    }) : configured.slice(0, 1),
  };
}

/** New additions must be configured. Retained legacy rows and the inherited
 * system first row can still be kept, reordered or removed even when disabled. */
export async function assertRecallCaptureModelAdditions(
  userId: string, previous: readonly RecallCaptureModelCandidate[], next: readonly RecallCaptureModelCandidate[],
): Promise<void> {
  const retained = new Set(previous.map(keyOf));
  if (next.every(item => retained.has(keyOf(item)))) return;
  const selection = await readRecallCaptureModelSelection(userId, previous);
  if (!previous.length) selection.effective.forEach(item => retained.add(keyOf(item)));
  const allowed = new Set(selection.configured.filter(item => item.available).map(keyOf));
  if (next.some(item => !retained.has(keyOf(item)) && !allowed.has(keyOf(item)))) {
    throw new Error('recall capture model is not configured or is disabled');
  }
}

/** Keep the generic runner's empty-route contract unchanged for non-settings
 * callers; capture-settings consumers explicitly resolve their default here. */
export async function resolveRecallCaptureModelCandidates(
  userId: string, candidates: readonly RecallCaptureModelCandidate[],
): Promise<RecallCaptureModelCandidate[]> {
  const effective = candidates.length ? candidates : (await readRecallCaptureModelSelection(userId, candidates)).effective;
  return effective.map(({ provider, model }) => ({ provider, model }));
}
