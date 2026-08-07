import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessagingAdapter } from '../../../src/main/features/messaging/types';

let tmpDir = '';
let previousRoot: string | undefined;

function connectedAdapter(): MessagingAdapter {
  return {
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
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-owner-bind-'));
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

async function seededFeishu(uid: string, allowUserIds: string[] = []) {
  vi.useFakeTimers();
  const adapter = connectedAdapter();
  vi.doMock('../../../src/main/features/messaging/adapters', () => ({ createAdapter: vi.fn(() => adapter) }));
  const groupSend = vi.fn(async () => ({ ok: true }));
  vi.doMock('../../../src/main/features/group_chat', () => ({ send: groupSend }));
  vi.doMock('../../../src/main/features/group_chat/bus', () => ({ subscribe: vi.fn() }));
  const registry = await import('../../../src/main/features/messaging/registry');
  const manager = await import('../../../src/main/features/messaging/manager');
  const created = await registry.createInstance(uid, {
    platform: 'feishu_lark',
    displayName: 'Bind bot',
    policy: { allowUserIds, allowGroupIds: [] },
    secret: { appId: 'cli_1234567890abcdef', appSecret: 'app-secret' },
  });
  await manager.setEnabled(uid, created.id, true);
  await vi.waitFor(async () => {
    const instances = await manager.listInstances(uid);
    expect(instances[0]?.status.kind).toBe('connected');
  });
  return { manager, registry, instanceId: created.id, groupSend };
}

function envelope(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: 'feishu_lark' as const,
    instanceId,
    externalMessageId: 'om-in-1',
    externalChatId: 'oc_dm_1',
    externalUserId: 'ou_sender_1',
    externalUserName: 'Sender One',
    text: '你好，绑定我',
    isGroup: false,
    mentionPresent: false,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function drain(groupSend: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(600);
  await vi.waitFor(() => expect(groupSend).toHaveBeenCalled());
}

describe('messaging owner auto-bind from direct message', () => {
  it('binds the first direct-message sender as owner inside the binding window', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId, groupSend } = await seededFeishu(uid, ['ou_sender_1']);
    manager.openOwnerBindingWindow(uid, instanceId);
    void manager.enqueueInbound(uid, envelope(instanceId));
    await drain(groupSend);

    const instance = await registry.getInstance(uid, instanceId);
    expect(instance).toMatchObject({
      ownerExternalUserId: 'ou_sender_1',
      ownerExternalUserName: 'Sender One',
      ownerIdentitySource: 'auto',
    });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('auto-opens the binding window when the bot is enabled', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId, groupSend } = await seededFeishu(uid, ['ou_sender_1']);
    // seededFeishu enabled the instance, which opens the window by itself —
    // no manual openOwnerBindingWindow call is needed.
    void manager.enqueueInbound(uid, envelope(instanceId));
    await drain(groupSend);

    expect(await registry.getInstance(uid, instanceId)).toMatchObject({
      ownerExternalUserId: 'ou_sender_1',
      ownerIdentitySource: 'auto',
    });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('ignores group messages inside the window', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId } = await seededFeishu(uid, ['ou_sender_1']);
    manager.openOwnerBindingWindow(uid, instanceId);
    void manager.enqueueInbound(uid, envelope(instanceId, { isGroup: true, externalChatId: 'oc_group_1' }));
    await vi.advanceTimersByTimeAsync(600);

    expect(await registry.getInstance(uid, instanceId)).not.toHaveProperty('ownerExternalUserId');
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('does not bind after the window expires', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId, groupSend } = await seededFeishu(uid, ['ou_sender_1']);
    manager.openOwnerBindingWindow(uid, instanceId);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    void manager.enqueueInbound(uid, envelope(instanceId));
    await drain(groupSend);

    expect(await registry.getInstance(uid, instanceId)).not.toHaveProperty('ownerExternalUserId');
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('does not overwrite an existing owner', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId, groupSend } = await seededFeishu(uid, ['ou_sender_1']);
    await registry.updateInstance(uid, instanceId, {
      ownerExternalUserId: 'ou_existing',
      ownerExternalUserName: 'Existing',
      ownerIdentitySource: 'manual',
    });
    manager.openOwnerBindingWindow(uid, instanceId);
    void manager.enqueueInbound(uid, envelope(instanceId));
    await drain(groupSend);

    expect(await registry.getInstance(uid, instanceId)).toMatchObject({ ownerExternalUserId: 'ou_existing' });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('closes the window after a successful bind', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId, groupSend } = await seededFeishu(uid, ['ou_sender_1']);
    manager.openOwnerBindingWindow(uid, instanceId);
    void manager.enqueueInbound(uid, envelope(instanceId, { externalMessageId: 'om-in-1' }));
    await drain(groupSend);
    // Second message from a different sender must not rebind; the allowlist
    // only admits the original sender, so no dispatch is expected here.
    void manager.enqueueInbound(uid, envelope(instanceId, { externalMessageId: 'om-in-2', externalUserId: 'ou_other' }));
    await vi.advanceTimersByTimeAsync(600);

    expect(await registry.getInstance(uid, instanceId)).toMatchObject({ ownerExternalUserId: 'ou_sender_1' });
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });

  it('reports live binding-window status and clears it on expiry', async () => {
    const uid = 'user-1';
    const { manager, registry, instanceId } = await seededFeishu(uid, ['ou_sender_1']);
    // seededFeishu enabled the instance, which opens the window automatically.
    const live = manager.getOwnerBindingStatus(uid, instanceId);
    expect(live).toMatchObject({ binding: true });
    expect(live?.remainingMs).toBeGreaterThan(0);
    expect(live?.remainingMs).toBeLessThanOrEqual(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    expect(manager.getOwnerBindingStatus(uid, instanceId)).toBeNull();
    await manager.stopForUser(uid);
    vi.useRealTimers();
  });
});
