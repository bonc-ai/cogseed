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

  it('stores Feishu owner identity privately and supports manual replacement and clearing', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const created = await registry.createInstance('user-1', {
      platform: 'feishu_lark',
      displayName: 'Feishu bot',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
      ownerExternalUserId: 'ou_owner_1',
      ownerExternalUserName: 'Owner One',
      ownerIdentitySource: 'manual',
    });
    expect(created).toMatchObject({
      ownerConfigured: true,
      ownerLabel: 'Owner One',
      ownerIdentitySource: 'manual',
    });
    expect(created).not.toHaveProperty('ownerExternalUserId');
    expect(JSON.stringify(created)).not.toContain('ou_owner_1');
    expect(await registry.getInstance('user-1', created.id)).toMatchObject({
      ownerExternalUserId: 'ou_owner_1',
      ownerExternalUserName: 'Owner One',
      ownerIdentitySource: 'manual',
    });

    const updated = await registry.updateInstance('user-1', created.id, {
      ownerExternalUserId: 'ou_owner_2',
      ownerExternalUserName: 'Owner Two',
      ownerIdentitySource: 'manual',
    });
    expect(updated).toMatchObject({ ownerConfigured: true, ownerLabel: 'Owner Two' });
    expect(JSON.stringify(updated)).not.toContain('ou_owner_2');

    const cleared = await registry.updateInstance('user-1', created.id, { clearOwner: true });
    expect(cleared).toMatchObject({ ownerConfigured: false });
    expect(cleared).not.toHaveProperty('ownerLabel');
    expect(await registry.getInstance('user-1', created.id)).not.toHaveProperty('ownerExternalUserId');
  });

  it('does not infer legacy owners from allowlists and removes QR owner during draft compensation', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const draft = await registry.createFeishuDraft('user-1', {
      feishuTenantBrand: 'feishu',
      displayName: 'Feishu draft',
      policy: { allowUserIds: ['ou_legacy_allowed'] },
    });
    expect(draft).toMatchObject({ ownerConfigured: false });

    const bound = await registry.bindFeishuDraft('user-1', draft.id, {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
      initialAllowUserId: 'ou_scanner',
      ownerExternalUserId: 'ou_scanner',
      ownerExternalUserName: 'Scanner',
    });
    expect(bound).toMatchObject({ ownerConfigured: true, ownerLabel: 'Scanner', ownerIdentitySource: 'qr' });
    // The scanner id legitimately appears in policy.allowUserIds (the client
    // DTO exposes that authorization list), so assert only that no dedicated
    // owner field leaks into the renderer-facing object.
    expect(bound).not.toHaveProperty('ownerExternalUserId');
    expect(JSON.stringify(bound)).not.toContain('ownerExternalUserId');

    await registry.revokeFeishuDraftCredentials('user-1', draft.id, {
      appId: 'cli_1234567890abcdef',
      appSecret: 'secret-value',
    });
    expect(await registry.listInstances('user-1')).toEqual([
      expect.objectContaining({ id: draft.id, hasCredentials: false, ownerConfigured: false }),
    ]);
    expect(await registry.getInstance('user-1', draft.id)).not.toHaveProperty('ownerExternalUserId');
  });

  it('migrates legacy delivery recipients to chat_id and persists open_id recipients for proactive sends', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const { userMessagingDeliveryLedgerFile } = await import('../../../src/main/paths');
    const file = userMessagingDeliveryLedgerFile('user-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      entries: {
        'bot-1:reply-1': {
          key: 'bot-1:reply-1',
          instanceId: 'bot-1',
          externalChatId: 'oc_legacy_chat',
          sourceMessageId: 'reply-1',
          textHash: 'hash',
          status: 'sent',
          attempts: 1,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    const migrated = await ledger.getDelivery('user-1', 'bot-1:reply-1');
    expect(migrated).toMatchObject({ recipientId: 'oc_legacy_chat', recipientIdType: 'chat_id' });

    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'proactive-1'),
      instanceId: 'bot-1',
      recipientId: 'ou_self_1',
      recipientIdType: 'open_id',
      sourceMessageId: 'proactive-1',
      textHash: ledger.textHash('hello'),
      text: 'hello',
    });
    expect(begun.duplicate).toBe(false);
    expect(begun.entry).toMatchObject({ recipientId: 'ou_self_1', recipientIdType: 'open_id' });
    expect(begun.entry.externalChatId).toBeUndefined();
    const read = await ledger.getDelivery('user-1', begun.entry.key);
    expect(read).toMatchObject({ recipientId: 'ou_self_1', recipientIdType: 'open_id' });
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

  it('waits for a terminal delivery state and resolves immediately when already terminal', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t1'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t1',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    await ledger.finishDelivery('user-1', begun.entry.key, { status: 'sent', externalDeliveryId: 'om_wait_1' });
    const waited = await ledger.waitForDeliveryTerminal('user-1', begun.entry.key);
    expect(waited).toMatchObject({ status: 'sent', externalDeliveryId: 'om_wait_1' });
  });

  it('wakes a registered waiter when the delivery finishes during the wait', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t2'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t2',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    const waiting = ledger.waitForDeliveryTerminal('user-1', begun.entry.key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ledger.finishDelivery('user-1', begun.entry.key, { status: 'sent' });
    await expect(waiting).resolves.toMatchObject({ status: 'sent' });
  });

  it('does not resolve while retry_pending and resolves failed when retries are exhausted', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t3'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t3',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    const waiting = ledger.waitForDeliveryTerminal('user-1', begun.entry.key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ledger.finishDelivery('user-1', begun.entry.key, {
      status: 'retry_pending',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    await ledger.finishDelivery('user-1', begun.entry.key, { status: 'failed', error: 'retries exhausted' });
    await expect(waiting).resolves.toMatchObject({ status: 'failed', error: 'retries exhausted' });
  });

  it('cancels a single delivery precisely, wakes its waiter, and blocks recovery', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t4'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t4',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    const waiting = ledger.waitForDeliveryTerminal('user-1', begun.entry.key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await ledger.cancelDelivery('user-1', begun.entry.key, 'proactive abort')).toBe(true);
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' });
    expect(await ledger.listRecoverableDeliveries('user-1', 'bot-1')).toEqual([]);
    expect(await ledger.cancelDelivery('user-1', begun.entry.key, 'again')).toBe(false);
  });

  it('aborts or times out a pending wait without leaving dangling promises', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const controller = new AbortController();
    const begun = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t5'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t5',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    const waiting = ledger.waitForDeliveryTerminal('user-1', begun.entry.key, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(waiting).rejects.toThrow('delivery wait aborted');

    const timed = await ledger.beginDelivery('user-1', {
      key: ledger.deliveryKey('bot-1', 'wait-t6'),
      instanceId: 'bot-1',
      recipientId: 'chat-1',
      recipientIdType: 'chat_id',
      sourceMessageId: 'wait-t6',
      textHash: ledger.textHash('hi'),
      text: 'hi',
    });
    await expect(ledger.waitForDeliveryTerminal('user-1', timed.entry.key, { timeoutMs: 20 })).rejects.toThrow('delivery wait timed out');
  });

  it('keeps rejecting a redelivered inbound id already marked duplicate', async () => {
    const ledger = await import('../../../src/main/features/messaging/ledger');
    const key = ledger.inboundKey('bot-1', 'message-1');
    const first = await ledger.reserveInbound('user-1', key);
    expect(first.duplicate).toBe(false);
    await ledger.completeInbound('user-1', first.entry.key, { status: 'duplicate' });
    const redelivered = await ledger.reserveInbound('user-1', key);
    expect(redelivered.duplicate).toBe(true);
    expect(redelivered.entry.status).toBe('duplicate');
    expect((await ledger.readInbound('user-1', key))?.status).toBe('duplicate');
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

      await invokeHandlers['messaging.update']({
        instanceId: 'bot-1',
        ownerExternalUserId: 'ou_owner_1',
        ownerExternalUserName: 'Owner One',
      }, { userId: 'user-1' });
      expect(updateInstance).toHaveBeenLastCalledWith('user-1', 'bot-1', {
        ownerExternalUserId: 'ou_owner_1',
        ownerExternalUserName: 'Owner One',
        ownerIdentitySource: 'manual',
      });

      await invokeHandlers['messaging.update']({
        instanceId: 'bot-1',
        clearOwner: true,
      }, { userId: 'user-1' });
      expect(updateInstance).toHaveBeenLastCalledWith('user-1', 'bot-1', { clearOwner: true });
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

  it('delivers ordinary replies through the adapter with an explicit chat_id recipient type', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const sendMessage = vi.fn(async () => ({}));
    const adapter: MessagingAdapter = {
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
        displayName: 'Reply bot',
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
        externalMessageId: 'incoming-recipient-1',
        externalChatId: 'chat-1',
        externalUserId: 'user-1',
        text: 'hi',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(busListener).toBeTypeOf('function');
      busListener?.({
        type: 'message',
        cid: inbound.cid,
        turn_end: true,
        turn_id: 'turn-1',
        msg: { id: 'reply-1', from: 'agent', text: 'The answer.' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage.mock.calls[0]?.[0]).toBe('chat-1');
      expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({ recipientIdType: 'chat_id' });
      await manager.stopForUser('user-1');
    } finally {
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

  it('bridges a pending wake request into an approval card in the bound chat', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const groupSend = vi.fn(async () => ({ ok: true }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const sendApprovalCard = vi.fn(async () => ({ deliveryId: 'om_approval_wake_1' }));
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
      sendMessage: vi.fn(async () => ({})),
      sendCard: vi.fn(async () => ({})),
      updateCard: vi.fn(async () => ({})),
      sendApprovalCard,
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
        displayName: 'Wake bridge bot',
        policy: { allowUserIds: ['user-1'] },
        secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret' },
      });
      await manager.setEnabled('user-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('user-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });
      await manager.ingestInbound('user-1', {
        platform: 'feishu_lark',
        instanceId: created.id,
        externalMessageId: 'incoming-wake-1',
        externalChatId: 'oc_wake',
        externalUserId: 'user-1',
        text: 'dispatch something',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(busListener).toBeTypeOf('function');

      busListener?.({
        type: 'wake_request',
        cid: 'cid-any',
        request: {
          id: 'wake-bridge-1',
          agent_id: 'agent-1',
          agent_name: '研究员',
          source: 'dispatch_to',
          objective: '对比三种传感器方案',
          status: 'pending',
        },
      });
      await vi.waitFor(() => expect(sendApprovalCard).toHaveBeenCalledTimes(1));
      expect(sendApprovalCard.mock.calls[0]?.[0]).toBe('oc_wake');
      expect(sendApprovalCard.mock.calls[0]?.[1]).toMatchObject({
        wakeId: 'wake-bridge-1',
        title: '需要你的审批：研究员',
        description: '对比三种传感器方案',
      });

      // Non-pending requests must not produce cards.
      busListener?.({
        type: 'wake_request',
        cid: 'cid-any',
        request: {
          id: 'wake-bridge-2',
          agent_id: 'agent-1',
          source: 'dispatch_to',
          objective: 'x',
          status: 'approved',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sendApprovalCard).toHaveBeenCalledTimes(1);
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});

describe('feishu message media degradation', () => {
  it('degrades every inbound message type to a model-readable text envelope', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const { feishuMessageToText } = _adapterTestHooks;
    expect(feishuMessageToText('text', JSON.stringify({ text: 'hello' }))).toBe('hello');
    expect(feishuMessageToText('image', JSON.stringify({ image_key: 'img_v2_1' }))).toBe('[图片]');
    expect(feishuMessageToText('file', JSON.stringify({ file_key: 'file_1', file_name: 'plan.pdf' }))).toBe('[文件] plan.pdf');
    expect(feishuMessageToText('audio', JSON.stringify({ file_name: 'voice.mp3' }))).toBe('[语音] voice.mp3');
    expect(feishuMessageToText('media', JSON.stringify({ file_name: 'demo.mp4' }))).toBe('[视频] demo.mp4');
    expect(feishuMessageToText('sticker', JSON.stringify({ image_key: 'img_1' }))).toBe('[表情]');
    expect(feishuMessageToText('share_chat', JSON.stringify({ chat_name: '项目群' }))).toBe('[分享了群聊] 项目群');
    expect(feishuMessageToText('share_user', JSON.stringify({ user_name: '张三' }))).toBe('[分享了联系人] 张三');
    expect(feishuMessageToText('interactive', JSON.stringify({ card: {} }))).toBe('[卡片消息]');
    expect(feishuMessageToText('unknown_type', '{"x":1}')).toBe('[unknown_type 消息]');
  });

  it('flattens rich text posts and merged forwards into readable lines', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const { feishuMessageToText } = _adapterTestHooks;
    const post = {
      zh_cn: {
        title: '公告',
        content: [
          [
            { tag: 'text', text: '第一行' },
            { tag: 'a', text: '链接', href: 'https://example.test' },
          ],
          [{ tag: 'text', text: '第二行' }],
        ],
      },
    };
    expect(feishuMessageToText('post', JSON.stringify(post))).toBe('公告\n第一行 链接\n第二行');
    const forward = {
      title: '合并的对话',
      preview: ['msg-1', 'msg-2', 'msg-3'],
    };
    expect(feishuMessageToText('merge_forward', JSON.stringify(forward))).toBe('合并的对话\nmsg-1\nmsg-2\nmsg-3');
  });

  it('falls back to type markers when content is empty or malformed', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const { feishuMessageToText } = _adapterTestHooks;
    expect(feishuMessageToText('file', '')).toBe('[文件]');
    expect(feishuMessageToText('post', 'not-json')).toBe('not-json');
    expect(feishuMessageToText('merge_forward', JSON.stringify({ preview: [] }))).toBe('[合并转发]');
  });

  it('accepts media messages through the full inbound envelope normalization', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const envelope = _adapterTestHooks.normalizeFeishuEvent({
      id: 'bot-media',
      platform: 'feishu_lark',
      displayName: 'Bot',
      enabled: true,
      workspace: { type: 'default' },
      policy: { replyMode: 'every_message', allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
      status: { kind: 'connected', checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      message: {
        message_id: 'om_media_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_1', file_name: 'data.xlsx' }),
        create_time: '1700000000000',
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_sender_1' } },
    }, 'ou_bot_1');
    expect(envelope).toMatchObject({
      platform: 'feishu_lark',
      text: '[文件] data.xlsx',
      externalChatId: 'oc_1',
      externalUserId: 'ou_sender_1',
    });
  });
});

describe('feishu adapter processing reaction', () => {
  function baseEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'feishu_lark' as const,
      instanceId: 'feishu-reaction-test',
      externalMessageId: 'om_reaction_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_sender_1',
      text: 'hello',
      isGroup: false,
      mentionPresent: false,
      receivedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('adds a Typing reaction before dispatch and removes it when the message is rejected', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'feishu-reaction-test',
      platform: 'feishu_lark' as const,
      feishuTenantBrand: 'feishu' as const,
      displayName: 'Reaction bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: { replyMode: 'every_message' as const, allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = new FeishuAdapter(instance, { appId: 'cli_reaction_test', appSecret: 'secret' });
    const create = vi.fn(async () => ({ code: 0, data: { reaction_id: 'reaction-1' } }));
    const remove = vi.fn(async () => ({ code: 0 }));
    (adapter as unknown as { client: { im: { v1: { message_reaction: { create: typeof create; delete: typeof remove } } } } }).client.im.v1.messageReaction = { create, delete: remove };
    const onInbound = vi.fn(async () => ({ accepted: false, duplicate: false, reason: 'user_not_allowed' }));
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, onStatus: vi.fn(async () => {}) };

    await (adapter as unknown as { handleInboundWithReaction(envelope: unknown): Promise<void> }).handleInboundWithReaction(baseEnvelope());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path: { message_id: 'om_reaction_1' },
      data: { reaction_type: { emoji_type: 'Typing' } },
    }));
    expect(remove).toHaveBeenCalledWith({ path: { message_id: 'om_reaction_1', reaction_id: 'reaction-1' } });
  });

  it('keeps the reaction while the message is accepted and removes it after the reply is sent', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'feishu-reaction-test',
      platform: 'feishu_lark' as const,
      feishuTenantBrand: 'feishu' as const,
      displayName: 'Reaction bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: { replyMode: 'every_message' as const, allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = new FeishuAdapter(instance, { appId: 'cli_reaction_test', appSecret: 'secret' });
    const create = vi.fn(async () => ({ code: 0, data: { reaction_id: 'reaction-2' } }));
    const remove = vi.fn(async () => ({ code: 0 }));
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply_1' } }));
    (adapter as unknown as { client: { im: { v1: { message_reaction: { create: typeof create; delete: typeof remove }; message: { reply: typeof reply } } } } }).client.im.v1.messageReaction = { create, delete: remove };
    (adapter as unknown as { client: { im: { v1: { message: { reply: typeof reply } } } } }).client.im.v1.message.reply = reply;
    const onInbound = vi.fn(async () => ({ accepted: true, duplicate: false, cid: 'cid-1' }));
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, onStatus: vi.fn(async () => {}) };

    await (adapter as unknown as { handleInboundWithReaction(envelope: unknown): Promise<void> }).handleInboundWithReaction(baseEnvelope());
    expect(remove).not.toHaveBeenCalled();

    await adapter.sendMessage('oc_1', 'reply text', undefined, { replyToMessageId: 'om_reaction_1' });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ path: { message_id: 'om_reaction_1', reaction_id: 'reaction-2' } }));
  });

  it('tolerates missing reaction permissions without failing the message flow', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'feishu-reaction-test',
      platform: 'feishu_lark' as const,
      feishuTenantBrand: 'feishu' as const,
      displayName: 'Reaction bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: { replyMode: 'every_message' as const, allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = new FeishuAdapter(instance, { appId: 'cli_reaction_test', appSecret: 'secret' });
    const create = vi.fn(async () => { throw new Error('permission denied'); });
    (adapter as unknown as { client: { im: { v1: { message_reaction: { create: typeof create } } } } }).client.im.v1.messageReaction = { create };
    const onInbound = vi.fn(async () => ({ accepted: true, duplicate: false, cid: 'cid-1' }));
    (adapter as unknown as { callbacks: unknown }).callbacks = { onInbound, onStatus: vi.fn(async () => {}) };

    await expect((adapter as unknown as { handleInboundWithReaction(envelope: unknown): Promise<void> }).handleInboundWithReaction(baseEnvelope())).resolves.toBeUndefined();
    expect(onInbound).toHaveBeenCalledTimes(1);
  });
});

