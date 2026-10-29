/**
 * A2A 接待运行（AC-04/05/16/18）—— 把一条入站问题交给接收方的助理，并把回答送回去。
 *
 * 与 `reception-service.ts` 的分工：那边只决定「要不要问本人、会话该是什么状态」，
 * 这边只做已经决定要做的事：在**已有会话**里跑一次普通助理回合，然后把最终回答经
 * relay 发回发起方。两者分开是为了让「首问需确认」这条规则可以被单独验证。
 *
 * 三条边界，都是硬要求而不是提示词：
 * - 只有 `role=receiver` 且 `state=active` 的会话能跑（D-04/D-11）——没有本人接受过
 *   这次接访，助理就不回答，对端也就永远收不到「自动」的回音（AC-16）；
 * - 回复走 group-chat bus 的普通入站路径（对端作为自己的 actor 说话），不新建派发
 *   通道；接待工具策略由会话 marker 在运行侧自动收口（L2），这里不再重复裁剪；
 * - 先持久化接收、派发和回复阶段；不确定的派发/发送不自动重试。
 *
 * 未获得答案时可发送失败说明；派发或发送结果不确定时保留收据，避免重复副作用。
 */

import { createLogger } from '../../logger';
import { createHash } from 'node:crypto';
import { safeId } from '../../storage';
import { userA2AReceptionLedgerFile } from '../../paths';
import { fileEditLock } from '../../util/locks';
import { t } from '../../i18n';
import { getConversation, listConversations, updateConversationAtomic } from '../chats';
import { getCachedContact } from '../contacts/store';
import { isInboundMarker, parseA2AConversationMarker, type A2AConversationMarker } from './conversation-marker';
import { isReceptionRun } from './reception-scope';
import { isReceptionStagingExpired, RECEPTION_STAGING_TTL_MS, validateReceptionWorkspaceGrant } from './reception-service';
import { sendRelayMessage, type RelayMessage } from './relay-client';
import { normalizeA2AQuestionText } from './outbound-intent';
import { currentHubIdentity, isHubIdentityCurrent } from '../hub_account/transport';
import { getActiveUserId } from '../users';
import {
  journalReception, matchesReception, quarantineReception, readReceptionLedger,
  receptionAnswerHash, updateReceptionEntry, validReceptionPayload,
  type ReceptionLedgerEntry,
} from './reception-ledger';

const log = createLogger('a2a-reception');

/** 一次接待运行的等待上限。超过就回一句「暂时答不上」，不让对端空等。 */
export const A2A_RECEPTION_TIMEOUT_MS = 3 * 60 * 1000;

/** 本模块只认的保留 actor id（与 group_chat/state 一致，避免静态依赖）。 */
const COMMANDER_ACTOR_ID = 'commander';
const USER_ACTOR_ID = 'user';

function receptionMessageId(messageId: string): string {
  return `a2a-in-${createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 20)}`;
}

export interface ReceptionQuestion {
  toAccount?: string;
  createdAt?: string;
  messageId: string;
  fromAccount: string;
  conversationId: string;
  text: string;
  /** 对端显示名（Hub 联表带回）；缺失时用账号兜底。 */
  fromName?: string;
}

export type ReceptionRunStatus = 'answered' | 'failed' | 'not_active' | 'duplicate' | 'skipped' | 'uncertain';

export interface ReceptionRunResult {
  status: ReceptionRunStatus;
  /** 实际发给对端的正文（失败时是失败说明）。 */
  text?: string;
  error?: string;
}

/** 只描述本模块用到的那部分 bus 事件（GroupEvent 的 message 分支）。 */
export interface ReceptionBusEvent {
  type: string;
  turn_end?: boolean;
  turn_id?: string;
  msg?: { from?: string; to?: unknown; text?: string };
}

export interface ReceptionEnqueueInput {
  isCurrent?: () => boolean;
  uid: string;
  cid: string;
  fromActorId: string;
  /** 气泡上显示的对端原话。 */
  text: string;
  /** 模型看到的那一份（原话 + 接待口径 + 本人私下指示）。 */
  model_text?: string;
  forceTo: string[];
  skipKstarRouting: boolean;
  externalInbound: boolean;
  messageId?: string;
  dispatchTurnId: string;
}

