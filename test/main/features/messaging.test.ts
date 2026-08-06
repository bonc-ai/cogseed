import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeliveryLedgerEntry, MessagingAdapter, MessagingCardAdapter } from '../../../src/main/features/messaging/types';

let tmpDir = '';
let previousRoot: string | undefined;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) throw new Error('deferred promise initialization failed');
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-messaging-'));
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

describe('messaging policy', () => {
  it('enforces user, group, mention and command policy in order', async () => {
    const { evaluateInboundPolicy } = await import('../../../src/main/features/messaging/policy');
    const instance = {
      id: 'bot-1',
      platform: 'telegram' as const,
      displayName: 'Bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: {
        replyMode: 'every_message' as const,
        allowUserIds: ['u-1'],
        allowGroupIds: ['g-1'],
        requireMentionInGroups: true,
      },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const base = {
      platform: 'telegram' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-1',
      externalChatId: 'g-1',
      externalUserId: 'u-1',
      text: '@bot hello',
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    };
    expect(evaluateInboundPolicy(instance, { ...base, externalUserId: 'u-2' })).toEqual({ allowed: false, reason: 'user_not_allowed' });
    expect(evaluateInboundPolicy(instance, { ...base, externalChatId: 'g-2' })).toEqual({ allowed: false, reason: 'group_not_allowed' });
    expect(evaluateInboundPolicy(instance, { ...base, mentionPresent: false })).toEqual({ allowed: false, reason: 'mention_required' });
    expect(evaluateInboundPolicy(instance, base)).toEqual({ allowed: true });
  });

  it('denies empty allowlists and requires explicit user and group matches', async () => {
    const { evaluateInboundPolicy } = await import('../../../src/main/features/messaging/policy');
    const instance = {
      id: 'bot-1',
      platform: 'telegram' as const,
      displayName: 'Bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: {
        replyMode: 'every_message' as const,
        allowUserIds: [],
        allowGroupIds: [],
        requireMentionInGroups: false,
      },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const direct = {
      platform: 'telegram' as const,
      instanceId: 'bot-1',
      externalMessageId: 'm-private',
      externalChatId: 'u-1',
      externalUserId: 'u-1',
      text: 'hello',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
    };
    const group = {
      ...direct,
      externalMessageId: 'm-group',
      externalChatId: 'g-1',
      isGroup: true,
    };

    expect(evaluateInboundPolicy(instance, direct)).toEqual({ allowed: false, reason: 'user_not_allowed' });
    expect(evaluateInboundPolicy(instance, group)).toEqual({ allowed: false, reason: 'user_not_allowed' });
    const userAllowed = {
      ...instance,
      policy: { ...instance.policy, allowUserIds: ['u-1'] },
    };
    expect(evaluateInboundPolicy(userAllowed, direct)).toEqual({ allowed: true });
    expect(evaluateInboundPolicy(userAllowed, group)).toEqual({ allowed: false, reason: 'group_not_allowed' });
    expect(evaluateInboundPolicy({
      ...userAllowed,
      policy: { ...userAllowed.policy, allowGroupIds: ['g-1'] },
    }, group)).toEqual({ allowed: true });
  });

  it('removes only exact verified bot mention tokens', async () => {
    const { stripBotMention } = await import('../../../src/main/features/messaging/policy');
    expect(stripBotMention('@mate-bot hello @alice', ['@mate-bot'])).toBe('hello @alice');
    expect(stripBotMention('@mate-bothello @alice', ['@mate-bot'])).toBe('@mate-bothello @alice');
    expect(stripBotMention('@mate.bot+ hello @alice', ['@mate.bot+'])).toBe('hello @alice');
    expect(stripBotMention('@mate-bot hello @alice')).toBe('@mate-bot hello @alice');
  });
});

