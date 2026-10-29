/**
 * Minimal HTTP client for the CogSeed Hub account service.
 *
 * The Hub service is a separate backend (own domain / base URL), not the
 * marketplace API base. Base resolution precedence:
 *   1. `COGSEED_HUB_API_BASE` env override (local integration),
 *   1.5 启动时的「生产优先 / 本地兜底」选择结果（`features/service_origins.ts`）。
 *      只在 dev / unknown 通道生效；release 与 packaged-dev 不参与。
 *      **显式 env 永远排在它前面**，所以联调时设变量即可强制指定。
 *   2. the origin baked into the package at build time (`hubApiBase` in
 *      `.build/build-info.json`, written by `scripts/write-build-info.cjs`),
 *   3. channel default — dev/unknown 在解析完成前落到生产；packaged-dev 用本机
 *      测试服务；release 用占位值。
 *
 * Step 2 is why a packaged release can reach the Hub at all: a double-clicked
 * `.app` inherits no environment, and the source tree deliberately carries no
 * real origin; release deployments supply their service origin at package time.
 *
 * Every endpoint returns the Hub envelope `{ ok: true, data }`; failures
 * throw `HubApiError` carrying the service error code (e.g.
 * `AUTH_INVALID_TOKEN`, `BINDING_ALREADY_EXISTS`) so callers can branch.
 */
import { createLogger } from '../../logger';
import { resolveBuildIdentity } from '../../util/build-identity';
import { normalizeHttpsOrigin } from '../../util/https-origin';
import * as serviceOrigins from '../service_origins';
import type {
  HubAccountMe,
  HubUpdateProfileRequest,
  HubBindResult,
  HubCallbackDeviceInfo,
  HubCallbackResult,
  HubConsent,
  HubDeletionImpact,
  HubDeletionResult,
  HubDeletionSendCodeResult,
  HubDeleteAccountRequest,
  HubDevice,
  HubRefreshResult,
} from './types';

const log = createLogger('hub_account:client');

export const DEFAULT_HUB_API_BASE = 'http://localhost:3000';
// 验收用 packaged-dev 包固定指向本机账号服务；正式 release
// 仍使用线上 HTTPS 地址，避免测试配置泄漏到发布通道。
export const PACKAGED_DEV_HUB_API_BASE = 'http://127.0.0.1:4202';
export const RELEASE_HUB_API_BASE = 'https://hub.example.com';

/**
 * 按环境变量、构建期注入值与构建通道解析 Hub 服务地址。
 * 优先级：`COGSEED_HUB_API_BASE` > 构建期注入值（release）> 通道默认值。
 * 纯函数，便于测试。
 */
export function resolveHubApiBase(
  envOverride: string | undefined,
  channel: string,
  packagedBase = '',
): string {
  const env = envOverride?.trim();
  if (env) return env;
  if (channel === 'release') return normalizeHttpsOrigin(packagedBase) || RELEASE_HUB_API_BASE;
  if (channel === 'packaged-dev') return PACKAGED_DEV_HUB_API_BASE;
  return DEFAULT_HUB_API_BASE; // dev / unknown：本地联调默认 localhost
}

/** Resolve the Hub service base URL. `COGSEED_HUB_API_BASE` is the documented
 *  local-integration override; packaged builds use the origin baked into
 *  `.build/build-info.json` at package time. */
export function hubApiBase(): string {
  // ① 启动时的"生产优先 / 本地兜底"选择结果（见 features/service_origins.ts）
  const selected = serviceOrigins.selectedHubBase();
  if (selected) return selected;

  const env = process.env.COGSEED_HUB_API_BASE;
  const { channel, hubApiBase: packagedBase } = resolveBuildIdentity();
  // ② 开发通道且尚未解析完成：先指生产。
  //    以前这里落到 `http://localhost:3000`，而本机没有 Hub 实现 ——
  //    用户看到的是"无法连接 Hub 服务"，且不知道要改什么。指生产至少是"能连的那台"。
  const { channelAllowsLocalFallback, PRODUCTION_HUB_BASE } = serviceOrigins;
  if (!env?.trim() && channelAllowsLocalFallback(channel)) return PRODUCTION_HUB_BASE;

  return resolveHubApiBase(env, channel, packagedBase);
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string | null;
  body?: unknown;
  /** Return the full response envelope (`{ data, total, page, ... }`) instead of unwrapping `data`. */
  raw?: boolean;
}

