/**
 * 60-second journey marker — `<WS_ROOT>/journey-state.json`.
 *
 * Machine-local, shared across all uids, NOT cloud-synced. Stored under
 * WS_ROOT next to onboarding-state.json. The 60-second journey fires once
 * per device after onboarding completes; switching account or moving to a
 * new machine restarts the flow.
 *
 * The renderer reaches this through the `prefs.getJourney` /
 * `prefs.setJourney` IPC channels.
 */

import { JOURNEY_STATE_FILE } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';

export interface JourneyState {
  /** Set to true once the user finishes (or explicitly skips) the
   *  60-second post-onboarding journey. Missing / any non-true value is
   *  treated as "not yet done". */
  completed?: boolean;
  /** Epoch ms of completion — diagnostic only, never gates anything. */
  completed_at_ms?: number;
}

/**
 * True only when the journey has been explicitly marked complete.
 *
 * Dev override: setting `ORKAS_JOURNEY_ALWAYS=1` forces this to always
 * report "not completed", so the journey re-appears after onboarding
 * regardless of the persisted marker. This is purely a local testing aid.
 */
export function getJourneyCompleted(): boolean {
  if (process.env.ORKAS_JOURNEY_ALWAYS === '1') return false;
  return readJsonSync<JourneyState>(JOURNEY_STATE_FILE).completed === true;
}

/** Persist the completion flag. Idempotent — writing true twice is a no-op
 *  in effect. Returns the value written so IPC callers can echo it back. */
export function setJourneyCompleted(completed: boolean): boolean {
  const value = !!completed;
  writeJsonSync(JOURNEY_STATE_FILE, {
    completed: value,
    completed_at_ms: value ? Date.now() : undefined,
  } satisfies JourneyState);
  return value;
}
