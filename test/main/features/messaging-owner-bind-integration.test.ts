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

describe('wechat_personal end-to-end', () => {
  it('routes an owner inbound message through to a bound conversation reply with tokenRef', async () => {
    const { WechatPersonalAdapter } = await import('../../../src/main/features/messaging/wechat-personal');
    const stateStore = await import('../../../src/main/features/messaging/wechat-state-store');
    const manager = await import('../../../src/main/features/messaging/manager');
    const registry = await import('../../../src/main/features/messaging/registry');
    // 注册态实例（owner 已绑定）并启用
    const instance = await registry.createWechatInstance('uid-1', {
      displayName: '我的微信',
      ilinkBotToken: 't'.repeat(64),
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-1',
      ownerExternalUserId: 'owner-1',
    });
    await registry.updateInstance('uid-1', instance.id, { enabled: true });
    // 直接走 manager 的 ingestInbound（adapter 之外的管线）
    const result = await manager.ingestInbound('uid-1', {
      platform: 'wechat_personal',
      instanceId: instance.id,
      externalMessageId: 'm-1',
      externalChatId: 'owner-1',
      externalUserId: 'owner-1',
      text: '你好',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
      contextTokenRef: 'ref-1',
    });
    expect(result.accepted).toBe(true);
    // 非 owner 被拒绝
    const denied = await manager.ingestInbound('uid-1', {
      platform: 'wechat_personal',
      instanceId: instance.id,
      externalMessageId: 'm-2',
      externalChatId: 'stranger-1',
      externalUserId: 'stranger-1',
      text: 'hack',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    });
    expect(denied.accepted).toBe(false);
  });

  it('requires uid to build a wechat adapter and constructs with it', async () => {
    const { createAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'inst-w',
      platform: 'wechat_personal' as const,
      displayName: '我的微信',
      enabled: true,
      responseMode: 'text' as const,
      workspace: { type: 'default' as const },
      policy: { replyMode: 'every_message' as const, allowUserIds: ['owner-1'], allowGroupIds: [], requireMentionInGroups: false },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const secret = {
      ilinkBotToken: 't'.repeat(64),
      ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-1',
    };
    expect(() => createAdapter(instance, secret)).toThrow('wechat adapter requires uid');
    const adapter = createAdapter(instance, secret, 'uid-1');
    expect(adapter.platform).toBe('wechat_personal');
  });

  it('carries the inbound contextTokenRef into the ledger entry and the send context', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true }));
    const sendMessage = vi.fn(async () => ({ deliveryId: 'remote-reply-1' }));
    const adapter: import('../../../src/main/features/messaging/types').MessagingAdapter = {
      platform: 'wechat_personal',
      async start(signal, callbacks) {
        await callbacks.onStatus({ kind: 'connected', checkedAt: new Date().toISOString() });
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async stop() {},
      async checkHealth() {
        return { kind: 'connected', checkedAt: new Date().toISOString() };
      },
      sendMessage,
    };
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe }));

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const ledger = await import('../../../src/main/features/messaging/ledger');
      const created = await registry.createWechatInstance('uid-1', {
        displayName: '我的微信',
        ilinkBotToken: 't'.repeat(64),
        ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
        ilinkBotId: 'bot-1',
        ownerExternalUserId: 'owner-1',
      });
      await manager.setEnabled('uid-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('uid-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });

      const envelope = {
        platform: 'wechat_personal' as const,
        instanceId: created.id,
        externalMessageId: 'in-1',
        externalChatId: 'owner-1',
        externalUserId: 'owner-1',
        text: '你好',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
        contextTokenRef: 'ref-1',
      };
      const inbound = await manager.ingestInbound('uid-1', envelope);
      expect(inbound.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));

      busListener?.({
        type: 'message',
        turn_end: true,
        msg: { id: 'reply-1', from: 'commander', text: '回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      // The ledger entry carries the inbound token reference so a restart
      // recovery can re-send with the same context token.
      expect(await ledger.getDelivery('uid-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        status: 'sent',
        contextTokenRef: 'ref-1',
      });
      expect(sendMessage.mock.calls[0][3]).toMatchObject({ contextTokenRef: 'ref-1' });

      // A follow-up inbound without a token reference clears it: the next
      // reply must not reuse a stale token.
      const second = await manager.ingestInbound('uid-1', {
        ...envelope,
        externalMessageId: 'in-2',
        contextTokenRef: undefined,
      });
      expect(second.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(2));
      busListener?.({
        type: 'message',
        turn_end: true,
        msg: { id: 'reply-2', from: 'commander', text: '第二回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      expect(sendMessage.mock.calls[1][3]).not.toHaveProperty('contextTokenRef');
      expect(await ledger.getDelivery('uid-1', ledger.deliveryKey(created.id, 'reply-2'))).not.toHaveProperty('contextTokenRef');

      await manager.stopForUser('uid-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});
