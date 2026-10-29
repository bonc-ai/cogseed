/**
 * Hub client for the A2A contacts feature.
 *
 * The Hub is the authority for contact relationships (D-1). Every call takes the
 * local `userId` and uses that identity's **normal Hub session** (T2.2): the old
 * `COGSEED_A2A_HUB_URL` + `COGSEED_A2A_HUB_TOKEN` fixture made "not signed in"
 * indistinguishable from "signed in", and let a signed-out identity keep acting.
 *
 * Failure codes stay explicit because the UI must distinguish three states:
 * - `HUB_NOT_CONFIGURED` — nobody is signed in on this machine;
 * - `HUB_AUTH_REQUIRED`  — the session can no longer be refreshed (re-login);
 * - `HUB_UNREACHABLE`    — network/timeout, retryable;
 * - plus Hub's own business codes (NOT_DISCOVERABLE, …).
 *
 * `null` still means "Hub unavailable" for callers that degrade locally.
 */

import { currentHubIdentity, isHubIdentityCurrent, hasHubSession, withHubSession, throwIfHubUnauthorized, type HubSessionScope } from '../hub_account/transport';
import { HubApiError } from '../hub_account/client';

export interface HubLookupResult {
  registered: boolean;
  discoverable: boolean;
  is_contact: boolean;
}

const TIMEOUT_MS = 5_000;

function sessionFailureCode(reason: 'no_session' | 'network' | 'auth'): string {
  if (reason === 'no_session') return 'HUB_NOT_CONFIGURED';
  if (reason === 'auth') return 'HUB_AUTH_REQUIRED';
  return 'HUB_UNREACHABLE';
}

/** 只有当前身份持有正常登录会话时，联系人能力才可用。 */
export function hubConfigured(userId: string): boolean {
  return hasHubSession(userId);
}

async function request<T>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; isCurrent?: () => boolean } = {},
): Promise<T | null> {
  const detailed = await requestDetailed<T>(userId, path, init);
  return detailed.ok ? detailed.data : null;
}

/** 带错误码的请求：开关/发送这类「失败原因要告诉用户」的路径用这个。 */
export async function requestDetailed<T>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; isCurrent?: () => boolean } = {},
): Promise<{ ok: true; data: T | null } | { ok: false; code: string }> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, code: 'HUB_NOT_CONFIGURED' };
  if (init.isCurrent && !init.isCurrent()) return { ok: false, code: 'HUB_NOT_CONFIGURED' };
  const result = await withHubSession(uid, async ({ baseUrl, token, isCurrent }) => {
    if (!isCurrent() || (init.isCurrent && !init.isCurrent())) return { ok: false as const, code: 'HUB_NOT_CONFIGURED' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init.method || (init.body ? 'POST' : 'GET'),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: T; error?: { code?: string } }
        | null;
      if (!isCurrent() || (init.isCurrent && !init.isCurrent())) return { ok: false as const, code: 'HUB_NOT_CONFIGURED' };
      throwIfHubUnauthorized(res.status, json?.error?.code);
      if (!res.ok || !json || json.ok === false) {
        return {
          ok: false as const,
          code: String(json?.error?.code || (res.ok ? 'HUB_BAD_RESPONSE' : `HUB_${res.status}`)),
        };
      }
      return { ok: true as const, data: (json.data ?? null) as T | null };
    } catch (error) {
      if (error instanceof HubApiError) throw error;
      // 网络失败/超时：调用方决定是回落本地实现还是把原因告诉用户。
      return { ok: false as const, code: 'HUB_UNREACHABLE' };
    } finally {
      clearTimeout(timer);
    }
  });
  if ('reason' in result) return { ok: false, code: sessionFailureCode(result.reason) };
  return result.value;
}

const HUB_LOOKUP_FALLBACK_CODES = new Set(['HUB_NOT_CONFIGURED', 'HUB_AUTH_REQUIRED', 'HUB_UNREACHABLE']);

function lookupErrorMessage(code: string): string {
  if (code === 'LOOKUP_QUOTA_EXCEEDED') return '今日查找次数已用完';
  if (code === 'CLIENT_UPGRADE_REQUIRED') return '客户端版本过低';
  return code;
}

/**
 * 手机号 → 三个布尔（Hub 侧已做配额与版本闸门）。
 * 返回 null 表示"Hub 不可用"（网络/未登录等），调用方可以回落本地；
 * 配额、版本闸门这类**业务拒绝**抛 HubApiError，不能被当成"未注册"静默吞掉。
 */
export async function hubLookupPhone(userId: string, phone: string): Promise<HubLookupResult | null> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const detailed = await requestDetailed<HubLookupResult>(userId, '/api/v1/a2a/lookup', { body: { phone: digits } });
  if ('code' in detailed) {
    const code = detailed.code;
    if (HUB_LOOKUP_FALLBACK_CODES.has(code)) return null;
    throw new HubApiError(code, lookupErrorMessage(code), 0);
  }
  const data = detailed.data;
  if (!data) return null;
  return {
    registered: data.registered === true,
    discoverable: data.discoverable === true,
    is_contact: data.is_contact === true,
  };
}

// ── 关系链路（申请 / 列表 / 通过 / 删除）─────────────────────────────
// 返回 null 一律表示"Hub 不可用"，调用方回落到本地实现。

export interface HubContact {
  accountId: string;
  name: string;
  online: boolean;
}

