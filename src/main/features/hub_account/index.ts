/**
 * CogSeed Hub account feature — desktop-side account management.
 *
 * Public surface for IPC handlers and the deep-link delivery path:
 *   - `startLogin` / `openAuthorizeUrl` / `completeLogin` — OAuth flow
 *   - `getHubStatus` / `logout` / device & consent management
 *   - `handleAccountCallbackUrl` — entry point for the
 *     `cogseed://account/callback` OS deep link (dispatched from
 *     `features/connectors/protocol.ts`)
 */
import { getActiveUserId } from '../users';
import { createLogger } from '../../logger';
import { HubApiError } from './client';
import {
  startLogin,
  openAuthorizeUrl,
  completeLogin,
  bindLocalIdentity,
  refreshSession,
  ensureFreshSession,
  getAccountMe,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  logout,
  getHubStatus,
  currentLoginState,
  type HubStatusView,
} from './auth-flow';
import { readHubAccountState } from './state';
import { loadHubSession } from './tokens';
import { broadcastHubLoginOutcome } from './account-events';
import { assertHubAccountReleaseEnabled } from './gate';

const log = createLogger('hub_account');
const ACCOUNT_CALLBACK_HOST = 'account';
const ACCOUNT_CALLBACK_PATH = '/callback';

export type { HubStatusView };
export { HubApiError };

/**
 * Recognize a Hub account deep link (`cogseed://account/callback?code=..&state=..`).
 * Returns the raw URL when it matches, otherwise null.
 */
export function accountCallbackUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'cogseed:') return null;
    if (parsed.host.toLowerCase() !== ACCOUNT_CALLBACK_HOST) return null;
    if ((parsed.pathname.replace(/\/+$/, '') || '/') !== ACCOUNT_CALLBACK_PATH) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

type ParsedAccountCallback =
  | { ok: true; url: string; code: string; state: string }
  | { ok: false; error: string };

/**
 * Validate the callback URL and extract `code` + `state`, rejecting duplicate,
 * empty, oversized, or control-character parameters before any state is touched.
 */
export function parseAccountCallback(rawUrl: string): ParsedAccountCallback {
  const url = accountCallbackUrl(rawUrl);
  if (!url) return { ok: false, error: 'not_an_account_callback' };
  const parsed = new URL(url);
  const codes = parsed.searchParams.getAll('code');
  const states = parsed.searchParams.getAll('state');
  if (codes.length > 1) return { ok: false, error: 'duplicate_code' };
  if (states.length > 1) return { ok: false, error: 'duplicate_state' };
  const code = codes[0] || '';
  const state = states[0] || '';
  if (!code) return { ok: false, error: 'missing_code' };
  if (!state) return { ok: false, error: 'missing_state' };
  if (code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) return { ok: false, error: 'invalid_code' };
  if (state.length > 512 || /[\u0000-\u001f\u007f]/.test(state)) return { ok: false, error: 'invalid_state' };
  return { ok: true, url, code, state };
}

/**
 * Consume a `cogseed://account/callback` deep link: extract `code` + `state`
 * and complete the login flow for the active local identity.
 *
 * Always notifies the renderer of the outcome: nothing on the renderer side
 * awaits this call, so the broadcast is the only way the account pane learns
 * that the login finished.
 */
export async function handleAccountCallbackUrl(rawUrl: string): Promise<{ ok: boolean; error?: string; account_id?: string; is_new_account?: boolean }> {
  // The release Gate short-circuits before any authorization parameter is
  // consumed or any user-scoped state is touched.
  try {
    assertHubAccountReleaseEnabled();
  } catch (err) {
    const failureCode = err instanceof HubApiError ? err.code : 'HUB_RELEASE_GATE_CLOSED';
    broadcastHubLoginOutcome({ result: 'failure', code: failureCode });
    return { ok: false, error: failureCode };
  }

  const callback = parseAccountCallback(rawUrl);
  if (callback.ok === false) {
    // Non-account deep links belong to other flows: leave their traffic alone.
    if (callback.error !== 'not_an_account_callback') {
      broadcastHubLoginOutcome({ result: 'failure', code: callback.error });
    }
    return callback;
  }

  // Login is always bound to the active local identity.
  const userId = getActiveUserId();
  try {
    const { account_id, is_new_account } = await completeLogin(userId, callback.code, callback.state);
    broadcastHubLoginOutcome({ result: 'success', account_id, is_new_account });
    return { ok: true, account_id, is_new_account };
  } catch (err) {
    log.warn('account deep-link login failed', { error: (err as Error).message });
    const failureCode = err instanceof HubApiError ? err.code : 'login_failed';
    broadcastHubLoginOutcome({ result: 'failure', code: failureCode, error: (err as Error).message });
    return { ok: false, error: failureCode };
  }
}

export const hubAccount = {
  startLogin,
  openAuthorizeUrl,
  completeLogin,
  bindLocalIdentity,
  refreshSession,
  ensureFreshSession,
  getAccountMe,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  logout,
  getHubStatus,
  currentLoginState,
  readHubAccountState,
  loadHubSession,
};

// Named re-exports so IPC handlers can import functions directly.
export {
  startLogin,
  openAuthorizeUrl,
  completeLogin,
  bindLocalIdentity,
  refreshSession,
  ensureFreshSession,
  getAccountMe,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  logout,
  getHubStatus,
  currentLoginState,
};

export const _test = { accountCallbackUrl, parseAccountCallback };
