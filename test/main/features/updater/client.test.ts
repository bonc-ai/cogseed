/**
 * Update-check client: server round-trip semantics, reminder rules, and the
 * checksum-verified download path.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
// 把测试正文切成两段，模拟"下到一半被暂停"。
const HALF = Math.floor(DMG_BODY.length / 2);
const FIRST = DMG_BODY.slice(0, HALF);
const SECOND = DMG_BODY.slice(HALF);

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

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
    electronMock.app.isPackaged = false;
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

  it('sends the updates-contract platform token (darwin/win32/linux), not the app taxonomy', async () => {
    const fetchMock = stubFetch(async () => latestResponse(null));
    await updater.checkForUpdates(UID, { manual: true, now: 1_000 });
    const call = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    const headers = (call[1].headers || {}) as Record<string, string>;
    const contractToken = { darwin: 'darwin', win32: 'win32', linux: 'linux' }[process.platform];
    if (contractToken) {
      // The shared client header maps darwin→'mac' for other APIs; the
      // update channel must send the contract token or /updates/latest
      // matches no catalog entry and silently reports "up to date".
      expect(headers['CogSeed-Platform']).toBe(contractToken);
      expect(headers['CogSeed-Platform']).not.toBe('mac');
    }
    // Other metadata rides along unchanged.
    expect(headers['CogSeed-App-Version']).toBe('0.0.5');
    expect(headers['CogSeed-Arch']).toBe(process.arch);
  });

  it('skips packaged Windows latest checks instead of surfacing updates/latest 400', async () => {
    electronMock.app.isPackaged = true;
    const fetchMock = stubFetch(async () => new Response('bad platform', { status: 400 }));

    const result = await withPlatform('win32', () => updater.checkForUpdates(UID, { manual: true, now: 1_000 }));

    expect(result).toMatchObject({
      checked: true,
      has_update: false,
      reminded: false,
      current_version: '0.0.5',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readUpdaterState(UID).latest_info).toBeUndefined();
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
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('verify_failed');
    // 校验不过必须 fail-closed：半包删掉，而且不给「继续下载」——拼起来也是坏的。
    expect(result.resumable).toBe(false);
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
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('already_downloading');
    expect(second.resumable).toBe(true);

    release(new Response(DMG_BODY));
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it('derives safe filenames and falls back on traversal attempts', () => {
    expect(updater.installerFilenameFromUrl('https://dl.example.com/CogSeed-0.0.6-mac-arm64.dmg'))
      .toBe('CogSeed-0.0.6-mac-arm64.dmg');
    expect(updater.installerFilenameFromUrl('https://dl.example.com/CogSeed-0.9.0-win-x64.exe'))
      .toBe('CogSeed-0.9.0-win-x64.exe');
    const evil = updater.installerFilenameFromUrl('https://dl.example.com/CogSeed%2F..%2F..%2Fetc%2Fpasswd');
    expect(evil).not.toContain('..');
    expect(evil).not.toContain('/');
    expect(evil.endsWith('.dmg') || evil.endsWith('.zip') || evil.endsWith('.exe')).toBe(true);
  });
});

// 2026-09-21：下载可暂停 / 可续传。核心风险是"续传拼出来的文件其实不完整"，
// 所以每条用例都落到最终 sha256 上，而不是只看流程返回值。
describe('resumable download control', () => {
  const ETAG = 'etag-abc';

  function partPath() {
    return `${path.join(userUpdaterDownloadsDir(UID), updater.installerFilenameFromUrl(infoFixture().url))}.part`;
  }

  function partSize() {
    try {
      return fs.statSync(partPath()).size;
    } catch {
      return -1;
    }
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await new Promise((done) => setTimeout(done, 5));
    }
    return predicate();
  }

  /**
   * 第一段立刻送达，然后挂住直到请求被 abort —— 真实的 fetch 会在 signal 上中断，
   * 假 fetch 必须照做：abort 时让读流报错，否则 pipeline 会一直等下去。
   */
  function stalledFirstResponse(holder: { controller?: ReadableStreamDefaultController<Uint8Array> }) {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        holder.controller = controller;
        controller.enqueue(new TextEncoder().encode(FIRST));
      },
      pull() {
        return new Promise<void>(() => { /* 挂住，等 abort */ });
      },
    }), {
      status: 200,
      headers: { 'content-length': String(DMG_BODY.length), etag: `"${ETAG}"` },
    });
  }

  function stubAbortable() {
    const holder: { controller?: ReadableStreamDefaultController<Uint8Array>; signal?: AbortSignal | null } = {};
    const fetchMock = stubFetch(async (_input, init) => {
      holder.signal = init?.signal ?? null;
      const response = stalledFirstResponse(holder);
      init?.signal?.addEventListener('abort', () => {
        try {
          holder.controller?.error(new Error('aborted'));
        } catch { /* already closed */ }
      });
      return response;
    });
    return { holder, fetchMock };
  }

  beforeEach(() => {
    process.env.COGSEED_API_BASE_URL = API_BASE;
    void resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COGSEED_API_BASE_URL;
    void updater.cancelActiveDownloadForTest();
  });

  it('pauses without throwing away the bytes already on disk', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    stubAbortable();
    electronMock.app.getVersion.mockReturnValue('0.0.5');

    const running = updater.downloadUpdate(UID);
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);

    const paused = await updater.pauseDownload(UID);
    expect(paused.ok).toBe(false);
    if (paused.ok) return;
    expect(paused.paused).toBe(true);
    expect(paused.resumable).toBe(true);
    expect(paused.received).toBe(FIRST.length);

    const state = readUpdaterState(UID);
    expect(state.partial?.version).toBe('0.0.6');
    expect(state.partial?.received).toBe(FIRST.length);
    expect(state.partial?.etag).toBe(ETAG);
    expect(fs.readFileSync(partPath(), 'utf8')).toBe(FIRST);
    // 暂停态要能被界面读到（主进程是唯一权威）。
    await expect(updater.getDownloadState(UID)).resolves.toMatchObject({
      phase: 'paused',
      received: FIRST.length,
    });

    // 通过 abort 收尾的那次 invoke 也必须以 paused 结束，而不是被当成网络失败。
    const result = await running;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('paused');
  });

  it('resumes with a Range request and still verifies the final sha256', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    const calls: Array<Record<string, string>> = [];
    stubAbortable();

    const running = updater.downloadUpdate(UID);
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);
    await updater.pauseDownload(UID);
    await running;
    vi.unstubAllGlobals();

    // 续传：主进程必须带 Range 从已有字节继续，并带 If-Range 作为制品凭据。
    stubFetch(async (_input, init) => {
      calls.push((init?.headers || {}) as Record<string, string>);
      return new Response(SECOND, {
        status: 206,
        headers: {
          'content-range': `bytes ${FIRST.length}-${DMG_BODY.length - 1}/${DMG_BODY.length}`,
          'content-length': String(SECOND.length),
          etag: `"${ETAG}"`,
        },
      });
    });

    const resumed = await updater.resumeDownload(UID);
    expect(calls[0].Range).toBe(`bytes=${FIRST.length}-`);
    expect(calls[0]['If-Range']).toBe(ETAG);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // 关键：哈希是随流增量算的，续传若只哈希后半段，这里必然是 verify_failed。
    expect(resumed.sha256).toBe(DMG_SHA);
    expect(fs.readFileSync(resumed.path, 'utf8')).toBe(DMG_BODY);
    expect(readUpdaterState(UID).partial).toBeUndefined();
    expect(fs.existsSync(partPath())).toBe(false);
  });

  it('restarts from zero when the server ignores Range and answers 200', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    stubAbortable();
    const running = updater.downloadUpdate(UID);
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);
    await updater.pauseDownload(UID);
    await running;
    vi.unstubAllGlobals();

    const calls: Array<Record<string, string>> = [];
    stubFetch(async (_input, init) => {
      calls.push((init?.headers || {}) as Record<string, string>);
      // 服务端不支持 Range：回 200 + 完整正文。
      return new Response(DMG_BODY, { status: 200, headers: { 'content-length': String(DMG_BODY.length) } });
    });

    const resumed = await updater.resumeDownload(UID);
    expect(calls).toHaveLength(1);
    expect(calls[0].Range).toBe(`bytes=${FIRST.length}-`);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // 半包被丢弃重下，拼出来的文件必须是完整的（不是 FIRST + 全文）。
    expect(fs.readFileSync(resumed.path, 'utf8')).toBe(DMG_BODY);
    expect(resumed.sha256).toBe(DMG_SHA);
  });

  it('discards the partial when the artifact validator changed', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    stubAbortable();
    const running = updater.downloadUpdate(UID);
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);
    await updater.pauseDownload(UID);
    await running;
    vi.unstubAllGlobals();

    const calls: Array<Record<string, string>> = [];
    stubFetch(async (_input, init) => {
      calls.push((init?.headers || {}) as Record<string, string>);
      if (calls.length === 1) {
        // 制品换了：206 的正文属于新 build，和磁盘上的旧字节拼不起来。
        return new Response(SECOND, {
          status: 206,
          headers: {
            'content-range': `bytes ${FIRST.length}-${DMG_BODY.length - 1}/${DMG_BODY.length}`,
            etag: '"etag-changed"',
          },
        });
      }
      return new Response(DMG_BODY, { status: 200, headers: { 'content-length': String(DMG_BODY.length) } });
    });

    const resumed = await updater.resumeDownload(UID);
    expect(calls).toHaveLength(2);
    expect(calls[0]['If-Range']).toBe(ETAG);
    expect(calls[1].Range).toBeUndefined();
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(fs.readFileSync(resumed.path, 'utf8')).toBe(DMG_BODY);
    expect(resumed.sha256).toBe(DMG_SHA);
  });

  it('keeps the partial for a later resume when the connection drops', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    let dropConnection: (() => void) | null = null;
    stubFetch(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(FIRST));
        dropConnection = () => controller.error(new Error('socket hang up'));
      },
      pull() {
        return new Promise<void>(() => { /* 挂着，等测试主动断连 */ });
      },
    }), { status: 200, headers: { 'content-length': String(DMG_BODY.length) } }));

    const running = updater.downloadUpdate(UID);
    // 先确认第一段真的落盘了，再断连——否则测的是"零字节失败"，不是"可续传中断"。
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);
    dropConnection?.();
    const result = await running;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.resumable).toBe(true);
    // 网络断了但字节还在：保留半包，用户点「继续下载」即可。
    expect(fs.readFileSync(partPath(), 'utf8')).toBe(FIRST);
    expect(readUpdaterState(UID).partial?.received).toBe(FIRST.length);
  });

  it('cancel reclaims the partial and returns to idle', async () => {
    writeUpdaterState(UID, { version: 1, latest_info: infoFixture() });
    stubAbortable();
    const running = updater.downloadUpdate(UID);
    expect(await waitFor(() => partSize() === FIRST.length)).toBe(true);

    const canceled = await updater.cancelDownload(UID);
    expect(canceled.ok).toBe(false);
    if (canceled.ok) return;
    expect(canceled.canceled).toBe(true);
    await running;

    expect(fs.existsSync(partPath())).toBe(false);
    expect(readUpdaterState(UID).partial).toBeUndefined();
    await expect(updater.getDownloadState(UID)).resolves.toMatchObject({ phase: 'idle' });
  });

  it('reports a paused transfer that outlived the process', async () => {
    writeUpdaterState(UID, {
      version: 1,
      latest_info: infoFixture(),
      partial: { version: '0.0.6', etag: ETAG, received: FIRST.length, total: DMG_BODY.length, updated_at: Date.now() },
    });
    fs.mkdirSync(userUpdaterDownloadsDir(UID), { recursive: true });
    fs.writeFileSync(partPath(), FIRST);
    // 新进程：内存里的运行时态是空的，暂停进度只能从磁盘记录里恢复。
    await updater.cancelActiveDownloadForTest();

    await expect(updater.getDownloadState(UID)).resolves.toMatchObject({
      phase: 'paused',
      received: FIRST.length,
      total: DMG_BODY.length,
    });
  });

  it('ignores a partial record whose file is gone', async () => {
    writeUpdaterState(UID, {
      version: 1,
      latest_info: infoFixture(),
      partial: { version: '0.0.6', received: FIRST.length, total: DMG_BODY.length, updated_at: Date.now() },
    });
    await updater.cancelActiveDownloadForTest();
    await expect(updater.getDownloadState(UID)).resolves.toMatchObject({ phase: 'idle' });
  });
});

