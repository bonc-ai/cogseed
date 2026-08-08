import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wechat-reg-'));
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

describe('wechat registration flow', () => {
  it('walks wait -> scaned -> confirmed and creates an owner-bound instance', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    const statuses: string[] = [];
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async (url: string) => {
        expect(String(url)).toContain('/ilink/bot/get_bot_qrcode');
        expect(String(url)).toContain('bot_type=3');
        return new Response(JSON.stringify({ ret: 0, qrcode: 'qr-abc', url: 'https://ilinkai.weixin.qq.com/qr' }), { status: 200 });
      })
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'wait' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'scaned' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0,
        status: 'confirmed',
        bot_token: 't'.repeat(64),
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'owner-1',
      }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    expect(started.state).toBe('awaiting_scan');
    // 轮询直到 completed（内部以短间隔轮询）
    await vi.waitFor(async () => {
      const s = getWechatQrRegistrationStatus('uid-1', started.flowId);
      statuses.push(s.state);
      expect(s.state).toBe('completed');
    }, { timeout: 8_000, interval: 100 });
    // 状态按 awaiting_scan → scanned → completed 单调推进
    const seen: string[] = [];
    for (const s of statuses) {
      if (seen[seen.length - 1] !== s) seen.push(s);
    }
    expect(seen).toEqual(['awaiting_scan', 'scanned', 'completed']);
    const registry = await import('../../../src/main/features/messaging/registry');
    const instances = await registry.listInstances('uid-1');
    expect(instances).toHaveLength(1);
    expect(instances[0].ownerConfigured).toBe(true);
    expect(instances[0].policy.allowUserIds).toEqual(['owner-1']);
  });

  it('fails closed when confirmed payload misses ilink_user_id', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-1' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'confirmed', bot_token: 't'.repeat(64), baseurl: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'bot-1' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('failed');
    }, { timeout: 8_000, interval: 100 });
    expect(getWechatQrRegistrationStatus('uid-1', started.flowId).errorCode).toBe('confirmed_payload_invalid');
    const registry = await import('../../../src/main/features/messaging/registry');
    expect(await registry.listInstances('uid-1')).toHaveLength(0);
  });

  it('rejects a confirmed baseurl outside the whitelist', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-2' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        ret: 0, status: 'confirmed',
        bot_token: 't'.repeat(64), baseurl: 'https://evil.example.com',
        ilink_bot_id: 'bot-2', ilink_user_id: 'owner-2',
      }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('failed');
    }, { timeout: 8_000, interval: 100 });
    expect(getWechatQrRegistrationStatus('uid-1', started.flowId).errorCode).toBe('confirmed_payload_invalid');
  });

  it('fails expired after exhausting the QR refresh budget', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      // 初始二维码 + 3 次过期刷新，随后 4 个 expired 状态耗尽刷新预算
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-exp' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'expired' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-exp-1' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'expired' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-exp-2' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'expired' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-exp-3' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'expired' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      const s = getWechatQrRegistrationStatus('uid-1', started.flowId);
      expect(s.state).toBe('expired');
      expect(s.errorCode).toBe('qr_refresh_exhausted');
    }, { timeout: 8_000, interval: 100 });
  });

  it('fails with unknown_qr_status for an unmapped raw status', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-u' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'alien_state' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      const s = getWechatQrRegistrationStatus('uid-1', started.flowId);
      expect(s.state).toBe('failed');
      expect(s.errorCode).toBe('unknown_qr_status');
    }, { timeout: 8_000, interval: 100 });
  });

  it('fails with qr_ret_<n> on a non-zero poll ret', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-r' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 123, status: 'wait' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    await vi.waitFor(() => {
      const s = getWechatQrRegistrationStatus('uid-1', started.flowId);
      expect(s.state).toBe('failed');
      expect(s.errorCode).toBe('qr_ret_123');
    }, { timeout: 8_000, interval: 100 });
  });

  it('cancel while a confirmed response is in flight never creates an instance', async () => {
    let resolveConfirmed!: (value: Response) => void;
    const confirmedGate = new Promise<Response>((resolve) => { resolveConfirmed = resolve; });
    let markConfirmedFetchInFlight!: () => void;
    const confirmedFetchInFlight = new Promise<void>((resolve) => { markConfirmedFetchInFlight = resolve; });
    const { startWechatQrRegistration, cancelWechatQrRegistration, getWechatQrRegistrationStatus } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-race' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'wait' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'scaned' }), { status: 200 }))
      .mockImplementationOnce(async () => { markConfirmedFetchInFlight(); return confirmedGate; }));
    const started = await startWechatQrRegistration('uid-1');
    // 等到 confirmed 响应已经在途（fetch 已发出、尚未返回）
    await confirmedFetchInFlight;
    cancelWechatQrRegistration('uid-1', started.flowId);
    resolveConfirmed(new Response(JSON.stringify({
      ret: 0, status: 'confirmed',
      bot_token: 't'.repeat(64), baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_bot_id: 'bot-race', ilink_user_id: 'owner-race',
    }), { status: 200 }));
    await vi.waitFor(() => {
      expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('cancelled');
    }, { timeout: 8_000, interval: 100 });
    const registry = await import('../../../src/main/features/messaging/registry');
    expect(await registry.listInstances('uid-1')).toHaveLength(0);
  });

  it('rejects status access and cancel for a flow owned by another uid', async () => {
    const { startWechatQrRegistration, getWechatQrRegistrationStatus, cancelWechatQrRegistration } =
      await import('../../../src/main/features/messaging/wechat-registration');
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, qrcode: 'qr-own' }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ret: 0, status: 'wait' }), { status: 200 })));
    const started = await startWechatQrRegistration('uid-1');
    expect(() => getWechatQrRegistrationStatus('uid-2', started.flowId)).toThrow('wechat registration flow not found');
    expect(() => cancelWechatQrRegistration('uid-2', started.flowId)).toThrow('wechat registration flow not found');
    // 本人仍然可以正常读取/取消
    cancelWechatQrRegistration('uid-1', started.flowId);
    expect(getWechatQrRegistrationStatus('uid-1', started.flowId).state).toBe('cancelled');
  });
});
