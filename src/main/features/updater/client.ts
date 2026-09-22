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
  DownloadRuntimeState,
  PartialDownload,
  UpdateInfo,
  UpdaterState,
} from './types';

const log = createLogger('updater');

const LATEST_CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_EXTENSIONS_ALLOWED = new Set(['.dmg', '.exe', '.zip']);

/**
 * Headers for the updates endpoints. The updates contract
 * (docs/design/updates-api.md, updates-server catalog) uses node-style
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

function isPackagedReminderPlatformUnsupported(): boolean {
  return electronApp?.isPackaged === true && process.platform !== 'darwin';
}

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
  if (isPackagedReminderPlatformUnsupported()) {
    const state = readUpdaterState(userId);
    state.last_check_at = now;
    writeUpdaterState(userId, { ...state, latest_info: undefined });
    return { checked: true, has_update: false, reminded: false, current_version: current };
  }
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
  const ext = url.toLowerCase().match(/\.(dmg|exe|zip)(\?|$)/)?.[1] || 'dmg';
  return `CogSeed-${process.platform}-${process.arch}.${ext}`;
}

interface ActiveDownload {
  controller: AbortController;
  pauseRequested: boolean;
  cancelRequested: boolean;
  /** Strong validator replayed as `If-Range` when the transfer is resumed. */
  etag: string;
  total: number;
  received: number;
  promise: Promise<DownloadResult>;
}

let activeDownload: ActiveDownload | null = null;

/**
 * Download runtime state, owned by main. The renderer renders it and never
 * infers it from its own click bookkeeping — the 2026-09-21 report ("clicking
 * 下载更新 a second time makes the progress bar vanish") came from exactly that:
 * the second click hit `already_downloading`, the pane called it a failure and
 * cleared its local flag, and every later progress push was dropped because of
 * that flag, even though main was still downloading.
 */
let downloadRuntime: DownloadRuntimeState = { phase: 'idle', received: 0, total: 0, percent: 0 };

type DownloadStateListener = (state: DownloadRuntimeState) => void;
let downloadStateListener: DownloadStateListener | null = null;

/** Main → renderer phase pushes (`updates:download`); wired in ipc/updates.ts. */
export function setDownloadStateListener(listener: DownloadStateListener | null): void {
  downloadStateListener = listener;
}

/**
 * Publish runtime state. Progress arrives once per streamed chunk, so listeners
 * are notified on PHASE changes only; the per-chunk numbers ride the throttled
 * `updates:progress` channel instead of flooding the bridge.
 */
function _setRuntime(next: DownloadRuntimeState): void {
  const phaseChanged = next.phase !== downloadRuntime.phase;
  downloadRuntime = next;
  if (phaseChanged && downloadStateListener) {
    try {
      downloadStateListener({ ...next });
    } catch { /* window gone */ }
  }
}

function _idleRuntime(): DownloadRuntimeState {
  return { phase: 'idle', received: 0, total: 0, percent: 0 };
}