/** 运行侧依赖；缺省走真实 bus / relay，测试注入替身。 */
export interface ReceptionRunDeps {
  /** Identity ceiling only: admitted calls do not acquire a new TTL. */
  isCurrent?: () => boolean;
  enqueue?: (input: ReceptionEnqueueInput) => Promise<unknown>;
  subscribe?: (userId: string, conversationId: string, listener: (ev: ReceptionBusEvent) => void) => Promise<() => void>;
  addMember?: (userId: string, conversationId: string, actor: { kind: 'agent'; id: string; name: string }) => Promise<unknown>;
  send?: (input: { to: string; conversationId: string; kind: RelayMessage['kind']; text: string; requestId: string }) => Promise<{ messageId: string } | null>;
  timeoutMs?: number;
  recovery?: boolean;
  afterStage?: (stage: 'reserved' | 'running' | 'dispatching' | 'enqueued' | 'answer' | 'sending' | 'relay' | 'sent' | 'result') => Promise<void>;
}

async function defaultEnqueue(input: ReceptionEnqueueInput): Promise<unknown> {
  const bus = await import('../group_chat/bus');
  return bus.enqueue(input as never);
}

async function defaultSubscribe(
  userId: string,
  conversationId: string,
  listener: (ev: ReceptionBusEvent) => void,
): Promise<() => void> {
  const bus = await import('../group_chat/bus');
  return bus.subscribe(userId, conversationId, listener as never);
}

async function defaultAddMember(
  userId: string,
  conversationId: string,
  actor: { kind: 'agent'; id: string; name: string },
  isCurrent?: () => boolean,
): Promise<unknown> {
  const state = await import('../group_chat/state');
  return state.addMember(userId, conversationId, actor, undefined, isCurrent);
}