export interface HubRequest {
  requestId: string;
  direction: 'in' | 'out';
  peerAccountId: string;
  peerName?: string;
  phoneMasked: string;
  note: string;
  state: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
}

/**
 * 本方账号 id（GET /account/me）。A2A 交换 id 由「双方账号」派生，发起侧必须知道自己是谁。
 *
 * Cache belongs to one account/session lifecycle; ordinary refresh keeps it.
 */
const _selfAccountCache = new Map<string, HubSessionScope>();

export async function hubSelfAccountId(userId: string): Promise<string | null> {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const scope = currentHubIdentity(uid);
  if (!scope) return null;
  const cached = _selfAccountCache.get(uid);
  if (cached && isHubIdentityCurrent(uid, cached)) return cached.accountId;
  const data = await request<{ account?: { account_id?: string } }>(uid, '/api/v1/account/me');
  const accountId = String(data?.account?.account_id || '').trim();
  if (!accountId || accountId !== scope.accountId || !isHubIdentityCurrent(uid, scope)) return null;
  _selfAccountCache.set(uid, scope);
  return accountId;
}

/** 测试用：清掉账号缓存（退出/换账号后不应复用旧值）。 */
export function _resetHubSelfAccountCache(): void {
  _selfAccountCache.clear();
}

export async function hubListContacts(userId: string, options: { isCurrent?: () => boolean } = {}): Promise<HubContact[] | null> {
  const data = await request<{ contacts: HubContact[] }>(userId, '/api/v1/a2a/contacts', options);
  return data && Array.isArray(data.contacts) ? data.contacts : null;
}

export async function hubListRequests(userId: string): Promise<HubRequest[] | null> {
  const data = await request<{ requests: HubRequest[] }>(userId, '/api/v1/a2a/contacts/requests');
  return data && Array.isArray(data.requests) ? data.requests : null;
}

/** 两个开关的服务端权威（consent_records）。缺记录＝用户没关过（与 Hub 同口径）。 */
export const A2A_CONSENT_SCOPES = {
  discoverable: 'contacts.discoverable',
  assistantQuestions: 'contacts.assistant_questions',
} as const;

/**
 * consent 记录的判定：**显式 granted=1 才算开**，缺记录＝没开过（默认关）。
 * 纯函数，界面与测试共用同一口径，避免「缺记录」在某一层被读成「没关过」。
 */
export function consentState(records: Record<string, boolean> | null | undefined, scope: string): boolean {
  if (!records || typeof records !== 'object') return false;
  return records[scope] === true;
}

export async function hubGetConsents(userId: string): Promise<Record<string, boolean> | null> {
  const detailed = await requestDetailed<Array<{ scope: string; granted: number | boolean }>>(
    userId,
    '/api/v1/consent',
  );
  if (detailed.ok === false) return null;
  const rows = Array.isArray(detailed.data) ? detailed.data : [];
  const out: Record<string, boolean> = {};
  for (const row of rows) {
    if (!row || typeof row.scope !== 'string') continue;
    out[row.scope] = Number(row.granted) === 1 || row.granted === true;
  }
  return out;
}

/** 授权/撤回一个 scope；返回 false 表示服务端没接受（调用方应把开关回滚）。 */
export async function hubSetConsent(userId: string, scope: string, granted: boolean): Promise<boolean> {
  const detailed = await requestDetailed(
    userId,
    `/api/v1/consent/${encodeURIComponent(scope)}`,
    { method: granted ? 'PUT' : 'DELETE' },
  );
  return detailed.ok;
}

/** 发申请；带错误码，界面据此区分「不可被搜」与「网络问题」。 */
export async function hubSendRequestDetailed(
  userId: string,
  phone: string,
  note?: string,
): Promise<{ ok: true; requestId: string } | { ok: false; code: string }> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { ok: false, code: 'INVALID_PHONE' };
  const detailed = await requestDetailed<{ requestId: string }>(userId, '/api/v1/a2a/contacts/requests', {
    body: { phone: digits, ...(note ? { note } : {}) },
  });
  if (detailed.ok === false) return { ok: false, code: detailed.code };
  const requestId = String(detailed.data?.requestId || '').trim();
  return requestId ? { ok: true, requestId } : { ok: false, code: 'HUB_BAD_RESPONSE' };
}

export async function hubSendRequest(
  userId: string,
  phone: string,
  note?: string,
): Promise<{ requestId: string } | null> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return request<{ requestId: string }>(userId, '/api/v1/a2a/contacts/requests', {
    body: { phone: digits, ...(note ? { note } : {}) },
  });
}

export async function hubDecideRequest(userId: string, id: string, accept: boolean): Promise<boolean> {
  const data = await request<{ state: string }>(
    userId,
    `/api/v1/a2a/contacts/requests/${encodeURIComponent(id)}/${accept ? 'accept' : 'reject'}`,
    { method: 'POST' },
  );
  return !!data && (data.state === 'accepted' || data.state === 'rejected');
}

export async function hubRemoveContact(userId: string, accountId: string): Promise<boolean> {
  const data = await request<{ removed: boolean }>(
    userId,
    `/api/v1/a2a/contacts/${encodeURIComponent(accountId)}`,
    { method: 'DELETE' },
  );
  return !!data && data.removed === true;
}

export async function hubPresencePing(userId: string): Promise<void> {
  await request(userId, '/api/v1/a2a/presence', { method: 'POST' });
}
