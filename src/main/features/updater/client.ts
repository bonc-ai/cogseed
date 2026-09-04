/**
 * Update-check client: server round-trip, reminder rules, and the
 * checksum-verified installer download.
 *
 * Server contract (same envelope as every CogSeed business API):
 *
 *   GET {COGSEED_API_BASE_URL}/updates/latest
 *   Headers: withCommonHeaders() — carries app version / platform / arch /
 *            channel, so the server needs no query params.
 *
 *   200 { "code": 0, "data": { latest_version, url, sha256, size?, notes?,
 *                              min_app_version?, released_at?, mandatory? } }
 *   200 { "code": 0, "data": null }   → already on the latest version
 *   non-zero code / network failure   → checked:false with a message
 *
 * Design notes:
 *  - Checks never throw: automatic (boot) checks must be silent, and manual
 *    checks surface the `error` string to the renderer.
 *  - Reminder surfacing (once per 24h, skip-respecting) is decided here and
 *    reported via `CheckResult.reminded`; the caller decides whether to
 *    broadcast. Manual checks always report `has_update` truthfully.
 *  - Downloads stream to a `.part` file under `<uid>/local/updates/`,
 *    hashing as they go; the artifact is renamed into place only after the
 *    sha256 digest matches the server-provided value. A mismatch deletes the
 *    partial file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { app as electronApp } from 'electron';

import { createLogger } from '../../logger';
import { fetchWithRetry } from '../../util/retry';
import { compareVersions } from '../../util/app-version-compat';
import { requireCogSeedApiBase } from '../api_base';
import { CLIENT_HEADER_NAMES, withCommonHeaders } from '../api_common';
import { userUpdaterDownloadsDir } from '../../paths';
import {
  markReminded,
  readUpdaterState,
  shouldRemind,
  writeUpdaterState,
} from './state';
import type {
  CheckResult,
  DownloadProgress,
  DownloadResult,
  UpdateInfo,
} from './types';

const log = createLogger('updater');

const LATEST_CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_EXTENSIONS_ALLOWED = new Set(['.dmg', '.zip']);

/**
 * Headers for the updates endpoints. The updates contract
 * (updates-server catalog) uses node-style
 * platform tokens darwin/win32/linux, while the shared client header carries
 * the app's own taxonomy ('mac'/'windows'/'pc') for other business APIs —
 * an unmapped 'mac' matches no catalog entry and silently reports "up to
 * date", so the update channel maps the token explicitly.
 */
function updaterRequestHeaders(): Record<string, string> {
  const contractPlatform: Record<string, string> = {
    darwin: 'darwin',
    win32: 'win32',
    linux: 'linux',
  };
  const headers = withCommonHeaders();
  headers[CLIENT_HEADER_NAMES.platform] = contractPlatform[process.platform] || process.platform;
  return headers;
}

export interface CheckOptions {
  /** Manual (settings-page) check: bypasses the reminder throttle and
   *  always reports the truth; does not consume the daily reminder. */
  manual?: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
}

interface LatestEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