describe('feishu card action normalization', () => {
  const instance = {
    id: 'feishu-card-test',
    platform: 'feishu_lark' as const,
    feishuTenantBrand: 'feishu' as const,
    displayName: 'Card bot',
    enabled: true,
    workspace: { type: 'default' as const },
    policy: { replyMode: 'every_message' as const, allowUserIds: ['ou_admin'], allowGroupIds: [], requireMentionInGroups: true },
    status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('extracts operator, chat and button value from the SDK event shape', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const action = _adapterTestHooks.normalizeFeishuCardAction(instance, {
      context: { open_message_id: 'om_card_1', open_chat_id: 'oc_group' },
      operator: { open_id: 'ou_admin', name: 'Admin' },
      action: { tag: 'button', value: { action: 'approve', wake_id: 'wake-1' } },
    });
    expect(action).toMatchObject({
      platform: 'feishu_lark',
      instanceId: 'feishu-card-test',
      externalMessageId: 'om_card_1',
      externalChatId: 'oc_group',
      externalUserId: 'ou_admin',
      action: 'approve',
      payload: { wake_id: 'wake-1' },
    });
  });

  it('rejects card events missing the message, chat or operator', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    expect(_adapterTestHooks.normalizeFeishuCardAction(instance, { operator: { open_id: 'ou_x' } })).toBeNull();
    expect(_adapterTestHooks.normalizeFeishuCardAction(instance, {
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
    })).toBeNull();
  });

  it('falls back to the button tag when the value has no action field', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const action = _adapterTestHooks.normalizeFeishuCardAction(instance, {
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_admin' },
      action: { tag: 'button', value: { wake_id: 'wake-2' } },
    });
    expect(action?.action).toBe('button');
    expect(action?.payload).toEqual({ wake_id: 'wake-2' });
  });
});