describe('messaging registry and ledgers', () => {
  it('normalizes omitted allowlists to explicit deny-all arrays', async () => {
    const { _registryTestHooks } = await import('../../../src/main/features/messaging/registry');
    expect(_registryTestHooks.normalizePolicy()).toMatchObject({
      allowUserIds: [],
      allowGroupIds: [],
    });
  });

  it('encrypts credentials and never returns them in the client DTO', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const created = await registry.createInstance('user-1', {
      platform: 'telegram',
      displayName: 'Telegram bot',
      secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
    });
    expect(created.hasCredentials).toBe(true);
    expect(JSON.stringify(created)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const configPath = path.join(tmpDir, 'user-1', 'local', 'config', 'messaging.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const listed = await registry.listInstances('user-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secretsEnc');

    const unbound = await registry.updateInstance('user-1', created.id, { enabled: false, clearSecret: true });
    expect(unbound.hasCredentials).toBe(false);
    const afterUnbind = await registry.listInstances('user-1');
    expect(afterUnbind[0]).toMatchObject({ enabled: false, hasCredentials: false });
    const manager = await import('../../../src/main/features/messaging/manager');
    await expect(manager.setEnabled('user-1', created.id, true)).rejects.toThrow('credentials required');
    expect((await registry.getInstance('user-1', created.id))?.enabled).toBe(false);
  });

  it('deduplicates inbound and delivery records without re-sending sent output', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const first = await ledger.reserveInbound('user-1', ledger.inboundKey('bot-1', 'message-1'));
    expect(first.duplicate).toBe(false);
    const second = await ledger.reserveInbound('user-1', ledger.inboundKey('bot-1', 'message-1'));
    expect(second.duplicate).toBe(true);
    await ledger.completeInbound('user-1', first.entry.key, { status: 'accepted', cid: 'cid-1' });
    const third = await ledger.reserveInbound('user-1', ledger.inboundKey('bot-1', 'message-1'));
    expect(third.duplicate).toBe(true);
    const delivery = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'reply-1'),
      instanceId: 'bot-1',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-1',
      textHash: ledger.textHash('hello'),
      text: 'hello',
    });
    expect(delivery.duplicate).toBe(false);
    const pendingDuplicate = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'reply-1'),
      instanceId: 'bot-1',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-1',
      textHash: ledger.textHash('hello'),
      text: 'hello',
    });
    expect(pendingDuplicate.duplicate).toBe(true);
    await ledger.finishDelivery('user-1', delivery.entry.key, { status: 'sent', externalDeliveryId: 'remote-1' });
    const repeated = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'reply-1'),
      instanceId: 'bot-1',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-1',
      textHash: ledger.textHash('hello'),
      text: 'hello',
    });
    expect(repeated.duplicate).toBe(true);

    const cancelled = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'reply-cancelled'),
      instanceId: 'bot-1',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-cancelled',
      textHash: ledger.textHash('do not resume'),
      text: 'do not resume',
    });
    await ledger.finishDelivery('user-1', cancelled.entry.key, { status: 'cancelled' });
    const cancelledRepeat = await ledger.beginDelivery('user-1', {
      key: cancelled.entry.key,
      instanceId: 'bot-1',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-cancelled',
      textHash: ledger.textHash('do not resume'),
      text: 'do not resume',
    });
    expect(cancelledRepeat.duplicate).toBe(true);
  });

  it('removes local ledgers idempotently when a robot is deleted', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const created = await registry.createInstance('user-1', {
      platform: 'telegram',
      displayName: 'Delete me',
      secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
    });
    const inbound = await ledger.reserveInbound('user-1', ledger.inboundKey(created.id, 'incoming-1'));
    await ledger.completeInbound('user-1', inbound.entry.key, { status: 'accepted', cid: 'cid-1' });
    const delivery = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey(created.id, 'reply-1'),
      instanceId: created.id,
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-1',
      textHash: ledger.textHash('response'),
      text: 'response',
    });
    await ledger.finishDelivery('user-1', delivery.entry.key, { status: 'sent', externalDeliveryId: 'remote-1' });

    await expect(manager.deleteInstance('user-1', created.id)).resolves.toBe(true);
    expect(await ledger.readInbound('user-1', inbound.entry.key)).toBeNull();
    expect(await ledger.getDelivery('user-1', delivery.entry.key)).toBeNull();
    await expect(manager.deleteInstance('user-1', created.id)).resolves.toBe(true);
  });
});

