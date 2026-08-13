/**
 * Minimal HTTP client for the CogSeed Hub account service.
 *
 * The Hub service is a separate backend (own domain / base URL), not the
 * marketplace API base. Development defaults to `http://localhost:3000`
 * (the Hub service dev server); production URL comes from the
 * `ORKAS_HUB_API_BASE` env override until the platform owner assigns a
 * public domain (then it can also be moved to remote config).
 *
 * Every endpoint returns the Hub envelope `{ ok: true, data }`; failures
 * throw `HubApiError` carrying the service error code (e.g.
 * `AUTH_INVALID_TOKEN`, `BINDING_ALREADY_EXISTS`) so callers can branch.
 */
import { createLogger } from '../../logger';

const log = createLogger('hub_account:client');

export const DEFAULT_HUB_API_BASE = 'http://localhost:3000';

/** Resolve the Hub service base URL (env override wins; tests inject directly). */
export function hubApiBase(): string {
  return process.env.ORKAS_HUB_API_BASE?.trim() || DEFAULT_HUB_API_BASE;
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
}

export interface HubClient {
  login(provider: string, redirectUri: string): Promise<{ authorize_url: string; state: string }>;
  callback(code: string, state: string): Promise<import('./types').HubCallbackResult>;
  refresh(refreshToken: string): Promise<import('./types').HubRefreshResult>;
  logout(accessToken: string): Promise<{ message: string }>;
  me(accessToken: string): Promise<import('./types').HubAccountMe>;
  bind(
    accessToken: string,
    body: { local_identity_id: string; device_name: string; device_os: string },
  ): Promise<import('./types').HubBindResult>;
  listDevices(accessToken: string, page?: number, pageSize?: number): Promise<{ data: import('./types').HubDevice[]; total: number }>;
  revokeDevice(accessToken: string, deviceId: string): Promise<{ device_id: string; revoked_sessions: number }>;
  listConsents(accessToken: string): Promise<import('./types').HubConsent[]>;
  setConsent(accessToken: string, scope: string): Promise<import('./types').HubConsent>;
  revokeConsent(accessToken: string, scope: string): Promise<import('./types').HubConsent>;
  deleteAccount(accessToken: string, confirmation: string): Promise<{ account_id: string; status: string; deletion_scheduled_at: string }>;
  healthz(): Promise<boolean>;
  readyz(): Promise<boolean>;
}

/** Create a Hub client bound to a concrete base URL (production: `hubApiBase()`). */
export function createHubClient(baseUrl: string): HubClient {
  async function request<T>(pathname: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${pathname}`, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      log.warn('hub request network failure', { pathname, error: (err as Error).message });
      throw new HubApiError('HUB_NETWORK_ERROR', `无法连接 Hub 服务（${baseUrl}）`, 0);
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON body — keep `json` null and surface status-based error below
    }

    const payload = json as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    if (res.ok && payload?.ok !== false) {
      return (payload?.data ?? payload) as T;
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
      return request<{ data: import('./types').HubDevice[]; total: number }>(
        `/api/v1/devices?page=${page}&page_size=${pageSize}`,
        { token: accessToken },
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