describe('messaging card action dispatch', () => {
  it('rejects card clicks from users outside the allowlist', async () => {
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const created = await registry.createInstance('user-1', {
      platform: 'feishu_lark',
      displayName: 'Card bot',
      policy: { allowUserIds: ['ou_admin'] },
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret' },
    });
    // Enable at the registry level: ingestCardAction only reads config state,
    // and starting the runtime would construct a real adapter.
    await registry.updateInstance('user-1', created.id, { enabled: true });
    const result = await manager.ingestCardAction('user-1', {
      platform: 'feishu_lark',
      instanceId: created.id,
      externalMessageId: 'om_card_1',
      externalChatId: 'oc_1',
      externalUserId: 'ou_stranger',
      action: 'approve',
      payload: { wake_id: 'wake-1' },
      receivedAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({ accepted: false, reason: 'user_not_allowed' });
  });

  it('routes approve/deny card actions to the wake approval gate', async () => {
    const approveWakeRequest = vi.fn(async () => ({ request: { id: 'wake-1' }, approval: {} }));
    const rejectWakeRequest = vi.fn(async () => ({}));
    vi.doMock('../../../src/main/features/p3394/wake-service', () => ({
      approveWakeRequest,
      rejectWakeRequest,
    }));
    try {
      const registry = await import('../../../src/main/features/messaging/registry');
      const manager = await import('../../../src/main/features/messaging/manager');
      const created = await registry.createInstance('user-1', {
        platform: 'feishu_lark',
        displayName: 'Card bot',
        policy: { allowUserIds: ['ou_admin'] },
        secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret' },
      });
      // Enable at the registry level: ingestCardAction only reads config state,
      // and starting the runtime would construct a real adapter.
      await registry.updateInstance('user-1', created.id, { enabled: true });
      const base = {
        platform: 'feishu_lark' as const,
        instanceId: created.id,
        externalMessageId: 'om_card_1',
        externalChatId: 'oc_1',
        externalUserId: 'ou_admin',
        receivedAt: new Date().toISOString(),
      };
      const approved = await manager.ingestCardAction('user-1', { ...base, action: 'approve', payload: { wake_id: 'wake-1' } });
      expect(approved.accepted).toBe(true);
      expect(approveWakeRequest).toHaveBeenCalledWith('user-1', 'wake-1');
      const denied = await manager.ingestCardAction('user-1', { ...base, action: 'deny', payload: { wake_id: 'wake-2' } });
      expect(denied.accepted).toBe(true);
      expect(rejectWakeRequest).toHaveBeenCalledWith('user-1', 'wake-2');
      const unsupported = await manager.ingestCardAction('user-1', { ...base, action: 'jump', payload: { wake_id: 'wake-3' } });
      expect(unsupported).toMatchObject({ accepted: false, reason: 'unsupported_card_action' });
    } finally {
      vi.doUnmock('../../../src/main/features/p3394/wake-service');
      vi.resetModules();
    }
  });
});

describe('feishu approval cards', () => {
  it('builds an approval card whose buttons carry the wake id and action', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'feishu-approval-test',
      platform: 'feishu_lark' as const,
      feishuTenantBrand: 'feishu' as const,
      displayName: 'Approval bot',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: { replyMode: 'every_message' as const, allowUserIds: [], allowGroupIds: [], requireMentionInGroups: true },
      status: { kind: 'connected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = new FeishuAdapter(instance, { appId: 'cli_1234567890abcdef', appSecret: 'secret' });
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_approval_1' } }));
    (adapter as unknown as { client: { im: { v1: { message: { create: typeof create } } } } }).client.im.v1.message.create = create;
    const receipt = await adapter.sendApprovalCard('oc_1', {
      wakeId: 'wake-7',
      title: '需要你的审批',
      description: 'Agent 想执行: npm run deploy',
      allowSession: true,
      allowPermanent: false,
    });
    expect(receipt).toEqual({ deliveryId: 'om_approval_1' });
    const payload = JSON.parse(String(create.mock.calls[0]?.[0]?.data?.content)) as Record<string, any>;
    expect(payload.header.title.content).toBe('需要你的审批');
    const buttons = (payload.elements.find((element: Record<string, any>) => element.tag === 'action')?.actions || []) as Array<Record<string, any>>;
    expect(buttons.map((button) => button.value)).toEqual([
      { action: 'approve', wake_id: 'wake-7' },
      { action: 'approve_session', wake_id: 'wake-7' },
      { action: 'deny', wake_id: 'wake-7' },
    ]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ receive_id_type: 'chat_id' }),
      data: expect.objectContaining({ receive_id: 'oc_1', msg_type: 'interactive' }),
    }));
  });

  it('builds a terminal resolved card for approved and denied choices', async () => {
    const manager = await import('../../../src/main/features/messaging/manager');
    const approved = manager._managerTestHooks.buildResolvedApprovalCard('approve', 'Admin');
    expect(approved.header.template).toBe('green');
    expect(JSON.stringify(approved)).toContain('已允许');
    expect(JSON.stringify(approved)).toContain('Admin');
    const denied = manager._managerTestHooks.buildResolvedApprovalCard('deny');
    expect(denied.header.template).toBe('red');
    expect(JSON.stringify(denied)).toContain('已拒绝');
  });
});

