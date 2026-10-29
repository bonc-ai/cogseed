/**
 * A2A relay 泵（H-04）：主进程侧的**唯一** relay 消费点。
 *
 * relay 是「投递即删」的：一条消息被谁拉走就归谁。所以消费点只能有一个，而且不能
 * 由「用户正开在某个会话里」决定——接待要能在任意页面上发生（AC-04/05）。渲染层
 * 因此不再轮询，只订阅 `a2a:relay` 推送。
 *
 * 收到什么就做什么：
 * - `question` → 走 `handleInboundQuestion` 决策：首问等本人确认（顺带排 5 分钟
 *   提示），已接受的接访直接开跑；
 * - 其它（`answer`/`correction`）→ 只是给对方看的一条消息，推给界面。
 *
 * 运行不在这里等：接待跑一次可能几分钟，泵只负责把它启动，结果靠事件回推。
 */

import { createLogger } from '../../logger';
import { pollRelayMessages, type RelayMessage } from './relay-client';
import { expireStaleReceptions, handleInboundQuestion, previewReceptionWorkspace } from './reception-service';
import { listWaitingInbox, settleInboxEntry, stageInboundMessages, type WaitingInboxEntry } from './relay-inbox-store';
import { currentHubIdentity, type HubSessionScope } from '../hub_account/transport';
import { fileEditLock } from '../../util/locks';
import { userA2ARelayInboxFile } from '../../paths';
import { getActiveUserId } from '../users';
import { runReception } from './reception-run';
import { scheduleReceptionNudge } from './reception-nudge';
import { getCachedContact } from '../contacts/store';
import { appendIncomingAnswer } from './outbound';

const log = createLogger('a2a-relay-pump');

/** 轮询间隔：与旧渲染层一致，够快且不会给 Hub 压力。 */
export const A2A_RELAY_POLL_MS = 4000;

/** 泵需要的最小问题形状：实时消息与恢复出来的暂存项都满足它。 */
export type RelayQuestionLike = Pick<
  RelayMessage,
  'messageId' | 'fromAccount' | 'conversationId' | 'text'
> & { fromName?: string; createdAt?: string };

export type RelayPumpEvent =
  | {
    type: 'question';
    message: RelayQuestionLike;
    conversationId: string;
    /** true＝等本人确认；false＝已交助理开跑。 */
    awaitingConfirmation: boolean;
    /** 只读解析出的「默认工作区」实际目录（D4 单根），供确认弹窗如实展示。 */
    workspacePreview?: string;
    defaultWorkspace?: string;
    defaultAgentId?: string;
  }
  | { type: 'message'; message: RelayMessage }
  | { type: 'ignored'; message: RelayQuestionLike; reason: string }
  | { type: 'reception-result'; messageId: string; conversationId: string; status: string };

