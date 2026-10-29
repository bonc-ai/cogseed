import type { JevGate } from './types';

export interface JevRolloutEnvironment {
  COGSEED_JEV_GATES?: string;
  COGSEED_JEV_ROLLOUT_PERCENT?: string;
}

export interface JevRolloutDecision {
  enabled: boolean;
  reason: 'global_disabled' | 'gate_disabled' | 'missing_rollout_key' | 'outside_cohort' | 'enabled';
  percent: number;
  bucket?: number;
  enabledGates: JevGate[];
}

const ALL_GATES: readonly JevGate[] = ['intent', 'candidate_suitability', 'result_validation'];

function rolloutPercent(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function enabledGates(value: unknown): JevGate[] {
  if (value === undefined || value === null || String(value).trim() === '') return [...ALL_GATES];
  const requested = new Set(String(value).split(',').map((entry) => entry.trim()));
  return ALL_GATES.filter((gate) => requested.has(gate));
}

function stableBucket(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000;
}

/** Resolve gate-specific rollout without making any network call. Partial
 * rollout requires a stable user/tenant key so repeated turns do not flap. */
export function resolveJevRollout(
  gate: JevGate,
  globalEnabled: boolean,
  rolloutKey: string | undefined,
  env: JevRolloutEnvironment = process.env,
): JevRolloutDecision {
  const gates = enabledGates(env.COGSEED_JEV_GATES);
  const percent = rolloutPercent(env.COGSEED_JEV_ROLLOUT_PERCENT);
  if (!globalEnabled) return { enabled: false, reason: 'global_disabled', percent, enabledGates: gates };
  if (!gates.includes(gate)) return { enabled: false, reason: 'gate_disabled', percent, enabledGates: gates };
  if (percent <= 0) return { enabled: false, reason: 'outside_cohort', percent, enabledGates: gates };
  if (percent >= 100) return { enabled: true, reason: 'enabled', percent, enabledGates: gates };
  const key = String(rolloutKey || '').trim();
  if (!key) return { enabled: false, reason: 'missing_rollout_key', percent, enabledGates: gates };
  const bucket = stableBucket(key);
  return {
    enabled: bucket < percent * 100,
    reason: bucket < percent * 100 ? 'enabled' : 'outside_cohort',
    percent,
    bucket,
    enabledGates: gates,
  };
}