describe('feishu bot identity parsing', () => {
  it('extracts the bot open id from the real bot/v3/info response shape', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const openId = _adapterTestHooks.parseFeishuBotOpenId({
      code: 0,
      msg: 'ok',
      bot: {
        activate_status: 2,
        app_name: '飞书',
        avatar_url: 'https://example.test/avatar.png',
        ip_white_list: [],
        open_id: 'ou_9c331defc6a7862b9b9ee9c5b4827680',
      },
    });
    expect(openId).toBe('ou_9c331defc6a7862b9b9ee9c5b4827680');
  });

  it('accepts the legacy data.open_id wrapper for compatibility', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    const openId = _adapterTestHooks.parseFeishuBotOpenId({ code: 0, data: { open_id: 'ou_legacy' } });
    expect(openId).toBe('ou_legacy');
  });

  it('returns an empty string when the response has no bot identity', async () => {
    const { _adapterTestHooks } = await import('../../../src/main/features/messaging/adapters');
    expect(_adapterTestHooks.parseFeishuBotOpenId({ code: 0, msg: 'ok' })).toBe('');
    expect(_adapterTestHooks.parseFeishuBotOpenId({ code: 99991, msg: 'system busy' })).toBe('');
    expect(_adapterTestHooks.parseFeishuBotOpenId({ bot: { open_id: '  ' } })).toBe('');
  });
});

