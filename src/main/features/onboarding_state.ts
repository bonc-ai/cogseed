/**
 * First-run onboarding marker — `<WS_ROOT>/onboarding-state.json`.
 *
 * Machine-local, shared across all uids, NOT cloud-synced (deliberately
 * stored under WS_ROOT next to window-state.json rather than in the
 * per-user cloud preferences bag). Product decision: the first-launch
 * walkthrough fires once per device; switching account or moving to a
 * new machine restarts the flow.
 *
 * The renderer reaches this through the `prefs.getOnboarding` /
 * `prefs.setOnboarding` IPC channels. `boot.js` checks `completed` after
 * the last view is restored and lifts the onboarding overlay only when
 * it is false.
 */

import { ONBOARDING_STATE_FILE } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';

export interface OnboardingState {
  /** Set to true once the user finishes (or explicitly completes) the
   *  four-step first-run walkthrough. Missing / any non-true value is
   *  treated as "not yet done" so a fresh install always shows it. */
  completed?: boolean;
  /** Epoch ms of completion — diagnostic only, never gates anything. */
  completed_at_ms?: number;
}

/**
 * True only when the walkthrough has been explicitly marked complete.
 *
 * Dev override: setting `ORKAS_ONBOARDING_ALWAYS=1` forces this to always
 * report "not completed", so the walkthrough re-appears on every launch /
 * window reload regardless of the persisted marker. This mirrors the
 * `ORKAS_METACOGNITION` env-override convention and is purely a local
 * testing aid — it is off by default, so shipped behavior stays "show once".
 */
export function getOnboardingCompleted(): boolean {
  console.log('[ONBOARDING STATE] getOnboardingCompleted called');
  console.log('[ONBOARDING STATE] ORKAS_ONBOARDING_ALWAYS =', process.env.ORKAS_ONBOARDING_ALWAYS);
  console.log('[ONBOARDING STATE] ONBOARDING_STATE_FILE =', ONBOARDING_STATE_FILE);

  if (process.env.ORKAS_ONBOARDING_ALWAYS === '1') {
    console.log('[ONBOARDING STATE] Returning false due to ORKAS_ONBOARDING_ALWAYS=1');
    return false;
  }

  const state = readJsonSync<OnboardingState>(ONBOARDING_STATE_FILE);
  console.log('[ONBOARDING STATE] Read state:', JSON.stringify(state));
  const completed = state.completed === true;
  console.log('[ONBOARDING STATE] Returning completed =', completed);
  return completed;
}

/** Persist the completion flag. Idempotent — writing true twice is a no-op
 *  in effect. Returns the value written so IPC callers can echo it back. */
export function setOnboardingCompleted(completed: boolean): boolean {
  const value = !!completed;
  writeJsonSync(ONBOARDING_STATE_FILE, {
    completed: value,
    completed_at_ms: value ? Date.now() : undefined,
  } satisfies OnboardingState);
  return value;
}