function currentAppVersion(): string {
  try {
    const version = electronApp?.getVersion?.();
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch { /* pre-ready */ }
  return process.env.COGSEED_APP_VERSION || '0.0.0';
}

export { currentAppVersion };

function _asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function _parseUpdateInfo(value: unknown): UpdateInfo | null {
  const obj = _asRecord(value);
  if (!obj) return null;
  if (typeof obj.latest_version !== 'string' || !obj.latest_version.trim()) return null;
  if (typeof obj.url !== 'string' || !obj.url.trim()) return null;
  if (typeof obj.sha256 !== 'string' || !obj.sha256.trim()) return null;
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

async function _fetchLatest(): Promise<UpdateInfo | null> {
  const base = requireCogSeedApiBase();
  const url = `${base}/updates/latest`;
  const res = await fetchWithRetry(`updater:${url}`, url, {
    method: 'GET',
    headers: updaterRequestHeaders(),
  }, {
    timeoutMs: LATEST_CHECK_TIMEOUT_MS,
    timeoutMessage: `updater:latest timed out after ${LATEST_CHECK_TIMEOUT_MS / 1000}s`,
  });
  if (!res.ok) throw new Error(`updates/latest failed (${res.status})`);
  const text = await res.text();
  let envelope: LatestEnvelope;
  try {
    envelope = JSON.parse(text) as LatestEnvelope;
  } catch {
    throw new Error('bad updates/latest response');
  }
  if (envelope.code !== 0) {
    throw new Error(String(envelope.msg || `updates/latest failed (code=${String(envelope.code)})`));
  }
  // `data: null` / absent → already on the latest version.
  if (envelope.data === null || envelope.data === undefined) return null;
  const info = _parseUpdateInfo(envelope.data);
  if (!info) throw new Error('bad updates/latest data');
  return info;
}

/**
 * Check for a newer version.
 *
 * Automatic (`manual: false`) checks apply the once-per-day reminder rule
 * and skip list; manual checks always report an available update truthfully
 * and never consume the reminder budget. Never throws — failures return
 * `{ checked: false, error }` so boot-time checks stay silent.
 */
export async function checkForUpdates(
  userId: string,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const now = opts.now ?? Date.now();
  const current = currentAppVersion();
  try {
    const info = await _fetchLatest();
    const state = readUpdaterState(userId);
    state.last_check_at = now;
    if (!info) {
      // No server-side update: keep known_latest as-is (it may describe a
      // version the server no longer serves) but drop the stale info so a
      // later download can't reuse it.
      writeUpdaterState(userId, { ...state, latest_info: undefined });
      return { checked: true, has_update: false, reminded: false, current_version: current };
    }
    const hasUpdate = compareVersions(info.latest_version, current) > 0;
    if (!hasUpdate) {
      writeUpdaterState(userId, { ...state, latest_info: undefined });
      return { checked: true, has_update: false, reminded: false, current_version: current };
    }
    state.known_latest = info.latest_version;
    state.latest_info = info;
    let reminded = false;
    if (!opts.manual && shouldRemind(state, info.latest_version, now)) {
      markReminded(state, info.latest_version, now);
      reminded = true;
    }
    writeUpdaterState(userId, state);
    return {
      checked: true,
      has_update: true,
      reminded,
      current_version: current,
      info,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log.warn(`update check failed: ${message}`);
    return { checked: false, has_update: false, reminded: false, current_version: current, error: message };
  }
}

/** Remember that the user does not want automatic reminders for `version`. */
export function dismissVersion(userId: string, version: string): void {
  const state = readUpdaterState(userId);
  state.dismissed_version = version;
  writeUpdaterState(userId, state);
}

/** Derive a safe local filename for an installer URL. */
export function installerFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(path.posix.basename(parsed.pathname));
    if (base && path.posix.basename(base) === base && !base.includes('..')) {
      const ext = path.posix.extname(base).toLowerCase();
      if (DOWNLOAD_EXTENSIONS_ALLOWED.has(ext)) return base;
    }
  } catch { /* fall through to the fallback name */ }
  const ext = url.toLowerCase().match(/\.(dmg|zip)(\?|$)/)?.[1] || 'dmg';
  return `CogSeed-${process.platform}-${process.arch}.${ext}`;
}

let activeDownload: Promise<DownloadResult> | null = null;

/** Test-only: clear any in-flight download so suites can reset between cases. */
export async function cancelActiveDownloadForTest(): Promise<void> {
  activeDownload = null;
}

/**
 * Download the latest known installer (from `state.latest_info`) and verify
 * its sha256 before making it available. One download at a time.
 */
export function downloadUpdate(
  userId: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  if (activeDownload) {
    return Promise.resolve({ ok: false as const, error: 'already_downloading' });
  }
  activeDownload = _doDownload(userId, opts).finally(() => { activeDownload = null; });
  return activeDownload;
}

async function _doDownload(userId: string, opts: DownloadOptions): Promise<DownloadResult> {
  const state = readUpdaterState(userId);
  const info = state.latest_info;
  if (!info) {
    return { ok: false, error: 'no_update_info' };
  }
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return { ok: false, error: 'bad_url' };
  }
  if (url.protocol !== 'https:') {
    log.warn(`update download refused: non-https url ${info.url}`);
    return { ok: false, error: 'insecure_url' };
  }
  const filename = installerFilenameFromUrl(info.url);
  const dir = userUpdaterDownloadsDir(userId);
  const finalPath = path.join(dir, filename);
  const partPath = `${finalPath}.part`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    await fs.promises.rm(partPath, { force: true });
    const res = await fetchWithRetry(`updater:download:${info.url}`, info.url, {
      method: 'GET',
      headers: withCommonHeaders(),
    }, {
      // Large artifacts: no wall-clock timeout; no retry (a failed attempt
      // restarts the whole file — acceptable for v1, the user can retry).
      retries: 0,
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const totalHeader = res.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.length;
          opts.onProgress?.({
            received,
            total,
            percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
          });
          yield chunk;
        }
      },
      fs.createWriteStream(partPath, { flags: 'wx' }),
    );
    const digest = hash.digest('hex').toLowerCase();
    if (digest !== info.sha256.trim().toLowerCase()) {
      await fs.promises.rm(partPath, { force: true });
      log.warn(`update download verification failed: sha256 mismatch for ${info.latest_version}`);
      return { ok: false, error: 'verify_failed' };
    }
    await fs.promises.rename(partPath, finalPath);
    const stat = await fs.promises.stat(finalPath);
    const next = readUpdaterState(userId);
    next.downloaded = {
      version: info.latest_version,
      path: finalPath,
      size: stat.size,
      sha256: digest,
      downloaded_at: Date.now(),
    };
    writeUpdaterState(userId, next);
    log.info(`update downloaded and verified: version=${info.latest_version} size=${stat.size}`);
    return { ok: true, path: finalPath, version: info.latest_version, size: stat.size, sha256: digest };
  } catch (err) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    const message = (err as Error).message || String(err);
    log.warn(`update download failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Open the verified installer for the current platform.
 *
 * v1 (macOS): reveal/open the dmg via the OS — the user drags the app into
 * /Applications (Gatekeeper behaviour makes silent installs impossible for
 * dmg). Phase 2 slots an automatic zip-replacement path behind the same
 * signature; the caller only ever sees "opened".
 */
export async function openDownloaded(userId: string): Promise<{ opened: boolean; error?: string }> {
  const state = readUpdaterState(userId);
  const downloaded = state.downloaded;
  if (!downloaded) return { opened: false, error: 'no_download' };
  try {
    await fs.promises.access(downloaded.path);
  } catch {
    // Installer disappeared (user cleaned cache etc.) — drop the stale record.
    writeUpdaterState(userId, { ...state, downloaded: undefined });
    return { opened: false, error: 'file_missing' };
  }
  try {
    const { openDownloadedUpdate } = await import('./installer');
    await openDownloadedUpdate(downloaded.path);
    return { opened: true };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log.warn(`open installer failed: ${message}`);
    return { opened: false, error: message };
  }
}
