/**
 * Update-check client: server round-trip semantics, reminder rules, and the
 * checksum-verified download path.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.5'),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: electronMock.app }));

import * as updater from '../../../../src/main/features/updater/client';
import { REMIND_THROTTLE_MS, readUpdaterState, writeUpdaterState } from '../../../../src/main/features/updater/state';
import { userUpdaterDownloadsDir, userUpdaterStateFile } from '../../../../src/main/paths';

const UID = 'updater-client-test';
const API_BASE = 'https://api.example.com';

function latestResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }));
}

function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const DMG_BODY = 'fake-dmg-bytes-0123456789';
const DMG_SHA = crypto.createHash('sha256').update(DMG_BODY).digest('hex');

function infoFixture(overrides: Record<string, unknown> = {}) {
  return {
    latest_version: '0.0.6',
    url: 'https://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg',
    sha256: DMG_SHA,
    size: DMG_BODY.length,
    ...overrides,
  };
}

async function resetState() {
  try {
    fs.rmSync(userUpdaterStateFile(UID), { force: true });
    fs.rmSync(userUpdaterDownloadsDir(UID), { recursive: true, force: true });
  } catch { /* ignore */ }
}

describe('checkForUpdates', () => {
  beforeEach(() => {
    electronMock.app.getVersion.mockReturnValue('0.0.5');
    process.env.COGSEED_API_BASE_URL = API_BASE;
    void resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COGSEED_API_BASE_URL;
    updater.cancelActiveDownloadForTest?.();
  });

  it('reports a newer server version and surfaces the first reminder', async () => {
    stubFetch(async () => latestResponse(infoFixture()));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(true);
    expect(result.has_update).toBe(true);
    expect(result.reminded).toBe(true);
    expect(result.current_version).toBe('0.0.5');
    expect(result.info?.latest_version).toBe('0.0.6');

    const state = readUpdaterState(UID);
    expect(state.known_latest).toBe('0.0.6');
    expect(state.latest_info?.latest_version).toBe('0.0.6');
    expect(state.reminded?.['0.0.6']).toBe(1_000);
  });

  it('throttles automatic reminders to once per day, same version', async () => {
    stubFetch(async () => latestResponse(infoFixture()));
    await updater.checkForUpdates(UID, { now: 1_000 });
    const within = await updater.checkForUpdates(UID, { now: 1_000 + 60_000 });
    expect(within.has_update).toBe(true);
    expect(within.reminded).toBe(false);
    const nextDay = await updater.checkForUpdates(UID, { now: 1_000 + REMIND_THROTTLE_MS + 1 });
    expect(nextDay.reminded).toBe(true);
  });

  it('respects the skip list for automatic checks but not manual ones', async () => {
    stubFetch(async () => latestResponse(infoFixture()));
    updater.dismissVersion(UID, '0.0.6');
    const auto = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(auto.has_update).toBe(true);
    expect(auto.reminded).toBe(false);

    const manual = await updater.checkForUpdates(UID, { now: 2_000, manual: true });
    expect(manual.has_update).toBe(true);
    expect(manual.reminded).toBe(false);
  });

  it('manual checks never consume the reminder budget', async () => {
    stubFetch(async () => latestResponse(infoFixture()));
    const manual = await updater.checkForUpdates(UID, { now: 1_000, manual: true });
    expect(manual.has_update).toBe(true);
    expect(manual.reminded).toBe(false);

    const auto = await updater.checkForUpdates(UID, { now: 2_000 });
    expect(auto.reminded).toBe(true);
  });

  it('no update when the server says so (data null)', async () => {
    stubFetch(async () => latestResponse(null));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(true);
    expect(result.has_update).toBe(false);
    expect(result.reminded).toBe(false);
    expect(readUpdaterState(UID).latest_info).toBeUndefined();
  });

  it('no update when the server version is not newer', async () => {
    stubFetch(async () => latestResponse(infoFixture({ latest_version: '0.0.4' })));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(true);
    expect(result.has_update).toBe(false);
  });

  it('handles prerelease-ish comparisons via compareVersions', async () => {
    stubFetch(async () => latestResponse(infoFixture({ latest_version: '0.0.6-beta.1' })));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.has_update).toBe(true);
  });

  it('fails silently (checked:false) on network errors', async () => {
    stubFetch(async () => { throw new Error('network down'); });
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(false);
    expect(result.has_update).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('falls back to the channel default when the env override is unset, and still fails silently', async () => {
    delete process.env.COGSEED_API_BASE_URL;
    stubFetch(async () => { throw new Error('network down'); });
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails silently on non-zero envelope code', async () => {
    stubFetch(async () => new Response(JSON.stringify({ code: 1, msg: 'boom' })));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('fails silently on malformed data', async () => {
    stubFetch(async () => latestResponse({ latest_version: '0.0.6' }));
    const result = await updater.checkForUpdates(UID, { now: 1_000 });
    expect(result.checked).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('downloadUpdate', () => {
  beforeEach(() => {
    process.env.COGSEED_API_BASE_URL = API_BASE;
    void resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COGSEED_API_BASE_URL;
    updater.cancelActiveDownloadForTest?.();
  });

  it('downloads, verifies sha256 and records state on success', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    stubFetch(async () => new Response(DMG_BODY));
    const result = await updater.downloadUpdate(UID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.readFileSync(result.path, 'utf8')).toBe(DMG_BODY);

    const state = readUpdaterState(UID);
    expect(state.downloaded?.version).toBe('0.0.6');
    expect(state.downloaded?.sha256).toBe(DMG_SHA);
    expect(state.downloaded?.path).toBe(result.path);
  });

  it('deletes the partial file when the checksum mismatches', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture({ sha256: 'deadbeef'.repeat(8) }) });
    stubFetch(async () => new Response(DMG_BODY));
    const result = await updater.downloadUpdate(UID);
    expect(result).toEqual({ ok: false, error: 'verify_failed' });
    const leftovers = fs.readdirSync(userUpdaterDownloadsDir(UID));
    expect(leftovers).toEqual([]);
  });

  it('refuses when no latest info is cached', async () => {
    const result = await updater.downloadUpdate(UID);
    expect(result).toEqual({ ok: false, error: 'no_update_info' });
  });

  it('refuses non-https download urls without calling fetch', async () => {
    const fetchMock = stubFetch(async () => new Response(DMG_BODY));
    writeUpdaterState(UID, {
      version: 1,
      latest_info: infoFixture({ url: 'http://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg' }),
    });
    const result = await updater.downloadUpdate(UID);
    expect(result).toEqual({ ok: false, error: 'insecure_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows only one download at a time', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    stubFetch(async () => pending);

    const first = updater.downloadUpdate(UID);
    const second = await updater.downloadUpdate(UID);
    expect(second).toEqual({ ok: false, error: 'already_downloading' });

    release(new Response(DMG_BODY));
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it('derives safe filenames and falls back on traversal attempts', () => {
    expect(updater.installerFilenameFromUrl('https://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg'))
      .toBe('CogSeed-0.0.6-mac-arm64.dmg');
    const evil = updater.installerFilenameFromUrl('https://dl.example.com/CogSeed%2F..%2F..%2Fetc%2Fpasswd');
    expect(evil).not.toContain('..');
    expect(evil).not.toContain('/');
    expect(evil.endsWith('.dmg') || evil.endsWith('.zip')).toBe(true);
  });
});