describe('feishu adapter bot identity resolution', () => {
  it('resolves the bot open id from the real bot/v3/info response shape', async () => {
    const { FeishuAdapter } = await import('../../../src/main/features/messaging/adapters');
    const instance = {
      id: 'feishu-identity-test',
      platform: 'feishu_lark' as const,
      feishuTenantBrand: 'feishu' as const,
      displayName: 'Feishu identity test',
      enabled: true,
      workspace: { type: 'default' as const },
      policy: {
        replyMode: 'every_message' as const,
        allowUserIds: [],
        allowGroupIds: [],
        requireMentionInGroups: true,
      },
      status: { kind: 'disconnected' as const, checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const adapter = new FeishuAdapter(instance, {
      appId: 'cli_aafef89eb9785be8',
      appSecret: 'fake-secret-for-identity-test',
    });
    const request = vi.fn(async () => ({
      code: 0,
      msg: 'ok',
      bot: {
        activate_status: 2,
        app_name: '飞书',
        avatar_url: 'https://example.test/avatar.png',
        ip_white_list: [],
        open_id: 'ou_9c331defc6a7862b9b9ee9c5b4827680',
      },
    }));
    (adapter as unknown as { client: { request: typeof request } }).client.request = request;
    await (adapter as unknown as { resolveBotIdentity(): Promise<void> }).resolveBotIdentity();
    expect((adapter as unknown as { botOpenId: string }).botOpenId).toBe('ou_9c331defc6a7862b9b9ee9c5b4827680');
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/bot/v3/info' });
  });
});

describe('messaging per-chat inbound serialization', () => {
  it('processes concurrent inbound messages from the same chat one at a time', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const groupSend = vi.fn(async (input: { text?: string }) => {
      order.push(input.text ?? '');
      if (order.length === 1) await firstGate;
      return { ok: true };
    });
    const subscribe = vi.fn(() => () => {});
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
      async sendMessage() {
        return {};
      },
      async sendCard() {
        return {};
      },
      async updateCard() {
        return {};
      },
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
        responseMode: 'text',
        policy: { allowUserIds: ['ou_sender_1'] },
        secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
      });
      await manager.setEnabled('user-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('user-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });
      const envelope = (externalMessageId: string, text: string) => ({
        platform: 'feishu_lark' as const,
        instanceId: created.id,
        externalMessageId,
        externalChatId: 'oc_serial',
        externalUserId: 'ou_sender_1',
        text,
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });

      const first = manager.ingestInbound('user-1', envelope('om_serial_1', 'first'));
      // The first message blocks inside groupChat.send; the second one must
      // wait on the per-chat lock instead of entering the chat concurrently.
      await vi.waitFor(() => expect(order).toEqual(['first']));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(['first']);
      releaseFirst?.();
      const second = manager.ingestInbound('user-1', envelope('om_serial_2', 'second'));
      await Promise.all([first, second]);
      expect(order).toEqual(['first', 'second']);
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});

