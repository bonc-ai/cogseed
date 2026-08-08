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
    expect(_wechatTestHooks.classifyError(new Error('socket hang up'))).toBe('network');
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
});
