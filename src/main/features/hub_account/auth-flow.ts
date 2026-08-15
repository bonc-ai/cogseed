/**
 * Hub account orchestration for the desktop app.
 *
 * Flow (mirrors the Hub API contract v1.3):
 *   1. `startLogin`   — GET /auth/login → authorize_url, remember state
 *   2. open browser   — user authorizes on GitHub; the deep link
 *                       `cogseed://account/callback?code=..&state=..` comes back
 *                       (delivered via `features/connectors/protocol.ts`)
 *   3. `completeLogin`— POST /auth/callback {code,state} → store session
 *                       (encrypted), bind the current local identity
 *   4. thereafter     — silent refresh before expiry; 401 → refresh → retry
 *
 * Local semantics: signing out (or a failed Hub call) never touches the
 * local identity or its data — only the Hub session and binding metadata.
 */
import * as os from 'node:os';
import { shell } from 'electron';

import { tokenStore } from '../connectors/_server_bridge';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { HubApiError, hubClient, type HubClient } from './client';
import { saveHubSession, loadHubSession, clearHubSession } from './tokens';
import { readHubAccountState, writeHubAccountState } from './state';
import type { HubSession, HubBindResult } from './types';
import { isHubAccountReleaseEnabled } from './gate';

const log = createLogger('hub_account:auth-flow');
const ACCOUNT_CALLBACK_SCHEME = 'cogseed';
const ACCOUNT_CALLBACK_PATH = '/account/callback';

export const ACCOUNT_CALLBACK_URL = `${ACCOUNT_CALLBACK_SCHEME}://account/callback`;

/** Long-lived OAuth state for an in-flight login — validated by the Hub service. */
let _pendingState: string | null = null;

export function _pendingLoginStateForTest(): string | null {
  return _pendingState;
}

/** Test hook — clear the in-memory pending state (simulates an abandoned login). */
export function _clearPendingLoginForTest(): void {
  _pendingState = null;
}

function _deviceName(): string {
  return os.hostname() || 'Unknown';
}

function _deviceOs(): string {
  return `${os.platform()} ${os.release()}`;
}

function _isExpiringSoon(session: HubSession, withinMs: number): boolean {
  const exp = Date.parse(session.access_expires_at);
  if (Number.isNaN(exp)) return true; // unknown expiry → refresh proactively
  return exp - Date.now() <= withinMs;
}

// ── Login ────────────────────────────────────────────────────────────────

/**
 * Begin a Hub login: ask the Hub service for the provider authorize URL and
 * remember the returned state so the deep-link callback can be completed.
 * The caller (IPC layer) opens the browser.
 */
export async function startLogin(userId: string, client: HubClient = hubClient()): Promise<{ authorize_url: string; state: string }> {
  // Provider is selectable for local joint debugging: `COGSEED_HUB_PROVIDER=mock`
  // exercises the full login flow against the development Hub service without
  // a real GitHub OAuth App. Default stays `github`.
  const provider = (process.env.COGSEED_HUB_PROVIDER ?? 'github').trim() || 'github';
  const { authorize_url, state } = await client.login(provider, ACCOUNT_CALLBACK_URL);
  _pendingState = state;
  writeHubAccountState(userId, { pending_login: { state, started_at: new Date().toISOString() } });
  return { authorize_url, state };
}

/** Open the system browser at the authorize URL (user-facing step). */
export async function openAuthorizeUrl(authorizeUrl: string): Promise<void> {
  // Mock provider (local joint debugging): `mock://` has no registered app, so
  // the "browser" step is skipped and the login completes via the deep-link
  // callback (or the test harness feeding `cogseed://account/callback`).
  if (authorizeUrl.startsWith('mock://')) {
    log.info('mock provider: skipping browser open; complete via deep link');
    return;
  }
  try {
    await shell.openExternal(authorizeUrl);
  } catch (err) {
    log.warn('failed to open authorize url', { error: (err as Error).message });
    throw err;
  }
}

/** Expected state for the in-flight login — `null` when nothing is pending. */
export function currentLoginState(userId: string): string | null {
  const pending = readHubAccountState(userId).pending_login;
  return pending?.state ?? _pendingState;
}

// ── Deep-link callback ───────────────────────────────────────────────────

/**
 * Complete the OAuth flow from the `cogseed://account/callback` deep link.
 * `state` is verified by the Hub service; we still drop callbacks that carry
 * no matching pending login to avoid surprising logins.
 */