describe('messaging streaming card concurrency', () => {
  it('never creates a second card when deltas arrive during an in-flight flush', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    let releaseSend: ((value: { deliveryId: string }) => void) | undefined;
    const sendGate = new Promise<{ deliveryId: string }>((resolve) => {
      releaseSend = resolve;
    });
    const sendCard = vi.fn(() => sendGate);
    const updateCard = vi.fn(async () => ({}));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const groupSend = vi.fn(async () => ({ ok: true }));
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
      async sendMessage() {
        return {};
      },
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
        policy: { allowUserIds: ['ou_sender_1'] },
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
        externalMessageId: 'om_concurrent_1',
        externalChatId: 'oc_concurrent',
        externalUserId: 'ou_sender_1',
        text: 'hello',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(inbound.accepted).toBe(true);

      // First delta schedules flush 1, which blocks on the sendCard gate.
      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-1',
        data: { type: 'delta', text: 'start ' },
      });
      await vi.waitFor(() => expect(sendCard).toHaveBeenCalledTimes(1));

      // Deltas that arrive while flush 1 is awaiting the network must only
      // accumulate — they must not schedule a second concurrent sendCard.
      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-1',
        data: { type: 'delta', text: 'more ' },
      });
      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-1',
        data: { type: 'delta', text: 'final' },
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(sendCard).toHaveBeenCalledTimes(1);

      // Release flush 1; the trailing flush must update the existing card
      // instead of creating a second one.
      releaseSend?.({ deliveryId: 'om_card_1' });
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      expect(sendCard).toHaveBeenCalledTimes(1);
      expect(updateCard.mock.calls[0]?.[1]).toMatchObject({
        elements: [{ tag: 'markdown', content: 'start more final' }],
      });
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});

