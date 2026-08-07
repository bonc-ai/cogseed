import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-owner-bind-int-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Integration: a real Feishu receive_v1 event flows through the actual
 * FeishuAdapter → onInbound → manager.enqueueInbound → owner auto-bind.
 * Only the Larksuite SDK transport is mocked (WSClient dispatcher capture).
 */
describe('owner auto-bind through the real Feishu event path', () => {
  it('binds the sender from a real receive_v1 direct message while the window is open', async () => {
    let handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
    const dispatcher = {
      register: vi.fn((registered: Record<string, (event: unknown) => Promise<unknown>>) => {
        handlers = registered;
        return dispatcher;
      }),
    };
    const EventDispatcher = vi.fn(function EventDispatcher() { return dispatcher; });
    const WSClient = vi.fn(function WSClient() { return { start: vi.fn(async () => {}), close: vi.fn() }; });
    const Client = vi.fn(function Client() { return {
      request: vi.fn(async () => ({ code: 0, data: { open_id: 'ou_bot' } })),
      im: { v1: { message: { create: vi.fn() } } },
    }; });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({
      AppType: { SelfBuild: 'SelfBuild' },
      Client,
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      EventDispatcher,
      LoggerLevel: { error: 'error' },
      WSClient,
    }));

    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const created = await registry.createInstance('user-1', {
      platform: 'feishu_lark',
      displayName: 'Real bot',
      policy: { allowUserIds: ['ou_sender_1'], allowGroupIds: [] },
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
    });
    // Enabling the bot starts the real adapter and opens the binding window.
    await manager.setEnabled('user-1', created.id, true);

    const receive = handlers['im.message.receive_v1'];
    expect(receive).toBeTypeOf('function');
    await receive({
      message: {
        message_id: 'om_in_1',
        chat_id: 'oc_dm_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '你好，绑定我' }),
        create_time: '1710000000000',
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_sender_1' } },
    });

    await vi.waitFor(async () => {
      const instance = await registry.getInstance('user-1', created.id);
      expect(instance?.ownerExternalUserId).toBe('ou_sender_1');
    });
    const bound = await registry.getInstance('user-1', created.id);
    expect(bound).toMatchObject({
      ownerExternalUserId: 'ou_sender_1',
      ownerIdentitySource: 'auto',
    });
    // The raw event carries no user display name, so no label is persisted.
    expect(bound).not.toHaveProperty('ownerExternalUserName');
    await manager.stopForUser('user-1');
  });
});
