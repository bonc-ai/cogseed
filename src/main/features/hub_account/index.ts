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
  updateProfile,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  getDeletionImpact,
  sendDeletionCode,
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
/**
 * 「换个 CogSeed 账号登录」深链：`cogseed://account/switch`
 *
 * 为什么要这条深链（specs/004-oauth-account-rebind/contracts/account-switch-deeplink.md）：
 *   插件授权页由**课程平台**渲染于系统浏览器，而登录入口是桌面端的 IPC
 *   （`hub-account.start_login`）—— 浏览器里的页面调不到它。深链是唯一能把
 *   "用户想换账号"这一意图交给客户端的通道。
 *
 * 🔴 与 `accountCallbackUrl` 同族但语义不同：那个是**登录完成**的回调（带 code/state），
 *    这个是**换账号请求**（不带任何参数）。
 */
const ACCOUNT_SWITCH_PATH = '/switch';

/** 识别换账号深链；不是该深链时返回 null。 */
export function accountSwitchRequested(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'cogseed:') return null;
    if (parsed.host.toLowerCase() !== ACCOUNT_CALLBACK_HOST) return null;
    if ((parsed.pathname.replace(/\/+$/, '') || '/') !== ACCOUNT_SWITCH_PATH) return null;
    // 🔴 契约要求**不得携带任何参数**：它只是"用户想换账号"的意图信号，
    //    账号是谁由随后的 Hub 登录决定。带上参数会让它变成一个可被构造的入口。
    if ([...parsed.searchParams.keys()].length > 0) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * 处理换账号深链：**先登出、再发起登录**（顺序不可颠倒）。
 *
 * 🔴 为什么必须先登出：Hub 的登录端点不接受"强制选择账号"参数，若本地仍持有
 *    有效会话，Hub 极可能直接复用同一个账号 —— 用户会看到"我换了账号却还是原来那个"。
 *
 * 🔴 **绝不撤销任何教育身份接入关系**：换 CogSeed 账号不是解绑（FR-006）。
 *    换完之后新账号在本平台本来就没有接入关系，授权流程会自然走到身份核对环节。
 */
export async function handleAccountSwitchRequested(): Promise<{ ok: boolean; error?: string }> {
  try {
    assertHubAccountReleaseEnabled();
  } catch (err) {
    const failureCode = err instanceof HubApiError ? err.code : 'HUB_RELEASE_GATE_CLOSED';
    log.warn('account switch deep link rejected by release gate', { code: failureCode });
    return { ok: false, error: failureCode };
  }

  const userId = getActiveUserId();
  try {
    // ① 已登录则先登出（清本地会话；服务端登出在 logout 内部尽力而为）
    const session = loadHubSession(userId);
    if (session) await logout(userId);
    // ② 再发起登录：登录在系统浏览器内完成，随后走既有的 account/callback 深链回来
    const { authorize_url } = await startLogin(userId);
    await openAuthorizeUrl(authorize_url);
    log.info('account switch requested; login flow started');
    return { ok: true };
  } catch (err) {
    // 🔴 失败不得破坏当前登录态：logout 内部已优先清本地、失败只记 warn，
    //    这里只上报错误，不额外改动任何状态。
    const message = (err as Error).message;
    log.warn('account switch login failed to start', { error: message });
    return { ok: false, error: message };
  }
}

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
    // T2.3：登录成功后按新身份恢复在线心跳（启动时可能还没登录）。
    try {
      const { onSignedIn } = await import('./session-lifecycle');
      await onSignedIn(userId);
    } catch {
      // 心跳是尽力而为的展示信息，失败不能影响登录结果。
    }
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
  updateProfile,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  getDeletionImpact,
  sendDeletionCode,
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
  updateProfile,
  listDevices,
  revokeDevice,
  listConsents,
  setConsent,
  revokeConsent,
  deleteHubAccount,
  getDeletionImpact,
  sendDeletionCode,
  logout,
  getHubStatus,
  currentLoginState,
};

export const _test = { accountCallbackUrl, parseAccountCallback, accountSwitchRequested };
