/**
 * `browser_poll` authorization — the `interactive_token` variant WPS SkillHub needs.
 *
 * The provider has no OAuth authorization server and no CLI, so the flow is bespoke: generate a
 * code, open a consent page carrying it, then poll an exchange endpoint with that same code until a
 * token appears. Three properties are worth pinning, because each fails in a different, user-visible
 * way:
 *
 *  1. **The consent URL carries the code we generated** — a mismatch means the poll waits on a code
 *     nobody approved, and the user just sees a spinner until the deadline.
 *  2. **Response parsing is tolerant** — providers in this family put the token at
 *     `access_token`, `token`, or `data.access_token`; a strict parser turns a successful consent
 *     into a timeout.
 *  3. **Failure is classified, not hung** — a rejected code is terminal, while transport errors and
 *     "not approved yet" must keep polling, because the user may still be mid-consent.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

// `interactive-auth.ts` imports `electron` for `shell.openExternal`; the module under test never
// touches the real API because the browser open is fire-and-forget and we assert on the URL instead.
vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }));

const WPS_AUTH = {
  kind: 'browser_poll' as const,
  authorize_url: 'https://mcp-center.wps.cn/kdocs-auth/auth-guide',
  exchange_url: 'https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange',
  poll_interval_ms: 1,
  timeout_ms: 5_000,
};

async function loadModule() {
  return await import('../../../../src/main/features/connectors/interactive-auth');
}

/** A fetch stub that answers from a queue; the last entry repeats. */
function fetchQueue(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body,
    } as unknown as Response;
  };
  return { impl, calls };
}

describe('browser_poll authorization', () => {
  it('opens a consent URL carrying the generated code, then returns the token', async () => {
    const mod = await loadModule();
    const { impl, calls } = fetchQueue([{ body: { code: 0, data: { access_token: 'wps-tok-1' } } }]);
    let consentUrl = '';

    const token = await mod.authorizeBrowserPoll(WPS_AUTH, {
      fetchImpl: impl,
      onConsentUrl: (url) => { consentUrl = url; },
    });

    expect(token).toBe('wps-tok-1');
    const parsed = new URL(consentUrl);
    expect(parsed.origin + parsed.pathname).toBe('https://mcp-center.wps.cn/kdocs-auth/auth-guide');
    const code = parsed.searchParams.get('auth_code');
    expect(code).toMatch(/^[0-9a-f-]{36}$/);
    // The SAME code must reach the exchange endpoint, or consent can never match the poll.
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ code });
  });

  it('accepts every token placement this provider family uses', async () => {
    const mod = await loadModule();
    for (const [body, expected] of [
      [{ access_token: 'a' }, 'a'],
      [{ token: 'b' }, 'b'],
      [{ data: { access_token: 'c' } }, 'c'],
      [{ data: { token: 'd' } }, 'd'],
    ] as const) {
      const { impl } = fetchQueue([{ body }]);
      expect(await mod.authorizeBrowserPoll(WPS_AUTH, { fetchImpl: impl })).toBe(expected);
    }
  });

  it('honours an explicit token_field, including a dotted path', async () => {
    const mod = await loadModule();
    const { impl } = fetchQueue([{ body: { result: { ticket: 'e' } } }]);
    const token = await mod.authorizeBrowserPoll({ ...WPS_AUTH, token_field: 'result.ticket' }, { fetchImpl: impl });
    expect(token).toBe('e');
  });

  it('never treats an object at the named field as a credential', async () => {
    const mod = await loadModule();
    // `result` is an envelope, not a token: putting it in an Authorization header would send
    // "[object Object]". The flow must keep waiting instead.
    const { impl } = fetchQueue([{ body: { result: { ticket: 'e' } } }]);
    await expect(mod.authorizeBrowserPoll({ ...WPS_AUTH, token_field: 'result', timeout_ms: 30 }, { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'flow_timeout' });
  });

  it('keeps polling while the provider says "not approved yet"', async () => {
    const mod = await loadModule();
    // 200 without a token = pending; then the token appears.
    const { impl, calls } = fetchQueue([
      { body: { code: 0, data: {} } },
      { body: { code: 0, data: { access_token: 'late' } } },
    ]);

    expect(await mod.authorizeBrowserPoll(WPS_AUTH, { fetchImpl: impl })).toBe('late');
    expect(calls.length).toBe(2);
  });

  it('survives transient transport errors while the user is still consenting', async () => {
    const mod = await loadModule();
    let call = 0;
    const impl = async () => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, json: async () => ({ access_token: 'after-reset' }) } as unknown as Response;
    };

    expect(await mod.authorizeBrowserPoll(WPS_AUTH, { fetchImpl: impl })).toBe('after-reset');
  });

  it('fails fast on a rejected code instead of hanging until the deadline', async () => {
    const mod = await loadModule();
    const { impl, calls } = fetchQueue([{ status: 403, body: { error: 'invalid code' } }]);

    await expect(mod.authorizeBrowserPoll(WPS_AUTH, { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'exchange_failed' });
    // Terminal: one attempt, not a poll loop.
    expect(calls.length).toBe(1);
  });

  it('reports a deadline as flow_timeout, the code the connect UI already understands', async () => {
    const mod = await loadModule();
    const { impl } = fetchQueue([{ body: { code: 0, data: {} } }]);

    await expect(mod.authorizeBrowserPoll({ ...WPS_AUTH, timeout_ms: 30 }, { fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'flow_timeout' });
  });

  it('stops immediately when the connect attempt was cancelled', async () => {
    const mod = await loadModule();
    const { impl, calls } = fetchQueue([{ body: { code: 0, data: {} } }]);

    await expect(mod.authorizeBrowserPoll(WPS_AUTH, { fetchImpl: impl, isCancelled: () => true }))
      .rejects.toMatchObject({ code: 'user_cancelled' });
    expect(calls.length).toBe(0);
  });
});

describe('wps catalog entry', () => {
  it('points the browser_poll variant at the official SkillHub MCP endpoint', async () => {
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const entry = findCatalogEntry('wps');
    expect(entry).toBeTruthy();
    expect(entry!.auth_mode).toBe('interactive_token');
    expect(entry!.interactive_auth).toMatchObject({ kind: 'browser_poll' });
    expect(entry!.transport_template).toMatchObject({
      kind: 'streamable-http',
      url: 'https://mcp-center.wps.cn/skill_hub/mcp',
      oauth_header_key: 'Authorization',
    });
  });

  it('materializes the credential as a bearer header once one is obtained', async () => {
    const { applyTemplate } = await import('../../../../src/main/features/connectors/apply-template');
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');

    expect(applyTemplate(findCatalogEntry('wps')!, { access_token: 'tok' })).toEqual({
      kind: 'streamable-http',
      url: 'https://mcp-center.wps.cn/skill_hub/mcp',
      headers: { Authorization: 'Bearer tok' },
    });
  });
});
