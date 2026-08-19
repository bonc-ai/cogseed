/**
 * Interactive-tour completion marker — `<uid>/local/config/tour-state.json`.
 *
 * Per-account (NOT machine-wide). The first-run onboarding walkthrough fires
 * once per device (onboarding_state.ts, deliberately shared across uids), but
 * the post-onboarding interactive tour must be force-shown at most once per
 * account: switching accounts must not re-trap a user who already finished or
 * skipped it. Stored under the user-local config dir next to
 * cli-fallback.json — machine-local, never cloud-synced.
 *
 * The renderer reaches this through the `prefs.getTourCompleted` /
 * `prefs.setTourCompleted` IPC channels: `onboarding.js` checks `completed`
 * right before starting the tour, and `interactive-tour.js` persists it when
 * the tour is finished or skipped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userLocalConfigDir } from '../paths';

const FILE = 'tour-state.json';

export interface TourState {
  /** True once the user finished or skipped the interactive tour. */
  completed?: boolean;
  /** Epoch ms of the completion — diagnostic only, never gates anything. */
  completed_at_ms?: number;
}

function filePath(uid: string): string {
  return path.join(userLocalConfigDir(uid), FILE);
}

function read(uid: string): TourState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(uid), 'utf8')) as Partial<TourState>;
    return {
      completed: raw.completed === true,
      completed_at_ms: typeof raw.completed_at_ms === 'number' ? raw.completed_at_ms : undefined,
    };
  } catch {
    return {};
  }
}

/** True only after the tour was finished or skipped for THIS account. */
export function getTourCompleted(uid: string): boolean {
  return read(uid).completed === true;
}

/** Persist the completion flag. Idempotent — writing true twice is a no-op
 *  in effect. Returns the value written so IPC callers can echo it back. */
export function setTourCompleted(uid: string): boolean {
  const state: TourState = { completed: true, completed_at_ms: Date.now() };
  fs.mkdirSync(path.dirname(filePath(uid)), { recursive: true });
  fs.writeFileSync(filePath(uid), JSON.stringify(state, null, 2), 'utf8');
  return true;
}
