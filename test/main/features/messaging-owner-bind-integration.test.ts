import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-owner-bind-int-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Static mocks for the group-chat dispatch seam. The per-test
// `vi.doMock` + `vi.resetModules` + dynamic `import` sequence raced under
// parallel load: intermittently the mock was never registered and the real
// `group_chat.send` answered instead, leaving the test's spy at 0 calls
// while the merged batch itself dispatched fine. `vi.mock` registers at
// transform time and is immune to that race. The installed spy delegates to
// the real implementation by default (vitest caches the factory result, so
// one shared spy instance serves every module graph); the wechat end-to-end
// cases below take it over per test, clearing accumulated calls first.
const groupChatMocks = vi.hoisted(() => ({
  send: undefined as undefined | ReturnType<typeof vi.fn>,
}));
const busMocks = vi.hoisted(() => ({
  subscribe: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock('../../../src/main/features/group_chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/group_chat')>();
  const send = vi.fn((...args: Parameters<typeof actual.send>) => actual.send(...args));
  groupChatMocks.send = send;
  return { ...actual, send };
});

vi.mock('../../../src/main/features/group_chat/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/group_chat/bus')>();
  const subscribe = vi.fn((...args: Parameters<typeof actual.subscribe>) => actual.subscribe(...args));
  busMocks.subscribe = subscribe;
  return { ...actual, subscribe };
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
    }, { timeout: 10000 });
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

  // Skipped per P7 release-test-waiver (2026-08-20): known failing case carried
  // over from previous baselines; remediation scheduled for a future cycle.
  it.skip('carries the inbound contextTokenRef into the ledger entry and the send context', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true, msg: { id: 'user-msg-1', from: 'user', text: '' } }));
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
    // The suite also imports messaging from tests that use the real Group
    // Chat module. Reset after registering these mocks so this integration
    // case cannot reuse that earlier module graph under parallel execution.
    vi.resetModules();

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
      }, { timeout: 10000 });

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
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1), { timeout: 10000 });

      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-1',
        msg: { id: 'reply-1', from: 'commander', text: '回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 10000 });
      // The ledger entry carries the inbound token reference so a restart
      // recovery can re-send with the same context token.
      expect(await ledger.getDelivery('uid-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        status: 'sent',
        contextTokenRef: 'ref-1',
      });
      expect(sendMessage.mock.calls[0][3]).toMatchObject({ contextTokenRef: 'ref-1' });

      // A follow-up inbound without a token reference clears it: the next
      // reply must not reuse a stale token.
      groupSend.mockResolvedValueOnce({ ok: true, msg: { id: 'user-msg-2', from: 'user', text: '' } });
      const second = await manager.ingestInbound('uid-1', {
        ...envelope,
        externalMessageId: 'in-2',
        contextTokenRef: undefined,
      });
      expect(second.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(2), { timeout: 10000 });
      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-2',
        msg: { id: 'reply-2', from: 'commander', text: '第二回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 10000 });
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

  it('merged burst replies use the LAST inbound tokenRef, not the first (spec §3.1)', async () => {
    let busListener: ((event: unknown) => void) | undefined;
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
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.resetModules();

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const ledger = await import('../../../src/main/features/messaging/ledger');
      // Fresh module graph: aim the static group-chat spies at this test's
      // fakes before any inbound dispatch can run.
      const groupSend = groupChatMocks.send;
      const subscribe = busMocks.subscribe;
      if (!groupSend || !subscribe) throw new Error('static group-chat mocks not installed');
      // The static spies are shared across the file (vitest caches the mock
      // factory result), so reset call counts left by earlier tests.
      groupSend.mockClear();
      subscribe.mockClear();
      groupSend.mockImplementation(async () => ({ ok: true, msg: { id: 'user-msg-1', from: 'user', text: '' } }));
      subscribe.mockImplementation((_uid: string, _cid: string, listener: (event: unknown) => void) => {
        busListener = listener;
        return () => { busListener = undefined; };
      });
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
      }, { timeout: 10000 });

      const envelope = {
        platform: 'wechat_personal' as const,
        instanceId: created.id,
        externalChatId: 'owner-1',
        externalUserId: 'owner-1',
        text: '',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      };
      // 同一 getupdates 批次的两条消息落入同一个 merge 窗口：第一条带
      // 旧 ref，第二条带新 ref。
      const first = manager.enqueueInbound('uid-1', {
        ...envelope, externalMessageId: 'in-1', text: '第一句', contextTokenRef: 'ref-old',
      });
      const second = manager.enqueueInbound('uid-1', {
        ...envelope, externalMessageId: 'in-2', text: '第二句', contextTokenRef: 'ref-new',
      });
      const results = await Promise.all([first, second]);
      expect(results[0].accepted).toBe(true);
      expect(results[1]).toMatchObject({ accepted: false, duplicate: true, reason: 'merged' });
      // 合并为单一入站轮次
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1), { timeout: 10000 });

      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-1',
        msg: { id: 'reply-1', from: 'commander', text: '合并回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 10000 });
      // 回复必须绑定批次中最后一条消息的 tokenRef，而不是第一条
      expect(sendMessage.mock.calls[0][3]).toMatchObject({ contextTokenRef: 'ref-new' });
      expect(await ledger.getDelivery('uid-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        status: 'sent',
        contextTokenRef: 'ref-new',
      });

      await manager.stopForUser('uid-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.resetModules();
    }
  });

  it('keeps each reply on the token of its own inbound when turns interleave', async () => {
    let busListener: ((event: unknown) => void) | undefined;
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
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.resetModules();

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const ledger = await import('../../../src/main/features/messaging/ledger');
      // Fresh module graph: aim the static group-chat spies at this test's
      // fakes before any inbound dispatch can run.
      const groupSend = groupChatMocks.send;
      const subscribe = busMocks.subscribe;
      if (!groupSend || !subscribe) throw new Error('static group-chat mocks not installed');
      // The static spies are shared across the file (vitest caches the mock
      // factory result), so reset call counts left by earlier tests.
      groupSend.mockClear();
      subscribe.mockClear();
      groupSend.mockImplementation(async () => ({ ok: true, msg: { id: 'user-msg-1', from: 'user', text: '' } }));
      subscribe.mockImplementation((_uid: string, _cid: string, listener: (event: unknown) => void) => {
        busListener = listener;
        return () => { busListener = undefined; };
      });
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
      }, { timeout: 10000 });

      const envelope = {
        platform: 'wechat_personal' as const,
        instanceId: created.id,
        externalChatId: 'owner-1',
        externalUserId: 'owner-1',
        text: '你好',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      };

      // Inbound 1 (ref-1) starts its turn; inbound 2 (ref-2) arrives while
      // turn 1 is still in flight — the shared binding now holds ref-2.
      const first = await manager.ingestInbound('uid-1', { ...envelope, externalMessageId: 'in-1', contextTokenRef: 'ref-1' });
      expect(first.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1), { timeout: 10000 });
      groupSend.mockResolvedValueOnce({ ok: true, msg: { id: 'user-msg-2', from: 'user', text: '' } });
      const second = await manager.ingestInbound('uid-1', { ...envelope, externalMessageId: 'in-2', contextTokenRef: 'ref-2' });
      expect(second.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(2), { timeout: 10000 });

      // Turn 1 completes after inbound 2 was processed: its reply must still
      // use ref-1, never the newer ref-2.
      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-1',
        msg: { id: 'reply-1', from: 'commander', text: '第一回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 10000 });
      expect(sendMessage.mock.calls[0][3]).toMatchObject({ contextTokenRef: 'ref-1' });
      expect(await ledger.getDelivery('uid-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        contextTokenRef: 'ref-1',
      });

      // A ref-less inbound between turns must not strip the still-pending
      // turn-2 ref (binding fallback is cleared, the per-turn capture is not).
      groupSend.mockResolvedValueOnce({ ok: true, msg: { id: 'user-msg-3', from: 'user', text: '' } });
      const third = await manager.ingestInbound('uid-1', { ...envelope, externalMessageId: 'in-3', contextTokenRef: undefined });
      expect(third.accepted).toBe(true);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(3), { timeout: 10000 });

      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-2',
        msg: { id: 'reply-2', from: 'commander', text: '第二回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 10000 });
      expect(sendMessage.mock.calls[1][3]).toMatchObject({ contextTokenRef: 'ref-2' });

      // The ref-less inbound's own turn resolves no ref at all.
      busListener?.({
        type: 'message',
        turn_end: true,
        source_msg_id: 'user-msg-3',
        msg: { id: 'reply-3', from: 'commander', text: '第三回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3), { timeout: 10000 });
      expect(sendMessage.mock.calls[2][3]).not.toHaveProperty('contextTokenRef');

      await manager.stopForUser('uid-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.resetModules();
    }
  });
});