/** 对端在本会话里的 actor id：前缀 + 白名单字符，稳定且不会撞保留 id。 */
export function a2aPeerActorId(accountId: string): string {
  const sanitized = String(accountId || '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `a2a_${sanitized || 'peer'}`;
}

/**
 * 回复正文 → 可跨方的纯文本。
 *
 * 会话消息里允许出现 HTML（气泡渲染用），但 relay 只传文字：把标签与常见实体
 * 折回文本，避免对端看到 `<span style=…>`。KStar 自评块是宿主内部信号，整段丢弃。
 */
export async function toRelayPlainText(raw: unknown): Promise<string> {
  let text = typeof raw === 'string' ? raw : '';
  if (!text) return '';
  // 宿主内部标记不能出现在对端看到的文字里：agent-result 是运行结果统计、plan-interaction
  // 是协作编排、agent-input-form 是给本人填的表单。复用 router 的实现，避免两处口径分叉。
  try {
    const router = await import('../group_chat/router');
    text = router.extractActorResultFromFinal(text).cleanText;
    text = router.extractPlanInteractionFromFinal(text).cleanText;
  } catch { /* 提取器不可用时退回纯标签剥离 */ }
  text = text.replace(/<agent-input-form\b[^>]*\/>/gi, '');
  text = text.replace(/<agent-input-form\b[^>]*>[\s\S]*?<\/agent-input-form>/gi, '');
  text = text.replace(/<kstar-review>[\s\S]*?<\/kstar-review>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const ANSWER_FAILED_KEY = 'a2a.reception.answer_failed';
const ANSWER_FAILED_FALLBACK = '这件事暂时没能回答，稍后再问我一次。';

/** 失败时也要给对端一句话（relay 投递即删，不能让人无限等）。 */
export function receptionFailureText(): string {
  const text = t(ANSWER_FAILED_KEY);
  return text && text !== ANSWER_FAILED_KEY ? text : ANSWER_FAILED_FALLBACK;
}

// ── 台账：一条 relay 消息只回答一次 ────────────────────────────────────────

/** 记下「等本人确认」的来访原文；同一会话只留最新一条。
 *
 * @deprecated 生产入站走 `handleInboundQuestion` 的唯一时间锚点。这个兼容入口只
 * 用于旧调用方：`receivedAt` 必须来自原消息时间，缺省也只能退回会话创建时间，
 * **绝不用当前时间**（重复提交会把暂存截止时间往后推）。 */
export async function rememberPendingReception(
  userId: string,
  input: {
    conversationId: string;
    messageId: string;
    peerUserId: string;
    peerName?: string;
    text: string;
    /** 原消息时间（原消息 `createdAt`）。 */
    createdAt?: string;
  },
): Promise<void> {
  const text = normalizeA2AQuestionText(input.text);
  if (!text) return;
  await updateConversationAtomic(userId, input.conversationId, (current) => {
    const marker = parseA2AConversationMarker(current.a2a);
    if (!marker || !isInboundMarker(marker) || marker.state !== 'waiting'
      || marker.peer_user_id !== input.peerUserId) return null;
    const requested = String(input.createdAt || '').trim();
    const conversationCreatedAt = String(current.created_at || '').trim();
    // 原消息时间优先；没有就落到不可变的会话创建时间；都没有就不建暂存。
    const anchor = requested && Number.isFinite(Date.parse(requested)) ? requested
      : Number.isFinite(Date.parse(conversationCreatedAt)) ? conversationCreatedAt : '';
    if (!anchor) return null;
    return {
      a2a_pending_reception: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        peerUserId: input.peerUserId,
        ...(input.peerName ? { peerName: input.peerName } : {}),
        text,
        receivedAt: anchor,
        state: 'pending',
      },
    };
  });
  // Compatibility callers may try to remember a payload after the decision
  // moved on. The atomic marker check keeps that a harmless no-op.
}

/** 待确认的来访（本地台账里的 pending 条目）。
 *
 * @deprecated 生产投影是 `reception-service.listPendingReceptions`（带 TTL）。这里
 * 同样按原消息时间过滤，避免旧调用方把过期项再露出去。 */
export async function readPendingReceptions(
  userId: string,
  options: { now?: number } = {},
): Promise<Array<{
  conversationId: string;
  messageId: string;
  peerUserId: string;
  peerName?: string;
  text: string;
  at: string;
}>> {
  const now = options.now ?? Date.now();
  const pending = [];
  for (const conversation of await listConversations(userId)) {
    const marker = parseA2AConversationMarker(conversation.a2a);
    const entry = conversation.a2a_pending_reception;
    if (!marker || !isInboundMarker(marker) || marker.state !== 'waiting' || !entry
      || entry.state !== 'pending'
      || entry.conversationId !== conversation.conversation_id
      || entry.peerUserId !== marker.peer_user_id) continue;
    if (isReceptionStagingExpired(entry.receivedAt, now, conversation.created_at)) continue;
    pending.push({
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      peerUserId: entry.peerUserId,
      ...(entry.peerName ? { peerName: entry.peerName } : {}),
      text: entry.text,
      at: entry.receivedAt,
    });
  }
  return pending;
}

export async function recoverClaimedReceptions(
  userId: string,
  deps: {
    run?: (userId: string, question: ReceptionQuestion) => Promise<ReceptionRunResult>;
    setCodingProjectDir?: (userId: string, cid: string, workspace: string) => Promise<void>;
    send?: ReceptionRunDeps['send'];
    activeUserId?: () => string | null;
  } = {},
): Promise<{ scheduled: number }> {
  // 启动恢复先清过期暂存：TTL 是本地事实，不依赖 Hub 身份在线与否。
  const { expireStaleReceptions } = await import('./reception-service');
  await expireStaleReceptions(userId).catch((error) => {
    log.warn('reception staging cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const scope = currentHubIdentity(userId);
  const isCurrent = () => !!scope && isHubIdentityCurrent(userId, scope)
    && (deps.activeUserId ?? getActiveUserId)() === userId;
  if (!isCurrent()) return { scheduled: 0 };
  const run = deps.run ?? ((uid: string, question: ReceptionQuestion) => runReception(uid, question, { recovery: true, isCurrent }));
  let scheduled = 0;
  const entries = await readReceptionLedger(userId);
  for (const snapshot of entries) {
    // 过期终态是墓碑：没有正文、没有可恢复的运行，也不再作为待处理收据扫描。
    if (snapshot.status === 'expired') continue;
    const key = `${userA2AReceptionLedgerFile(userId)}:${snapshot.conversationId}`;
    const question = await fileEditLock(key).runExclusive(async () => {
      // A live reception may finish while recovery waits. Classify only its
      // current receipt, so live work is never mistaken for a crashed dispatch.
      const current = await readReceptionLedger(userId);
      const matching = current.filter((row) => row.messageId === snapshot.messageId);
      const entry = matching[0];
      if (!entry) return null;
      // 等待锁期间可能已被清理成过期终态：不隔离、不改写、不重试。
      if (entry.status === 'expired') return null;
      // Preserve legacy/unscoped and other-account receipts for inspection;
      // never infer their recipient or original time from the current login.
      if (!isCurrent() || entry.toAccount !== scope!.accountId
        || !entry.createdAt || !Number.isFinite(Date.parse(entry.createdAt))) return null;
      const admissionIsCurrent = () => isCurrent()
        && Date.now() < Date.parse(entry.createdAt!) + RECEPTION_STAGING_TTL_MS;
      if (entry.admission === 'prepared' && !admissionIsCurrent()) return null;
      if (!validReceptionPayload(entry) || entry.conversationId !== snapshot.conversationId || matching.length !== 1) {
        await quarantineReception(userId, entry.messageId, 'invalid or legacy reception identity');
        return null;
      }
      if (entry.status === 'uncertain') return null;
      if (entry.status === 'answered' || entry.status === 'failed') {
        await clearReceptionBinding(userId, entry, isCurrent);
        return null;
      }
      const question = {
        messageId: entry.messageId, conversationId: entry.conversationId,
        fromAccount: entry.peerUserId, text: entry.text,
        toAccount: entry.toAccount, createdAt: entry.createdAt,
        ...(entry.peerName ? { fromName: entry.peerName } : {}),
      };
      if (entry.admission === 'prepared') {
        const { handleInboundQuestion } = await import('./reception-service');
        const admitted = await handleInboundQuestion(userId, question, { recoveryGeneration: entry.generation, isCurrent: admissionIsCurrent });
        if (!admitted.accepted) return null;
      }
      const marker = await authorizedReception(userId, entry);
      if (!marker || !isCurrent()) return null;
      if (entry.stage === 'dispatching' || entry.stage === 'enqueued' || entry.stage === 'sending') {
        await quarantineReception(userId, entry.messageId, entry.stage === 'sending'
          ? 'relay acknowledgement uncertain; Hub does not deduplicate' : 'model dispatch interrupted; execution may have occurred');
        log.warn('reception recovery retained uncertain work', { cid: entry.conversationId, stage: entry.stage });
        return null;
      }
      if (entry.stage === 'answer' || entry.stage === 'sent') {
        await deliverReceptionAnswer(userId, entry, { send: deps.send, isCurrent });
        return null;
      }
      if (entry.stage !== 'admitted' && entry.stage !== 'reserved') {
        await quarantineReception(userId, entry.messageId, 'unknown reception dispatch stage');
        return null;
      }
      const workspace = validateReceptionWorkspaceGrant(marker.workspace);
      if (!workspace) {
        await quarantineReception(userId, entry.messageId, 'workspace grant is unavailable');
        return null;
      }
      try {
        if (deps.setCodingProjectDir) await deps.setCodingProjectDir(userId, entry.conversationId, workspace);
        else await restoreReceptionWorkspace(userId, entry.conversationId, workspace);
      } catch {
        log.warn('reception workspace restoration failed', { cid: entry.conversationId });
        return null;
      }
      return isCurrent() ? question : null;
    });
    if (!question || !isCurrent()) continue;
    scheduled += 1;
    // The run wrapper acquires this same mutex and rechecks the receipt.
    await run(userId, question);
  }
  return { scheduled };
}

async function authorizedReception(userId: string, entry: ReceptionLedgerEntry): Promise<A2AConversationMarker | null> {
  const conversation = await getConversation(userId, entry.conversationId).catch(() => null);
  const marker = parseA2AConversationMarker(conversation?.a2a);
  const pending = conversation?.a2a_pending_reception;
  if (entry.requiresConfirmation && (!pending || pending.messageId !== entry.messageId
    || pending.conversationId !== entry.conversationId || pending.peerUserId !== entry.peerUserId
    || normalizeA2AQuestionText(pending.text) !== entry.text
    || (pending.state !== 'claimed' && pending.state !== 'running'))) return null;
  return validReceptionPayload(entry) && conversation && marker && isReceptionRun(marker)
    && marker.exchange_id === entry.conversationId && marker.peer_user_id === entry.peerUserId
    && conversation._cogseed_result_generation === entry.generation
    && await getCachedContact(userId, entry.peerUserId) ? marker : null;
}

async function clearReceptionBinding(userId: string, entry: ReceptionLedgerEntry, isCurrent?: () => boolean): Promise<void> {
  await updateConversationAtomic(userId, entry.conversationId, (current) => {
    if (isCurrent && !isCurrent()) return null;
    const pending = current.a2a_pending_reception;
    if (current._cogseed_result_generation !== entry.generation || !pending
      || pending.messageId !== entry.messageId || pending.conversationId !== entry.conversationId
      || pending.peerUserId !== entry.peerUserId || normalizeA2AQuestionText(pending.text) !== entry.text) return null;
    return { a2a_pending_reception: undefined };
  }, undefined, isCurrent);
}

/** The current Hub ignores requestId. A sending receipt is deliberately never
 * retried: a timeout or process exit may hide an accepted external message. */
async function deliverReceptionAnswer(userId: string, entry: ReceptionLedgerEntry, deps: ReceptionRunDeps): Promise<ReceptionRunResult> {
  const answer = entry.answer;
  const requestId = `a2a-answer-${createHash('sha256').update(entry.messageId).digest('hex')}`;
  if (!answer || answer.requestId !== requestId || !answer.text || answer.text.length > 4_000
    || answer.payloadHash !== receptionAnswerHash(entry, answer.text)) {
    await quarantineReception(userId, entry.messageId, 'invalid answer outbox payload');
    return { status: 'uncertain', error: 'invalid answer outbox payload' };
  }
  let authorized = false;
  let sentEntry: ReceptionLedgerEntry | null = null;
  await updateConversationAtomic(userId, entry.conversationId, async (current) => {
    if (deps.isCurrent && !deps.isCurrent()) return null;
    const marker = parseA2AConversationMarker(current.a2a);
    if (!marker || !isReceptionRun(marker) || marker.exchange_id !== entry.conversationId
      || marker.peer_user_id !== entry.peerUserId || current._cogseed_result_generation !== entry.generation
      || !(await getCachedContact(userId, entry.peerUserId))) return null;
    if (deps.isCurrent && !deps.isCurrent()) return null;
    authorized = true;
    if (entry.stage === 'sent') { sentEntry = entry; return null; }
    const sending = await updateReceptionEntry(userId, entry, (row) => row.stage === 'answer'
      ? { ...row, stage: 'sending' } : null, deps.isCurrent);
    if (!sending) return null;
    await deps.afterStage?.('sending');
    if (deps.isCurrent && !deps.isCurrent()) return null;
    const sent = await (deps.send ?? ((input: Parameters<typeof sendRelayMessage>[1]) => sendRelayMessage(userId, input)))({
      to: entry.peerUserId, conversationId: entry.conversationId, kind: 'answer',
      text: answer.text, requestId: answer.requestId,
    }).catch(() => null);
    await deps.afterStage?.('relay');
    if (deps.isCurrent && !deps.isCurrent()) return null;
    if (!sent) {
      await quarantineReception(userId, entry.messageId, 'relay acknowledgement uncertain; Hub does not deduplicate');
      return null;
    }
    sentEntry = await updateReceptionEntry(userId, entry, (row) => ({
      ...row, stage: 'sent', answer: { ...answer, relayMessageId: sent.messageId },
    }), deps.isCurrent);
    return null;
  });
  if (!authorized) return { status: 'not_active', error: 'contact unavailable' };
  if (!sentEntry) return { status: 'uncertain', text: answer.text, error: 'relay acknowledgement uncertain' };
  await deps.afterStage?.('sent');
  await updateReceptionEntry(userId, entry, (row) => row.stage === 'sent'
    ? { ...row, status: answer.ok ? 'answered' : 'failed' } : null, deps.isCurrent);
  await deps.afterStage?.('result');
  await clearReceptionBinding(userId, entry, deps.isCurrent);
  return answer.ok ? { status: 'answered', text: answer.text } : { status: 'failed', text: answer.text, error: 'no answer' };
}

async function receptionStage(deps: ReceptionRunDeps, stage: Parameters<NonNullable<ReceptionRunDeps['afterStage']>>[0]): Promise<void> {
  try { await deps.afterStage?.(stage); }
  catch (error) { throw Object.assign(new Error('reception interrupted', { cause: error }), {
    message: error instanceof Error ? error.message : String(error), receptionCrash: true,
  }); }
}

// ── 运行 ────────────────────────────────────────────────────────────────

/**
 * 等这次接待运行的收尾回答。
 *
 * 只收「说给本人」的 end-of-turn（`to` 含 user）：commander→agent 的过程汇报也是
 * end-of-turn，但它不是给对端的答案。只认原派发的 turn_id 与接待助理；超时
 * 不代表底层 worker 完成，晚到的上一轮回答不能被下一轮接收。订阅先于入队。
 */
async function waitForAnswer(
  subscribe: (listener: (ev: ReceptionBusEvent) => void) => Promise<() => void>,
  recipientId: string,
  turnId: string,
  timeoutMs: number,
): Promise<{ promise: Promise<string | null>; cancel: () => void }> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let resolveFn: (value: string | null) => void = () => {};

  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
    resolveFn(value);
  };

  const promise = new Promise<string | null>((resolve) => {
    resolveFn = resolve;
  });

  unsubscribe = await subscribe((ev) => {
    if (settled) return;
    if (!ev || ev.type !== 'message' || ev.turn_end !== true || !ev.msg) return;
    if (ev.turn_id !== turnId || ev.msg.from !== recipientId) return;
    const to = Array.isArray(ev.msg.to) ? ev.msg.to.map((row) => String(row)) : [];
    if (!to.includes(USER_ACTOR_ID)) return;
    finish(typeof ev.msg.text === 'string' ? ev.msg.text : '');
  });
  timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));

  return { promise, cancel: () => finish(null) };
}

/**
 * 这次运行模型该看到的消息正文（对端原话 + 接待口径）。
 *
 * `model_text` 是 bus 既有的「模型视角」字段：气泡上仍是对方的原话，模型看到的
 * 是同一句前面多了接待规则与本人的私下指示（D-21/FR-32）。规则放提示词文件里，
 * 只有易变的那部分（范围、对面是谁）在运行期拼进去。
 */
export async function buildReceptionModelText(input: {
  userId: string;
  conversationId: string;
  peerName: string;
  question: string;
  workspace?: string;
}): Promise<string> {
  const parts: string[] = [];
  try {
    const { prompts } = await import('../../prompts/loader');
    const scope = [
      `- Visitor display name: ${input.peerName}`,
      input.workspace
        ? `- Read root (the only directory you may read): ${input.workspace}`
        : '- No directory was granted for this visit; answer from general knowledge and the user\'s own instructions only.',
      // 写/执行可以发生，但每一次都由宿主自动弹审批给接收方本人；技能脚本/连接器/网络仍不可用。
      '- Writing a file or running a command is allowed inside the scope once the user approves it; the runtime asks them automatically for each action, so attempt it directly instead of asking anyone in chat.',
      input.workspace
        ? '- Writes may only target files under the read root above.'
        : '- No directory was granted, so writes are not available for this visit.',
      '- Skill scripts, connectors and network access are unavailable in this run.',
    ].join('\n');
    const guide = prompts.load('a2a_reception', { reception_scope: scope }).trim();
    if (guide) parts.push(guide);
  } catch (error) {
    log.warn('reception prompt unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // 接收方本人在会话里写下的私下指示：只对他自己的助理可见，绝不能发给对端。
  try {
    const { loadInstructionContext } = await import('./instructions');
    const instructions = await loadInstructionContext(input.userId, input.conversationId);
    if (instructions?.content) parts.push(instructions.content);
  } catch (error) {
    log.warn('reception instructions unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  parts.push(`<a2a-visitor-message>\n${input.question}\n</a2a-visitor-message>`);
  return parts.join('\n\n');
}

/**
 * 这次接待由谁回答。
 *
 * 本人可以在确认接待时指定一个助理（FR-22），但只有**内进程** Agent 可以接访：
 * 外接 CLI / 网关运行不经过 L2 工具策略，让它们接访等于绕过接待隔离（§15）。
 * 任何一环对不上都回落 Commander —— 宁可换人回答，也不要让一次来访无人应答。
 */
export async function resolveReceptionAssistant(userId: string, requested?: string | null): Promise<string> {
  const id = String(requested || '').trim();
  if (!id || id === COMMANDER_ACTOR_ID) return COMMANDER_ACTOR_ID;
  try {
    const { isAgentEnabled } = await import('../component_enabled');
    if (!isAgentEnabled(userId, id)) return COMMANDER_ACTOR_ID;
    const agents = await import('../agents');
    const agent = await agents.getAgentForChatDispatch(userId, id);
    if (!agent) return COMMANDER_ACTOR_ID;
    const kind = (agent.runtime as { kind?: string } | undefined)?.kind;
    if (kind === 'cli' || kind === 'p3394-gateway') return COMMANDER_ACTOR_ID;
    return id;
  } catch (error) {
    log.warn('reception assistant resolution failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return COMMANDER_ACTOR_ID;
  }
}

/** Restore the exact existing grant; an absent directory is never provisioned. */
async function restoreReceptionWorkspace(userId: string, cid: string, workspace: string): Promise<void> {
  if (validateReceptionWorkspaceGrant(workspace) !== workspace) throw new Error('workspace grant is unavailable');
  const { readState, setCodingProjectDir } = await import('../group_chat/state');
  const state = await readState(userId, cid);
  if (state.coding_project_dir !== workspace || state.coding_project_dir_explicit !== true) {
    await setCodingProjectDir(userId, cid, workspace, { explicit: true });
  }
  const restored = await readState(userId, cid);
  if (restored.coding_project_dir !== workspace || restored.coding_project_dir_explicit !== true
    || validateReceptionWorkspaceGrant(workspace) !== workspace) throw new Error('workspace state unavailable');
}

/**
 * 跑一次接待：对端的问题以对端自己的身份进入会话，助理的收尾回答被捕获后发回。
 *
 * 返回 `not_active` 而不是抛错，是因为调用方（IPC）要在「还没接受接访」时安静地
 * 什么都不做；真正的失败（超时/relay 发不出去）才记为 `failed`。
 */
export async function runReception(
  userId: string,
  question: ReceptionQuestion,
  deps: ReceptionRunDeps = {},
): Promise<ReceptionRunResult> {
  if (!safeId(userId) || !safeId(question.conversationId)) return { status: 'skipped', error: 'invalid question' };
  const scope = currentHubIdentity(userId);
  const isCurrent = deps.isCurrent ?? (() => !!scope && isHubIdentityCurrent(userId, scope) && getActiveUserId() === userId);
  const key = `${userA2AReceptionLedgerFile(userId)}:${question.conversationId}`;
  // The bus answer stream belongs to a conversation. Serialize its questions
  // so one model reply cannot satisfy two accepted inbox entries.
  return fileEditLock(key).runExclusive(() => isCurrent()
    ? runReceptionOnce(userId, question, { ...deps, isCurrent }) : { status: 'skipped' as const });
}

async function runReceptionOnce(
  userId: string,
  question: ReceptionQuestion,
  deps: ReceptionRunDeps = {},
): Promise<ReceptionRunResult> {
  const cid = String(question.conversationId || '').trim();
  const messageId = String(question.messageId || '').trim();
  const peerUserId = String(question.fromAccount || '').trim();
  const text = normalizeA2AQuestionText(question.text);
  const isCurrent = deps.isCurrent!;
  const stale = () => ({ status: 'skipped' as const, error: 'session changed' });
  if (!safeId(cid) || !messageId || !peerUserId || !text) {
    return { status: 'skipped', error: 'invalid question' };
  }

  const conversation = await getConversation(userId, cid).catch(() => null);
  const marker = parseA2AConversationMarker(conversation?.a2a);
  const generation = conversation?._cogseed_result_generation;
  if (!isCurrent()) return stale();
  if (!marker || !isReceptionRun(marker) || !generation || marker.exchange_id !== cid
    || marker.peer_user_id !== peerUserId || !(await getCachedContact(userId, peerUserId))) {
    // 未经本人接受的来访不回答（D-04/AC-16）。
    return { status: 'not_active' };
  }

  const scopeDir = validateReceptionWorkspaceGrant(marker.workspace);
  if (!scopeDir) return { status: 'failed', error: 'workspace grant is unavailable' };
  try { await restoreReceptionWorkspace(userId, cid, scopeDir); }
  catch { return { status: 'failed', error: 'workspace state unavailable' }; }
  if (!isCurrent()) return stale();

  let entries = await readReceptionLedger(userId);
  if (!isCurrent()) return stale();
  const receipt = entries.find((row) => row.messageId === messageId);
  const identity = { messageId, conversationId: cid, peerUserId, text, generation,
    toAccount: question.toAccount ?? receipt?.toAccount,
    createdAt: question.createdAt ?? receipt?.createdAt };
  // A confirmed caller may omit relay fields only when its canonical receipt
  // already owns them. A legacy row never borrows the current login identity.
  if (identity.toAccount !== currentHubIdentity(userId)?.accountId || !identity.createdAt
    || !Number.isFinite(Date.parse(identity.createdAt))) return { status: 'skipped', error: 'unscoped reception identity' };
  // Compatibility for already-confirmed main-owned callers. Recovery itself
  // never invents an identity or hash for a legacy running row.
  if (!entries.some((row) => row.messageId === messageId) && !deps.recovery) {
    if (!(await journalReception(userId, {
      ...identity,
      ...(question.fromName ? { peerName: question.fromName.slice(0, 200) } : {}),
    }, isCurrent))) return { status: 'skipped', error: 'reception identity unavailable' };
    await updateReceptionEntry(userId, identity, (entry) => ({ ...entry, admission: 'committed' }), isCurrent);
    entries = await readReceptionLedger(userId);
  }
  const matching = entries.filter((row) => row.messageId === messageId);
  const existing = matching[0];
  // 过期终态没有正文、也不可能再被授权；任何迟到的运行请求都安静跳过。
  if (existing?.status === 'expired') return { status: 'skipped', error: 'reception expired' };
  if (matching.length !== 1 || !matchesReception(existing, identity)) return { status: 'skipped', error: 'reception identity mismatch' };
  if (existing.admission !== 'committed') return { status: 'skipped', error: 'reception not admitted' };
  if (existing.status === 'uncertain') return { status: 'uncertain', error: existing.error };
  if (existing.status === 'answered' || existing.status === 'failed') {
    await clearReceptionBinding(userId, existing, isCurrent);
    return { status: 'duplicate' };
  }
  if (!(await authorizedReception(userId, existing)) || !isCurrent()) return { status: 'not_active' };
  if (existing.stage === 'answer' || existing.stage === 'sent') return deliverReceptionAnswer(userId, existing, deps);
  if (existing.stage === 'dispatching' || existing.stage === 'enqueued' || existing.stage === 'sending') {
    return { status: 'uncertain', error: 'reception execution or delivery may have occurred' };
  }
  const reserved = await updateReceptionEntry(userId, identity, (entry) => (
    (entry.status === 'pending' && entry.stage === 'admitted')
    || (deps.recovery && entry.status === 'running' && entry.stage === 'reserved')
  ) ? { ...entry, status: 'running', stage: 'reserved', admission: 'committed' } : null, isCurrent);
  if (!reserved) return { status: 'duplicate' };
  await deps.afterStage?.('reserved');
  await updateConversationAtomic(userId, cid, (current) => {
    if (!isCurrent()) return null;
    const pending = current.a2a_pending_reception;
    if (!pending || pending.messageId !== messageId) return null;
    return { a2a_pending_reception: { ...pending, state: 'running' } };
  }, undefined, isCurrent);
  await deps.afterStage?.('running');
  if (!isCurrent()) return stale();

  const enqueue = deps.enqueue ?? defaultEnqueue;
  const addMember = deps.addMember ?? defaultAddMember;
  const subscribe = deps.subscribe ?? defaultSubscribe;
  const peerName = String(question.fromName || '').trim() || peerUserId;
  const peerActorId = a2aPeerActorId(peerUserId);

  // 对端以自己身份出现在会话里：气泡显示对方名字，而不是「我」说的。
  try {
    if (deps.addMember) await addMember(userId, cid, { kind: 'agent', id: peerActorId, name: peerName });
    else await defaultAddMember(userId, cid, { kind: 'agent', id: peerActorId, name: peerName }, isCurrent);
  } catch (error) {
    log.warn('reception peer actor registration failed', {
      cid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 接访的是本人指定的助理（内进程 Agent），没有就用 Commander。
  const recipientId = await resolveReceptionAssistant(userId, marker.assistant_agent_id);
  if (!isCurrent()) return stale();
  const dispatchTurnId = `turn-${receptionMessageId(messageId)}`;

  let answer: string | null = null;
  let waiter: { promise: Promise<string | null>; cancel: () => void } | null = null;
  try {
    waiter = await waitForAnswer(
      (listener) => subscribe(userId, cid, listener),
      recipientId,
      dispatchTurnId,
      deps.timeoutMs ?? A2A_RECEPTION_TIMEOUT_MS,
    );
    // The grant was validated/restored before reservation. Never manufacture a
    // scope from ordinary conversation defaults for a restricted reception.
    const modelText = await buildReceptionModelText({
      userId,
      conversationId: cid,
      peerName,
      question: text,
      workspace: scopeDir,
    });
    const authorized = await authorizedReception(userId, reserved);
    if (!authorized || authorized.workspace !== scopeDir || !isCurrent()) return { status: 'not_active' };
    await restoreReceptionWorkspace(userId, cid, scopeDir);
    const dispatching = await updateReceptionEntry(userId, identity, (entry) => entry.stage === 'reserved'
      ? { ...entry, stage: 'dispatching' } : null, isCurrent);
    if (!dispatching) return { status: 'uncertain', error: 'dispatch receipt unavailable' };
    await receptionStage(deps, 'dispatching');
    if (!isCurrent()) return stale();
    await enqueue({
      isCurrent,
      uid: userId,
      cid,
      fromActorId: peerActorId,
      // 气泡显示对端原话；模型看到同一句 + 接待口径（D-21/FR-32）。
      text,
      model_text: modelText,
      // 派给选定的内进程助理；外接运行已在 resolveReceptionAssistant 里挡掉。
      forceTo: [recipientId],
      skipKstarRouting: true,
      externalInbound: true,
      messageId: receptionMessageId(messageId),
      dispatchTurnId,
    });
    await updateReceptionEntry(userId, identity, (entry) => ({ ...entry, stage: 'enqueued' }), isCurrent);
    // Fault injection exceptions must model process exit, never a model error.
    await receptionStage(deps, 'enqueued');
    answer = await toRelayPlainText(await waiter.promise);
  } catch (error) {
    if ((error as { receptionCrash?: boolean })?.receptionCrash) throw error;
    if (!isCurrent()) return stale();
    log.warn('reception run failed', {
      cid,
      error: error instanceof Error ? error.message : String(error),
    });
    const current = (await readReceptionLedger(userId)).find((entry) => entry.messageId === messageId);
    if (current?.stage === 'dispatching' || current?.stage === 'enqueued') {
      await quarantineReception(userId, messageId, 'model dispatch interrupted; execution may have occurred');
      return { status: 'uncertain', error: 'model dispatch interrupted' };
    }
  } finally {
    waiter?.cancel();
  }

  const ok = !!answer;
  const outbound = answer || receptionFailureText();
  const stored = await updateReceptionEntry(userId, identity, (entry) => ({
    ...entry, stage: 'answer', answer: {
      text: outbound, ok, payloadHash: receptionAnswerHash(identity, outbound),
      requestId: `a2a-answer-${createHash('sha256').update(messageId).digest('hex')}`,
    },
  }), isCurrent);
  if (!stored) return { status: 'uncertain', error: 'answer persistence unavailable' };
  await deps.afterStage?.('answer');
  return deliverReceptionAnswer(userId, stored, deps);
}