describe('messaging tool chrome', () => {
  it('renders Hermes-style tool lines with emoji, name and truncated preview', async () => {
    const { _managerTestHooks } = await import('../../../src/main/features/messaging/manager');
    expect(_managerTestHooks.renderToolLine('web_search', { query: 'site:openai.com Codex 2026' }))
      .toBe('🔍 web_search: "site:openai.com Codex 2026"');
    expect(_managerTestHooks.renderToolLine('terminal', { command: 'ollama run qwen3-vl:8b hello' }))
      .toBe('🖥️ terminal: "ollama run qwen3-vl:8b hello"');
    // Unknown tools fall back to the default emoji; long previews truncate.
    const long = _managerTestHooks.renderToolLine('write_file', { path: '/a/very/long/path/that/exceeds/the/forty/character/preview/cap/definitely' });
    expect(long.startsWith('✍️ write_file: "')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…"')).toBe(true);
  });

  it('extracts tool lines from bus process events', async () => {
    const { _managerTestHooks } = await import('../../../src/main/features/messaging/manager');
    const lines = _managerTestHooks.toolLinesFromProcessEvent({
      type: 'process',
      cid: 'c',
      turn_id: 't1',
      data: {
        type: 'event',
        event: {
          stream: 'tool',
          data: { phase: 'start', id: 'call_1', name: 'web_search', arguments: { query: 'hello' } },
        },
      },
    } as never);
    expect(lines).toEqual(['🔍 web_search: "hello"']);
    expect(_managerTestHooks.toolLinesFromProcessEvent({
      type: 'process', cid: 'c', turn_id: 't1', data: { type: 'delta', text: 'x' },
    } as never)).toEqual([]);
    expect(_managerTestHooks.toolLinesFromProcessEvent({
      type: 'process', cid: 'c', turn_id: 't1',
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 'call_1', name: 'web_search' } } },
    } as never)).toEqual([]);
  });

  it('shows tool chrome inside the streaming card and keeps it at finalize', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const sendCard = vi.fn(async () => ({ deliveryId: 'om_card_tool' }));
    const updateCard = vi.fn(async () => ({}));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const groupSend = vi.fn(async () => ({ ok: true }));
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
      async sendMessage() {
        return {};
      },
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
        policy: { allowUserIds: ['ou_sender_1'] },
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
        externalMessageId: 'om_tool_1',
        externalChatId: 'oc_tool',
        externalUserId: 'ou_sender_1',
        text: 'search for me',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(inbound.accepted).toBe(true);

      // Tool start event → tool chrome appears in the card before any text.
      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-tool',
        data: {
          type: 'event',
          event: { stream: 'tool', data: { phase: 'start', id: 'call_1', name: 'web_search', arguments: { query: 'Codex 2026' } } },
        },
      });
      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-tool',
        data: { type: 'delta', text: '结果如下' },
      });
      await vi.waitFor(() => expect(sendCard).toHaveBeenCalledTimes(1));
      const card = sendCard.mock.calls[0]?.[1];
      expect(card.elements[0]).toMatchObject({
        tag: 'markdown',
        content: expect.stringContaining('🔍 web_search: "Codex 2026"'),
      });
      expect(card.elements[1]).toMatchObject({ tag: 'hr' });

      // Finalize keeps the tool chrome and appends the final text.
      busListener?.({
        type: 'message', cid: inbound.cid, turn_end: true, turn_id: 'turn-tool',
        msg: { id: 'reply-tool', from: 'agent', text: '最终回答' },
      });
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      const finalCard = updateCard.mock.calls[0]?.[1];
      expect(finalCard.elements[0].content).toContain('🔍 web_search: "Codex 2026"');
      expect(finalCard.elements[2].content).toBe('最终回答');
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });

  it('merges tool chrome into the plain-text reply', async () => {
    let busListener: ((event: unknown) => void) | undefined;
    const sendMessage = vi.fn(async () => ({ deliveryId: 'om_text_tool' }));
    const subscribe = vi.fn((_uid: string, _cid: string, listener: (event: unknown) => void) => {
      busListener = listener;
      return () => { busListener = undefined; };
    });
    const groupSend = vi.fn(async () => ({ ok: true }));
    const adapter: MessagingAdapter = {
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
        responseMode: 'text',
        policy: { allowUserIds: ['ou_sender_1'] },
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
        externalMessageId: 'om_text_tool_1',
        externalChatId: 'oc_text_tool',
        externalUserId: 'ou_sender_1',
        text: 'search',
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });
      expect(inbound.accepted).toBe(true);

      busListener?.({
        type: 'process', cid: inbound.cid, actor: 'agent', turn_id: 'turn-text',
        data: {
          type: 'event',
          event: { stream: 'tool', data: { phase: 'start', id: 'call_1', name: 'web_search', arguments: { query: 'Codex' } } },
        },
      });
      busListener?.({
        type: 'message', cid: inbound.cid, turn_end: true, turn_id: 'turn-text',
        msg: { id: 'reply-text', from: 'agent', text: '正文回复' },
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const sentText = sendMessage.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('🔍 web_search: "Codex"');
      expect(sentText).toContain('正文回复');
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});

describe('messaging session reset (/new)', () => {
  it('rotates to a fresh conversation on /new and confirms with a system message', async () => {
    const groupSend = vi.fn(async () => ({ ok: true }));
    const sendMessage = vi.fn(async () => ({ deliveryId: 'om_new_confirm' }));
    const subscribe = vi.fn(() => () => {});
    const adapter: MessagingAdapter = {
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
        responseMode: 'text',
        policy: { allowUserIds: ['ou_sender_1'] },
        secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
      });
      await manager.setEnabled('user-1', created.id, true);
      await vi.waitFor(async () => {
        const instances = await manager.listInstances('user-1');
        expect(instances[0]?.status.kind).toBe('connected');
      });
      const envelope = (externalMessageId: string, text: string) => ({
        platform: 'feishu_lark' as const,
        instanceId: created.id,
        externalMessageId,
        externalChatId: 'oc_reset',
        externalUserId: 'ou_sender_1',
        text,
        isGroup: false,
        mentionPresent: false,
        receivedAt: new Date().toISOString(),
      });

      // First message binds to conversation A.
      const first = await manager.ingestInbound('user-1', envelope('om_reset_1', 'hello'));
      expect(first.accepted).toBe(true);
      expect(groupSend).toHaveBeenCalledTimes(1);
      const cidA = first.cid;
      expect(cidA).toBeTruthy();

      // /new rotates to a fresh conversation and sends the confirmation
      // without consuming a Meta Agent turn.
      const reset = await manager.ingestInbound('user-1', envelope('om_reset_2', '/new'));
      expect(reset.accepted).toBe(true);
      expect(reset.cid).toBeTruthy();
      expect(reset.cid).not.toBe(cidA);
      expect(groupSend).toHaveBeenCalledTimes(1); // no commander turn for /new
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage.mock.calls[0]?.[1]).toContain('已开始新的对话');

      // The next message continues in the fresh conversation B.
      const next = await manager.ingestInbound('user-1', envelope('om_reset_3', '继续'));
      expect(next.accepted).toBe(true);
      expect(next.cid).toBe(reset.cid);
      expect(groupSend).toHaveBeenCalledTimes(2);
      expect(groupSend.mock.calls[1]?.[0]).toMatchObject({ cid: reset.cid });
      await manager.stopForUser('user-1');
    } finally {
      vi.doUnmock('../../../src/main/features/messaging/adapters');
      vi.doUnmock('../../../src/main/features/group_chat');
      vi.doUnmock('../../../src/main/features/group_chat/bus');
      vi.resetModules();
    }
  });
});

