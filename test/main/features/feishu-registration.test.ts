import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

type RegistrationResult = {
  client_id: string;
  client_secret: string;
  user_info?: { tenant_brand?: 'feishu' | 'lark'; open_id?: string; name?: string };
};

type PollMock = RegistrationResult | { error: string };

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

/** Replace the registration protocol transport with a scripted form-post
 * mock. `polls` is consumed one entry per poll call; a missing entry keeps
 * returning authorization_pending so a flow only advances when the test
 * supplies results. */
function installProtocol(
  feature: {
    _feishuRegistrationProtocol: {
      formPost: (flow: unknown, baseUrl: string, body: Record<string, string>) => Promise<Record<string, unknown>>;
    };
  },
  opts: {
    qrUrl?: string;
    expiresInSeconds?: number;
    polls?: Array<PollMock | Error>;
    onFormPost?: (body: Record<string, string>) => void;
  } = {},
) {
  const pollQueue = [...(opts.polls ?? [])];
  const formPost = vi.fn(async (_flow: unknown, _baseUrl: string, body: Record<string, string>) => {
    opts.onFormPost?.(body);
    if (body.action === 'begin') {
      return {
        device_code: 'device-1',
        verification_uri_complete: opts.qrUrl ?? 'https://accounts.feishu.cn/oauth/authorize?code=temporary',
        expires_in: opts.expiresInSeconds ?? 600,
        interval: 1,
      };
    }
    if (body.action === 'poll') {
      const next = pollQueue.shift();
      if (next instanceof Error) throw next;
      if (!next) return { error: 'authorization_pending' };
      if ('error' in next) return { error: next.error };
      return {
        client_id: next.client_id,
        client_secret: next.client_secret,
        ...(next.user_info ? { user_info: next.user_info } : {}),
      };
    }
    return {};
  });
  feature._feishuRegistrationProtocol.formPost = formPost;
  return { formPost };
}