describe('messaging IPC validation', () => {
  it('rejects malformed credentials before feature calls', async () => {
    vi.doMock('../../../src/main/features/messaging/registry', () => ({
      isValidInstanceId: vi.fn(() => true),
      getInstance: vi.fn(),
    }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      PLATFORM_CATALOG: [],
      listInstances: vi.fn(),
      createInstance: vi.fn(),
      updateInstance: vi.fn(),
      setEnabled: vi.fn(),
      unbindInstance: vi.fn(),
      health: vi.fn(),
      deleteInstance: vi.fn(),
    }));
    try {
      const { invokeHandlers } = await import('../../../src/main/ipc/messaging');
      await expect(invokeHandlers['messaging.create']({
        platform: 'telegram',
        displayName: 'bad',
        secret: { botToken: 'not-a-token' },
      }, { userId: 'user-1' })).rejects.toThrow('invalid Telegram bot token');
      await expect(invokeHandlers['messaging.create']({
        platform: 'feishu_lark',
        displayName: 'bad',
        secret: { appId: 'cli_not-a-valid-id', appSecret: 'secret' },
      }, { userId: 'user-1' })).rejects.toThrow('invalid Feishu app id');
      await expect(invokeHandlers['messaging.set_enabled']({ instanceId: 'bot-1', enabled: 'false' }, { userId: 'user-1' }))
        .rejects.toThrow('invalid enabled');
      expect(invokeHandlers).not.toHaveProperty('messaging.ingest');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/registry');
      vi.doUnmock('../../../src/main/features/messaging/manager');
      vi.resetModules();
    }
  });

  it('creates Feishu drafts and accepts the all-workspace scope', async () => {
    const createFeishuDraft = vi.fn(async () => ({ id: 'draft-1' }));
    const updateInstance = vi.fn(async () => ({ id: 'bot-1' }));
    vi.doMock('../../../src/main/features/messaging/registry', () => ({
      isValidInstanceId: vi.fn(() => true),
      getInstance: vi.fn(async () => ({ id: 'bot-1', platform: 'feishu_lark' })),
      createFeishuDraft,
    }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      PLATFORM_CATALOG: [],
      listInstances: vi.fn(),
      createInstance: vi.fn(),
      updateInstance,
      setEnabled: vi.fn(),
      unbindInstance: vi.fn(),
      health: vi.fn(),
      deleteInstance: vi.fn(),
    }));
    try {
      const { invokeHandlers } = await import('../../../src/main/ipc/messaging');
      await invokeHandlers['messaging.feishu_draft.create']({
        feishuTenantBrand: 'feishu',
        displayName: '飞书',
      }, { userId: 'user-1' });
      expect(createFeishuDraft).toHaveBeenCalledWith('user-1', expect.objectContaining({
        feishuTenantBrand: 'feishu',
        displayName: '飞书',
      }));

      await invokeHandlers['messaging.update']({
        instanceId: 'bot-1',
        workspace: { type: 'all' },
      }, { userId: 'user-1' });
      expect(updateInstance).toHaveBeenCalledWith('user-1', 'bot-1', { workspace: { type: 'all' } });

      await expect(invokeHandlers['messaging.update']({
        instanceId: 'bot-1',
        workspace: { type: 'global' },
      }, { userId: 'user-1' })).rejects.toThrow('invalid workspace type');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/registry');
      vi.doUnmock('../../../src/main/features/messaging/manager');
      vi.resetModules();
    }
  });
});

