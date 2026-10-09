/**
 * Update-check domain types.
 *
 * The server contract is an envelope response (`code === 0`) with a `data`
 * payload — same shape as every other CogSeed business API. `data` may be
 * null/absent when the client is already on the latest version.
 */

/** Server-provided metadata for one downloadable release. */
export interface UpdateInfo {
  /** Newest published version (semver-ish; compared via util/app-version-compat). */
  latest_version: string;
  /** HTTPS URL of the installer artifact (dmg on macOS v1; zip lands in phase 2). */
  url: string;
  /** Hex sha256 digest of the installer; download is discarded when it mismatches. */
  sha256: string;
  /** Artifact size in bytes (optional; drives progress display when present). */
  size?: number;
  /** Human-readable release notes (plain text; optional). */
  notes?: string;
  /** Optional minimum app version the update requires (informational). */
  min_app_version?: string;
  /** ISO-8601 release timestamp (optional). */
  released_at?: string;
  /** Whether the update is mandatory (informational in v1; never forced). */
  mandatory?: boolean;
}

/** A completed, checksum-verified local download. */
export interface DownloadedUpdate {
  version: string;
  path: string;
  size: number;
  sha256: string;
  downloaded_at: number;
}

/**
 * Machine-private update state, persisted at
 * `<uid>/local/config/updater.json`. Never synced: reminder throttling and
 * skip choices are per-device behaviour, and the downloaded installer path
 * is meaningless on another machine.
 */
export interface UpdaterState {
  version: 1;
  /** Last successful check (ms epoch). */
  last_check_at?: number;
  /** Latest version we have learned about. */
  known_latest?: string;
  /** Full info of `known_latest`, kept so a download can start without a re-check. */
  latest_info?: UpdateInfo;
  /** version -> last time a reminder was surfaced (ms epoch); drives the once-per-day throttle. */
  reminded?: Record<string, number>;
  /** Version the user explicitly asked not to be reminded about. */
  dismissed_version?: string;
  /** Most recent verified download. */
  downloaded?: DownloadedUpdate;
}

/** Byte-level progress of a running download. */
export interface DownloadProgress {
  received: number;
  total: number;
  percent: number;
}

/** Outcome of one update check. */
export interface CheckResult {
  checked: boolean;
  has_update: boolean;
  /** True when this (automatic) check actually surfaced a reminder after throttle + skip rules. */
  reminded: boolean;
  current_version: string;
  info?: UpdateInfo;
  error?: string;
}

export type DownloadResult =
  | { ok: true; path: string; version: string; size: number; sha256: string }
  | { ok: false; error: string };
