import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingInstanceClient } from '../../../src/main/features/messaging/types';

const UID = 'user-1';
const BOT_ID = 'wecom.bot-1';
const BOT_SECRET = 'wecom-secret-value-123';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) throw new Error('deferred promise initialization failed');
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function clientInstance(overrides: Partial<MessagingInstanceClient> = {}): MessagingInstanceClient {
  return {
    id: 'wecom-bot-1',
    platform: 'wecom',
    displayName: 'WeCom helper',
    enabled: true,
    workspace: { type: 'default' },
    policy: {
      replyMode: 'every_message',
      allowUserIds: [],
      allowGroupIds: [],
      requireMentionInGroups: true,
    },
    status: { kind: 'connecting', checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasCredentials: true,
    ...overrides,
  };
}

describe('WeCom QR registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.doUnmock('../../../src/main/features/messaging/manager');
    vi.resetModules();
  });

  it('completes the official scan flow once and never returns credentials', async () => {
    const createInstance = vi.fn(async () => clientInstance({ enabled: false }));
    const setEnabled = vi.fn(async () => clientInstance());
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, {
      displayName: ' WeCom helper ',
      workspace: { type: 'default' },
      policy: { requireMentionInGroups: true },
    });
    expect(started).toMatchObject({
      state: 'awaiting_scan',
      authUrl: 'https://work.weixin.qq.com/ai/qc/gen',
    });
    expect(JSON.stringify(started)).not.toContain(BOT_SECRET);

    const completed = await feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(createInstance).toHaveBeenCalledWith(UID, {
      platform: 'wecom',
      displayName: 'WeCom helper',
      workspace: { type: 'default' },
      policy: { requireMentionInGroups: true },
      secret: { wecomBotId: BOT_ID, wecomBotSecret: BOT_SECRET },
    });
    expect(setEnabled).toHaveBeenCalledWith(UID, 'wecom-bot-1', true);
    expect(completed).toMatchObject({
      state: 'completed',
      instance: { id: 'wecom-bot-1', enabled: true, platform: 'wecom' },
    });
    expect(completed).not.toHaveProperty('authUrl');
    expect(completed).not.toHaveProperty('expiresAt');
    expect(JSON.stringify(completed)).not.toContain(BOT_SECRET);
    expect(JSON.stringify(feature.getWecomQrRegistrationStatus(UID, started.flowId))).not.toContain(BOT_SECRET);
  });

  it('expires before completion without creating an instance or leaking the scan URL', async () => {
    const createInstance = vi.fn();
    const setEnabled = vi.fn();
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(),
    }));
    const now = 1_710_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });

    nowSpy.mockReturnValue(now + 5 * 60 * 1000);
    expect(feature.getWecomQrRegistrationStatus(UID, started.flowId)).toEqual({
      flowId: started.flowId,
      state: 'expired',
      errorCode: 'expired',
    });
    await expect(feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET)).resolves.toEqual({
      flowId: started.flowId,
      state: 'expired',
      errorCode: 'expired',
    });
    expect(createInstance).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('cancels an activation race, removes the stale instance, and does not expose its secret', async () => {
    const creation = deferred<MessagingInstanceClient>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    const deleteInstance = vi.fn(async () => true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });
    const completion = feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    expect(feature.cancelWecomQrRegistration(UID, started.flowId)).toMatchObject({ state: 'cancelled' });
    creation.resolve(clientInstance({ enabled: false }));

    await expect(completion).resolves.toEqual({ flowId: started.flowId, state: 'cancelled' });
    expect(setEnabled).not.toHaveBeenCalled();
    expect(deleteInstance).toHaveBeenCalledWith(UID, 'wecom-bot-1');
    expect(JSON.stringify(feature.getWecomQrRegistrationStatus(UID, started.flowId))).not.toContain(BOT_SECRET);
  });

  it('preserves expiry when asynchronous instance creation fails after the QR window closes', async () => {
    const creation = deferred<MessagingInstanceClient>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));
    const now = 1_710_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });
    const completion = feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    nowSpy.mockReturnValue(now + 5 * 60 * 1000);
    creation.reject(new Error('registration transport failed'));

    await expect(completion).resolves.toEqual({
      flowId: started.flowId,
      state: 'expired',
      errorCode: 'expired',
    });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('preserves expiry and removes the created instance when enabling fails after the QR window closes', async () => {
    const creation = deferred<MessagingInstanceClient>();
    const enabling = deferred<MessagingInstanceClient>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn(() => enabling.promise);
    const deleteInstance = vi.fn(async () => true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));
    const now = 1_710_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });
    const completion = feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));
    creation.resolve(clientInstance({ enabled: false }));
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));

    nowSpy.mockReturnValue(now + 5 * 60 * 1000);
    enabling.reject(new Error('enablement transport failed'));

    await expect(completion).resolves.toEqual({
      flowId: started.flowId,
      state: 'expired',
      errorCode: 'expired',
    });
    expect(deleteInstance).toHaveBeenCalledWith(UID, 'wecom-bot-1');
  });

  it('reports a pre-expiry activation failure after cleaning up its created instance', async () => {
    const createInstance = vi.fn(async () => clientInstance({ enabled: false }));
    const setEnabled = vi.fn(async () => {
      throw new Error('enablement transport failed');
    });
    const deleteInstance = vi.fn(async () => true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });

    await expect(feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET)).resolves.toEqual({
      flowId: started.flowId,
      state: 'failed',
      errorCode: 'activation_failed',
    });
    expect(deleteInstance).toHaveBeenCalledWith(UID, 'wecom-bot-1');
  });

  it('serializes duplicate completion callbacks for the same scan flow', async () => {
    const creation = deferred<MessagingInstanceClient>();
    const enabling = deferred<MessagingInstanceClient>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn(() => enabling.promise);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/wecom-registration');
    const started = await feature.startWecomQrRegistration(UID, { displayName: 'Helper' });
    const first = feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));
    const second = feature.completeWecomQrRegistration(UID, started.flowId, BOT_ID, BOT_SECRET);

    expect(createInstance).toHaveBeenCalledTimes(1);
    creation.resolve(clientInstance({ enabled: false }));
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));
    enabling.resolve(clientInstance({ enabled: true }));

    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0]).toMatchObject({ state: 'completed', instance: { id: 'wecom-bot-1' } });
    expect(['activating', 'completed']).toContain(outcomes[1].state);
    expect(feature.getWecomQrRegistrationStatus(UID, started.flowId)).toMatchObject({
      state: 'completed',
      instance: { id: 'wecom-bot-1' },
    });
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });
});