describe('messaging adapter cancellation', () => {
  it('forwards the runtime abort signal to in-flight requests', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const request = _adapterTestHooks.fetchJson('https://example.test/poll', {}, 60_000, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(request).rejects.toThrow('request aborted');
  });

  it('forwards the runtime abort signal to an outbound Telegram delivery', async () => {
    const { TelegramAdapter } = await import('../../../src/main/features/messaging/adapters');
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('outbound request aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new TelegramAdapter({
      id: 'telegram-cancel-test',
      platform: 'telegram',
      displayName: 'Telegram cancel test',
      enabled: true,
      workspace: { type: 'default' },
      policy: {
        replyMode: 'every_message',
        allowUserIds: [],
        allowGroupIds: [],
        requireMentionInGroups: true,
      },
      status: { kind: 'connected', checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    });
    const controller = new AbortController();
    const sending = adapter.sendMessage('chat-1', 'pending reply', controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(sending).rejects.toThrow('outbound request aborted');
  });
});

describe('messaging manager adapter flow', () => {
  it('routes inbound text into group chat and retries failed outbound delivery once', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    let resolveGroupSend: ((result: { ok: true }) => void) | undefined;
    const groupSend = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      resolveGroupSend = resolve;
    }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary delivery failure'))
      .mockResolvedValue({ deliveryId: 'remote-reply-1' });
    const adapter: MessagingAdapter = {
      platform: 'telegram',
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
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe }));

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const ledger = await import('../../../src/main/features/messaging/ledger');
      const created = await registry.createInstance('user-1', {
        platform: 'telegram',
        displayName: 'Test Telegram',
        policy: { allowUserIds: ['user-1'] },
        secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
      });

      await manager.setEnabled('user-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('user-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });
      const envelope = {
        platform: 'telegram' as const,
        instanceId: created.id,
        externalMessageId: 'incoming-1',
        externalChatId: 'chat-1',
        externalUserId: 'user-1',
        text: 'hello agent',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      };
      const inboundPromise = manager.ingestInbound('user-1', envelope);
      await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
      const duplicate = await manager.ingestInbound('user-1', envelope);
      expect(duplicate).toMatchObject({ accepted: false, duplicate: true });
      expect(resolveGroupSend).toBeTypeOf('function');
      resolveGroupSend?.({ ok: true });
      const inbound = await inboundPromise;

      expect(inbound.accepted).toBe(true);
      expect(inbound.cid).toBeTruthy();
      expect(groupSend).toHaveBeenCalledWith({ userId: 'user-1', cid: inbound.cid, text: 'hello agent' });
      expect(busListener).toBeTypeOf('function');

      const outboundEvent = {
        type: 'message',
        turn_end: true,
        msg: { id: 'reply-1', from: 'commander', text: 'reply from agent' },
      };
      busListener?.(outboundEvent);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      // The first attempt failed, so the ledger schedules a bounded automatic
      // retry instead of waiting for another bus broadcast.
      expect(await ledger.getDelivery('user-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        status: 'retry_pending',
        attempts: 1,
      });

      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 3000 });
      expect(await ledger.getDelivery('user-1', ledger.deliveryKey(created.id, 'reply-1'))).toMatchObject({
        status: 'sent',
        attempts: 2,
        externalDeliveryId: 'remote-reply-1',
      });

      busListener?.(outboundEvent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      await manager.stopForUser('user-1');
      expect((await manager.listInstances('user-1'))[0]?.status.kind).toBe('disconnected');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });

  it('cancels a queued outbound reply before unbind can remove its credentials', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const reservation = deferred<{ duplicate: boolean; entry: DeliveryLedgerEntry }>();
    const beginDelivery = vi.fn(() => reservation.promise);
    const finishDelivery = vi.fn(async (_uid: string, key: string, patch: Pick<DeliveryLedgerEntry, 'status'>) => ({
      key,
      instanceId: 'placeholder',
      externalChatId: 'chat-1',
      sourceMessageId: 'reply-after-unbind',
      textHash: 'hash',
      status: patch.status,
      attempts: 1,
      updatedAt: new Date().toISOString(),
    }));
    const sendMessage = vi.fn(async () => ({ deliveryId: 'unexpected' }));
    const stop = vi.fn(async () => {});
    const adapter: MessagingAdapter = {
      platform: 'telegram',
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
      stop,
      async checkHealth() {
        return { kind: 'connected', checkedAt: new Date().toISOString() };
      },
      sendMessage,
    };

    vi.doMock('../../../src/main/features/messaging/ledger', async () => {
      const actual = await vi.importActual<typeof import('../../../src/main/features/messaging/ledger')>(
        '../../../src/main/features/messaging/ledger',
      );
      return { ...actual, beginDelivery, finishDelivery };
    });
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe }));

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const created = await registry.createInstance('user-1', {
        platform: 'telegram',
        displayName: 'Stop before send',
        policy: { allowUserIds: ['user-1'] },
        secret: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' },
      });
      await manager.setEnabled('user-1', created.id, true);
      await manager.ingestInbound('user-1', {
        platform: 'telegram',
        instanceId: created.id,
        externalMessageId: 'incoming-before-unbind',
        externalChatId: 'chat-1',
        externalUserId: 'user-1',
        text: 'hello agent',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(busListener).toBeTypeOf('function');

      busListener?.({
        type: 'message',
        turn_end: true,
        msg: { id: 'reply-after-unbind', from: 'commander', text: 'must not be sent' },
      });
      await vi.waitFor(() => expect(beginDelivery).toHaveBeenCalledTimes(1));

      const unbind = manager.unbindInstance('user-1', created.id);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      reservation.resolve({
        duplicate: false,
        entry: {
          key: `delivery:${created.id}:reply-after-unbind`,
          instanceId: created.id,
          externalChatId: 'chat-1',
          sourceMessageId: 'reply-after-unbind',
          textHash: 'hash',
          status: 'pending',
          attempts: 1,
          updatedAt: new Date().toISOString(),
        },
      });

      await unbind;
      expect(sendMessage).not.toHaveBeenCalled();
      expect(finishDelivery).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        expect.objectContaining({ status: 'cancelled' }),
      );
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/ledger');
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });

  it('streams a Feishu reply as an interactive card and finalizes it at turn end', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const sendMessage = vi.fn(async () => ({}));
    const sendCard = vi.fn(async () => ({ deliveryId: 'om_card_1' }));
    const updateCard = vi.fn(async () => ({}));
    const adapter: MessagingCardAdapter = {
      platform: 'feishu_lark',
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
      sendCard,
      updateCard,
    };

    vi.doMock('../../../src/main/features/messaging/adapters', () => ({
      createAdapter: vi.fn(() => adapter),
    }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe }));

    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const created = await registry.createInstance('user-1', {
        platform: 'feishu_lark',
        displayName: 'Feishu bot',
        responseMode: 'streaming_card',
        policy: { allowUserIds: ['user-1'] },
        secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
      });
      await manager.setEnabled('user-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('user-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });
      const inbound = await manager.ingestInbound('user-1', {
        platform: 'feishu_lark',
        instanceId: created.id,
        externalMessageId: 'incoming-1',
        externalChatId: 'chat-1',
        externalUserId: 'user-1',
        text: 'hello agent',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(inbound.accepted).toBe(true);
      expect(busListener).toBeTypeOf('function');

      busListener?.({
        type: 'process',
        cid: inbound.cid,
        actor: 'agent',
        turn_id: 'turn-1',
        data: { type: 'delta', text: 'The answer ' },
      });
      busListener?.({
        type: 'process',
        cid: inbound.cid,
        actor: 'agent',
        turn_id: 'turn-1',
        data: { type: 'delta', text: 'is here.' },
      });
      await vi.waitFor(() => expect(sendCard).toHaveBeenCalledTimes(1));
      expect(sendCard.mock.calls[0]?.[0]).toBe('chat-1');
      expect(sendCard.mock.calls[0]?.[1]).toMatchObject({
        header: { title: { tag: 'plain_text', content: 'Feishu bot' } },
      });
      expect(sendCard.mock.calls[0]?.[1]?.elements?.[0]?.content).toBe('The answer is here.');

      busListener?.({
        type: 'message',
        cid: inbound.cid,
        turn_end: true,
        turn_id: 'turn-1',
        msg: { id: 'reply-1', from: 'agent', text: 'The final answer.' },
      });
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      expect(updateCard.mock.calls[0]?.[0]).toBe('om_card_1');
      expect(updateCard.mock.calls[0]?.[1]?.elements?.[0]?.content).toBe('The final answer.');
      expect(sendMessage).not.toHaveBeenCalled();
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});
