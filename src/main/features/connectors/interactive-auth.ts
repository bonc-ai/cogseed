/**
 * `browser_poll` authorization for `interactive_token` connectors.
 *
 * Some providers publish a remote MCP endpoint but no MCP-spec OAuth authorization server, and no
 * CLI to wrap. WPS SkillHub is the case in hand: the client generates a code, opens a consent page
 * carrying it as `?auth_code=`, the user approves in a browser, and the client polls an exchange
 * endpoint with that same code until the provider mints a token. There is no redirect back to us
 * and no client secret — which is precisely why this is a bespoke flow rather than `mcp_dcr`.
 *
 * Two properties this module is responsible for:
 *
 *  1. **Nothing secret is logged.** Only the consent URL (which the user is about to visit anyway),
 *     status codes and token length reach the log — never the token, never the code.
 *  2. **The token goes straight to the caller**, which materializes it into the connector's
 *     transport so it lands in the instance's encrypted `secrets_enc` blob. This module stores
 *     nothing itself.
 */
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';

import { fetchWithTimeout } from '../../util/abort';
import { createLogger } from '../../logger';
import type { InteractiveTokenAuth } from './types';

const log = createLogger('connectors:interactive-auth');

export type BrowserPollAuth = Extract<InteractiveTokenAuth, { kind: 'browser_poll' }>;

/** WPS's own client uses 1s and 5 minutes; overridable per entry because these are provider
 *  conventions, not protocol constants. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Per-request budget. Must stay well under the poll interval's worth of patience: a hung socket
 *  should not consume the whole authorization window. */
const EXCHANGE_HTTP_TIMEOUT_MS = 20_000;

/** The consent URL the user must visit, carrying the code this client generated. */
export function consentUrlFor(auth: BrowserPollAuth, authCode: string): string {
  const base = auth.authorize_url;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}auth_code=${encodeURIComponent(authCode)}`;
}

/** Providers in this family disagree on where the token sits in the exchange response, so the
 *  entry may name it (`token_field`, dotted paths allowed — `result.ticket`) and we otherwise try
 *  the four shapes seen in the wild.
 *
 *  Only a non-empty STRING counts as a token. An object at the named field is a provider envelope,
 *  not a credential; accepting it would put `[object Object]` into an Authorization header. */
function extractToken(body: unknown, tokenField?: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const data = (record.data && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>;

  if (tokenField) {
    // Dotted path, resolved against the envelope and its `data` wrapper so both
    // `result.ticket` and `data.result.ticket` work.
    const segments = tokenField.split('.');
    for (const root of [record, data]) {
      let cursor: unknown = root;
      for (const segment of segments) {
        cursor = cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[segment] : undefined;
      }
      if (typeof cursor === 'string' && cursor.trim()) return cursor.trim();
    }
    return null;
  }

  for (const candidate of [record.access_token, record.token, data.access_token, data.token]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export interface PollOptions {
  /** Injected by tests; production uses the app's timeout-aware fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Called with the consent URL once, so the caller can broadcast it to the renderer before the
   *  browser opens (a failed `openExternal` must not leave the user without the link). */
  onConsentUrl?: (url: string) => void;
  /** Poll cadence override, for tests. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Cancellation: return true to abort the wait. */
  isCancelled?: () => boolean;
}

/** Run the whole flow: generate a code, hand out the consent URL, and poll until a token appears.
 *
 *  Resolves with the token, or throws with `code: 'flow_timeout'` / `'user_cancelled'` — the same
 *  vocabulary `manager._oauthConnectErrorCode` maps to renderer-facing outcomes. */
export async function authorizeBrowserPoll(
  auth: BrowserPollAuth,
  options: PollOptions = {},
): Promise<string> {
  const authCode = randomUUID();
  const url = consentUrlFor(auth, authCode);
  const doFetch = options.fetchImpl
    || ((url: string, init: RequestInit) =>
      fetchWithTimeout(url, init, EXCHANGE_HTTP_TIMEOUT_MS, undefined,
        `interactive authorization exchange timed out after ${Math.round(EXCHANGE_HTTP_TIMEOUT_MS / 1000)}s`));
  const pollIntervalMs = options.pollIntervalMs ?? auth.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? auth.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  options.onConsentUrl?.(url);
  // Best-effort: the caller has already broadcast the URL, so a missing default browser degrades to
  // "copy this link" rather than a failure.
  shell.openExternal(url).catch((err) => {
    log.warn('failed to open the authorization URL in a browser', { error: (err as Error).message });
  });
  log.info('interactive authorization started', { consent_url: url, timeout_ms: timeoutMs });

  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  for (;;) {
    if (options.isCancelled?.()) {
      throw Object.assign(new Error('interactive authorization cancelled'), { code: 'user_cancelled' });
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error('interactive authorization flow timed out'), { code: 'flow_timeout' });
    }
    try {
      const res: Response = await doFetch(auth.exchange_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Identifying the client is part of the provider's contract, and it is also what makes a
          // server-side failure diagnosable from their logs.
          'user-agent': 'cogseed-desktop/1.0 (+connector:interactive-token)',
        },
        body: JSON.stringify({ code: authCode }),
      });
      lastStatus = res.status;
      if (res.ok) {
        const token = extractToken(await res.json().catch(() => null), auth.token_field);
        if (token) {
          log.info('interactive authorization completed', { token_chars: token.length });
          return token;
        }
        // 200 without a token means "not approved yet" for this flow, so keep waiting.
      } else if (res.status >= 400 && res.status < 500 && res.status !== 404) {
        // A rejected code is terminal: waiting cannot fix it, and the user would stare at a spinner
        // until the deadline. 404 stays pollable — some providers answer 404 while the code is
        // still pending.
        throw Object.assign(new Error(`interactive authorization exchange failed: HTTP ${res.status}`), {
          code: 'exchange_failed',
        });
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'exchange_failed') throw err;
      // Transport errors are transient by assumption — the user may still be mid-consent, and a
      // flaky corporate proxy must not abort an otherwise valid attempt.
      lastStatus = lastStatus || 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
