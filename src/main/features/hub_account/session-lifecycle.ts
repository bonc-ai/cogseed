/**
 * 身份生命周期收尾（T2.3）。
 *
 * 登录/退出改变的是「当前身份能不能访问 Hub」。除了清会话本身，还要把**由旧
 * 身份派生出来的内存状态**一并撤销，否则退出后仍会：
 * - 用缓存下来的 Hub 账号 id 继续派生交换 id；
 * - 继续按旧身份发在线心跳；
 * - 到点后用已经失效的身份发接待提示。
 *
 * 这里只做编排，不复制各模块的业务逻辑；依赖可注入，便于在无网络、无 UI 的
 * 测试里验证「谁被撤销了」。
 */

import { createLogger } from '../../logger';

const log = createLogger('hub-session-lifecycle');

export interface SessionLifecycleDeps {
  /** 撤销 A2A 接待提示的排队计时器，返回撤销条数。 */
  cancelNudges?: (userId: string) => number;
  /** 停掉在线心跳。 */
  stopPresence?: () => void;
  /** 启动在线心跳。 */
  startPresence?: (userId: string) => void;
  /** 清掉 Hub 本方账号缓存。 */
  resetSelfAccount?: () => void;
}

async function defaults(): Promise<Required<SessionLifecycleDeps>> {
  const [nudges, presence, hubClient] = await Promise.all([
    import('../a2a/reception-nudge'),
    import('../contacts/presence'),
    import('../contacts/hub-client'),
  ]);
  return {
    cancelNudges: (userId: string) => nudges.cancelReceptionNudgesForUser(userId),
    stopPresence: () => presence.stopPresenceHeartbeat(),
    startPresence: (userId: string) => { presence.startPresenceHeartbeat(userId); },
    resetSelfAccount: () => hubClient._resetHubSelfAccountCache(),
  };
}

/** 登录成功后按新身份恢复心跳（启动时可能还没登录，那时不会挂计时器）。 */
export async function onSignedIn(
  userId: string,
  deps: SessionLifecycleDeps = {},
): Promise<void> {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const resolved = { ...(await defaults()), ...deps };
  try {
    resolved.startPresence(uid);
  } catch (error) {
    log.warn('presence heartbeat start failed after sign-in', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 退出登录/账号删除后撤销旧身份派生状态。
 *
 * 幂等：本地本来就没有会话时也安全地什么都不做。
 */
export async function onSignedOut(
  userId: string,
  deps: SessionLifecycleDeps = {},
): Promise<{ cancelledNudges: number }> {
  const uid = String(userId || '').trim();
  const resolved = { ...(await defaults()), ...deps };
  let cancelledNudges = 0;
  try {
    cancelledNudges = resolved.cancelNudges(uid);
  } catch (error) {
    log.warn('reception nudge cancellation failed after sign-out', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    resolved.stopPresence();
  } catch (error) {
    log.warn('presence heartbeat stop failed after sign-out', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    resolved.resetSelfAccount();
  } catch (error) {
    log.warn('hub self-account cache reset failed after sign-out', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  log.info('hub identity teardown complete', { cancelledNudges });
  return { cancelledNudges };
}
