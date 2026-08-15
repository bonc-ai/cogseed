/**
 * Minimal HTTP client for the CogSeed Hub account service.
 *
 * Hub routing uses the canonical account/marketplace Server base helper.
 * This module removes the helper's `/api` suffix before composing the
 * versioned Hub account paths under `/api/v1`.
 *
 * Every endpoint returns the Hub envelope `{ ok: true, data }`; failures
 * throw `HubApiError` carrying the service error code (e.g.
 * `AUTH_INVALID_TOKEN`, `BINDING_ALREADY_EXISTS`) so callers can branch.
 */
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { withCommonHeaders } from '../api_common';
import { accountApiBase } from '../connectors/_server_bridge';
import type {
  HubAccountMe,
  HubBindResult,
  HubCallbackResult,
  HubConsent,
  HubDevice,
  HubDeviceMetadata,
  HubRefreshResult,
} from './types';

const log = createLogger('hub_account:client');

/**
 * Resolve Hub through the canonical account/marketplace Server helper.
 * `COGSEED_HUB_API_BASE` overrides it for local joint debugging against a
 * development Hub service (e.g. `http://localhost:3000`).
 */
export function hubApiBase(): string {
  const override = (process.env.COGSEED_HUB_API_BASE ?? '').trim().replace(/\/+$/, '');
  const configured = (override || accountApiBase()).trim().replace(/\/+$/, '');
  return configured.endsWith('/api') ? configured.slice(0, -4) : configured;
}

export class HubApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HubApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  token?: string | null;
  body?: unknown;
  /** Return the full response envelope (`{ data, total, page, ... }`) instead of unwrapping `data`. */
  raw?: boolean;
}

export interface HubClient {
  login(provider: string, redirectUri: string): Promise<{ authorize_url: string; state: string }>;
  callback(code: string, state: string): Promise<HubCallbackResult>;
  refresh(refreshToken: string): Promise<HubRefreshResult>;
  logout(accessToken: string): Promise<{ message: string }>;
  me(accessToken: string): Promise<HubAccountMe>;
  bind(
    accessToken: string,
    body: { local_identity_id: string; installation_id: string; device_name: string; device_os: string },
  ): Promise<HubBindResult>;
  listDevices(accessToken: string, page?: number, pageSize?: number): Promise<{ data: HubDevice[]; total: number }>;
  revokeDevice(accessToken: string, deviceId: string): Promise<{ device_id: string; revoked_sessions: number }>;
  listConsents(accessToken: string): Promise<HubConsent[]>;
  setConsent(accessToken: string, scope: string): Promise<HubConsent>;
  revokeConsent(accessToken: string, scope: string): Promise<HubConsent>;
  deleteAccount(accessToken: string, confirmation: string): Promise<{ account_id: string; status: string; deletion_scheduled_at: string }>;
  healthz(): Promise<boolean>;
  readyz(): Promise<boolean>;
}

/** Create a Hub client bound to a concrete base URL (production: `hubApiBase()`). */
export function createHubClient(baseUrl: string): HubClient {
  async function request<T>(pathname: string, opts: RequestOptions = {}): Promise<T> {
    const headers = withCommonHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' });
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${pathname}`, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'error',
      });
    } catch (err) {
      log.warn('hub request network failure', { pathname, error: logErrorRef(err) });
      throw new HubApiError('HUB_NETWORK_ERROR', '无法连接 Hub 服务', 0);
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON body — keep `json` null and surface status-based error below
    }

    const payload = json as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    if (res.ok && payload?.ok !== false) {
      return (opts.raw ? payload : (payload?.data ?? payload)) as T;
    }

    const code = payload?.error?.code || 'HUB_UNKNOWN_ERROR';
    const message = payload?.error?.message || `Hub 请求失败（HTTP ${res.status}）`;
    const details = payload?.error?.details;
    log.warn('hub request failed', { pathname, status: res.status, code });
    throw new HubApiError(code, message, res.status, details);
  }

  return {
    async login(provider, redirectUri) {
      const qs = new URLSearchParams({ provider, redirect_uri: redirectUri });
      return request<{ authorize_url: string; state: string }>(`/api/v1/auth/login?${qs.toString()}`);
    },
    // Contract v1.3: callback body is exactly { code, state } — device
    // registration happens server-side during callback; the desktop only
    // binds LocalIdentity afterwards when `is_new_account` is true.
    callback: (code, state) =>
      request('/api/v1/auth/callback', { method: 'POST', body: { code, state } }),
    refresh: (refreshToken) =>
      request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } }),
    logout: (accessToken) =>
      request('/api/v1/auth/logout', { method: 'POST', token: accessToken }),
    me: (accessToken) =>
      request('/api/v1/account/me', { token: accessToken }),
    bind: (accessToken, body) =>
      request('/api/v1/local-identity/bind', { method: 'POST', token: accessToken, body }),
    async listDevices(accessToken, page = 1, pageSize = 20) {
      return request<{ data: HubDevice[]; total: number }>(
        `/api/v1/devices?page=${page}&page_size=${pageSize}`,
        { token: accessToken, raw: true },
      );
    },
    revokeDevice: (accessToken, deviceId) =>
      request(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', token: accessToken }),
    listConsents: (accessToken) =>
      request('/api/v1/consent', { token: accessToken }),
    setConsent: (accessToken, scope) =>
      request(`/api/v1/consent/${encodeURIComponent(scope)}`, { method: 'PUT', token: accessToken }),
    revokeConsent: (accessToken, scope) =>
      request(`/api/v1/consent/${encodeURIComponent(scope)}`, { method: 'DELETE', token: accessToken }),
    deleteAccount: (accessToken, confirmation) =>
      request('/api/v1/account', { method: 'DELETE', token: accessToken, body: { confirmation } }),
    async healthz() {
      try {
        await request<{ status: string }>('/healthz');
        return true;
      } catch {
        return false;
      }
    },
    async readyz() {
      try {
        await request<{ status: string }>('/readyz');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Shared client instance at the resolved base URL. */
let _shared: HubClient | null = null;
export function hubClient(): HubClient {
  if (!_shared) _shared = createHubClient(hubApiBase());
  return _shared;
}

/** Test hook — replace the shared client (e.g. point at a mock server). */
export function setSharedHubClient(client: HubClient | null): void {
  _shared = client;
}