export async function completeLogin(
  userId: string,
  code: string,
  state: string,
  client: HubClient = hubClient(),
): Promise<{ account_id: string; is_new_account: boolean }> {
  const expected = currentLoginState(userId);
  // Attack shape: a deep link carrying code+state with NO in-flight login must
  // not complete — otherwise a forged cogseed://account/callback can trigger
  // an unexpected login/bind on this machine. The Hub service also validates
  // state (one-time, TTL), but we drop it locally first.
  if (!expected) {
    throw new HubApiError('AUTH_NO_PENDING_LOGIN', '没有进行中的登录，请重新发起登录', 400);
  }
  if (expected !== state) {
    throw new HubApiError('AUTH_INVALID_STATE', 'OAuth state 不匹配，请重新登录', 400);
  }

  const result = await client.callback(code, state);
  saveHubSession(userId, result.session);
  writeHubAccountState(userId, {
    account_id: result.account.account_id,
    auth_provider: result.account.auth_provider,
    account_status: result.account.status,
    pending_login: undefined,
  });

  // Contract v1.3: LocalIdentity binding happens only for a brand-new account.
  // Returning users already have a binding; re-binding would be wrong (and the
  // Hub service would reject a duplicate).
  let bind: HubBindResult | null = null;
  if (result.is_new_account) {
    try {
      bind = await bindLocalIdentity(userId, result.session.access_token, client);
    } catch (err) {
      try {
        await client.logout(result.session.access_token);
      } catch (logoutError) {
        log.warn('failed to revoke partially established Hub session', { error: logErrorRef(logoutError) });
      }
      clearHubAuthorization(userId);
      _pendingState = null;
      throw err;
    }
  }
  _pendingState = null;
  log.info('hub login completed', { accountId: mask(result.account.account_id), isNew: result.is_new_account, bound: !!bind });
  return { account_id: result.account.account_id, is_new_account: result.is_new_account };
}

