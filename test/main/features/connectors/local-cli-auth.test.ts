/**
 * `local-cli-auth.ts` — the `auth_mode: 'local_cli'` authorization driver.
 *
 * This module is the only place that drives a browser login through the adapter, and its failure
 * modes are all user-visible, so each one is pinned here:
 *
 *  - an already-signed-in CLI must NOT start a redundant login;
 *  - a not-signed-in CLI must open the browser *and* publish the URL (so a browser that refuses to
 *    open is still recoverable);
 *  - the deadline and the cancel affordance must both end the attempt with a code the manager maps
 *    to a renderer outcome (`flow_timeout`, `user_cancelled`);
 *  - and every path must tear the ephemeral connection down, because a surviving `tmeet auth login`
 *    would be a stray process the user cannot see.
 *
 * The adapter itself is mocked here: it has its own suite (`tencent-stdio-adapter.test.ts`) that
 * covers URL extraction and process teardown for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: undefined as any,
  callTool: undefined as any,
  close: undefined as any,
  openExternal: undefined as any,
  broadcastAuthorizationUrl: undefined as any,
  transports: [] as any[],
}));

vi.mock('electron', () => ({
  // `apply-template.ts` reads `app.isPackaged` to decide whether to rewrite `app.asar` →
  // `app.asar.unpacked` in the resolved adapter path, so the mock has to provide it as well.
  app: { isPackaged: false },
  shell: { openExternal: (...args: any[]) => mocks.openExternal(...args) },
}));

/** The shape the adapter's MCP server returns: a single JSON text part.
 *  `McpConnection.callTool` hands this envelope through verbatim (only the model's tool path
 *  flattens it, in `tools-adapter.ts::stringifyMcpResult`), so the module under test must unwrap. */
function toolResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** An adapter-level failure — a text part plus `isError`, as produced when an adapter tool throws. */
function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({
  McpConnection: vi.fn().mockImplementation(function MockMcpConnection(_id: string, transport: any) {
    mocks.transports.push(transport);
    return {
      connect(...args: any[]) { return mocks.connect.apply(this, args); },
      // The REAL `McpConnection.callTool` returns the raw MCP envelope, not the parsed payload.
      // Enveloping here keeps every per-test stub honest: a test cannot accidentally hand the
      // code under test a pre-unwrapped object, which is what hid the envelope bug on a real machine.
      callTool(...args: any[]) {
        // A stub may return either a plain payload (enveloped here) or an explicit envelope
        // (`toolResult` / `toolError`, passed through). Either way the module under test always
        // receives the raw shape the real connection produces, so it cannot be handed a
        // pre-unwrapped object by accident.
        return Promise.resolve(mocks.callTool.apply(this, args)).then((value: any) =>
          value && Array.isArray(value.content) ? value : toolResult(value));
      },
      close(...args: any[]) { return mocks.close.apply(this, args); },
      get isConnected() { return true; },
    };
  }),
}));

vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({
  broadcastOAuthConnectOutcome: vi.fn(),
  broadcastAuthorizationUrl: (...args: any[]) => mocks.broadcastAuthorizationUrl(...args),
}));

const ENTRY = {
  id: 'tencent-meeting',
  display_name: 'Tencent Meeting',
  category: 'communication' as const,
  description_zh: '',
  description_en: '',
  auth_mode: 'local_cli' as const,
  transport_template: {
    kind: 'stdio' as const,
    command: '${COGSEED_NODE}',
    args: ['${COGSEED_PC_DIR}/bin/tencent-meeting-mcp-server.cjs'],
  },
};

const prevPoll = process.env.COGSEED_LOCAL_CLI_POLL_MS;
const prevTimeout = process.env.COGSEED_LOCAL_CLI_AUTH_TIMEOUT_MS;

