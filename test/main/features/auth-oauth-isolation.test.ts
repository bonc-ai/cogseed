import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OWNER_A = 'oauth-owner-a';
const OWNER_B = 'oauth-owner-b';

const oauthLogin = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@earendil-works/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(() => ({
    usesCallbackServer: false,
    login: oauthLogin,
  })),
  getOAuthProviders: vi.fn(() => []),
}));

vi.mock('../../../src/main/features/oauth-minimax', () => ({
  registerMinimaxOAuthProviders: vi.fn(async () => undefined),
}));

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-oauth-isolation-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function loadAuth() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(OWNER_A);
  const auth = await import('../../../src/main/features/auth');
  return { auth, users };
}

describe('auth OAuth user isolation', () => {
  it('keeps a flow and its completed profile bound to its owner after an active-user switch', async () => {
    let loginOptions: any;
    oauthLogin.mockImplementation(async (options: any) => {
      loginOptions = options;
      const value = await options.onPrompt({ message: 'Enter the code' });
      return {
        access: `access-${value}`,
        refresh: 'refresh-a',
        expires: Date.now() + 60_000,
      };
    });

    const { auth, users } = await loadAuth();
    const started = await auth.startOAuth(OWNER_A, 'test-provider');
    expect(started.status.kind).toBe('awaiting_input');

    users.activateUser(OWNER_B);
    expect(auth.pollOAuthFlow(OWNER_B, started.flowId)).toEqual({
      status: { kind: 'error', error: 'unknown flow' },
    });
    expect(auth.submitOAuthInput(OWNER_B, started.flowId, 'intruder')).toEqual({ ok: false });
    expect(auth.cancelOAuthFlow(OWNER_B, started.flowId)).toEqual({ ok: false });

    expect(auth.submitOAuthInput(OWNER_A, started.flowId, 'owner-code')).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(auth.pollOAuthFlow(OWNER_A, started.flowId).status.kind).toBe('done');
    });

    expect(loginOptions).toBeDefined();
    const ownerProfiles = Object.values(auth.loadProfilesForUser(OWNER_A).profiles);
    expect(ownerProfiles).toHaveLength(1);
    expect(ownerProfiles[0]).toMatchObject({
      type: 'oauth',
      access: 'access-owner-code',
    });
    expect(auth.loadProfilesForUser(OWNER_B).profiles).toEqual({});
  });

  it('allows only the owner to cancel a flow', async () => {
    oauthLogin.mockImplementation(async (options: any) => {
      await options.onPrompt({ message: 'Enter the code' });
      return { access: 'unused', refresh: 'unused', expires: Date.now() + 60_000 };
    });

    const { auth, users } = await loadAuth();
    const started = await auth.startOAuth(OWNER_A, 'test-provider');

    users.activateUser(OWNER_B);
    expect(auth.cancelOAuthFlow(OWNER_B, started.flowId)).toEqual({ ok: false });
    expect(auth.pollOAuthFlow(OWNER_B, started.flowId).status).toEqual({
      kind: 'error',
      error: 'unknown flow',
    });

    expect(auth.cancelOAuthFlow(OWNER_A, started.flowId)).toEqual({ ok: true });
    expect(auth.pollOAuthFlow(OWNER_A, started.flowId).status).toEqual({
      kind: 'error',
      error: 'cancelled',
    });
  });

  it('keeps cancellation terminal when a provider resolves after abort', async () => {
    let resolveLogin!: (credentials: { access: string; refresh: string; expires: number }) => void;
    const deferredLogin = new Promise<{ access: string; refresh: string; expires: number }>((resolve) => {
      resolveLogin = resolve;
    });
    oauthLogin.mockImplementation(() => deferredLogin);

    const { auth } = await loadAuth();
    const started = await auth.startOAuth(OWNER_A, 'test-provider');
    expect(auth.cancelOAuthFlow(OWNER_A, started.flowId)).toEqual({ ok: true });

    resolveLogin({ access: 'late-access', refresh: 'late-refresh', expires: Date.now() + 60_000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.pollOAuthFlow(OWNER_A, started.flowId).status).toEqual({
      kind: 'error',
      error: 'cancelled',
    });
    expect(auth.loadProfilesForUser(OWNER_A).profiles).toEqual({});
  });

  it('keeps cancellation terminal when a provider rejects after abort', async () => {
    let rejectLogin!: (error: Error) => void;
    const deferredLogin = new Promise<never>((_, reject) => {
      rejectLogin = reject;
    });
    oauthLogin.mockImplementation(() => deferredLogin);

    const { auth } = await loadAuth();
    const started = await auth.startOAuth(OWNER_A, 'test-provider');
    expect(auth.cancelOAuthFlow(OWNER_A, started.flowId)).toEqual({ ok: true });

    rejectLogin(new Error('late provider failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.pollOAuthFlow(OWNER_A, started.flowId).status).toEqual({
      kind: 'error',
      error: 'cancelled',
    });
  });

  it('cleans up completed and failed flows after the polling window', async () => {
    vi.useFakeTimers();
    let resolveLogin!: (credentials: { access: string; refresh: string; expires: number }) => void;
    oauthLogin.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLogin = resolve;
    }));

    const { auth } = await loadAuth();
    const completed = await auth.startOAuth(OWNER_A, 'test-provider');
    resolveLogin({ access: 'access-a', refresh: 'refresh-a', expires: Date.now() + 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.pollOAuthFlow(OWNER_A, completed.flowId).status.kind).toBe('done');

    await vi.advanceTimersByTimeAsync(4_999);
    expect(auth.pollOAuthFlow(OWNER_A, completed.flowId).status.kind).toBe('done');
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.pollOAuthFlow(OWNER_A, completed.flowId).status).toEqual({
      kind: 'error',
      error: 'unknown flow',
    });

    oauthLogin.mockImplementationOnce(async () => {
      throw new Error('provider failure');
    });
    const failed = await auth.startOAuth(OWNER_A, 'test-provider');
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.pollOAuthFlow(OWNER_A, failed.flowId).status).toEqual({
      kind: 'error',
      error: 'provider failure',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(auth.pollOAuthFlow(OWNER_A, failed.flowId).status).toEqual({
      kind: 'error',
      error: 'unknown flow',
    });

    let resolveCancelledLogin!: (credentials: { access: string; refresh: string; expires: number }) => void;
    oauthLogin.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCancelledLogin = resolve;
    }));
    const cancelled = await auth.startOAuth(OWNER_A, 'test-provider');
    expect(auth.cancelOAuthFlow(OWNER_A, cancelled.flowId)).toEqual({ ok: true });
    expect(auth.pollOAuthFlow(OWNER_A, cancelled.flowId).status).toEqual({
      kind: 'error',
      error: 'cancelled',
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(auth.pollOAuthFlow(OWNER_A, cancelled.flowId).status).toEqual({
      kind: 'error',
      error: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.pollOAuthFlow(OWNER_A, cancelled.flowId).status).toEqual({
      kind: 'error',
      error: 'unknown flow',
    });

    resolveCancelledLogin({ access: 'late-access', refresh: 'late-refresh', expires: Date.now() + 60_000 });
    await Promise.resolve();
    await Promise.resolve();
  });
});