export interface RelayPumpDeps {
  poll?: (since?: string) => Promise<RelayMessage[] | null>;
  /** 当前活跃用户；没有用户时本轮跳过（不消费消息）。 */
  activeUserId?: () => string | null;
  /** Trusted normal-session identity seam; fixtures must opt in explicitly. */
  identity?: (userId: string) => HubSessionScope | null;
  /** 收下一条消息；测试用替身，缺省是真实决策 + 运行。 */
  receive?: (userId: string, message: RelayMessage) => Promise<void>;
  onEvent?: (event: RelayPumpEvent) => void;
  intervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** 每用户游标：只活在内存里。重启后从头拉一次，问题类由台账去重。 */
const cursors = new Map<string, string>();
const cursorScopes = new Map<string, string>();
/** 暂存 TTL 清理节流：复用既有轮询 tick，不另立定时器。 */
const STALE_SWEEP_INTERVAL_MS = 60_000;
const staleSweepAt = new Map<string, number>();
let running = false;
let tickHandle: unknown = null;
let inFlight = false;
let lastFailureLogAt = 0;

function activeUserIdOf(deps: RelayPumpDeps): string | null {
  try {
    return (deps.activeUserId ?? getActiveUserId)();
  } catch {
    return null;
  }
}

function identityGuard(userId: string, scope: HubSessionScope, deps: RelayPumpDeps): () => boolean {
  return () => {
    const current = (deps.identity ?? currentHubIdentity)(userId);
    return activeUserIdOf(deps) === userId && !!current && current.accountId === scope.accountId
      && current.sessionId === scope.sessionId
      && current.generation === scope.generation;
  };
}

function admissionLock(userId: string) {
  return fileEditLock(`${userA2ARelayInboxFile(userId)}:admission`);
}

function emit(deps: RelayPumpDeps, event: RelayPumpEvent): void {
  try {
    deps.onEvent?.(event);
  } catch (error) {
    log.warn('relay pump event dispatch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 收下一条入站消息（泵与测试共用）。
 *
 * 决策在 `handleInboundQuestion` 里（会话/联系人/状态机），这里只负责「跑」与
 * 「告诉界面」；没有可用的本人（用户还没登录/初始化）时不做任何事。
 */
export async function receiveRelayMessage(
  userId: string,
  message: RelayMessage,
  deps: RelayPumpDeps = {},
): Promise<void> {
  const scope = (deps.identity ?? currentHubIdentity)(userId);
  if (!scope || message.toAccount !== scope.accountId) return;
  const isCurrent = identityGuard(userId, scope, deps);
  if (!isCurrent()) return;
  const kind = message.kind;
  if (kind === 'question') {
    await admissionLock(userId).runExclusive(async () => {
      if (!isCurrent()) return;
      // Only the successfully persisted canonical payload can reach admission.
      const staged = await stageInboundMessages(userId, [{
        messageId: message.messageId,
        conversationId: message.conversationId,
        fromAccount: message.fromAccount,
        toAccount: message.toAccount,
        ...(message.fromName ? { fromName: message.fromName } : {}),
        text: message.text,
        ...(message.createdAt ? { receivedAt: message.createdAt } : {}),
      }], { isCurrent }).catch((error) => {
        log.warn('relay inbound staging failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!staged || !isCurrent()) return;
      for (const entry of staged.eligible) await admitStagedQuestion(userId, entry, deps, isCurrent);
    });
    return;
  }
  {
    // 对方助理的回答：落进发起方那条 A2A 会话，再推给界面。
    const accepted = await appendIncomingAnswer(userId, message, { isCurrent }).catch((error) => {
      log.warn('relay answer append failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });
    if (accepted && isCurrent()) emit(deps, { type: 'message', message });
    return;
  }
}

/**
 * 受理一条已落盘的入站问题（泵、恢复与测试共用）。
 *
 * 顺序固定：先暂存（`receiveRelayMessage` 已做）→ 关系/状态决策 → 结算暂存。
 * 只有「关系查不到但 Hub 不可达」才留成等待，其余结果都结算，避免无限重试。
 */
async function admitStagedQuestion(
  userId: string,
  entry: WaitingInboxEntry,
  deps: RelayPumpDeps,
  identityIsCurrent: () => boolean,
): Promise<void> {
  const isCurrent = () => identityIsCurrent() && Date.now() < Date.parse(entry.expiresAt);
  if (!isCurrent()) return;
  const message: RelayQuestionLike = {
    messageId: entry.messageId, conversationId: entry.conversationId, fromAccount: entry.fromAccount,
    text: entry.text, createdAt: entry.receivedAt,
    ...(entry.fromName ? { fromName: entry.fromName } : {}),
  };
  const settle = (reason: string) => settleInboxEntry(userId, entry.messageId, reason, {
    toAccount: entry.toAccount, payloadDigest: entry.payloadDigest, isCurrent: identityIsCurrent,
  });
  let decision: Awaited<ReturnType<typeof handleInboundQuestion>>;
  try {
    decision = await handleInboundQuestion(userId, {
      messageId: message.messageId,
      fromAccount: message.fromAccount,
      conversationId: message.conversationId,
      text: message.text,
      createdAt: message.createdAt,
      toAccount: entry.toAccount,
      ...(message.fromName ? { fromName: message.fromName } : {}),
    }, { isCurrent });
  } catch (error) {
    log.warn('relay pump inbound decision failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (isCurrent()) emit(deps, { type: 'ignored', message, reason: 'decision_failed' });
    return;
  }
  if (!isCurrent()) return;
  if (decision.accepted === false) {
    // `unknown_relation`：Hub 没能回答关系，暂存保持等待，下一轮轮询重试。
    if (decision.reason !== 'unknown_relation') {
      await settle(decision.reason).catch(() => false);
    }
    if (isCurrent()) emit(deps, { type: 'ignored', message, reason: decision.reason });
    return;
  }
  if (!(await settle('admitted').catch(() => false)) || !isCurrent()) return;
  const { outcome } = decision;
  if (outcome.awaitingConfirmation) {
    // 5 分钟后代说一句「稍后回复」（D-23）；确认/拒绝时由 IPC 取消。
    const contact = await getCachedContact(userId, message.fromAccount).catch(() => null);
    // D4：按预设选择解析实际根；实时与重启使用同一只读预览，不建目录。
    const resolved = await previewReceptionWorkspace(userId, {
      conversationId: outcome.conversationId, workspace: contact?.defaultWorkspace,
    }).catch(() => null);
    const preview = resolved && 'preview' in resolved ? resolved.preview : null;
    if (!isCurrent()) return;
    scheduleReceptionNudge(userId, outcome.conversationId, message.fromAccount);
    emit(deps, {
      type: 'question',
      message,
      conversationId: outcome.conversationId,
      awaitingConfirmation: true,
      ...(preview?.root ? { workspacePreview: preview.root } : {}),
      // 联系人详情里设过的默认接待范围：预填进确认弹窗，仍要本人点确认（FR-06）。
      ...(contact?.defaultWorkspace ? { defaultWorkspace: contact.defaultWorkspace } : {}),
      ...(contact?.defaultAgentId ? { defaultAgentId: contact.defaultAgentId } : {}),
    });
    return;
  }

  emit(deps, {
    type: 'question',
    message,
    conversationId: outcome.conversationId,
    awaitingConfirmation: false,
  });
  // 后台跑：泵不在这里等一次接待运行。
  void runReception(userId, {
    toAccount: entry.toAccount,
    createdAt: entry.receivedAt,
    messageId: message.messageId,
    fromAccount: message.fromAccount,
    conversationId: outcome.conversationId,
    text: message.text,
    ...(message.fromName ? { fromName: message.fromName } : {}),
  }, { isCurrent: identityIsCurrent }).then((result) => {
    if (!identityIsCurrent()) return;
    emit(deps, {
      type: 'reception-result',
      messageId: message.messageId,
      conversationId: outcome.conversationId,
      status: result.status,
    });
  }).catch((error) => {
    log.warn('relay pump reception run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (identityIsCurrent()) emit(deps, {
      type: 'reception-result',
      messageId: message.messageId,
      conversationId: outcome.conversationId,
      status: 'failed',
    });
  });
}

/** 一轮拉取：拉到的消息逐条交给 `receiveRelayMessage`，游标推进到最新一条。 */
export async function pumpOnce(deps: RelayPumpDeps = {}): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  try {
    const uid = String(activeUserIdOf(deps) || '').trim();
    if (!uid) return 0;
    const scope = (deps.identity ?? currentHubIdentity)(uid);
    if (!scope) {
      cursorScopes.delete(uid);
      cursors.delete(uid);
      return 0;
    }
    const identityIsCurrent = identityGuard(uid, scope, deps);
    const isCurrent = identityIsCurrent;
    const scopeKey = JSON.stringify([scope.accountId, scope.sessionId, scope.generation]);
    if (cursorScopes.get(uid) !== scopeKey) {
      cursors.delete(uid);
      cursorScopes.set(uid, scopeKey);
    }
    // T3.5：过期暂存清理复用本 tick（每分钟至多一次）。放在读 inbox 之前，
    // 这样超期来访的正文不会因为用户一直开着应用而无限期留在会话里。
    if (Date.now() - (staleSweepAt.get(uid) ?? 0) >= STALE_SWEEP_INTERVAL_MS) {
      staleSweepAt.set(uid, Date.now());
      await expireStaleReceptions(uid, { isCurrent: identityIsCurrent }).catch((error) => {
        log.warn('reception staging cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // T3.4：先补上一轮没处理完的暂存项（进程重启或 Hub 一度不可达留下的），
    // 再拉新消息。用既有轮询入口重试，不另立调度器。
    await admissionLock(uid).runExclusive(async () => {
      if (!isCurrent()) return;
      // Read failure must stop this round before destructive Hub GET.
      const waiting = await listWaitingInbox(uid, { toAccount: scope.accountId, isCurrent: identityIsCurrent });
      for (const entry of waiting) {
        if (!isCurrent()) return;
        await admitStagedQuestion(uid, entry, deps, identityIsCurrent);
      }
    });
    if (!isCurrent()) return 0;
    const poll = deps.poll ?? ((since?: string) => pollRelayMessages(uid, since, { isCurrent }));
    const since = cursors.get(uid);
    const messages = await poll(since || undefined);
    if (!isCurrent()) return 0;
    if (!messages) {
      // 失败每 4 秒一次，只按分钟留一条，避免刷日志。
      if (Date.now() - lastFailureLogAt > 60_000) {
        lastFailureLogAt = Date.now();
        log.warn('relay poll unavailable', { since: since || null });
      }
      return 0;
    }
    if (!messages.length) return 0;
    log.info('relay poll delivered', { count: messages.length });
    const receive = deps.receive ?? ((userId: string, message: RelayMessage) => receiveRelayMessage(userId, message, deps));
    for (const message of messages) {
      if (!isCurrent()) return 0;
      if (!message || !message.messageId || message.toAccount !== scope.accountId) continue;
      try {
        await receive(uid, message);
      } catch (error) {
        log.warn('relay pump message handling failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!isCurrent()) return 0;
      if (Number.isFinite(Date.parse(message.createdAt))) cursors.set(uid, message.createdAt);
    }
    return messages.length;
  } catch (error) {
    log.warn('relay pump poll failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    inFlight = false;
  }
}

/** 启动泵；重复调用是空操作。返回停止函数。 */
export function startRelayPump(deps: RelayPumpDeps = {}): () => void {
  if (running) return stopRelayPump;
  // Normal session and recipient identity are checked live on every round.

  running = true;
  log.info('relay pump started', { interval_ms: deps.intervalMs ?? A2A_RELAY_POLL_MS });
  const setI = deps.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const handle = setI(() => { void pumpOnce(deps); }, deps.intervalMs ?? A2A_RELAY_POLL_MS);
  if (typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
  tickHandle = handle;
  void pumpOnce(deps);
  return stopRelayPump;
}

export function stopRelayPump(): void {
  if (!running) return;
  running = false;
  const clear = clearInterval;
  if (tickHandle !== null) clear(tickHandle as never);
  tickHandle = null;
}

/** 测试用：重置内存状态（游标、运行标记）。 */
export function resetRelayPumpForTest(): void {
  cursors.clear();
  cursorScopes.clear();
  staleSweepAt.clear();
  inFlight = false;
}