// 「没有更新时不该出现下载/打开安装包」的根因在数据层：持久化的 latest_info
// 直到下次检查才被重新校验，中间这段窗口会让已装好的版本继续挂在那儿。
describe('stale update records', () => {
  beforeEach(() => {
    process.env.COGSEED_API_BASE_URL = API_BASE;
    void resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COGSEED_API_BASE_URL;
    void updater.cancelActiveDownloadForTest();
  });

  it('treats the running version as not actionable and prunes its records', async () => {
    electronMock.app.getVersion.mockReturnValue('0.0.6');
    const dir = userUpdaterDownloadsDir(UID);
    fs.mkdirSync(dir, { recursive: true });
    const installer = path.join(dir, 'CogSeed-0.0.6-mac-arm64.dmg');
    fs.writeFileSync(installer, DMG_BODY);
    fs.writeFileSync(`${installer}.part`, FIRST);
    writeUpdaterState(UID, {
      version: 1,
      known_latest: '0.0.6',
      latest_info: infoFixture(),
      downloaded: {
        version: '0.0.6', path: installer, size: DMG_BODY.length, sha256: DMG_SHA, downloaded_at: Date.now(),
      },
      partial: { version: '0.0.6', received: FIRST.length, total: DMG_BODY.length, updated_at: Date.now() },
    });

    const current = updater.currentAppVersion();
    await updater.reconcileStaleState(UID);

    const state = readUpdaterState(UID);
    expect(updater.isUpdateActionable(state.latest_info, current)).toBe(false);
    expect(updater.isUpdateOffered(state, current)).toBe(false);
    expect(state.latest_info).toBeUndefined();
    expect(state.downloaded).toBeUndefined();
    expect(state.partial).toBeUndefined();
    // 没用了的半包连磁盘一起回收；已校验的安装包文件保持不动（不替用户删文件）。
    expect(fs.existsSync(`${installer}.part`)).toBe(false);
    expect(fs.existsSync(installer)).toBe(true);
  });

  it('does not offer a version the user skipped', () => {
    const current = '0.0.5';
    const state = { version: 1 as const, latest_info: infoFixture(), dismissed_version: '0.0.6' };
    expect(updater.isUpdateActionable(state.latest_info, current)).toBe(true);
    expect(updater.isUpdateOffered(state, current)).toBe(false);
  });

  it('keeps offering a genuinely newer version', () => {
    const current = '0.0.5';
    const state = { version: 1 as const, latest_info: infoFixture() };
    expect(updater.isUpdateOffered(state, current)).toBe(true);
    expect(updater.isInstallReady({
      version: 1,
      downloaded: {
        version: '0.0.6', path: '/tmp/x.dmg', size: 1, sha256: DMG_SHA, downloaded_at: 1,
      },
    }, current)).toBe(true);
  });
});
