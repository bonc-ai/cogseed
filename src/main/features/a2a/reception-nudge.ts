/**
 * A2A 接待的 5 分钟提示（D-23/AC-18）。
 *
 * 首问停在 waiting 时，接收方可能正在开会、没看见界面。让提问人无限等是不礼貌的，
 * 所以过了 5 分钟由助理代说一句「需要我本人确认，稍后回复」——只此一次（marker 上的
 * `nudged` 是幂等标记），本人一旦确认/拒绝就取消。
 *
 * 计时器只活在主进程内存里：应用重启后这一轮提示会丢。这是有意的取舍——提示是
 * 礼貌性的附加动作，为它写一套持久化时钟与恢复流程不划算；`nudged` 已落盘，所以
 * 重启后也不会重复提示第二次。
 */

import { createLogger } from '../../logger';
import { hasHubSession } from '../hub_account/transport';
import { t } from '../../i18n';
import { updateConversationAtomic } from '../chats';
import { getCachedContact } from '../contacts/store';
import { isInboundMarker, parseA2AConversationMarker } from './conversation-marker';
import { sendRelayMessage, type RelayMessage } from './relay-client';

const log = createLogger('a2a-reception-nudge');

/** PRD D-23：超过这个窗口就代说一句「稍后回复」。 */
export const A2A_RECEPTION_NUDGE_MS = 5 * 60 * 1000;

const PENDING_REPLY_MESSAGE_ID = 'a2a.reception.pending_reply';
const PENDING_REPLY_FALLBACK = '这件事需要我本人确认，稍后回复你。';

export function receptionPendingReplyText(): string {
  const text = t(PENDING_REPLY_MESSAGE_ID);
  return text && text !== PENDING_REPLY_MESSAGE_ID ? text : PENDING_REPLY_FALLBACK;
}

export interface ReceptionNudgeDeps {
  send?: (input: { to: string; conversationId: string; kind: RelayMessage['kind']; text: string }) => Promise<{ messageId: string } | null>;
  setTimeoutFn?: (handler: () => void, ms: number) => NudgeTimer;
  clearTimeoutFn?: (timer: NudgeTimer) => void;
  delayMs?: number;
}

/** 只在主进程内按「用户 + 会话」去重：同一会话不会有两条提示排着队。 */
// 计时器句柄在 DOM/Node 两套声明里类型不同（number vs Timeout），统一按最宽的一种存。
type NudgeTimer = number | ReturnType<typeof setTimeout>;
const pendingTimers = new Map<string, NudgeTimer>();

function keyOf(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** 计时器句柄在 DOM/Node 两套声明里类型不同，这里统一成一种。 */
function clearTimer(deps: ReceptionNudgeDeps, timer: NudgeTimer): void {
  const clear = (deps.clearTimeoutFn ?? clearTimeout) as unknown as (handle: NudgeTimer) => void;
  clear(timer);
}

/**
 * 排一次提示。已经在排队就保持现状（重复的入站问题不应叠加计时器）。
 * `peerUserId` 是消息里带来的对端账号——不重新推导，避免发送时对错人。
 */
export function scheduleReceptionNudge(
  userId: string,
  conversationId: string,
  peerUserId: string,
  deps: ReceptionNudgeDeps = {},
): void {
  const key = keyOf(userId, conversationId);
  if (pendingTimers.has(key)) return;
  // 未配置 relay 时提示也发不出去，不必挂一个空计时器。
  if (!relayAvailable(userId, deps)) return;
  const setT = deps.setTimeoutFn ?? setTimeout;
  const timer: NudgeTimer = setT(() => {
    pendingTimers.delete(key);
    void sendNudge(userId, conversationId, peerUserId, deps).catch((error) => {
      log.warn('reception nudge failed', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, deps.delayMs ?? A2A_RECEPTION_NUDGE_MS);
  // 计时器不应独自把进程留在事件循环里。
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  pendingTimers.set(key, timer);
}

export function cancelReceptionNudge(userId: string, conversationId: string, deps: ReceptionNudgeDeps = {}): void {
  const key = keyOf(userId, conversationId);
  const timer = pendingTimers.get(key);
  if (!timer) return;
  clearTimer(deps, timer);
  pendingTimers.delete(key);
}

/**
 * 退出登录/切身份时撤销该身份排队中的提示（T2.3）。
 *
 * 提示发送依赖正常会话；会话没了还留着计时器，只会在到点时做一次注定失败的
 * 发送。返回撤销的条数，便于日志与测试观察。
 */
export function cancelReceptionNudgesForUser(userId: string, deps: ReceptionNudgeDeps = {}): number {
  const uid = String(userId || '');
  if (!uid) return 0;
  const prefix = `${uid}:`;
  let cancelled = 0;
  for (const [key, timer] of pendingTimers.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearTimer(deps, timer);
    pendingTimers.delete(key);
    cancelled += 1;
  }
  return cancelled;
}

/** 测试用：清空全部排队中的提示。 */
export function resetReceptionNudges(deps: ReceptionNudgeDeps = {}): void {
  for (const timer of pendingTimers.values()) clearTimer(deps, timer);
  pendingTimers.clear();
}

function relayAvailable(userId: string, deps: ReceptionNudgeDeps): boolean {
  // 测试替身显式注入时按注入走；生产只认当前身份的正常登录会话（T2.2）。
  // 环境 Token 不再是能力来源：它让「未登录也能发」，退出登录后还会继续发。
  if (deps.send) return true;
  return hasHubSession(userId);
}

/**
 * 到点时的判定：会话仍是「等本人确认」且没提示过，才代说一句。
 *
 * 本人已经确认/拒绝、或已经提示过，都静默返回——提示不是状态机的一部分，
 * 只是一个附加动作，任何一步对不上就什么都不做。
 */
async function sendNudge(
  userId: string,
  conversationId: string,
  peerUserId: string,
  deps: ReceptionNudgeDeps,
): Promise<void> {
  const send = deps.send ?? ((input: Parameters<typeof sendRelayMessage>[1]) => sendRelayMessage(userId, input));
  let sent = false;
  await updateConversationAtomic(userId, conversationId, async (current) => {
    const marker = parseA2AConversationMarker(current.a2a);
    if (!marker || !isInboundMarker(marker) || marker.peer_user_id !== peerUserId
      || marker.state !== 'waiting' || marker.nudged) return null;
    // 联系人缓存是 Hub 权威名单的本地镜像。检查与 relay 同处会话写队列，
    // 删除收尾若已完成就不会发送；若提示先拿到队列，删除只能在发送后完成。
    if (!(await getCachedContact(userId, peerUserId))) return null;
    const delivered = await send({
      to: peerUserId,
      conversationId,
      kind: 'answer',
      text: receptionPendingReplyText(),
    });
    if (!delivered) return null;
    sent = true;
    return { a2a: { ...marker, nudged: true } };
  });
  if (sent) log.info('reception nudge sent', { conversationId });
}
