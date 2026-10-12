/**
 * 贡献者身份门。
 *
 * ## 复用了什么
 *
 * Hub 账号层（`features/hub_account/`）整套已存在：`startLogin` / `openAuthorizeUrl` /
 * `completeLogin` / `getAccountMe` / 会话刷新 / 登录结果广播。本模块**不新建登录流程**，
 * 只把贡献所需的两个前置判定收在一处：会话是否可用、显示名是否具备。
 *
 * ## 显示名为什么是硬前置
 *
 * 跨端契约 c00 §1：提交时取 `/me` 的 `community_profile.display_name` 快照，为空或仅空白
 * 一律 `DISPLAY_NAME_REQUIRED`——**不允许匿名贡献**。`HubAccountMe.account.community_profile`
 * 的类型是 `{ display_name: string | null; is_contributor: boolean }`，`null` 是合法取值，
 * 所以这不是边缘情况而是必经判定。
 *
 * 客户端先判是为了少一次注定失败的往返，**服务端判定仍为准**（c00 §1 明写）。
 *
 * ## `is_contributor` 为什么不用
 *
 * Hub 侧 `research.md` R-01 记载该字段当前硬编码 `false`，贡献者身份以 Hub 的提交记录
 * 判定，不依赖它。这里一并不读，避免让一个恒假的字段影响本机判断。
 *
 * ## release gate
 *
 * `hub-account.*` 的多数 IPC 走 `requireReleaseGate()`。Gate 关闭时整个 Hub 账号能力
 * 不可用，贡献自然也不可用——这里显式表达，避免上层把"gate 关闭"误读成"未登录"
 * 而去引导一个不会成功的登录。
 */
import { createLogger } from '../../logger';
import { isHubAccountReleaseEnabled } from '../hub_account/gate';
import { getAccountMe } from '../hub_account';
import { loadHubSession } from '../hub_account/tokens';

const log = createLogger('contribution/identity');

export type IdentityGateOutcome = 'ready' | 'blocked';

export type IdentityBlockReason =
  | 'release_disabled'       // Hub 账号能力未在本构建开放
  | 'not_signed_in'          // 无本地会话
  | 'display_name_required'  // 已登录但社区显示名为空（c00 §1，不允许匿名贡献）
  | 'account_unavailable';   // /me 不可达或账号不可用

export interface IdentityGateResult {
  outcome: IdentityGateOutcome;
  reason?: IdentityBlockReason;
  /** 提交时写入 manifest 的显示名快照。仅 `ready` 时存在。 */
  displayName?: string;
  /** 账号标识，用于日志与本机关联，**不进上行 manifest**（服务端自行解析）。 */
  accountId?: string;
}
/**
 * 贡献前的身份判定。
 *
 * 永不抛错：网络或服务端问题落 `account_unavailable`，由上层决定是提示重试还是
 * 停在当前页——都不该让贡献流程以未捕获异常收场。
 */
export async function gateIdentity(uid: string): Promise<IdentityGateResult> {
  if (!isHubAccountReleaseEnabled()) {
    return { outcome: 'blocked', reason: 'release_disabled' };
  }

  // 先看本地会话：没有会话时不必打网络，直接走登录引导。
  if (!loadHubSession(uid)) {
    return { outcome: 'blocked', reason: 'not_signed_in' };
  }

  let me: Awaited<ReturnType<typeof getAccountMe>>;
  try {
    me = await getAccountMe(uid);
  } catch (err) {
    log.warn('identity gate: /me unavailable', { error: (err as Error).message });
    return { outcome: 'blocked', reason: 'account_unavailable' };
  }

  if (me.account.status !== 'active') {
    return { outcome: 'blocked', reason: 'account_unavailable' };
  }

  // 空串与纯空白都算缺失（c00 §1「为空 / 仅空白」）。
  const displayName = String(me.account.community_profile?.display_name || '').trim();
  if (!displayName) {
    return { outcome: 'blocked', reason: 'display_name_required', accountId: me.account.account_id };
  }

  return { outcome: 'ready', displayName, accountId: me.account.account_id };
}
