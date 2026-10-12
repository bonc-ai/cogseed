/**
 * Authorization for `auth_mode: 'local_cli'` connectors.
 *
 * These connectors have no OAuth authorization server to talk to: the provider's supported
 * programmatic surface is a locally installed CLI that owns its own login. So there is no grant to
 * exchange and no `cogseed://` deep-link callback to wait for. Instead this module drives the
 * bundled adapter's auth-session tools over an *ephemeral* stdio connection:
 *
 *   check_login  → already signed in? Nothing to do.
 *   start_login  → the adapter returns the authorization URL.
 *   check_login  → poll until signed in, the user cancels, or the deadline passes.
 *   stop_login   → on every exit path, so no `tmeet auth login` process outlives the attempt.
 *
 * Two deliberate choices worth keeping:
 *
 *  1. **No new spawn site.** `tmeet` is spawned by the adapter child, exactly as it already is for
 *     the read-only tools, and main only speaks MCP to that child. `AGENTS.md` names two child
 *     process choke points (`local_agents/runner.ts`, `connectors/mcp-client.ts`); driving the CLI
 *     from here through the adapter keeps the count at two.
 *
 *  2. **The URL is both opened and shown.** `shell.openExternal` is best-effort: if no browser
 *     handles it, the renderer already holds the URL and can offer a copyable link. That is the
 *     difference between a recoverable failure and a click that appears to do nothing.
 *
 * The ephemeral connection is closed on every path. Leaving it open would pin a second adapter
 * process for the life of the app, and the adapter here is only a vehicle for authorization — the
 * real connector instance is provisioned separately by `manager.connectViaOAuth`.
 */
import { shell } from 'electron';

import { createLogger } from '../../logger';
import { applyTemplate } from './apply-template';
import { McpConnection } from './mcp-client';
import { broadcastAuthorizationUrl } from './oauth-events';
import type { CatalogEntry } from './types';

const log = createLogger('connectors:local-cli-auth');

/** How long the user has to finish in the browser before the attempt is abandoned. Matches the
 *  OAuth deep-link flow's window so both modes behave the same from the user's point of view. */
const FLOW_TIMEOUT_MS = Number(process.env.COGSEED_LOCAL_CLI_AUTH_TIMEOUT_MS || 5 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.COGSEED_LOCAL_CLI_POLL_MS || 2000);

/** Connection id for the ephemeral auth session. Deliberately not a catalog id or an instance id:
 *  nothing should ever find this in the live-connection map or the registry. */
const AUTH_CONNECTION_ID = 'local-cli-auth';

export interface LocalCliAuthStatus {
  logged_in: boolean;
  user_name?: string;
}

/** In-flight attempt. Cancellation is observed between polls rather than by aborting the connection,
 *  which keeps one code path in charge of teardown (the `finally` in `ensureLocalCliAuthorized`). */
interface PendingAuth {
  catalogId: string;
  cancelled: Error | null;
}

let _pending: PendingAuth | null = null;

function _abortError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/** Wired to the renderer's 「取消」 affordance, alongside `cancelInFlightOAuth`. */
export function cancelLocalCliAuth(): boolean {
  const pending = _pending;
  if (!pending) return false;
  pending.cancelled = _abortError('local CLI authorization cancelled by user', 'user_cancelled');
  return true;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Unref so a pending poll cannot hold the process open during shutdown or tests.
    timer.unref?.();
  });
}

/**
 * Unwrap an MCP `callTool` result into the tool's own payload.
 *
 * `McpConnection.callTool` returns the **raw envelope** — `{ content: [{ type: 'text', text: '<json>' }],
 * isError? }`. The flattening the model's tool path uses is `tools-adapter.ts::stringifyMcpResult`,
 * which yields a string rather than the structured payload this module needs.
 *
 * Reading `.logged_in` straight off the envelope silently yields `undefined`. That is how an
 * already-authorized CLI got asked to log in again on a real machine: every `check_login` looked
 * like "not signed in", so a needless login was started and the already-signed-in CLI rejected it.
 * The unit tests could not catch it because they stubbed `callTool` with an already-unwrapped
 * object; they now stub the real envelope shape instead.
 */
