import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) throw new Error('deferred promise initialization failed');
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function clientInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'feishu-bot-1',
    platform: 'feishu_lark' as const,
    feishuTenantBrand: 'lark' as const,
    displayName: 'Team helper',
    enabled: true,
    workspace: { type: 'default' as const },
    policy: {
      replyMode: 'every_message' as const,
      allowUserIds: [],
      allowGroupIds: [],
      requireMentionInGroups: true,
    },
    status: { kind: 'connecting' as const, checkedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasCredentials: true,
    ...overrides,
  };
}

describe('Feishu QR registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.doUnmock('@larksuiteoapi/node-sdk');
    vi.doUnmock('../../../src/main/features/messaging/manager');
    vi.doUnmock('../../../src/main/features/messaging/registry');
    vi.resetModules();
  });

  it('keeps the QR URL in main memory and stores a successful Lark registration without returning secrets', async () => {
    const registration = deferred<{ client_id: string; client_secret: string; user_info: { tenant_brand: 'lark' } }>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    let statusChanged: ((info: { status: 'polling' | 'slow_down' | 'domain_switched'; interval?: number }) => void) | undefined;
    const registerApp = vi.fn((options: {
      onQRCodeReady: (info: { url: string; expireIn: number }) => void;
      onStatusChange?: (info: { status: 'polling' | 'slow_down' | 'domain_switched'; interval?: number }) => void;
      signal: AbortSignal;
    }) => {
      qrReady = options.onQRCodeReady;
      statusChanged = options.onStatusChange;
      return registration.promise;
    });
    const createInstance = vi.fn(async () => clientInstance({ enabled: false }));
    const setEnabled = vi.fn(async () => clientInstance());
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', {
      displayName: 'Team helper',
      workspace: { type: 'default' },
      policy: { requireMentionInGroups: true },
    });
    expect(started.state).toBe('starting');
    expect(started).not.toHaveProperty('client_secret');
    expect(qrReady).toBeTypeOf('function');
    expect(registerApp).toHaveBeenCalledWith(expect.objectContaining({
      appPreset: { name: 'Team helper' },
      addons: {
        preset: false,
        scopes: { tenant: ['im:message:send_as_bot'] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
      },
    }));
    // The landing page must keep the "已有应用" (reuse existing app) entry
    // point enabled next to "立即创建"; passing createOnly would disable it.
    expect(registerApp.mock.calls[0]?.[0]).not.toHaveProperty('createOnly');

    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    const waiting = feature.getFeishuQrRegistrationStatus('user-1', started.flowId);
    expect(waiting).toMatchObject({
      state: 'awaiting_scan',
      qrUrl: 'https://accounts.feishu.cn/oauth/authorize?code=temporary',
    });
    statusChanged?.({ status: 'slow_down', interval: 12 });
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'slow_down',
      intervalSeconds: 12,
    });

    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value', user_info: { tenant_brand: 'lark' } });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'));
    expect(createInstance).toHaveBeenCalledTimes(1);
    const createdInput = createInstance.mock.calls[0]?.[1];
    expect(createdInput).toMatchObject({
      platform: 'feishu_lark',
      feishuTenantBrand: 'lark',
      displayName: 'Team helper',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
    });
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', started.flowId))).not.toContain('secret-value');
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'completed',
      instance: { id: 'feishu-bot-1', enabled: true, feishuTenantBrand: 'lark' },
    });
  });

  it('rejects untrusted QR hosts and never creates an instance', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const createInstance = vi.fn();
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({ createInstance, deleteInstance: vi.fn() }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://attacker.example/steal?code=temporary', expireIn: 600 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('failed'));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ errorCode: 'invalid_response' });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('cancels a flow before a late registration result can create a robot', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const createInstance = vi.fn();
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({ createInstance, deleteInstance: vi.fn() }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.larksuite.com/oauth/authorize?code=temporary', expireIn: 600 });
    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('retains an invalid QR failure when aborting the official flow rejects its promise', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance: vi.fn(),
      deleteInstance: vi.fn(),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://invalid.example/authorize?code=temporary', expireIn: 600 });
    registration.reject({ code: 'abort' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'invalid_response',
    }));
  });

  it('cancels an activation race, retries stale-instance cleanup, and never enables it', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    const creation = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    const deleteInstance = vi.fn()
      .mockRejectedValueOnce(new Error('temporary local write failure'))
      .mockResolvedValue(true);
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(2));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('expires while instance creation is in flight and compensates before enabling', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    const creation = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 30 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    nowSpy.mockReturnValue(now + 31_000);
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(1));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'expired',
      errorCode: 'expired_token',
    });
  });

  it('expires while enabling is in flight and deletes the resulting instance', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    const enabling = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const created = clientInstance({ enabled: false });
    const createInstance = vi.fn(async () => created);
    const setEnabled = vi.fn(() => enabling.promise);
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 30 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith('user-1', created.id, true));

    nowSpy.mockReturnValue(now + 31_000);
    enabling.resolve(clientInstance({ enabled: true }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(1));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'expired',
      errorCode: 'expired_token',
    });
  });

  it('cancels while enabling is in flight and compensates after the await resolves', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    const enabling = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const created = clientInstance({ enabled: false });
    const createInstance = vi.fn(async () => created);
    const setEnabled = vi.fn(() => enabling.promise);
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith('user-1', created.id, true));

    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    enabling.resolve(clientInstance({ enabled: true }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(1));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('surfaces a cleanup failure instead of hiding the residual local instance', async () => {
    const registration = deferred<{ client_id: string; client_secret: string }>();
    const creation = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const createInstance = vi.fn(() => creation.promise);
    const deleteInstance = vi.fn().mockRejectedValue(new Error('local storage unavailable'));
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled: vi.fn(),
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    registration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    feature.cancelFeishuQrRegistration('user-1', started.flowId);
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'activation_failed',
      instance: { id: 'feishu-bot-1' },
    }));
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', started.flowId))).not.toContain('secret-value');
    expect(deleteInstance).toHaveBeenCalledTimes(3);
  });

  it('retains a failed cleanup status when a newer flow supersedes the old one', async () => {
    const firstRegistration = deferred<{ client_id: string; client_secret: string }>();
    const secondRegistration = deferred<{ client_id: string; client_secret: string }>();
    const creation = deferred<ReturnType<typeof clientInstance>>();
    let invocation = 0;
    let firstQrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      invocation += 1;
      if (invocation === 1) firstQrReady = options.onQRCodeReady;
      return invocation === 1 ? firstRegistration.promise : secondRegistration.promise;
    });
    const createInstance = vi.fn(() => creation.promise);
    const deleteInstance = vi.fn().mockRejectedValue(new Error('local storage unavailable'));
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled: vi.fn(),
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const first = await feature.startFeishuQrRegistration('user-1', { displayName: 'First helper' });
    firstQrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    firstRegistration.resolve({ client_id: 'cli_1234567890abcdef', client_secret: 'secret-value' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    const second = await feature.startFeishuQrRegistration('user-1', { displayName: 'Second helper' });
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', first.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'activation_failed',
      instance: { id: 'feishu-bot-1' },
    }));
    expect(feature.getFeishuQrRegistrationStatus('user-1', second.flowId)).toMatchObject({ state: 'starting' });
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', first.flowId))).not.toContain('secret-value');
    expect(deleteInstance).toHaveBeenCalledTimes(3);
    feature.cancelFeishuQrRegistration('user-1', second.flowId);
  });

  it('binds a successful scan to the exact draft and authorizes the scanner as the first user', async () => {
    const registration = deferred<{ client_id: string; client_secret: string; user_info: { tenant_brand: 'feishu'; open_id: string } }>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const draft = clientInstance({ id: 'feishu-draft-1', enabled: false, hasCredentials: false });
    const bound = clientInstance({ id: 'feishu-draft-1', enabled: false, hasCredentials: true });
    const bindFeishuDraft = vi.fn(async () => bound);
    const setEnabled = vi.fn(async () => clientInstance({ id: 'feishu-draft-1', enabled: true }));
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));
    vi.doMock('../../../src/main/features/messaging/registry', () => ({
      isValidInstanceId: vi.fn(() => true),
      getInstance: vi.fn(async () => draft),
      getInstanceWithSecret: vi.fn(async () => null),
      bindFeishuDraft,
      revokeFeishuDraftCredentials: vi.fn(async () => ({ revoked: false, instance: null })),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'feishu-draft-1');
    expect(started.state).toBe('starting');
    expect(started).not.toHaveProperty('client_secret');
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    registration.resolve({
      client_id: 'cli_1234567890abcdef',
      client_secret: 'secret-value',
      user_info: { tenant_brand: 'feishu', open_id: 'ou_scanner' },
    });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'));
    expect(bindFeishuDraft).toHaveBeenCalledWith('user-1', 'feishu-draft-1', {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
      initialAllowUserId: 'ou_scanner',
    });
    expect(setEnabled).toHaveBeenCalledWith('user-1', 'feishu-draft-1', true);
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', started.flowId))).not.toContain('secret-value');
  });

  it('revokes draft credentials when a bound scan is cancelled and keeps the draft', async () => {
    const registration = deferred<{ client_id: string; client_secret: string; user_info: { tenant_brand: 'feishu'; open_id: string } }>();
    const binding = deferred<ReturnType<typeof clientInstance>>();
    let qrReady: ((info: { url: string; expireIn: number }) => void) | undefined;
    const registerApp = vi.fn((options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      qrReady = options.onQRCodeReady;
      return registration.promise;
    });
    const draft = clientInstance({ id: 'feishu-draft-1', enabled: false, hasCredentials: false });
    const bindFeishuDraft = vi.fn(() => binding.promise);
    const revokeFeishuDraftCredentials = vi.fn(async () => ({ revoked: true, instance: draft }));
    vi.doMock('@larksuiteoapi/node-sdk', () => ({ registerApp }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      setEnabled: vi.fn(),
      deleteInstance: vi.fn(async () => true),
    }));
    vi.doMock('../../../src/main/features/messaging/registry', () => ({
      isValidInstanceId: vi.fn(() => true),
      getInstance: vi.fn(async () => draft),
      getInstanceWithSecret: vi.fn(async () => null),
      bindFeishuDraft,
      revokeFeishuDraftCredentials,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'feishu-draft-1');
    qrReady?.({ url: 'https://accounts.feishu.cn/oauth/authorize?code=temporary', expireIn: 600 });
    registration.resolve({
      client_id: 'cli_1234567890abcdef',
      client_secret: 'secret-value',
      user_info: { tenant_brand: 'feishu', open_id: 'ou_scanner' },
    });
    await vi.waitFor(() => expect(bindFeishuDraft).toHaveBeenCalledTimes(1));

    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    binding.resolve(clientInstance({ id: 'feishu-draft-1', enabled: false, hasCredentials: true }));

    await vi.waitFor(() => expect(revokeFeishuDraftCredentials).toHaveBeenCalledTimes(1));
    expect(revokeFeishuDraftCredentials).toHaveBeenCalledWith('user-1', 'feishu-draft-1', {
      appId: 'cli_1234567890abcdef',
      appSecret: 'secret-value',
    });
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('accepts the official SDK launcher hosts for QR presentation', async () => {
    const { qrUrl } = (await import('../../../src/main/features/messaging/feishu-registration'))._feishuRegistrationTestHooks;
    expect(qrUrl('https://open.feishu.cn/page/launcher?user_code=AB12-CD34&from=sdk')).toContain('open.feishu.cn');
    expect(qrUrl('https://open.larksuite.com/page/launcher?user_code=AB12-CD34&from=sdk')).toContain('open.larksuite.com');
    expect(qrUrl('https://accounts.feishu.cn/oauth/authorize?code=temporary')).toContain('accounts.feishu.cn');
    expect(() => qrUrl('https://evil.example/steal?code=x')).toThrow('untrusted QR URL');
  });
});
