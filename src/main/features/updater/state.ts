/**
 * Updater state persistence + pure reminder-throttle logic.
 *
 * State lives in `<uid>/local/config/updater.json` (machine-private; see
 * `paths.userUpdaterStateFile`). Reads are defensive — a missing or corrupt
 * file yields the default state — and writes go through the atomic
 * `storage.writeJsonSync` helper.
 */

import { userUpdaterStateFile } from '../../paths';
import { readJsonSync, writeJsonSync } from '../../storage';
import { createLogger } from '../../logger';
import type { DownloadedUpdate, UpdateInfo, UpdaterState } from './types';

const log = createLogger('updater');

/** Once-per-day reminder throttle. */
export const REMIND_THROTTLE_MS = 24 * 60 * 60 * 1000;

export function defaultUpdaterState(): UpdaterState {
  return { version: 1 };
}

function _asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function _sanitizeInfo(value: unknown): UpdateInfo | undefined {
  const obj = _asRecord(value);
  if (!obj) return undefined;
  if (typeof obj.latest_version !== 'string' || !obj.latest_version.trim()) return undefined;
  if (typeof obj.url !== 'string' || !obj.url.trim()) return undefined;
  if (typeof obj.sha256 !== 'string' || !obj.sha256.trim()) return undefined;
  const info: UpdateInfo = {
    latest_version: obj.latest_version.trim(),
    url: obj.url.trim(),
    sha256: obj.sha256.trim(),
  };
  if (typeof obj.size === 'number' && Number.isFinite(obj.size)) info.size = obj.size;
  if (typeof obj.notes === 'string') info.notes = obj.notes;
  if (typeof obj.min_app_version === 'string') info.min_app_version = obj.min_app_version;
  if (typeof obj.released_at === 'string') info.released_at = obj.released_at;
  if (typeof obj.mandatory === 'boolean') info.mandatory = obj.mandatory;
  return info;
}

function _sanitizeDownloaded(value: unknown): DownloadedUpdate | undefined {
  const obj = _asRecord(value);
  if (!obj) return undefined;
  if (typeof obj.version !== 'string' || !obj.version) return undefined;
  if (typeof obj.path !== 'string' || !obj.path) return undefined;
  if (typeof obj.sha256 !== 'string' || !obj.sha256) return undefined;
  if (typeof obj.size !== 'number' || !Number.isFinite(obj.size)) return undefined;
  if (typeof obj.downloaded_at !== 'number' || !Number.isFinite(obj.downloaded_at)) return undefined;
  return {
    version: obj.version,
    path: obj.path,
    size: obj.size,
    sha256: obj.sha256,
    downloaded_at: obj.downloaded_at,
  };
}

export function readUpdaterState(userId: string): UpdaterState {
  const raw = readJsonSync<unknown>(userUpdaterStateFile(userId));
  const obj = _asRecord(raw);
  if (!obj) return defaultUpdaterState();
  const state = defaultUpdaterState();
  if (typeof obj.last_check_at === 'number' && Number.isFinite(obj.last_check_at)) {
    state.last_check_at = obj.last_check_at;
  }
  if (typeof obj.known_latest === 'string' && obj.known_latest.trim()) {
    state.known_latest = obj.known_latest.trim();
  }
  const info = _sanitizeInfo(obj.latest_info);
  if (info) state.latest_info = info;
  const reminded = _asRecord(obj.reminded);
  if (reminded) {
    const cleaned: Record<string, number> = {};
    for (const [version, ts] of Object.entries(reminded)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) cleaned[version] = ts;
    }
    if (Object.keys(cleaned).length) state.reminded = cleaned;
  }
  if (typeof obj.dismissed_version === 'string' && obj.dismissed_version.trim()) {
    state.dismissed_version = obj.dismissed_version.trim();
  }
  const downloaded = _sanitizeDownloaded(obj.downloaded);
  if (downloaded) state.downloaded = downloaded;
  return state;
}

export function writeUpdaterState(userId: string, state: UpdaterState): void {
  try {
    writeJsonSync(userUpdaterStateFile(userId), state);
  } catch (err) {
    // Update state is a cache-like convenience; a failed write must never
    // break the app. The in-memory copy still drives this process's UI.
    log.warn(`updater state write failed: ${(err as Error).message}`);
  }
}

/**
 * Pure reminder decision: should an automatic check surface a reminder for
 * `version` right now?
 *
 *  - A user-skipped version is never re-surfaced automatically (manual
 *    checks still report it via `checkForUpdates(..., { manual: true })`).
 *  - Otherwise the reminder throttle is once per `REMIND_THROTTLE_MS`.
 */
export function shouldRemind(
  state: UpdaterState,
  version: string,
  now: number,
): boolean {
  if (state.dismissed_version === version) return false;
  const last = state.reminded && state.reminded[version];
  if (typeof last === 'number' && now - last < REMIND_THROTTLE_MS) return false;
  return true;
}

/** Record that a reminder was surfaced for `version` (throttle bookkeeping). */
export function markReminded(state: UpdaterState, version: string, now: number): void {
  state.reminded = { ...(state.reminded || {}), [version]: now };
}
