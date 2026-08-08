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

  describe('wechat personal adapter inbound/outbound', () => {
    // instance/secret 复用上文定义；增加一个 owner 实例
    const ownerInstance = {
      ...instance,
      ownerExternalUserId: 'owner-1',
    };

    it('normalizes a direct text message without leaking the raw token', async () => {
      const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
      const envelope = _wechatTestHooks.normalizeInbound(ownerInstance, 'owner-1', {
        msg_id: 'm-1',
        from_user_id: 'owner-1',
        item_list: [{ type: 'text_item', text_item: { text: '你好' } }],
        context_token: 'ctx-1',
        create_time: 1700000000000,
      });
      expect(envelope).not.toBeNull();
      expect(envelope!.externalMessageId).toBe('m-1');
      expect(envelope!.externalUserId).toBe('owner-1');
      expect(envelope!.text).toBe('你好');
      expect(envelope!.isGroup).toBe(false);
      // 纯函数不携带明文 token；tokenRef 由 handleBatch 在 dispatch 前注入
      expect(envelope!.contextTokenRef).toBeUndefined();
    });

    it('rejects group messages and messages missing required fields', async () => {
      const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
      expect(_wechatTestHooks.normalizeInbound(ownerInstance, 'owner-1', {
        msg_id: 'm-2', group_id: 'g-1', from_user_id: 'owner-1',
        item_list: [{ type: 'text_item', text_item: { text: 'hi' } }], context_token: 'ctx-2',
      })).toBeNull();
      expect(_wechatTestHooks.normalizeInbound(ownerInstance, 'owner-1', {
        from_user_id: 'owner-1',
        item_list: [{ type: 'text_item', text_item: { text: 'hi' } }], context_token: 'ctx-3',
      })).toBeNull(); // 缺 msg_id
      expect(_wechatTestHooks.normalizeInbound(ownerInstance, 'owner-1', {
        msg_id: 'm-4', from_user_id: 'owner-1',
        item_list: [], context_token: 'ctx-4',
      })).toBeNull(); // 无文本 item
      expect(_wechatTestHooks.normalizeInbound(ownerInstance, 'owner-1', {
        msg_id: 'm-5', from_user_id: 'owner-1',
        item_list: [{ type: 'text_item', text_item: { text: 'hi' } }],
      })).toBeNull(); // 缺 context_token
    });

    it('injects a tokenRef for the owner and sends with the bound token', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
      const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
      // 模拟入站时序：先落盘 peer token，拿到真实 tokenRef
      const tokenRef = await stateStore.saveWechatPeerToken(
        'uid-1', 'inst-1', fingerprint, 'owner-1', 'ctx-bound', 1_700_000_000_000,
      );

      const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }));

      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      const result = await adapter.sendMessage('owner-1', '回复内容', undefined, {
        contextTokenRef: tokenRef,
      });
      expect(result).toEqual({});
      expect(sent).toHaveLength(1);
      const msg = sent[0].body.msg as Record<string, unknown>;
      expect(msg.to_user_id).toBe('owner-1');
      expect(msg.context_token).toBe('ctx-bound');
      expect((msg.item_list as Array<{ text_item: { text: string } }>)[0].text_item.text).toBe('回复内容');
    });

    it('chunkText splits long replies at 4000 units without breaking surrogate pairs', async () => {
      const { _wechatTestHooks } = await import('../../../src/main/features/messaging/wechat-personal');
      const long = 'x'.repeat(9_500);
      const chunks = _wechatTestHooks.chunkText(long, 4_000);
      expect(chunks.map((c) => c.length)).toEqual([4_000, 4_000, 1_500]);
      expect(chunks.join('')).toBe(long);
      // 代理对（emoji）不被拆开：每块长度保持偶数（完整代理对）
      const emoji = '😀'.repeat(3_000);
      const emojiChunks = _wechatTestHooks.chunkText(emoji, 4_000);
      expect(emojiChunks.map((c) => c.length)).toEqual([4_000, 2_000]);
      expect(emojiChunks.join('')).toBe(emoji);
      // 短文本不切分
      expect(_wechatTestHooks.chunkText('short', 4_000)).toEqual(['short']);
    });

    it('sends long replies as multiple text_item chunks in one send, arriving complete', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
      const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
      const tokenRef = await stateStore.saveWechatPeerToken(
        'uid-1', 'inst-1', fingerprint, 'owner-1', 'ctx-bound', 1_700_000_000_000,
      );
      const sent: Array<{ body: Record<string, unknown> }> = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }));
      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      const longText = '段'.repeat(4_500);
      await adapter.sendMessage('owner-1', longText, undefined, { contextTokenRef: tokenRef });
      expect(sent).toHaveLength(1);
      const items = (sent[0].body.msg as { item_list: Array<{ type: string; text_item: { text: string } }> }).item_list;
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.type === 'text_item')).toBe(true);
      expect(items.map((item) => item.text_item.text.length)).toEqual([4_000, 500]);
      expect(items.map((item) => item.text_item.text).join('')).toBe(longText);
    });

    it('refuses to send when the tokenRef peer does not match the reply target', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
      const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
      const tokenRef = await stateStore.saveWechatPeerToken(
        'uid-1', 'inst-1', fingerprint, 'owner-1', 'ctx-bound', 1_700_000_000_000,
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      // tokenRef 编码 owner-1，但回复目标是另一位 peer → wechat_context_missing
      await expect(adapter.sendMessage('stranger-1', 'hi', undefined, { contextTokenRef: tokenRef }))
        .rejects.toThrow('wechat_context_missing');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('injects a tokenRef into the envelope before dispatch and persists the token', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
      const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
      const onInbound = vi.fn().mockResolvedValue({ accepted: true, duplicate: false });
      vi.stubGlobal('fetch', vi.fn()
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: 'cursor-1',
          messages: [{
            msg_id: 'm-1', from_user_id: 'owner-1',
            item_list: [{ type: 'text_item', text_item: { text: '你好' } }],
            context_token: 'ctx-live',
          }],
        }), { status: 200 })));
      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      const controller = new AbortController();
      const startPromise = adapter.start(controller.signal, { onInbound, onStatus: vi.fn().mockResolvedValue(undefined) } as never);
      await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
      controller.abort();
      await startPromise;
      const envelope = onInbound.mock.calls[0][0] as { contextTokenRef?: string };
      expect(envelope.contextTokenRef).toBeTruthy();
      const state = await stateStore.loadWechatState('uid-1', 'inst-1', fingerprint);
      expect(state?.peers['owner-1']?.contextToken).toBe('ctx-live');
      expect(state?.getUpdatesBuf).toBe('cursor-1');
    });

    it('does not persist peer state for a non-owner sender', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
      const fingerprint = stateStore.wechatCredentialFingerprint('bot-1', 'owner-1');
      const onInbound = vi.fn().mockResolvedValue({ accepted: false, duplicate: false });
      vi.stubGlobal('fetch', vi.fn()
        .mockImplementationOnce(async () => new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: 'cursor-2',
          messages: [{
            msg_id: 'm-2', from_user_id: 'stranger-1',
            item_list: [{ type: 'text_item', text_item: { text: 'hack' } }],
            context_token: 'ctx-stranger',
          }],
        }), { status: 200 })));
      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      const controller = new AbortController();
      const startPromise = adapter.start(controller.signal, { onInbound, onStatus: vi.fn().mockResolvedValue(undefined) } as never);
      await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
      controller.abort();
      await startPromise;
      const envelope = onInbound.mock.calls[0][0] as { contextTokenRef?: string; externalUserId: string };
      expect(envelope.externalUserId).toBe('stranger-1');
      expect(envelope.contextTokenRef).toBeUndefined();
      const state = await stateStore.loadWechatState('uid-1', 'inst-1', fingerprint);
      expect(state?.peers['stranger-1']).toBeUndefined();
    });

    it('refuses to send when no token is available', async () => {
      const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WechatPersonalAdapter(ownerInstance, secret, 'uid-1');
      await expect(adapter.sendMessage('owner-1', 'hi', undefined, { contextTokenRef: 'owner-1::no-such-uuid' }))
        .rejects.toThrow(/context/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
