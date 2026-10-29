/**
 * 按本地身份取 Hub 正常会话的传输接缝（T2）。
 *
 * 存在理由：联系人、relay 和接待提示原先各自读 `COGSEED_A2A_HUB_TOKEN` 环境变量。
 * 那是开发夹具，不是登录态——它让「未登录也能通信」，也让退出登录后旧身份继续
 * 工作。这里给出一条唯一入口：用**当前 userId 的正常会话**取 token，失败时明确
 * 区分「未登录」「网络不可达」「鉴权终止」，绝不再回落到环境 Token。
 *
 * 边界：
 * - 不做能力判断之外的业务决策（谁可以收发由各 feature 决定）；
 * - 网络错误与鉴权终止必须可区分：前者可以等待重试，后者必须要求重新登录；
 * - 本模块不写任何用户数据，只读取本机加密会话。
 */

import { hubApiBase, HubApiError, hubClient, type HubClient } from './client';
import { ensureFreshSession, refreshSession } from './auth-flow';
import { loadHubSession, hubSessionGeneration } from './tokens';
import { readHubAccountState } from './state';

export interface HubSessionScope {
  accountId: string;
  sessionId: string;
  generation: number;
}

/** Account identity comes from normal account state, never from a relay body. */
export function currentHubIdentity(userId: string): HubSessionScope | null {
  const session = loadHubSession(userId);
  const accountId = readHubAccountState(userId).account_id;
  return session && accountId ? { accountId, sessionId: session.session_id, generation: hubSessionGeneration(userId) } : null;
}

export function isHubIdentityCurrent(userId: string, scope: HubSessionScope): boolean {
  const current = currentHubIdentity(userId);
  return !!current && current.accountId === scope.accountId && current.sessionId === scope.sessionId
    && current.generation === scope.generation;
}

export type HubSessionFailure = 'no_session' | 'network' | 'auth';

export type HubSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: HubSessionFailure };

export interface HubSessionContext {
  baseUrl: string;
  token: string;
  isCurrent: () => boolean;
}

/** Whether this local identity has a stored normal session (no network call). */
export function hasHubSession(userId: string): boolean {
  const uid = String(userId || '').trim();
  return !!uid && !!loadHubSession(uid);
}

/** Raw HTTP callers must let the session owner classify 401 and retry only
 * AUTH_INVALID_TOKEN. Preserve Hub's code: revoked/expired/frozen accounts must
 * not be converted into refreshable invalid-token errors. */
export function throwIfHubUnauthorized(status: number, code?: string): void {
  if (status === 401) throw new HubApiError(code || 'HUB_401', 'Hub authentication failed', status);
}

function failureOf(error: unknown): HubSessionFailure {
  if (error instanceof HubApiError) {
    // status 0 / HUB_NETWORK_ERROR means "could not reach Hub": retryable, and it
    // must never be reported as a signed-out state.
    if (error.status === 0 || error.code === 'HUB_NETWORK_ERROR') return 'network';
    if (error.code === 'AUTH_REQUIRED') return 'no_session';
    return 'auth';
  }
  return 'network';
}

/**
 * Run one authenticated Hub call with the user's normal session.
 *
 * Never falls back to an environment token: a caller that gets `no_session` must
 * show the normal login guidance instead of continuing to talk to Hub.
 */
export async function withHubSession<T>(
  userId: string,
  fn: (context: HubSessionContext) => Promise<T>,
  client: HubClient = hubClient(),
): Promise<HubSessionResult<T>> {
  const uid = String(userId || '').trim();
  if (!uid || !loadHubSession(uid)) return { ok: false, reason: 'no_session' };
  const generation = hubSessionGeneration(uid);
  const sessionId = loadHubSession(uid)?.session_id;
  const accountId = readHubAccountState(uid).account_id;
  const isCurrent = () => generation === hubSessionGeneration(uid)
    && loadHubSession(uid)?.session_id === sessionId && readHubAccountState(uid).account_id === accountId;

  let session;
  try {
    session = await ensureFreshSession(uid, client);
  } catch (error) {
    return { ok: false, reason: failureOf(error) };
  }
  if (!isCurrent()) return { ok: false, reason: 'no_session' };

  const call = async (token: string): Promise<HubSessionResult<T>> => {
    if (!isCurrent()) return { ok: false, reason: 'no_session' };
    const value = await fn({ baseUrl: hubApiBase(), token, isCurrent });
    return isCurrent() ? { ok: true, value } : { ok: false, reason: 'no_session' };
  };

  try {
    return await call(session.access_token);
  } catch (error) {
    if (!isCurrent()) return { ok: false, reason: 'no_session' };
    // Access token may have expired between the freshness check and the request.
    if (error instanceof HubApiError && error.code === 'AUTH_INVALID_TOKEN') {
      try {
        const fresh = await refreshSession(uid, client);
        return await call(fresh.access_token);
      } catch (retryError) {
        return { ok: false, reason: failureOf(retryError) };
      }
    }
    return { ok: false, reason: failureOf(error) };
  }
}