function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}****${value.slice(-4)}`;
}

// ── Bind local identity ──────────────────────────────────────────────────

export async function bindLocalIdentity(
  userId: string,
  accessToken: string,
  client: HubClient = hubClient(),
): Promise<HubBindResult> {
  const result = await client.bind(accessToken, {
    local_identity_id: userId,
    installation_id: tokenStore.getDeviceId(),
    device_name: _deviceName(),
    device_os: _deviceOs(),
  });
  writeHubAccountState(userId, {
    device_id: result.device.device_id,
    device_name: result.device.device_name,
    bound: true,
    bound_at: result.bound_at,
  });
  log.info('hub local identity bound', { deviceId: mask(result.device.device_id) });
  return result;
}

const TERMINAL_AUTH_CODES = new Set([
  'AUTH_REFRESH_TOKEN_REVOKED',
  'AUTH_SESSION_NOT_FOUND',
  'AUTH_SESSION_REVOKED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_DEVICE_REVOKED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_DELETION',
  'ACCOUNT_DELETED',
]);

function lifecycleStatus(code: string): 'active' | 'suspended' | 'pending_deletion' | 'deleted' | undefined {
  if (code === 'ACCOUNT_SUSPENDED') return 'suspended';
  if (code === 'ACCOUNT_PENDING_DELETION') return 'pending_deletion';
  if (code === 'ACCOUNT_DELETED') return 'deleted';
  if (code.startsWith('AUTH_')) return 'active';
  return undefined;
}

function clearHubAuthorization(userId: string, code?: string): void {
  clearHubSession(userId);
  writeHubAccountState(userId, {
    bound: false,
    account_id: undefined,
    auth_provider: undefined,
    device_id: undefined,
    device_name: undefined,
    account_status: code ? lifecycleStatus(code) : undefined,
    bound_at: undefined,
    pending_login: undefined,
  });
}

function handleTerminalAuthError(userId: string, err: unknown): void {
  if (err instanceof HubApiError && TERMINAL_AUTH_CODES.has(err.code)) clearHubAuthorization(userId, err.code);
}

// ── Session refresh + authorized calls ───────────────────────────────────

/**
 * In-flight refresh per local identity. Concurrent callers share one
 * request — a rotated refresh token must never be replayed by a second
 * in-flight call (the Hub treats that as a leak and revokes all sessions).
 */
const _refreshInFlight = new Map<string, Promise<HubSession>>();

/** Refresh the Hub session now; throws `HubApiError` when the refresh token is gone/revoked. */
export async function refreshSession(userId: string, client: HubClient = hubClient()): Promise<HubSession> {
  const inFlight = _refreshInFlight.get(userId);
  if (inFlight) return inFlight;
  const session = loadHubSession(userId);
  if (!session) throw new HubApiError('AUTH_REQUIRED', '未登录', 401);
  const pending = _doRefresh(userId, session, client);
  _refreshInFlight.set(userId, pending);
  return pending;
}

async function _doRefresh(userId: string, session: HubSession, client: HubClient): Promise<HubSession> {
  try {
    const refreshed = await client.refresh(session.refresh_token);
    const next: HubSession = {
      session_id: session.session_id, // server keeps the same session family across rotation
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      access_expires_at: refreshed.access_expires_at,
      refresh_expires_at: refreshed.refresh_expires_at,
    };
    saveHubSession(userId, next);
    return next;
  } catch (err) {
    handleTerminalAuthError(userId, err);
    throw err;
  } finally {
    _refreshInFlight.delete(userId);
  }
}

/** Ensure a non-expired session exists (silent refresh when needed). */
export async function ensureFreshSession(userId: string, client: HubClient = hubClient()): Promise<HubSession> {
  const session = loadHubSession(userId);
  if (!session) throw new HubApiError('AUTH_REQUIRED', '未登录', 401);
  if (_isExpiringSoon(session, 5 * 60 * 1000)) return refreshSession(userId, client);
  return session;
}

/**
 * Run an authenticated Hub call with one automatic retry on `AUTH_INVALID_TOKEN`
 * (access token expired between our freshness check and the request).
 */
async function withAuthRetry<T>(
  userId: string,
  fn: (accessToken: string, client: HubClient) => Promise<T>,
  client: HubClient = hubClient(),
): Promise<T> {
  const session = await ensureFreshSession(userId, client);
  try {
    return await fn(session.access_token, client);
  } catch (err) {
    if (err instanceof HubApiError && err.code === 'AUTH_INVALID_TOKEN') {
      try {
        const fresh = await refreshSession(userId, client);
        return await fn(fresh.access_token, client);
      } catch (retryError) {
        handleTerminalAuthError(userId, retryError);
        throw retryError;
      }
    }
    handleTerminalAuthError(userId, err);
    throw err;
  }
}

// ── Account-facing operations ────────────────────────────────────────────

export async function getAccountMe(userId: string): Promise<import('./types').HubAccountMe> {
  return withAuthRetry(userId, (token, client) => client.me(token));
}

export async function listDevices(userId: string): Promise<import('./types').HubDevice[]> {
  const { data } = await withAuthRetry(userId, (token, client) => client.listDevices(token));
  return data;
}

export async function revokeDevice(userId: string, deviceId: string): Promise<{ revoked_sessions: number }> {
  return withAuthRetry(userId, (token, client) => client.revokeDevice(token, deviceId));
}

export async function listConsents(userId: string): Promise<import('./types').HubConsent[]> {
  return withAuthRetry(userId, (token, client) => client.listConsents(token));
}

export async function setConsent(userId: string, scope: string): Promise<import('./types').HubConsent> {
  return withAuthRetry(userId, (token, client) => client.setConsent(token, scope));
}

export async function revokeConsent(userId: string, scope: string): Promise<import('./types').HubConsent> {
  return withAuthRetry(userId, (token, client) => client.revokeConsent(token, scope));
}

export async function deleteHubAccount(userId: string, confirmation: string): Promise<{ account_id: string; status: string; deletion_scheduled_at: string }> {
  const result = await withAuthRetry(userId, (token, client) => client.deleteAccount(token, confirmation));
  clearHubAuthorization(userId, 'ACCOUNT_PENDING_DELETION');
  return result;
}

// ── Logout / sign-out ────────────────────────────────────────────────────

/**
 * Sign out of the Hub account: revoke the session server-side (best-effort),
 * clear encrypted credentials and binding metadata. The local identity and
 * its data are intentionally preserved.
 */
export async function logout(userId: string, client: HubClient = hubClient()): Promise<void> {
  // Drain an in-flight refresh first so we revoke the latest session and a
  // late refresh write-back cannot restore credentials after sign-out.
  await _refreshInFlight.get(userId)?.catch(() => {});
  const session = loadHubSession(userId);
  if (session) {
    try {
      await client.logout(session.access_token);
    } catch (err) {
      log.warn('hub logout request failed; clearing local session anyway', { error: (err as Error).message });
    }
  }
  clearHubAuthorization(userId);
  log.info('hub account signed out locally');
}

// ── Status for the renderer ──────────────────────────────────────────────

export interface HubStatusView {
  signed_in: boolean;
  account_id: string | null;
  auth_provider: string | null;
  bound: boolean;
  device_id: string | null;
  account_status: string | null;
  hub_reachable: boolean;
  access_expires_at: string | null;
  release_enabled: boolean;
  disabled_reason: 'release_gate' | null;
}

/** Renderer-safe status snapshot (no tokens). */
export async function getHubStatus(userId: string): Promise<HubStatusView> {
  const state = readHubAccountState(userId);
  const session = loadHubSession(userId);
  const releaseEnabled = isHubAccountReleaseEnabled();
  const reachable = releaseEnabled ? await hubClient().healthz().catch(() => false) : false;
  return {
    signed_in: !!session && !!state.account_id,
    account_id: state.account_id ?? null,
    auth_provider: state.auth_provider ?? null,
    bound: state.bound,
    device_id: state.device_id ?? null,
    account_status: state.account_status ?? null,
    hub_reachable: reachable,
    access_expires_at: session?.access_expires_at ?? null,
    release_enabled: releaseEnabled,
    disabled_reason: releaseEnabled ? null : 'release_gate',
  };
}
