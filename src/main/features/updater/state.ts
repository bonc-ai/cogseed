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
import type {
  DownloadedUpdate,
  PartialDownload,
  PendingBoot,
  PendingInstall,
  UpdateInfo,
  UpdaterState,
} from './types';

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

function _sanitizePartial(value: unknown): PartialDownload | undefined {
  const obj = _asRecord(value);
  if (!obj) return undefined;
  if (typeof obj.version !== 'string' || !obj.version) return undefined;
  const received = typeof obj.received === 'number' && Number.isFinite(obj.received) ? obj.received : NaN;
  // A partial record with no bytes on disk is not resumable and must not keep
  // the pane stuck in a "paused" state that can never continue.
  if (!(received > 0)) return undefined;
  const total = typeof obj.total === 'number' && Number.isFinite(obj.total) && obj.total > 0 ? obj.total : 0;
  const updatedAt = typeof obj.updated_at === 'number' && Number.isFinite(obj.updated_at) ? obj.updated_at : 0;
  const partial: PartialDownload = {
    version: obj.version,
    received,
    total,
    updated_at: updatedAt,
  };
  if (typeof obj.etag === 'string' && obj.etag.trim()) partial.etag = obj.etag.trim();
  return partial;
}

/** Attempt counters are bookkeeping only: a bad value restarts at 0, never NaN. */
function _sanitizeAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const attempts = Math.trunc(value);
  return attempts > 0 ? attempts : 0;
}

function _sanitizeInstall(value: unknown): PendingInstall | undefined {
  const obj = _asRecord(value);
  if (!obj) return undefined;
  if (typeof obj.version !== 'string' || !obj.version) return undefined;
  if (typeof obj.from_version !== 'string') return undefined;
  if (typeof obj.installer_path !== 'string' || !obj.installer_path) return undefined;
  if (typeof obj.sha256 !== 'string' || !obj.sha256) return undefined;
  if (typeof obj.requested_at !== 'number' || !Number.isFinite(obj.requested_at)) return undefined;
  return {
    version: obj.version,
    from_version: obj.from_version,
    installer_path: obj.installer_path,
    sha256: obj.sha256,
    requested_at: obj.requested_at,
    attempts: _sanitizeAttempts(obj.attempts),
  };
}

function _sanitizePendingBoot(value: unknown): PendingBoot | undefined {
  const obj = _asRecord(value);
  if (!obj) return undefined;
  if (typeof obj.to_version !== 'string' || !obj.to_version) return undefined;
  // An empty `from_version` is legitimate: the first boot after an upgrade may
  // not know the version it came from (installed-from-unknown or user data reset).
  if (typeof obj.from_version !== 'string') return undefined;
  if (typeof obj.first_seen_at !== 'number' || !Number.isFinite(obj.first_seen_at)) return undefined;
  return {
    from_version: obj.from_version,
    to_version: obj.to_version,
    attempts: _sanitizeAttempts(obj.attempts),
    first_seen_at: obj.first_seen_at,
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
  const partial = _sanitizePartial(obj.partial);
  if (partial) state.partial = partial;
  const install = _sanitizeInstall(obj.install);
  if (install) state.install = install;
  const pendingBoot = _sanitizePendingBoot(obj.pending_boot);
  if (pendingBoot) state.pending_boot = pendingBoot;
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

export function beginInstall(
  state: UpdaterState,
  input: {
    version: string;
    fromVersion: string;
    installerPath: string;
    sha256: string;
    now: number;
    /** Hand-off attempts already made for this install; defaults to 0. */
    attempts?: number;
  },
): UpdaterState {
  return {
    ...state,
    install: {
      version: input.version,
      from_version: input.fromVersion,
      installer_path: input.installerPath,
      sha256: input.sha256,
      requested_at: input.now,
      attempts: _sanitizeAttempts(input.attempts ?? 0),
    },
  };
}

export function recordBootAttempt(
  state: UpdaterState,
  input: { from_version: string; to_version: string; now: number },
): UpdaterState {
  const previous = state.pending_boot;
  const sameUpgrade = previous
    && previous.from_version === input.from_version
    && previous.to_version === input.to_version;
  return {
    ...state,
    pending_boot: {
      from_version: input.from_version,
      to_version: input.to_version,
      attempts: (sameUpgrade ? previous.attempts : 0) + 1,
      first_seen_at: sameUpgrade ? previous.first_seen_at : input.now,
    },
  };
}

export function clearPendingBoot(state: UpdaterState): UpdaterState {
  const { pending_boot: _dropped, ...rest } = state;
  return rest;
}

/** Drop an approved install (applied, canceled, or superseded); boot guard untouched. */
export function clearInstall(state: UpdaterState): UpdaterState {
  const { install: _dropped, ...rest } = state;
  return rest;
}
