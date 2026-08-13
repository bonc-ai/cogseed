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
    if (parsed.host.toLowerCase() !== ACCOUNT_CALLBACK_HOST) return null;
    if ((parsed.pathname.replace(/\/+$/, '') || '/') !== ACCOUNT_CALLBACK_PATH) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Consume a `cogseed://account/callback` deep link: extract `code` + `state`
 * and complete the login flow for the active local identity.
 */
export async function handleAccountCallbackUrl(rawUrl: string): Promise<{ ok: boolean; error?: string; account_id?: string; is_new_account?: boolean }> {
  const url = accountCallbackUrl(rawUrl);
  if (!url) return { ok: false, error: 'not_an_account_callback' };

  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code) return { ok: false, error: 'missing_code' };
  if (!state) return { ok: false, error: 'missing_state' };

  // Login is always bound to the active local identity.
  const userId = getActiveUserId();
  try {
    const { account_id, is_new_account } = await completeLogin(userId, code, state);
    return { ok: true, account_id, is_new_account };
  } catch (err) {
    log.warn('account deep-link login failed', { error: (err as Error).message });
    return { ok: false, error: err instanceof HubApiError ? err.code : 'login_failed' };
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

export const _test = { accountCallbackUrl };