function _percent(received: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

function _installerPaths(
  userId: string,
  info: UpdateInfo,
): { dir: string; finalPath: string; partPath: string } {
  const dir = userUpdaterDownloadsDir(userId);
  const finalPath = path.join(dir, installerFilenameFromUrl(info.url));
  return { dir, finalPath, partPath: `${finalPath}.part` };
}

async function _fileSize(file: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** `etag` arrives quoted (`"abc"`) and may carry the weak prefix; normalize it. */
function _normalizeEtag(raw: string | null): string {
  return String(raw || '').replace(/^W\//, '').replace(/"/g, '').trim();
}

/**
 * Full artifact size. On a `206` the `content-length` is only the REMAINING
 * length, so the total has to come from `content-range` (or the offset has to be
 * added back). Using the raw header is what makes a resumed transfer jump
 * straight to "100%".
 */
function _resolveTotal(res: Response, offset: number): number {
  const range = res.headers.get('content-range');
  if (range) {
    const match = /\/(\d+)\s*$/.exec(range);
    if (match) return Number(match[1]);
  }
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) return offset + length;
  return 0;
}

/**
 * Fold an existing `.part` prefix back into the digest. The hash is computed
 * incrementally while streaming, so a resumed transfer that only hashed the new
 * bytes would ALWAYS fail the final sha256 comparison on a perfectly good file.
 */
function _hashExistingPart(file: string, bytes: number, hash: crypto.Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: 0, end: bytes - 1 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

function _writePartial(userId: string, partial: PartialDownload): void {
  const state = readUpdaterState(userId);
  writeUpdaterState(userId, { ...state, partial });
}

function _clearPartial(userId: string): void {
  const state = readUpdaterState(userId);
  if (state.partial) writeUpdaterState(userId, { ...state, partial: undefined });
}

/** Discard a partial transfer: the `.part` file plus its resume record. */
async function _discardPartial(userId: string): Promise<void> {
  const state = readUpdaterState(userId);
  if (state.latest_info) {
    const { partPath } = _installerPaths(userId, state.latest_info);
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
  }
  if (state.partial) writeUpdaterState(userId, { ...state, partial: undefined });
}

/**
 * A paused transfer whose process is gone (app restart) is still resumable: the
 * `.part` file and its record outlive the run. Only consulted while the
 * in-memory runtime is idle, so a live session always wins.
 */
async function _pausedStateFromDisk(userId: string): Promise<DownloadRuntimeState | null> {
  const state = readUpdaterState(userId);
  const partial = state.partial;
  const info = state.latest_info;
  if (!partial || !info || partial.version !== info.latest_version) return null;
  const { partPath } = _installerPaths(userId, info);
  const size = await _fileSize(partPath);
  if (!(size > 0)) return null;
  const total = partial.total > 0 ? partial.total : (info.size || 0);
  return {
    phase: 'paused',
    version: partial.version,
    received: size,
    total,
    percent: _percent(size, total),
  };
}

/** Current download state for the settings pane (main is the only authority). */
export async function getDownloadState(userId: string): Promise<DownloadRuntimeState> {
  if (activeDownload) return { ...downloadRuntime };
  if (downloadRuntime.phase !== 'idle') return { ...downloadRuntime };
  return (await _pausedStateFromDisk(userId)) || _idleRuntime();
}

/**
 * Whether an available release is genuinely newer than what we are running.
 *
 * Lives in the feature layer on purpose: the settings pane used to decide button
 * visibility from "is there a latest_info at all?", which kept offering
 * "下载更新" for a version the user had already installed (persisted info is not
 * revalidated until the next check).
 */
export function isUpdateActionable(info: UpdateInfo | undefined, current: string): boolean {
  return !!info && compareVersions(info.latest_version, current) > 0;
}

/** True when a checksum-verified installer for a NEWER version is waiting. */
export function isInstallReady(state: UpdaterState, current: string): boolean {
  return !!state.downloaded && compareVersions(state.downloaded.version, current) > 0;
}

/**
 * Whether the pane should OFFER this update right now: newer than the running
 * version, and not skipped by the user. Skipping hides the buttons until an
 * explicit manual check reports the truth again (which stays intentional).
 */
export function isUpdateOffered(state: UpdaterState, current: string): boolean {
  const info = state.latest_info;
  if (!isUpdateActionable(info, current)) return false;
  return state.dismissed_version !== info.latest_version;
}

/**
 * Drop records that can no longer lead anywhere.
 *
 * The pane used to keep offering "下载更新" for a version the user had already
 * installed, because `latest_info` is persisted and nothing revalidated it
 * against the running version until the next check. Reconciling on read closes
 * that window (and reclaims the disk held by a dead partial transfer).
 */
export async function reconcileStaleState(userId: string): Promise<void> {
  const current = currentAppVersion();
  const state = readUpdaterState(userId);
  const info = state.latest_info;
  const staleInfo = !!info && !isUpdateActionable(info, current);
  const staleDownloaded = !!state.downloaded && compareVersions(state.downloaded.version, current) <= 0;
  const stalePartial = !!state.partial
    && (!info || staleInfo || state.partial.version !== info.latest_version);
  if (!staleInfo && !staleDownloaded && !stalePartial) return;
  if (info && (staleInfo || stalePartial)) {
    const { partPath } = _installerPaths(userId, info);
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
  }
  const next: UpdaterState = { ...state };
  if (staleInfo) next.latest_info = undefined;
  if (staleDownloaded) next.downloaded = undefined;
  if (staleInfo || stalePartial) next.partial = undefined;
  writeUpdaterState(userId, next);
  log.info(
    `updater state reconciled against running version ${current}:`
    + `${staleInfo ? ' dropped stale latest_info;' : ''}`
    + `${staleDownloaded ? ' dropped stale download record;' : ''}`
    + `${stalePartial ? ' dropped unusable partial transfer;' : ''}`,
  );
}

/** Test-only: drop any in-flight download so suites can reset between cases. */
export async function cancelActiveDownloadForTest(): Promise<void> {
  activeDownload?.controller.abort(new Error('test reset'));
  activeDownload = null;
  downloadRuntime = _idleRuntime();
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
    // Kept as a real guard (two windows, a stale renderer), but the settings
    // pane can no longer reach it: it derives its buttons from this module's
    // state instead of from its own click bookkeeping.
    return Promise.resolve({ ok: false as const, error: 'already_downloading', resumable: true });
  }
  return _startDownload(userId, opts, { resume: false });
}

/** Continue a paused/interrupted transfer from the bytes already on disk. */
export function resumeDownload(
  userId: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  if (activeDownload) {
    return Promise.resolve({ ok: false as const, error: 'already_downloading', resumable: true });
  }
  return _startDownload(userId, opts, { resume: true });
}

function _startDownload(
  userId: string,
  opts: DownloadOptions,
  mode: { resume: boolean },
): Promise<DownloadResult> {
  const controller = new AbortController();
  const active: ActiveDownload = {
    controller,
    pauseRequested: false,
    cancelRequested: false,
    etag: '',
    total: 0,
    received: 0,
    promise: Promise.resolve({ ok: false as const, error: 'not_started' }),
  };
  activeDownload = active;
  _setRuntime({ phase: 'downloading', received: 0, total: 0, percent: 0 });
  active.promise = _doDownload(userId, opts, active, mode)
    .catch((err): DownloadResult => ({
      ok: false,
      error: (err as Error).message || String(err),
      resumable: false,
    }))
    .finally(() => {
      if (activeDownload === active) activeDownload = null;
    });
  return active.promise;
}

/**
 * Stop the transfer but KEEP the bytes on disk. The aborted stream leaves a
 * `.part` file plus a resume record, so `resumeDownload` can continue with a
 * `Range` request instead of re-fetching the whole artifact.
 */
export async function pauseDownload(userId: string): Promise<DownloadResult> {
  const active = activeDownload;
  if (!active) {
    const paused = await _pausedStateFromDisk(userId);
    if (paused) {
      return {
        ok: false,
        error: 'paused',
        paused: true,
        resumable: true,
        received: paused.received,
        total: paused.total,
      };
    }
    return { ok: false, error: 'not_downloading' };
  }
  active.pauseRequested = true;
  active.controller.abort(new Error('paused'));
  await active.promise.catch(() => undefined);
  const paused = await _pausedStateFromDisk(userId);
  return {
    ok: false,
    error: 'paused',
    paused: true,
    resumable: !!paused,
    received: paused ? paused.received : 0,
    total: paused ? paused.total : 0,
  };
}

/** Stop the transfer and reclaim the disk it was holding. */
export async function cancelDownload(userId: string): Promise<DownloadResult> {
  const active = activeDownload;
  if (active) {
    active.cancelRequested = true;
    active.controller.abort(new Error('canceled'));
    await active.promise.catch(() => undefined);
  }
  await _discardPartial(userId);
  _setRuntime(_idleRuntime());
  log.info('update download canceled');
  return { ok: false, error: 'canceled', canceled: true };
}

async function _doDownload(
  userId: string,
  opts: DownloadOptions,
  active: ActiveDownload,
  mode: { resume: boolean },
): Promise<DownloadResult> {
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
  const { dir, finalPath, partPath } = _installerPaths(userId, info);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn(`update download dir unavailable: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message || String(err) };
  }

  // Resume offset comes from the FILE, not from the record: whatever failed to
  // flush is simply re-fetched, and the digest covers exactly the bytes that
  // exist on disk.
  let offset = 0;
  if (mode.resume && state.partial && state.partial.version === info.latest_version) {
    offset = await _fileSize(partPath);
    if (state.partial.etag) active.etag = state.partial.etag;
  }

  // A ranged request can be answered with a full 200 (no range support, or the
  // artifact was republished). Restarting from zero is correct there, but only
  // once — otherwise a server that always ignores Range would loop forever.
  let allowFreshRetry = offset > 0;
  for (;;) {
    const outcome = await _downloadAttempt(userId, opts, active, info, { finalPath, partPath, offset });
    if (outcome.kind === 'retry_fresh' && allowFreshRetry) {
      allowFreshRetry = false;
      offset = 0;
      continue;
    }
    return outcome.kind === 'done' ? outcome.result : { ok: false, error: 'download failed' };
  }
}

type AttemptOutcome = { kind: 'done'; result: DownloadResult } | { kind: 'retry_fresh' };

async function _downloadAttempt(
  userId: string,
  opts: DownloadOptions,
  active: ActiveDownload,
  info: UpdateInfo,
  ctx: { finalPath: string; partPath: string; offset: number },
): Promise<AttemptOutcome> {
  const { finalPath, partPath, offset } = ctx;
  let received = offset;
  let total = offset > 0 ? 0 : (info.size || 0);
  try {
    if (offset === 0) {
      await fs.promises.rm(partPath, { force: true });
    }
    const headers: Record<string, string> = { ...withCommonHeaders() };
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      // `If-Range` makes the server answer 200 (instead of a mismatched 206)
      // when the artifact changed, so bytes from two different builds can never
      // be stitched into one file.
      if (active.etag) headers['If-Range'] = active.etag;
    }
    const res = await fetchWithRetry(`updater:download:${info.url}`, info.url, {
      method: 'GET',
      headers,
      signal: active.controller.signal,
    }, {
      // Large artifacts: no wall-clock timeout and no automatic retry. A retry
      // loop would also fight the paused/interrupted states the user asked for;
      // continuing is an explicit user action.
      retries: 0,
    });

    if (!res.ok) throw new Error(`download failed (${res.status})`);

    // 服务端忽略 Range（或制品被重新发布）时回的是 200 + 完整正文：直接用这一个
    // 响应从 0 重来，而不是丢弃它再发一次请求（那等于白下一遍）。
    let effectiveOffset = offset;
    if (offset > 0 && res.status === 200) {
      log.warn('update resume rejected (no range support or artifact changed); restarting from 0');
      await fs.promises.rm(partPath, { force: true });
      effectiveOffset = 0;
      received = 0;
    }

    const etag = _normalizeEtag(res.headers.get('etag'));
    if (effectiveOffset > 0 && active.etag && etag && etag !== active.etag) {
      // 206 的正文是"新制品"的剩余部分，和磁盘上的旧字节拼不起来：只能重来。
      log.warn('update resume validator changed; restarting from 0');
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      return { kind: 'retry_fresh' };
    }
    if (etag) active.etag = etag;

    total = _resolveTotal(res, effectiveOffset) || info.size || 0;
    active.total = total;
    active.received = received;
    _setRuntime({
      phase: 'downloading',
      version: info.latest_version,
      received,
      total,
      percent: _percent(received, total),
    });
    if (received > 0) opts.onProgress?.({ received, total, percent: _percent(received, total) });

    const hash = crypto.createHash('sha256');
    if (effectiveOffset > 0) await _hashExistingPart(partPath, effectiveOffset, hash);

    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.length;
          active.received = received;
          const percent = _percent(received, total);
          _setRuntime({
            phase: 'downloading',
            version: info.latest_version,
            received,
            total,
            percent,
          });
          opts.onProgress?.({ received, total, percent });
          yield chunk;
        }
      },
      fs.createWriteStream(partPath, { flags: effectiveOffset > 0 ? 'a' : 'wx' }),
    );

    _setRuntime({
      phase: 'verifying',
      version: info.latest_version,
      received,
      total,
      percent: _percent(received, total),
    });

    const digest = hash.digest('hex').toLowerCase();
    if (digest !== info.sha256.trim().toLowerCase()) {
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      _clearPartial(userId);
      _setRuntime({
        phase: 'failed',
        version: info.latest_version,
        received: 0,
        total,
        percent: 0,
        error: 'verify_failed',
        resumable: false,
      });
      log.warn(`update download verification failed: sha256 mismatch for ${info.latest_version}`);
      return { kind: 'done', result: { ok: false, error: 'verify_failed', resumable: false, received: 0, total } };
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
    next.partial = undefined;
    writeUpdaterState(userId, next);
    _setRuntime({
      phase: 'idle',
      version: info.latest_version,
      received: stat.size,
      total: stat.size,
      percent: 100,
    });
    log.info(`update downloaded and verified: version=${info.latest_version} size=${stat.size}`);
    return {
      kind: 'done',
      result: { ok: true, path: finalPath, version: info.latest_version, size: stat.size, sha256: digest },
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (active.pauseRequested) {
      const size = await _fileSize(partPath);
      if (size > 0) {
        _writePartial(userId, {
          version: info.latest_version,
          etag: active.etag || undefined,
          received: size,
          total,
          updated_at: Date.now(),
        });
        _setRuntime({
          phase: 'paused',
          version: info.latest_version,
          received: size,
          total,
          percent: _percent(size, total),
        });
        log.info(`update download paused at ${size}/${total} bytes`);
        return { kind: 'done', result: { ok: false, error: 'paused', paused: true, resumable: true, received: size, total } };
      }
      // Nothing reached the disk yet, so there is nothing to continue from.
      // Parking the pane in a permanent "paused 0%" would be a lie.
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      _clearPartial(userId);
      _setRuntime(_idleRuntime());
      log.info('update download paused before any bytes arrived');
      return { kind: 'done', result: { ok: false, error: 'paused', paused: true, resumable: false, received: 0, total } };
    }
    if (active.cancelRequested) {
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      _clearPartial(userId);
      _setRuntime(_idleRuntime());
      return { kind: 'done', result: { ok: false, error: 'canceled', canceled: true } };
    }
    const size = await _fileSize(partPath);
    if (size > 0) {
      // Connection dropped mid-transfer: keep the bytes so the user can
      // continue instead of re-fetching the whole (possibly huge) artifact.
      _writePartial(userId, {
        version: info.latest_version,
        etag: active.etag || undefined,
        received: size,
        total,
        updated_at: Date.now(),
      });
      _setRuntime({
        phase: 'failed',
        version: info.latest_version,
        received: size,
        total,
        percent: _percent(size, total),
        error: message,
        resumable: true,
      });
      log.warn(`update download interrupted: ${message} (resumable at ${size} bytes)`);
      return { kind: 'done', result: { ok: false, error: message, resumable: true, received: size, total } };
    }
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    _clearPartial(userId);
    _setRuntime({
      phase: 'failed',
      version: info.latest_version,
      received: 0,
      total,
      percent: 0,
      error: message,
      resumable: false,
    });
    log.warn(`update download failed: ${message}`);
    return { kind: 'done', result: { ok: false, error: message, resumable: false, received: 0, total } };
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
