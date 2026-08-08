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
  });
});