function _unwrapToolResult<T>(raw: unknown): T {
  const envelope = raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  const text = Array.isArray(envelope?.content)
    ? envelope!.content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
    : '';
  // An adapter-level failure arrives as a text part plus `isError`, so it must be raised rather
  // than parsed: the text is a human-readable message, not JSON.
  if (envelope?.isError) throw new Error(text || 'the connector tool reported an error');
  if (!text) return (raw ?? {}) as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return (raw ?? {}) as T;
  }
}

/** `check_login` through the envelope, so callers get the parsed status. */
async function _checkLogin(conn: McpConnection): Promise<LocalCliAuthStatus> {
  return _unwrapToolResult<LocalCliAuthStatus>(await conn.callTool('check_login', {}));
}

/**
 * Resolve once the CLI holds a valid session, starting a login if it does not.
 *
 * Rejects with `err.code` in the same vocabulary `manager` maps to renderer-facing outcomes:
 * `user_cancelled`, `superseded`, `flow_timeout`, or an adapter/CLI error.
 */
export async function ensureLocalCliAuthorized(entry: CatalogEntry): Promise<{ user_name: string }> {
  if (entry.auth_mode !== 'local_cli') {
    throw new Error(`'${entry.id}' is not a local_cli connector`);
  }
  if (!entry.transport_template) {
    throw new Error(`'${entry.id}' is not installable yet (${entry.unavailable_reason || 'unavailable'})`);
  }

  // Pre-empt any prior attempt: clicking the card again while a browser tab is still open is a
  // legitimate path, and two concurrent `tmeet auth login` processes would fight over the session.
  if (_pending) {
    _pending.cancelled = _abortError('superseded by a new local CLI authorization', 'superseded');
  }

  const transport = applyTemplate(entry, null);
  const conn = new McpConnection(AUTH_CONNECTION_ID, transport);
  const state: PendingAuth = { catalogId: entry.id, cancelled: null };
  let timer: NodeJS.Timeout | null = null;

  try {
    await conn.connect();

    const before = await _checkLogin(conn);
    if (before?.logged_in) {
      log.info('local CLI already authorized', { catalog_id: entry.id });
      return { user_name: before.user_name || '' };
    }

    log.info('local CLI not authorized; starting login', { catalog_id: entry.id });
    _pending = state;
    const startedAt = Date.now();
    timer = setTimeout(() => {
      state.cancelled = _abortError('local CLI authorization flow timed out', 'flow_timeout');
    }, FLOW_TIMEOUT_MS);
    timer.unref?.();

    const started = _unwrapToolResult<{ authorization_url?: string }>(await conn.callTool('start_login', {}));
    const url = String(started?.authorization_url || '');
    if (!url) throw new Error('the authorization step returned no URL');

    // Push before opening: if `openExternal` fails or the user has no default browser, the renderer
    // still has everything it needs to show a copyable link.
    broadcastAuthorizationUrl({ catalog_id: entry.id, url });
    shell.openExternal(url).catch((err) => {
      log.warn('failed to open the authorization URL in a browser', {
        catalog_id: entry.id,
        error: (err as Error).message,
      });
    });

    for (;;) {
      await _sleep(POLL_INTERVAL_MS);
      if (state.cancelled) throw state.cancelled;
      const status = await _checkLogin(conn);
      if (status?.logged_in) {
        log.info('local CLI authorization completed', { catalog_id: entry.id });
        return { user_name: status.user_name || '' };
      }
      // Re-check after the awaited poll so a cancel that arrives mid-call is honoured promptly
      // rather than after one more interval.
      if (state.cancelled) throw state.cancelled;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (_pending === state) _pending = null;
    // Best-effort teardown: a failure here must not mask the real outcome of the attempt, but a
    // surviving `tmeet auth login` would be a real defect, so both steps are attempted and logged.
    try { await conn.callTool('stop_login', {}); } catch (err) {
      log.warn('failed to stop the pending CLI login', { error: (err as Error).message });
    }
    try { await conn.close(); } catch { /* already gone */ }
  }
}