describe('Feishu QR registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.doUnmock('../../../src/main/features/messaging/manager');
    vi.doUnmock('../../../src/main/features/messaging/registry');
    vi.resetModules();
  });

  it('keeps the QR URL in main memory and stores a successful Lark registration without returning secrets', async () => {
    const createInstance = vi.fn(async () => clientInstance({ enabled: false }));
    const setEnabled = vi.fn(async () => clientInstance());
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const formBodies: Array<Record<string, string>> = [];
    installProtocol(feature, {
      polls: [
        { error: 'authorization_pending' },
        {
          client_id: 'cli_1234567890abcdef',
          client_secret: 'secret-value',
          user_info: { tenant_brand: 'lark', open_id: 'ou_owner_1', name: 'Owner One' },
        },
      ],
      onFormPost: (body) => formBodies.push(body),
    });

    const started = await feature.startFeishuQrRegistration('user-1', {
      displayName: 'Team helper',
      workspace: { type: 'default' },
      policy: { requireMentionInGroups: true },
    });
    expect(started.state).toBe('starting');
    expect(started).not.toHaveProperty('client_secret');

    // begin completes → the QR is presented with the creation preset params.
    // (the state may already have advanced past awaiting_scan into polling,
    // but the qrUrl stays until activation clears it).
    await vi.waitFor(() => {
      const current = feature.getFeishuQrRegistrationStatus('user-1', started.flowId);
      expect(current.qrUrl).toBeTruthy();
    }, { timeout: 3000 });
    const waiting = feature.getFeishuQrRegistrationStatus('user-1', started.flowId);
    expect(waiting.qrUrl).toContain('accounts.feishu.cn/oauth/authorize');
    expect(waiting.qrUrl).toContain('from=mateagent');
    expect(waiting.qrUrl).toContain('tp=mateagent');
    expect(waiting.qrUrl).toContain('addons=');
    expect(waiting.qrUrl).toContain('name=');

    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'), { timeout: 5000 });
    expect(createInstance).toHaveBeenCalledTimes(1);
    const createdInput = createInstance.mock.calls[0]?.[1];
    expect(createdInput).toMatchObject({
      platform: 'feishu_lark',
      feishuTenantBrand: 'lark',
      displayName: 'Team helper',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
      ownerExternalUserId: 'ou_owner_1',
      ownerExternalUserName: 'Owner One',
      ownerIdentitySource: 'qr',
    });
    expect(createdInput).not.toHaveProperty('policy.allowUserIds');
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', started.flowId))).not.toContain('secret-value');
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'completed',
      instance: { id: 'feishu-bot-1', enabled: true, feishuTenantBrand: 'lark' },
    });

    // The poll must carry tp=ob_app so the platform creates a fully
    // configured bot (event subscription included) — mirrors hermes-agent.
    expect(formBodies).toContainEqual(expect.objectContaining({ action: 'begin' }));
    expect(formBodies).toContainEqual(expect.objectContaining({ action: 'poll', tp: 'ob_app' }));
  });

  it('polls through authorization_pending and slow_down until the scan succeeds', async () => {
    const createInstance = vi.fn(async () => clientInstance({ enabled: false }));
    const setEnabled = vi.fn(async () => clientInstance());
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    const { formPost } = installProtocol(feature, {
      polls: [
        { error: 'authorization_pending' },
        { error: 'slow_down' },
        {
          client_id: 'cli_1234567890abcdef',
          client_secret: 'secret-value',
          user_info: { tenant_brand: 'feishu', open_id: 'ou_owner_1' },
        },
      ],
    });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'), { timeout: 8000 });
    // 1 begin + 3 polls
    expect(formPost).toHaveBeenCalledTimes(4);
    const pollBodies = formPost.mock.calls.map(([, , body]) => body).filter((body) => body.action === 'poll');
    expect(pollBodies).toHaveLength(3);
  });

  it('exposes slow_down with a backed-off interval', async () => {
    const createInstance = vi.fn();
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled: vi.fn(),
      deleteInstance: vi.fn(async () => true),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, { polls: [{ error: 'slow_down' }] });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('slow_down'));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).intervalSeconds).toBe(6);
    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('rejects untrusted QR hosts and never creates an instance', async () => {
    const createInstance = vi.fn();
    vi.doMock('../../../src/main/features/messaging/manager', () => ({ createInstance, deleteInstance: vi.fn() }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, { qrUrl: 'https://attacker.example/steal?code=temporary' });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('failed'));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ errorCode: 'invalid_response' });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('cancels a flow before a late registration result can create a robot', async () => {
    const createInstance = vi.fn();
    vi.doMock('../../../src/main/features/messaging/manager', () => ({ createInstance, deleteInstance: vi.fn() }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      polls: [
        { error: 'authorization_pending' },
        {
          client_id: 'cli_1234567890abcdef',
          client_secret: 'secret-value',
          user_info: { open_id: 'ou_owner_1' },
        },
      ],
    });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => {
      const current = feature.getFeishuQrRegistrationStatus('user-1', started.flowId);
      expect(current.qrUrl).toBeTruthy();
    }, { timeout: 3000 });
    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('retains an invalid QR failure even when the flow is aborted', async () => {
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance: vi.fn(),
      deleteInstance: vi.fn(),
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, { qrUrl: 'https://invalid.example/authorize?code=temporary' });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'invalid_response',
    }));
  });

  it('cancels an activation race, retries stale-instance cleanup, and never enables it', async () => {
    const creation = deferred<ReturnType<typeof clientInstance>>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    const deleteInstance = vi.fn()
      .mockRejectedValueOnce(new Error('temporary local write failure'))
      .mockResolvedValue(true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(2));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('expires while instance creation is in flight and compensates before enabling', async () => {
    const creation = deferred<ReturnType<typeof clientInstance>>();
    const createInstance = vi.fn(() => creation.promise);
    const setEnabled = vi.fn();
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      expiresInSeconds: 30,
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
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
    const enabling = deferred<ReturnType<typeof clientInstance>>();
    const created = clientInstance({ enabled: false });
    const createInstance = vi.fn(async () => created);
    const setEnabled = vi.fn(() => enabling.promise);
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      expiresInSeconds: 30,
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
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
    const enabling = deferred<ReturnType<typeof clientInstance>>();
    const created = clientInstance({ enabled: false });
    const createInstance = vi.fn(async () => created);
    const setEnabled = vi.fn(() => enabling.promise);
    const deleteInstance = vi.fn().mockResolvedValue(true);
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled,
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith('user-1', created.id, true));

    expect(feature.cancelFeishuQrRegistration('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
    enabling.resolve(clientInstance({ enabled: true }));

    await vi.waitFor(() => expect(deleteInstance).toHaveBeenCalledTimes(1));
    expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({ state: 'cancelled' });
  });

  it('surfaces a cleanup failure instead of hiding the residual local instance', async () => {
    const creation = deferred<ReturnType<typeof clientInstance>>();
    const createInstance = vi.fn(() => creation.promise);
    const deleteInstance = vi.fn().mockRejectedValue(new Error('local storage unavailable'));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled: vi.fn(),
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });

    const started = await feature.startFeishuQrRegistration('user-1', { displayName: 'Helper' });
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
    const creation = deferred<ReturnType<typeof clientInstance>>();
    const createInstance = vi.fn(() => creation.promise);
    const deleteInstance = vi.fn().mockRejectedValue(new Error('local storage unavailable'));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      createInstance,
      setEnabled: vi.fn(),
      deleteInstance,
    }));

    const feature = await import('../../../src/main/features/messaging/feishu-registration');
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { open_id: 'ou_owner_1' },
      }],
    });

    const first = await feature.startFeishuQrRegistration('user-1', { displayName: 'First helper' });
    await vi.waitFor(() => expect(createInstance).toHaveBeenCalledTimes(1));

    const second = await feature.startFeishuQrRegistration('user-1', { displayName: 'Second helper' });
    creation.resolve(clientInstance({ enabled: false }));

    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', first.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'activation_failed',
      instance: { id: 'feishu-bot-1' },
    }));
    expect(feature.getFeishuQrRegistrationStatus('user-1', second.flowId)).toMatchObject({ state: 'polling' });
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', first.flowId))).not.toContain('secret-value');
    expect(deleteInstance).toHaveBeenCalledTimes(3);
    feature.cancelFeishuQrRegistration('user-1', second.flowId);
  });

  it('binds a successful scan to the exact draft and authorizes the scanner as the first user', async () => {
    const draft = clientInstance({
      id: 'feishu-draft-1',
      feishuTenantBrand: 'feishu',
      enabled: false,
      hasCredentials: false,
    });
    const bound = clientInstance({ id: 'feishu-draft-1', enabled: false, hasCredentials: true });
    const bindFeishuDraft = vi.fn(async () => bound);
    const setEnabled = vi.fn(async () => clientInstance({ id: 'feishu-draft-1', enabled: true }));
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
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { tenant_brand: 'feishu', open_id: 'ou_scanner', name: 'Scanner' },
      }],
    });

    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'feishu-draft-1');
    expect(started.state).toBe('starting');
    expect(started).not.toHaveProperty('client_secret');
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'));
    expect(bindFeishuDraft).toHaveBeenCalledWith('user-1', 'feishu-draft-1', {
      feishuTenantBrand: 'feishu',
      secret: { appId: 'cli_1234567890abcdef', appSecret: 'secret-value' },
      initialAllowUserId: 'ou_scanner',
      ownerExternalUserId: 'ou_scanner',
      ownerExternalUserName: 'Scanner',
    });
    expect(setEnabled).toHaveBeenCalledWith('user-1', 'feishu-draft-1', true);
    expect(JSON.stringify(feature.getFeishuQrRegistrationStatus('user-1', started.flowId))).not.toContain('secret-value');
  });

  it('starts an existing Lark draft on the shared accounts domain and preserves its tenant brand', async () => {
    const draft = clientInstance({
      id: 'lark-draft-1',
      feishuTenantBrand: 'lark',
      enabled: false,
      hasCredentials: false,
    });
    const bindFeishuDraft = vi.fn(async () => clientInstance({ id: 'lark-draft-1', enabled: false }));
    vi.doMock('../../../src/main/features/messaging/manager', () => ({
      setEnabled: vi.fn(async () => clientInstance({ id: 'lark-draft-1', enabled: true })),
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
    const formBodies: Array<Record<string, string>> = [];
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { tenant_brand: 'lark', open_id: 'ou_lark_owner' },
      }],
      onFormPost: (body) => formBodies.push(body),
    });

    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'lark-draft-1');

    expect(started.state).toBe('starting');
    // Registration always begins on the shared accounts.feishu.cn domain (the
    // launcher only recognizes codes issued there); the brand is applied at
    // activation time from the scan result.
    await vi.waitFor(() => expect(formBodies.some((body) => body.action === 'begin')).toBe(true));
    expect(formBodies).not.toContainEqual(expect.objectContaining({ domain: 'accounts.larksuite.com' }));
    // The poll must carry tp=ob_app so the platform configures the event
    // subscription on creation — mirrors hermes-agent.
    const pollBody = formBodies.find((body) => body.action === 'poll');
    expect(pollBody).toMatchObject({ action: 'poll', tp: 'ob_app' });

    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId).state).toBe('completed'));
    expect(bindFeishuDraft).toHaveBeenCalledWith('user-1', 'lark-draft-1', expect.objectContaining({
      feishuTenantBrand: 'lark',
      initialAllowUserId: 'ou_lark_owner',
    }));
  });

  it('rejects a scan result whose tenant brand does not match the selected draft channel', async () => {
    const draft = clientInstance({
      id: 'lark-draft-1',
      feishuTenantBrand: 'lark',
      enabled: false,
      hasCredentials: false,
    });
    const bindFeishuDraft = vi.fn();
    const setEnabled = vi.fn();
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
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { tenant_brand: 'feishu', open_id: 'ou_wrong_brand' },
      }],
    });

    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'lark-draft-1');
    await vi.waitFor(() => expect(feature.getFeishuQrRegistrationStatus('user-1', started.flowId)).toMatchObject({
      state: 'failed',
      errorCode: 'activation_failed',
    }));
    expect(bindFeishuDraft).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('revokes draft credentials when a bound scan is cancelled and keeps the draft', async () => {
    const binding = deferred<ReturnType<typeof clientInstance>>();
    const draft = clientInstance({
      id: 'feishu-draft-1',
      feishuTenantBrand: 'feishu',
      enabled: false,
      hasCredentials: false,
    });
    const bindFeishuDraft = vi.fn(() => binding.promise);
    const revokeFeishuDraftCredentials = vi.fn(async () => ({ revoked: true, instance: draft }));
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
    installProtocol(feature, {
      polls: [{
        client_id: 'cli_1234567890abcdef',
        client_secret: 'secret-value',
        user_info: { tenant_brand: 'feishu', open_id: 'ou_scanner', name: 'Scanner' },
      }],
    });

    const started = await feature.startFeishuQrRegistrationForInstance('user-1', 'feishu-draft-1');
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