describe('messaging burst merge on inbound', () => {
  async function seededInstance(uid: string): Promise<{ manager: typeof import('../../../src/main/features/messaging/manager'); groupSend: ReturnType<typeof vi.fn> }> {
    vi.useFakeTimers();
    const groupSend = vi.fn(async () => ({ ok: true }));
    // Same adapter mock shape as the rest of this file: start reports
    // 'connected' through onStatus so the seeded runtime is live.
    const adapter: MessagingAdapter = {
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
      sendMessage: vi.fn(async () => ({ deliveryId: 'om_9' })),
    };
    vi.doMock('../../../src/main/features/messaging/adapters', () => ({ createAdapter: vi.fn(() => adapter) }));
    vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
    vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe: vi.fn() }));
    const registry = await import('../../../src/main/features/messaging/registry');
    const manager = await import('../../../src/main/features/messaging/manager');
    const created = await registry.createInstance(uid, {
      platform: 'feishu_lark',
      displayName: 'Test Feishu',
      policy: { allowUserIds: [uid], allowGroupIds: ['oc_1'] },
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
    });
    await manager.setEnabled(uid, created.id, true);
    await vi.waitFor(async () => {
      const instances = await manager.listInstances(uid);
      expect(instances[0]?.status.kind).toBe('connected');
    });
    return { manager, groupSend };
  }

  it('merges split messages into one dispatch', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid);
    const base = async (id: string, text: string) => ({
      platform: 'feishu_lark' as const,
      instanceId: (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id,
      externalMessageId: id,
      externalChatId: 'oc_1',
      externalUserId: uid,
      text,
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    });
    // enqueueInbound's promise resolves only after the merged flush, so the
    // pushes must not be awaited before the fake clock advances the window.
    void manager.enqueueInbound(uid, await base('m-1', 'part one'));
    void manager.enqueueInbound(uid, await base('m-2', 'part two'));
    expect(groupSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    // The flush runs ledger I/O (real fs) under fake timers, so drain the
    // event loop with vi.waitFor (real interval) before asserting.
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    expect(groupSend.mock.calls[0][0]).toMatchObject({ text: 'part one\npart two' });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('resolves every enqueued promise when a batch flushes', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid);
    const base = async (id: string, text: string) => ({
      platform: 'feishu_lark' as const,
      instanceId: (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id,
      externalMessageId: id,
      externalChatId: 'oc_1',
      externalUserId: uid,
      text,
      isGroup: true,
      mentionPresent: true,
      receivedAt: new Date().toISOString(),
    });
    // Hold the promises before advancing the clock: every enqueued promise
    // must settle on flush, not only the batch's first one.
    const first = manager.enqueueInbound(uid, await base('m-1', 'part one'));
    const second = manager.enqueueInbound(uid, await base('m-2', 'part two'));
    expect(groupSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(groupSend).toHaveBeenCalledTimes(1));
    await expect(first).resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(second).resolves.toEqual({ accepted: false, duplicate: true, reason: 'merged' });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('dispatches synthetic envelopes immediately, bypassing the merger', async () => {
    const uid = 'user-1';
    const { manager, groupSend } = await seededInstance(uid);
    const instanceId = (await (await import('../../../src/main/features/messaging/registry')).listInstances(uid))[0].id;
    await manager.enqueueInbound(uid, {
      platform: 'feishu_lark',
      instanceId,
      externalMessageId: 'evt-1',
      externalChatId: 'oc_1',
      externalUserId: uid,
      text: 'reaction:added:THUMBSUP',
      isGroup: true,
      mentionPresent: true,
      synthetic: true,
      receivedAt: new Date().toISOString(),
    });
    expect(groupSend).toHaveBeenCalledTimes(1);
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });
});