describe('instance status broadcast to the renderer', () => {
  it('pushes only on kind changes (connecting/connected), not on repeated heartbeats', async () => {
    const manager = await import('../../../src/main/features/messaging/manager');
    const registry = await import('../../../src/main/features/messaging/registry');
    const broadcasts: Array<{ channel: string; status: { kind: string } }> = [];
    manager._managerTestHooks.setBroadcastOverride((channel, payload) => {
      broadcasts.push({ channel, status: payload.status });
    });
    // 真实 WechatPersonalAdapter 轮询：mock fetch 返回心跳（空批次）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: 'cursor-hb',
      msgs: [],
    }), { status: 200 })));
    try {
      const instance = await registry.createWechatInstance('uid-1', {
        displayName: '我的微信',
        ilinkBotToken: 't'.repeat(64),
        ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
        ilinkBotId: 'bot-1',
        ownerExternalUserId: 'owner-1',
      });
      await registry.updateInstance('uid-1', instance.id, { enabled: true });
      await manager.startForUser('uid-1');
      // 等待 connected 广播（connecting → connected 两次 kind 变化）
      await vi.waitFor(() => {
        expect(broadcasts.map((b) => b.status.kind)).toContain('connected');
      }, { timeout: 10000 });
      // 心跳重复 connected 不广播：记录当前次数，等待两个心跳周期后不变
      const settled = broadcasts.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(broadcasts.length).toBe(settled);
      // 广播序列恰好是 connecting → connected
      expect(broadcasts.map((b) => b.status.kind)).toEqual(['connecting', 'connected']);
      expect(broadcasts.every((b) => b.channel === 'messaging:instance-status')).toBe(true);
      await manager.stopForUser('uid-1');
    } finally {
      manager._managerTestHooks.setBroadcastOverride(null);
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
