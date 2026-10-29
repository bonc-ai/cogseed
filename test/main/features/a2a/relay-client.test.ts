import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Relay 客户端只认**当前身份的正常会话**（T2.2）。
 *
 * 这里同时钉住两件事：请求信封（稳定 requestId 同时进 body 与幂等头、非法正文
 * 不发请求），以及「没有会话就不发」——环境 Token 不再是可用身份。
 */
const USER = 'u1';
const previousBase = process.env.COGSEED_HUB_API_BASE;
const previousUrl = process.env.COGSEED_A2A_HUB_URL;
const previousToken = process.env.COGSEED_A2A_HUB_TOKEN;
let tmp: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-relay-client-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  process.env.COGSEED_HUB_API_BASE = 'https://hub.example.test';
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { messageId: 'hub-message-1' } }),
  })));
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const now = Date.now();
  saveHubSession(USER, {
    session_id: 'session-1',
    access_token: 'session-token',
    refresh_token: 'refresh-1',
    access_expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
  } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousBase === undefined) delete process.env.COGSEED_HUB_API_BASE;
  else process.env.COGSEED_HUB_API_BASE = previousBase;
  if (previousUrl === undefined) delete process.env.COGSEED_A2A_HUB_URL;
  else process.env.COGSEED_A2A_HUB_URL = previousUrl;
  if (previousToken === undefined) delete process.env.COGSEED_A2A_HUB_TOKEN;
  else process.env.COGSEED_A2A_HUB_TOKEN = previousToken;
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a2a relay client › idempotent request envelope', () => {
  it('passes the stable request id in both the Hub envelope and idempotency header', async () => {
    const { sendRelayMessageDetailed } = await import('../../../../src/main/features/a2a/relay-client');
    await expect(sendRelayMessageDetailed(USER, {
      to: 'cs_alice',
      conversationId: 'a2a-0123456789abcdef0123',
      kind: 'question',
      text: 'hello',
      requestId: 'req-stable-1',
    })).resolves.toEqual({ ok: true, messageId: 'hub-message-1' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({
      'idempotency-key': 'req-stable-1',
      // The normal session token is what reaches Hub, not an env fixture.
      authorization: 'Bearer session-token',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({ requestId: 'req-stable-1' });
  });

  it('rejects empty and over-limit text before contacting the Hub', async () => {
    const { sendRelayMessageDetailed } = await import('../../../../src/main/features/a2a/relay-client');
    for (const text of ['', '   ', 'x'.repeat(4_001), 'x'.repeat(12_000)]) {
      await expect(sendRelayMessageDetailed(USER, {
        to: 'cs_alice',
        conversationId: 'a2a-0123456789abcdef0123',
        kind: 'question',
        text,
        requestId: 'req-invalid-text',
      })).resolves.toEqual({ ok: false, code: 'INVALID_MESSAGE' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to send when the identity has no normal session, even with an env token', async () => {
    const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
    clearHubSession(USER);
    process.env.COGSEED_A2A_HUB_URL = 'https://hub.example.test';
    process.env.COGSEED_A2A_HUB_TOKEN = 'dev-token';
    const { sendRelayMessageDetailed, relayConfigured } = await import('../../../../src/main/features/a2a/relay-client');

    await expect(sendRelayMessageDetailed(USER, {
      to: 'cs_alice',
      conversationId: 'a2a-0123456789abcdef0123',
      kind: 'question',
      text: 'hello',
    })).resolves.toEqual({ ok: false, code: 'HUB_NOT_CONFIGURED' });
    expect(relayConfigured(USER)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