export interface HubClient {
  login(provider: string, redirectUri: string): Promise<{
    authorize_url: string;
    state: string;
    /** dev-only mock provider 直接返回的一次性 code（仅 NODE_ENV=development）。 */
    mock_code?: string;
  }>;
  callback(code: string, state: string, device: HubCallbackDeviceInfo): Promise<HubCallbackResult>;
  refresh(refreshToken: string): Promise<HubRefreshResult>;
  logout(accessToken: string): Promise<{ message: string }>;
  me(accessToken: string): Promise<HubAccountMe>;
  updateProfile(accessToken: string, body: HubUpdateProfileRequest): Promise<HubAccountMe>;
  bind(
    accessToken: string,
    body: { local_identity_id: string; installation_id: string; device_name: string; device_os: string },
  ): Promise<HubBindResult>;
  listDevices(accessToken: string, page?: number, pageSize?: number): Promise<{ data: HubDevice[]; total: number }>;
  revokeDevice(accessToken: string, deviceId: string): Promise<{ device_id: string; revoked_sessions: number }>;
  listConsents(accessToken: string): Promise<HubConsent[]>;
  setConsent(accessToken: string, scope: string): Promise<HubConsent>;
  revokeConsent(accessToken: string, scope: string): Promise<HubConsent>;
  /** 注销前影响矩阵（DEL-01，服务端下发）。 */
  deletionImpact(accessToken: string): Promise<HubDeletionImpact>;
  /** 向账号绑定手机号发送注销重新认证验证码（DEL-02）。 */
  sendDeletionCode(accessToken: string): Promise<HubDeletionSendCodeResult>;
  /** 注销账号：重新认证 + 二次确认（契约 v1.6）。 */
  deleteAccount(accessToken: string, body: HubDeleteAccountRequest): Promise<HubDeletionResult>;
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
      return request<{ authorize_url: string; state: string; mock_code?: string }>(
        `/api/v1/auth/login?${qs.toString()}`,
      );
    },
    callback: (code, state, device) =>
      request('/api/v1/auth/callback', { method: 'POST', body: { code, state, ...device } }),
    refresh: (refreshToken) =>
      request('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } }),
    logout: (accessToken) =>
      request('/api/v1/auth/logout', { method: 'POST', token: accessToken }),
    me: (accessToken) =>
      request('/api/v1/account/me', { token: accessToken }),
    updateProfile: (accessToken, body) =>
      request('/api/v1/account/me', { method: 'PATCH', token: accessToken, body: { display_name: body.display_name } }),
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
    deletionImpact: (accessToken) =>
      request('/api/v1/account/deletion/impact', { token: accessToken }),
    sendDeletionCode: (accessToken) =>
      request('/api/v1/account/deletion/send-code', { method: 'POST', token: accessToken, body: {} }),
    deleteAccount: (accessToken, body) =>
      request('/api/v1/account', { method: 'DELETE', token: accessToken, body }),
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
let _boundBase = '';
export function hubClient(): HubClient {
  if (!_shared) {
    _boundBase = hubApiBase();
    _shared = createHubClient(_boundBase);
  }
  return _shared;
}

/** Test hook — replace the shared client (e.g. point at a mock server). */
export function setSharedHubClient(client: HubClient | null): void {
  _shared = client;
}

/**
 * 共享客户端当前绑定的基址（用于判断解析完成后是否需要重绑）。
 *
 * 背景：服务地址在启动时**异步**探测（生产优先 / 本地兜底）。若某个模块在探测
 * 完成之前就调用过 `hubClient()`，实例会被绑在旧地址上。解析完成后作废一次即可，
 * 下次使用自然重绑 —— 这发生在用户点击之前，不构成"授权流程内切换服务器"。
 */
serviceOrigins.onServiceOriginsResolved(() => {
  const resolved = serviceOrigins.selectedHubBase();
  if (resolved && resolved !== _boundBase) {
    _shared = null;
    _boundBase = resolved;
  }
});
