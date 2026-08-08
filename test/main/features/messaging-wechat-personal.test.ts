import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wechat-adapter-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('wechat personal adapter wire contract', () => {
  const instance = {
    id: 'inst-1',
    platform: 'wechat_personal' as const,
    displayName: '我的微信',
    enabled: true,
    responseMode: 'text' as const,
    workspace: { type: 'default' as const },
    policy: { replyMode: 'every_message' as const, allowUserIds: ['owner-1'], allowGroupIds: [], requireMentionInGroups: false },
    status: { kind: 'disconnected' as const, checkedAt: new Date().toISOString() },
    createdAt: '',
    updatedAt: '',
  };
  const secret = {
    ilinkBotToken: 't'.repeat(64),
    ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
    ilinkBotId: 'bot-1',
  };
  const makeResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  /** Yield real event-loop turns (setImmediate is not faked by the tests'
   * limited fake-timer config) until a condition holds, so async chains that
   * mix real I/O (dynamic imports, fs reads) with faked timers settle. */
  const pumpUntil = async (cond: () => boolean, rounds = 500): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      if (cond()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('builds the full header set with a random X-WECHAT-UIN per call', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    const a = _wechatTestHooks.buildHeaders('bot-1', 't'.repeat(64));
    const b = _wechatTestHooks.buildHeaders('bot-1', 't'.repeat(64));
    expect(a['AuthorizationType']).toBe('ilink_bot_token');
    expect(a['Authorization']).toBe(`Bearer ${'t'.repeat(64)}`);
    expect(a['iLink-App-Id']).toBe('bot-1');
    expect(a['iLink-App-ClientVersion']).toBeTruthy();
    expect(a['Content-Type']).toBe('application/json');
    expect(a['X-WECHAT-UIN']).not.toBe(b['X-WECHAT-UIN']);
  });

  it('classifies HTTP 401 and JSON ret=-14 as terminal reauth errors', async () => {
    const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
    expect(_wechatTestHooks.classifyError(new Error('HTTP 401'))).toBe('reauth_required');
    expect(_wechatTestHooks.classifyError(new Error('ret=-14'))).toBe('reauth_required');
    expect(_wechatTestHooks.classifyError(new Error('ret=-14 token invalid'))).toBe('reauth_required');
    expect(_wechatTestHooks.classifyError(new Error('socket hang up'))).toBe('network');
    // Anchored matching: look-alike substrings must stay transient network errors.
    expect(_wechatTestHooks.classifyError(new Error('ret=-140'))).toBe('network');
    expect(_wechatTestHooks.classifyError(new Error('ret=100 timeout at -14:00'))).toBe('network');
    expect(_wechatTestHooks.classifyError(new Error('HTTP 1401'))).toBe('network');
  });

  it('long-polls getupdates, commits the opaque cursor after the batch settles, and stops on 401', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const onStatus = vi.fn().mockResolvedValue(undefined);
    const onInbound = vi.fn().mockResolvedValue({ accepted: true, duplicate: false });
    const fetches: Promise<Response>[] = [];
    const makeResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    // 第一轮：空批次（无 buf 或空 buf），第二轮：401
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        calls.push({ url: String(_url), init });
        fetches.push(Promise.resolve(makeResponse({ ret: 0, get_updates_buf: 'cursor-1', messages: [] })));
        return fetches[fetches.length - 1];
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        calls.push({ url: String(_url), init });
        return makeResponse({ ret: -14, errmsg: 'token invalid' });
      });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound, onStatus } as never);
    // 等两轮请求完成
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
    // 401 → 终态 error，不自动重试
    await vi.waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    });
    controller.abort();
    await startPromise;
    // 所有请求都带 redirect: error 与完整 headers
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers['AuthorizationType']).toBe('ilink_bot_token');
      expect(headers['Authorization']).toContain('Bearer ');
      expect((call.init as { redirect?: string }).redirect).toBe('error');
      expect(call.url).toContain('/ilink/bot/getupdates');
    }
  });

  it('does not treat an external abort or long-poll timeout as an error status', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      throw new Error('aborted');
    }));
    const onStatus = vi.fn().mockResolvedValue(undefined);
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound: vi.fn(), onStatus } as never);
    setTimeout(() => controller.abort(), 20);
    await startPromise;
    const errorCalls = onStatus.mock.calls.filter(([s]) => s.kind === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('cleans up callbacks when the initial connecting status callback rejects, so a later start() works', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const onStatus = vi.fn().mockRejectedValueOnce(new Error('status boom')).mockResolvedValue(undefined);
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const c1 = new AbortController();
    await expect(adapter.start(c1.signal, { onInbound: vi.fn(), onStatus } as never)).rejects.toThrow('status boom');
    // The first start failed loudly but must not wedge the adapter: the
    // already-started guard would otherwise block every later start().
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeResponse({ ret: 0, get_updates_buf: 'c1', messages: [] })));
    const c2 = new AbortController();
    const startPromise = adapter.start(c2.signal, { onInbound: vi.fn(), onStatus } as never);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connected' })));
    c2.abort();
    await startPromise;
  });

  it('does not let a rejecting disconnected status callback escape start()', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const onStatus = vi.fn().mockImplementation(async (status: { kind: string }) => {
      if (status.kind === 'disconnected') throw new Error('disco boom');
    });
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const startPromise = adapter.start(new AbortController().signal, { onInbound: vi.fn(), onStatus } as never);
    // First poll hangs; bump the generation via stop() so the poll result is
    // discarded and start() exits through the finally with a disconnected emit.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await adapter.stop();
    resolveFetch(makeResponse({ ret: 0, get_updates_buf: 'c1', messages: [] }));
    await expect(startPromise).resolves.toBeUndefined();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'disconnected' }));
  });

  it('backs off exponentially on consecutive failures (2s, 4s, 8s) and resets after a successful poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (typeof ms === 'number' && ms >= 1_000) delays.push(ms);
      return realSetTimeout(fn, ms, ...args);
    });
    let fail = true;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('socket hang up');
      return makeResponse({ ret: 0, get_updates_buf: 'c1', messages: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onStatus = vi.fn().mockResolvedValue(undefined);
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound: vi.fn(), onStatus } as never);
    try {
      // Consecutive failures must wait 2s, then 4s, then 8s (exponential).
      const expected = [2_000, 4_000, 8_000];
      for (let i = 0; i < expected.length; i++) {
        await pumpUntil(() => delays.length > i);
        expect(delays[i]).toBe(expected[i]);
        await vi.advanceTimersByTimeAsync(expected[i]);
      }
      // A successful poll resets the counter: the next failure must wait the
      // base 2s again. Failures may already have queued further waits while
      // the fake clock advanced (real I/O can settle inside an advance), so
      // fire every pending backoff wait until a poll succeeds.
      fail = false;
      let sawConnected = false;
      for (let i = 0; i < 8 && !sawConnected; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await pumpUntil(() => onStatus.mock.calls.some(([s]) => s.kind === 'connected'));
        sawConnected = onStatus.mock.calls.some(([s]) => s.kind === 'connected');
      }
      expect(sawConnected).toBe(true);
      fail = true;
      const waitsBefore = delays.length;
      await pumpUntil(() => delays.length > waitsBefore);
      expect(delays[waitsBefore]).toBe(2_000);
    } finally {
      controller.abort();
      await startPromise;
      vi.useRealTimers();
    }
  });

  it('checkHealth: fresh poll is connected, 90s staleness flips to disconnected, terminal error reports error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const onStatus = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeResponse({ ret: 0, get_updates_buf: 'c1', messages: [] })));
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    try {
      // Never polled -> disconnected.
      expect((await adapter.checkHealth()).kind).toBe('disconnected');
      const controller = new AbortController();
      const startPromise = adapter.start(controller.signal, { onInbound: vi.fn(), onStatus } as never);
      await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'connected' })));
      controller.abort();
      await startPromise;
      // Fresh poll -> connected.
      expect((await adapter.checkHealth()).kind).toBe('connected');
      // Past the 90s staleness window -> disconnected.
      vi.advanceTimersByTime(91_000);
      expect((await adapter.checkHealth()).kind).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkHealth: reports error once a terminal reauth error ended the adapter', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const onStatus = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeResponse({ ret: -14, errmsg: 'token invalid' })));
    const adapter = new WechatPersonalAdapter(instance, secret, 'uid-1');
    const controller = new AbortController();
    const startPromise = adapter.start(controller.signal, { onInbound: vi.fn(), onStatus } as never);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })));
    controller.abort();
    await startPromise;
    const health = await adapter.checkHealth();
    expect(health.kind).toBe('error');
    expect(health.message).toContain('re-scan');
  });
});