beforeEach(() => {
  vi.resetModules();
  mocks.connect = vi.fn(async () => {});
  mocks.callTool = vi.fn(async () => ({}));
  mocks.close = vi.fn(async () => {});
  mocks.openExternal = vi.fn(async () => {});
  mocks.broadcastAuthorizationUrl = vi.fn();
  mocks.transports = [];
  // Small intervals keep the timeout/cancel cases fast without fake timers, which would otherwise
  // have to be driven through every `await` in the polling loop.
  process.env.COGSEED_LOCAL_CLI_POLL_MS = '5';
  process.env.COGSEED_LOCAL_CLI_AUTH_TIMEOUT_MS = '250';
});

afterEach(() => {
  if (prevPoll === undefined) delete process.env.COGSEED_LOCAL_CLI_POLL_MS;
  else process.env.COGSEED_LOCAL_CLI_POLL_MS = prevPoll;
  if (prevTimeout === undefined) delete process.env.COGSEED_LOCAL_CLI_AUTH_TIMEOUT_MS;
  else process.env.COGSEED_LOCAL_CLI_AUTH_TIMEOUT_MS = prevTimeout;
});

async function load() {
  return await import('../../../../src/main/features/connectors/local-cli-auth');
}

describe('local CLI authorization', () => {
  it('skips the login entirely when the CLI already holds a session', async () => {
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') return { logged_in: true, user_name: '晨曦' };
      return {};
    });

    const mod = await load();
    const result = await mod.ensureLocalCliAuthorized(ENTRY as any);

    expect(result).toEqual({ user_name: '晨曦' });
    // No authorization prompt, and no browser opened for a session that already exists.
    expect(calls).not.toContain('start_login');
    expect(mocks.openExternal).not.toHaveBeenCalled();
    // The ephemeral connection is still torn down.
    expect(calls).toContain('stop_login');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('opens the browser AND publishes the URL, then resolves once the poll reports a session', async () => {
    let polls = 0;
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') {
        polls += 1;
        return { logged_in: polls > 1, user_name: polls > 1 ? '晨曦' : '' };
      }
      if (name === 'start_login') {
        return { authorization_url: 'https://meeting.tencent.com/ai-skill/authorize?code=xyz' };
      }
      return {};
    });

    const mod = await load();
    const result = await mod.ensureLocalCliAuthorized(ENTRY as any);

    expect(result).toEqual({ user_name: '晨曦' });
    expect(calls).toContain('start_login');
    // Both, not either: the push is what makes a failed `openExternal` recoverable.
    expect(mocks.openExternal).toHaveBeenCalledWith('https://meeting.tencent.com/ai-skill/authorize?code=xyz');
    expect(mocks.broadcastAuthorizationUrl).toHaveBeenCalledWith({
      catalog_id: 'tencent-meeting',
      url: 'https://meeting.tencent.com/ai-skill/authorize?code=xyz',
    });
    expect(calls).toContain('stop_login');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('still succeeds when the browser refuses to open, because the URL was published first', async () => {
    let polls = 0;
    mocks.openExternal = vi.fn(async () => { throw new Error('no default browser'); });
    mocks.callTool = vi.fn(async (name: string) => {
      if (name === 'check_login') {
        polls += 1;
        return { logged_in: polls > 1, user_name: '晨曦' };
      }
      if (name === 'start_login') return { authorization_url: 'https://meeting.tencent.com/x' };
      return {};
    });

    const mod = await load();
    await expect(mod.ensureLocalCliAuthorized(ENTRY as any)).resolves.toEqual({ user_name: '晨曦' });
    expect(mocks.broadcastAuthorizationUrl).toHaveBeenCalled();
  });

  it('gives up with flow_timeout once the deadline passes, and tears everything down', async () => {
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') return { logged_in: false };
      if (name === 'start_login') return { authorization_url: 'https://meeting.tencent.com/x' };
      return {};
    });

    const mod = await load();
    // The manager maps this message to the renderer's `flow_timeout` outcome, so the wording is
    // load-bearing, not cosmetic.
    await expect(mod.ensureLocalCliAuthorized(ENTRY as any)).rejects.toThrow(/flow timed out/);
    expect(calls).toContain('stop_login');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('honours cancelLocalCliAuth while waiting, mapping to user_cancelled', async () => {
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') return { logged_in: false };
      if (name === 'start_login') return { authorization_url: 'https://meeting.tencent.com/x' };
      return {};
    });

    const mod = await load();
    const pending = mod.ensureLocalCliAuthorized(ENTRY as any);
    // Wait for the flow to actually be pending before cancelling, so the test asserts the real
    // window rather than racing it.
    await vi.waitFor(() => expect(calls).toContain('start_login'));
    expect(mod.cancelLocalCliAuth()).toBe(true);

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(calls).toContain('stop_login');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    // Nothing left behind: a second cancel has nothing to act on.
    expect(mod.cancelLocalCliAuth()).toBe(false);
  });

  it('rejects a start_login that returns no URL instead of polling forever', async () => {
    mocks.callTool = vi.fn(async (name: string) => {
      if (name === 'check_login') return { logged_in: false };
      if (name === 'start_login') return {};
      return {};
    });

    const mod = await load();
    await expect(mod.ensureLocalCliAuthorized(ENTRY as any)).rejects.toThrow(/returned no URL/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('supersedes a still-pending attempt when a new one starts', async () => {
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') return { logged_in: false };
      if (name === 'start_login') return { authorization_url: 'https://meeting.tencent.com/x' };
      return {};
    });

    const mod = await load();
    const first = mod.ensureLocalCliAuthorized(ENTRY as any);
    await vi.waitFor(() => expect(calls).toContain('start_login'));

    const second = mod.ensureLocalCliAuthorized(ENTRY as any);
    await vi.waitFor(() => expect(mocks.transports.length).toBeGreaterThanOrEqual(2));

    await expect(first).rejects.toThrow(/superseded/);
    // The second attempt is still live; end it so nothing dangles past the test.
    expect(mod.cancelLocalCliAuth()).toBe(true);
    await expect(second).rejects.toThrow(/cancelled/);
  });

  it('refuses an entry that is not a local_cli connector', async () => {
    const mod = await load();
    await expect(mod.ensureLocalCliAuthorized({ ...ENTRY, auth_mode: 'mcp_dcr' } as any))
      .rejects.toThrow(/not a local_cli connector/);
  });

  // ── Envelope handling ──────────────────────────────────────────────────
  //
  // These two exist because the original suite stubbed `callTool` with an already-unwrapped object,
  // which is not what the real `McpConnection` returns. That mismatch let a real defect ship: reading
  // `.logged_in` off the envelope always yielded `undefined`, so a signed-in CLI was asked to log in
  // again. A real-machine run caught it; these tests make it caught in CI instead.

  it('surfaces an adapter-level isError envelope instead of treating it as a payload', async () => {
    mocks.callTool = vi.fn(async () => toolError('tmeet auth status failed: not logged in'));

    const mod = await load();
    await expect(mod.ensureLocalCliAuthorized(ENTRY as any))
      .rejects.toThrow(/tmeet auth status failed/);
  });

  it('tolerates a text part that is not JSON rather than throwing a parse error', async () => {
    // A non-JSON text part cannot be a `check_login` payload, so the session must count as
    // unsigned-in and the flow must proceed to `start_login` rather than crash on JSON.parse.
    const calls: string[] = [];
    mocks.callTool = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'check_login') return { content: [{ type: 'text', text: 'not json' }] };
      if (name === 'start_login') return { authorization_url: 'https://meeting.tencent.com/x' };
      return {};
    });

    const mod = await load();
    const pending = mod.ensureLocalCliAuthorized(ENTRY as any);
    await vi.waitFor(() => expect(calls).toContain('start_login'));
    // Reached the poll stage, i.e. it unwrapped, failed to parse, and treated that as "signed out"
    // instead of surfacing a SyntaxError.
    expect(mocks.broadcastAuthorizationUrl).toHaveBeenCalledWith({
      catalog_id: 'tencent-meeting',
      url: 'https://meeting.tencent.com/x',
    });
    expect(mod.cancelLocalCliAuth()).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
