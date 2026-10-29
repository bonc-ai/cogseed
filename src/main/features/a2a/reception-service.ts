/**
 * A2A 接待（AC-04/05/16）：「收到一个问题」→「会话该处于什么状态」。
 *
 * 这一步只做**决策与会话落库**，不跑助理：首问进入 waiting（等人确认，D-04），
 * 已接受的会话进入 active 并可交给 `reception-run.ts` 运行。把决策与执行分开，
 * 是为了让「要不要问本人」这条规则可以被单独验证，而不是埋在运行链路里。
 *
 * 来访必须来自联系人：Hub 的 relay 端点只校验收件人账号，不校验关系，所以
 * 「是不是联系人」这一关只能在客户端把住（否则任何知道账号的人都能叫起助理）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalizePath, isPathAllowed, isSystemTmpDir } from '../../util/path-sandbox';
import { safeId } from '../../storage';
import { createLogger } from '../../logger';
import {
  getConversation,
  type Conversation,
  type A2APendingReceptionBinding,
  admitInboundA2AConversationAtomic,
  updateConversationAtomic,
} from '../chats';
import { getCachedContact, refreshContactsFromHub } from '../contacts/store';
import { hubConfigured } from '../contacts/hub-client';
import { currentHubIdentity, isHubIdentityCurrent } from '../hub_account/transport';
import { isInboundMarker, parseA2AConversationMarker, transitionA2AConversation, type A2AConversationMarker } from './conversation-marker';
import { isReceptionRun, type TrustedReceptionScope } from './reception-scope';
import { RELAY_INBOX_TTL_MS } from './relay-inbox-store';
import { cancelReceptionNudge } from './reception-nudge';
import { planInboundA2A } from './inbound';
import { isA2AConversationId } from './extensions';
import { normalizeA2AQuestionText } from './outbound-intent';
import {
  expireReceptionEntries, journalReception, matchesReception, readReceptionLedger, updateReceptionEntry,
} from './reception-ledger';

const log = createLogger('a2a-reception-service');

/**
 * 待确认来访的暂存有效期：自**原消息时间**起 10 分钟（方案 C09）。
 *
 * 时间锚点只有一个：`a2a_pending_reception.receivedAt`（由入站消息的
 * `createdAt` 落库）。列出、重启恢复、重复确认都不能重新起算；缺失时间时退回
 * 会话创建时间，两者都没有就按过期处理——**绝不用当前时间续期**。
 *
 * 与 relay 暂存共用同一个 10 分钟常量，避免两处策略漂移。
 */
export const RECEPTION_STAGING_TTL_MS = RELAY_INBOX_TTL_MS;

/** 暂存截止时间（epoch ms）。`fallbackReceivedAt` 只用于老记录缺字段时取原始
 *  会话时间，不是「现在」。返回 null 表示没有可信的原始时间。 */
export function receptionStagingDeadline(
  receivedAt: unknown,
  fallbackReceivedAt?: unknown,
): number | null {
  for (const candidate of [receivedAt, fallbackReceivedAt]) {
    const raw = typeof candidate === 'string' ? candidate.trim() : '';
    if (!raw) continue;
    const startedAt = Date.parse(raw);
    if (Number.isFinite(startedAt)) return startedAt + RECEPTION_STAGING_TTL_MS;
  }
  return null;
}

/** 是否已过暂存截止。没有可信原始时间时 fail closed（视为过期）。 */
export function isReceptionStagingExpired(
  receivedAt: unknown,
  now: number,
  fallbackReceivedAt?: unknown,
): boolean {
  const deadline = receptionStagingDeadline(receivedAt, fallbackReceivedAt);
  return deadline === null || now >= deadline;
}

/**
 * `expectedMessageId` 把一次「确认/拒绝」绑定到用户当时看到的那条 pending。
 *
 * P1-1 之后同一会话里的过期旧问题会被新问题替换（新 messageId、重开 waiting）。
 * 只带 conversationId 的决定会落到**当前** pending 上，于是对旧行的点击变成对新
 * 问题的确认。主进程必须比较身份，而不是相信界面上显示的是哪一行。
 *
 * 只有缺省（undefined）表示旧调用方不绑定；一旦提供就必须是非空字符串——类型不对
 * 是调用方 bug，不能静默跳过检查。
 */
function parseExpectedMessageId(
  value: unknown,
): { id: string } | { error: 'invalid expected message id' } {
  if (value === undefined) return { id: '' };
  if (typeof value !== 'string' || !value.trim()) return { error: 'invalid expected message id' };
  return { id: value.trim() };
}

/**
 * 过期后再来的问题是**新来访**，不是复活：旧的接待范围与助理选择属于已经过期的
 * 那次来访，不能被新问题继承。保留方向位/对端/exchange id 这些会话身份。
 */
function reopenedStagingMarker(marker: A2AConversationMarker): A2AConversationMarker {
  return {
    ...(marker.inbound ? { inbound: true } : {}),
    ...(marker.outgoing ? { outgoing: true } : {}),
    ...(marker.role ? { role: marker.role } : {}),
    peer_user_id: marker.peer_user_id,
    state: marker.state,
    ...(marker.peer_name ? { peer_name: marker.peer_name } : {}),
    ...(marker.exchange_id ? { exchange_id: marker.exchange_id } : {}),
  };
}

/**
 * 等待项的原始时间锚点（TTL 起点）。
 *
 * 有原消息时间就用它；重复投递沿用已经落库的 `receivedAt`；两者都没有时**绝不用
 * 当前时间**（重试会因此续期），只回退到该消息在本地台账的首次登记时间；仍取不到
 * 就 fail closed（拒绝建立暂存，而不是给它一个新起点）。
 */
async function stagingReceivedAt(
  userId: string,
  messageId: string,
  createdAt: unknown,
  existingPending: A2APendingReceptionBinding | null,
  duplicate: boolean,
): Promise<string | null> {
  const raw = String(createdAt || '').trim();
  if (raw && Number.isFinite(Date.parse(raw))) return raw;
  if (duplicate && existingPending) {
    const kept = String(existingPending.receivedAt || '').trim();
    if (kept && Number.isFinite(Date.parse(kept))) return kept;
  }
  const rows = await readReceptionLedger(userId).catch(() => []);
  const firstAt = rows.find((row) => row.messageId === messageId)?.at;
  const firstMs = Date.parse(String(firstAt || ''));
  return Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null;
}

/** Concurrent roster refreshes per user, so a burst of first questions from the
 *  same newly-accepted friend costs one Hub round trip, not one per message. */
const _relationRefreshInFlight = new Map<string, { task: Promise<boolean>; isCurrent: () => boolean }>();

/**
 * Resolve the sender against the roster, asking the authoritative source once on
 * a cache miss (T3.2).
 *
 * The cache is normally stale exactly when the first question arrives: the
 * receiving side has not opened the contacts page since the request was accepted.
 * Treating that miss as "not a contact" is what dropped the first question.
 *
 * A failed refresh is *not* a negative answer — Hub could not be reached. The
 * caller still sees `null`, because staging the message for a later retry needs
 * the inbox store; without it, an unreachable Hub keeps today's drop behaviour
 * and the reason is logged, never reported as an authoritative rejection.
 */
async function resolveInboundContact(
  userId: string,
  fromAccount: string,
  inboundIsCurrent?: () => boolean,
): Promise<{ contact: Awaited<ReturnType<typeof getCachedContact>> } | { unknown: true }> {
  const cached = await getCachedContact(userId, fromAccount);
  if (cached) return { contact: cached };
  // Hub 未配置＝这台机器根本没有关系来源（未登录/开发态），不是「暂时不知道」：
  // 这种情形按既有口径直接拒绝，不制造等待项。
  if (!hubConfigured(userId)) return { contact: null };
  const scope = currentHubIdentity(userId);
  const isCurrent = () => !!scope && isHubIdentityCurrent(userId, scope)
    && (!inboundIsCurrent || inboundIsCurrent());
  while (isCurrent()) {
    let pending = _relationRefreshInFlight.get(userId);
    if (!pending?.isCurrent()) {
      pending = { task: refreshContactsFromHub(userId, { isCurrent }).catch(() => false), isCurrent };
      _relationRefreshInFlight.set(userId, pending);
    }
    let refreshed: boolean;
    try {
      refreshed = await pending.task;
    } finally {
      if (_relationRefreshInFlight.get(userId) === pending) _relationRefreshInFlight.delete(userId);
    }
    if (!isCurrent()) return { unknown: true };
    // A joined caller may outlive the initiating caller's active-user ceiling.
    // It needs its own authoritative refresh, never the revoked task's cache.
    if (!pending.isCurrent()) continue;
    if (!refreshed) return { unknown: true };
    const after = await getCachedContact(userId, fromAccount);
    return isCurrent() ? { contact: after } : { unknown: true };
  }
  // Hub 没能回答：这是「还不知道」，不是「不是联系人」。暂存项保持等待，
  // 由下一轮轮询重试，而不是被当成未授权丢掉。
  return { unknown: true };
}

export interface InboundQuestion {
  messageId: string;
  fromAccount: string;
  conversationId: string;
  text: string;
  createdAt?: string;
  toAccount?: string;
  /** 对端显示名（Hub 联表带回）；没有就退回账号。 */
  fromName?: string;
}

export interface ReceptionOutcome {
  conversationId: string;
  marker: A2AConversationMarker;
  /** true 表示还需要接收方本人确认（首问，D-04）。 */
  awaitingConfirmation: boolean;
  /** 首问等待本人确认：这次运行还没开始，也不应该开始。 */
  rejected?: string;
}

export type InboundDecision =
  | { accepted: true; outcome: ReceptionOutcome }
  | { accepted: false; reason: 'not_contact' | 'unknown_relation' | 'rejected' | 'conversation_unavailable' };

/**
 * Decide what to do with an inbound question, persisting the marker.
 *
 * Marker and pending question binding are read and written in one canonical
 * conversation transaction; renderer data never becomes confirmation authority.
 */
export async function handleInboundQuestion(userId: string, message: InboundQuestion, deps: {
  afterStage?: (stage: 'journaled') => Promise<void>;
  recoveryGeneration?: string;
  /** Optional lifecycle fence supplied by authenticated inbound dispatch. */
  isCurrent?: () => boolean;
} = {}): Promise<InboundDecision> {
  const fromAccount = String(message.fromAccount || '').trim();
  const cid = String(message.conversationId || '').trim();
  const messageId = String(message.messageId || '').trim();
  const text = normalizeA2AQuestionText(message.text);
  if (!fromAccount || !messageId || !isA2AConversationId(cid) || !text) {
    return { accepted: false, reason: 'rejected' };
  }

  // 不是联系人 → 不建会话、不叫助理（relay 端点不校验关系，这一关必须在这里）。
  // 缓存未命中先查一次权威关系：刚被接受的好友首问正是在这个窗口到达的（T3.2）。
  const resolved = await resolveInboundContact(userId, fromAccount, deps.isCurrent);
  if (deps.isCurrent && !deps.isCurrent()) return { accepted: false, reason: 'rejected' };
  if ('unknown' in resolved) {
    log.warn('a2a question kept waiting: relation lookup unavailable', { cid });
    return { accepted: false, reason: 'unknown_relation' };
  }
  const contact = resolved.contact;
  if (!contact) {
    log.warn('a2a question dropped: sender is not a contact', { cid });
    return { accepted: false, reason: 'not_contact' };
  }
  const journal = (await readReceptionLedger(userId)).filter((row) => row.messageId === messageId);
  if (journal.length && (journal.length !== 1 || !matchesReception(journal[0], {
    messageId, conversationId: cid, peerUserId: fromAccount, text, toAccount: message.toAccount, createdAt: message.createdAt,
  }))) return { accepted: false, reason: 'rejected' };
  const recoveryGeneration = deps.recoveryGeneration
    || (journal[0]?.admission === 'prepared' ? journal[0].generation : undefined);

  let needsConfirmation = false;
  let reopened = false;
  let admittedIdentity: Parameters<typeof updateReceptionEntry>[1] | undefined;
  let rejection = 'rejected';
  const who = String(message.fromName || '').trim() || contact.name || fromAccount;
  const admission = await admitInboundA2AConversationAtomic(userId, {
    isCurrent: deps.isCurrent,
    conversationId: cid,
    peerUserId: fromAccount,
    title: `${who} 的来访`,
    ...(recoveryGeneration ? { recoveryGeneration } : {}),
    decide: async (existingMarker, existingPending, generation) => {
      const currentContact = await getCachedContact(userId, fromAccount);
      if (deps.isCurrent && !deps.isCurrent()) return null;
      if (!currentContact) {
        rejection = 'not_contact';
        return null;
      }
      if (deps.recoveryGeneration && journal[0]?.requiresConfirmation && existingMarker
        && !existingPending && existingMarker.state !== 'waiting') return null;
      const inFlight = !!existingPending
        && (existingPending.state === 'claimed' || existingPending.state === 'running');
      const duplicate = !!existingPending && existingPending.messageId === messageId
        && existingPending.peerUserId === fromAccount
        && existingPending.text === text;
      // 同一 CID 在旧来访过期后再问：这是**新来访**，不是复活。旧等待项保留到本次
      // 提交才被替换；它已经过期，不会再得到确认入口。仍可确认的等待项维持既有语义
      // （第二条问题由 relay 暂存结算），已接受的接访则直接继续（D-11）。
      const pendingIsStale = !!existingPending && !inFlight
        && isReceptionStagingExpired(existingPending.receivedAt, Date.now());
      const reopeningExpired = !duplicate && !inFlight
        && (existingMarker?.state === 'expired' || pendingIsStale);
      if (existingPending && !duplicate && existingMarker?.state !== 'active' && !reopeningExpired) return null;
      const plan = planInboundA2A({
      extension: {
        // 交换 id 由发起方随消息带来：双方各自从本地 uid 推定会得到两个不同的值，
        // 那样 marker 上的 exchange_id 就永远对不上对端。
        conversation_id: cid,
        kind: 'question',
        visibility: 'cross',
        recipient_user: userId,
      },
      localUserId: userId,
      peerUserId: fromAccount,
      existingMarker,
      });
      if ('rejected' in plan) return null;
      needsConfirmation = plan.needsConfirmation;
      reopened = reopeningExpired;
      const marker = plan.needsConfirmation
        ? {
          ...(reopeningExpired ? reopenedStagingMarker(plan.marker) : plan.marker),
          peer_name: String(message.fromName || '').trim() || currentContact.name,
        }
        : (existingMarker ?? transitionA2AConversation(plan.marker, 'active'));
      // 旧来访的正文随本次提交被新等待项替换；台账必须同时落成过期终态，否则它
      // 再没有清理路径。放在提交之前：即使提交失败，也只会少正文、不会多原文。
      if (reopeningExpired && existingPending) {
        await expireReceptionEntries(userId, [{
          messageId: existingPending.messageId,
          conversationId: cid,
          peerUserId: existingPending.peerUserId,
        }], deps.isCurrent);
      }
      // 旧来访的 5 分钟提示计时器属于已经过期的那次 visit：新问题重开后必须
      // 先撤销，否则旧 timer 会按新 visit 仍处于 waiting 直接发「稍后回复」，
      // 还会让 relay-pump 对新 visit 的 schedule 因同 key 去重而排不进来。
      if (reopeningExpired) cancelReceptionNudge(userId, cid);
      // Journal first: either side of the following conversation commit can
      // crash without losing an admitted active question or granting consent.
      admittedIdentity = {
        messageId, conversationId: cid, peerUserId: fromAccount, text, generation,
        ...(message.toAccount ? { toAccount: message.toAccount } : {}),
        ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      };
      if (!(await journalReception(userId, {
        ...admittedIdentity,
        requiresConfirmation: needsConfirmation,
        ...(who ? { peerName: who.slice(0, 200) } : {}),
      }, deps.isCurrent))) return null;
      await deps.afterStage?.('journaled');
      if (deps.isCurrent && !deps.isCurrent()) return null;
      let pendingForCommit: A2APendingReceptionBinding | null = null;
      if (plan.needsConfirmation) {
        // 缺原消息时间时 fail closed：绝不拿当前时间给暂存一个新起点。
        const receivedAt = await stagingReceivedAt(
          userId, messageId, message.createdAt, existingPending, duplicate,
        );
        if (!receivedAt) {
          rejection = 'rejected';
          return null;
        }
        pendingForCommit = {
          messageId,
          conversationId: cid,
          peerUserId: fromAccount,
          ...(who ? { peerName: who } : {}),
          text,
          receivedAt,
          state: 'pending',
        };
      } else if (inFlight) {
        pendingForCommit = existingPending;
      }
      return { marker, pending: pendingForCommit };
    },
  });
  if (!admission.accepted) {
    const reason = rejection === 'not_contact' ? rejection : 'conversation_unavailable';
    log.info('a2a question dropped after authority recheck', { cid, reason });
    return { accepted: false, reason };
  }
  const admittedContact = await getCachedContact(userId, fromAccount);
  if (deps.isCurrent && !deps.isCurrent()) return { accepted: false, reason: 'rejected' };
  if (!admittedContact) {
    const { endExchangesWithPeer } = await import('./end-exchange');
    await endExchangesWithPeer(userId, fromAccount, deps.isCurrent).catch(() => null);
    return { accepted: false, reason: 'not_contact' };
  }
  if (!admittedIdentity || !(await updateReceptionEntry(userId, admittedIdentity,
    (entry) => ({ ...entry, admission: 'committed' }), deps.isCurrent))) return { accepted: false, reason: 'rejected' };
  if (reopened) log.info('a2a expired visit reopened by a new question', { cid });
  return {
    accepted: true,
    outcome: {
      conversationId: admission.conversationId,
      marker: admission.marker,
      awaitingConfirmation: needsConfirmation,
    },
  };
}

/** Validate existing or prospective directories without touching the filesystem.
 * Prospective ancestors must be directories; dangling symlinks fail closed.
 * This guards static path identity, not races with other filesystem writers. */
function receptionDirectory(raw: unknown, allowMissing = false): string | null {
  if (typeof raw !== 'string' || !raw.trim() || !path.isAbsolute(raw.trim())) return null;
  const value = path.resolve(raw.trim());
  let ancestor = value;
  try {
    for (;;) {
      try {
        fs.lstatSync(ancestor);
        if (!fs.statSync(ancestor).isDirectory()) return null;
        break;
      } catch (error) {
        // lstat of a dangling link succeeds, stat fails: never provision it.
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) return null; } catch { /* absent */ }
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT'
          || ancestor === path.dirname(ancestor)) return null;
        ancestor = path.dirname(ancestor);
      }
    }
    const canonical = canonicalizePath(value);
    return isSystemTmpDir(canonical) ? null : canonical;
  } catch { return null; }
}

export function normalizeReceptionWorkspace(raw: unknown): string | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  return receptionDirectory(raw) ?? 'invalid';
}

/** Persisted grants are canonical, existing directories. Never recreate one or
 * follow a replacement symlink to a different root during restoration. */
export function validateReceptionWorkspaceGrant(raw: unknown): string | null {
  const root = receptionDirectory(raw);
  return root && typeof raw === 'string' && root === path.resolve(raw) ? root : null;
}

/**
 * Freeze the trusted per-turn execution ceiling from host-persisted state.
 *
 * Returns `null` — and the caller must refuse the turn — when the conversation
 * is not an active inbound reception, when the persisted grant is missing,
 * non-canonical, replaced by a symlink or no longer a directory. It never
 * provisions a directory, never falls back to a default root and never derives
 * trust from the source string alone.
 */
export function freezeTrustedReceptionScope(
  userId: string,
  conversationId: string,
  marker: unknown,
  sourceActorId: unknown,
): TrustedReceptionScope | null {
  if (!safeId(userId) || !safeId(conversationId)) return null;
  const source = typeof sourceActorId === 'string' ? sourceActorId.trim() : '';
  if (!source.startsWith('a2a_')) return null;
  const parsed = parseA2AConversationMarker(marker);
  if (!parsed || !isReceptionRun(parsed)) return null;
  const root = validateReceptionWorkspaceGrant(parsed.workspace);
  if (!root) return null;
  return Object.freeze({ sourceActorId: source, conversationId, root });
}

export interface ReceptionWorkspaceSelection {
  conversationId: string;
  workspace?: unknown;
  spaceId?: unknown;
}
export interface ReceptionWorkspacePreview { root: string; snapshot: string }
type PreviewResult = { preview: ReceptionWorkspacePreview } | { error: string };

/** Setup choices have no grant authority. Owning projections deliberately
 * bypass ordinary catalog provisioning, reconciliation and cache writes. */
export async function getReceptionSetupReadOnly(userId: string) {
  const { listReceptionSpacesReadOnly } = await import('../spaces');
  const { listReceptionAgentsReadOnly } = await import('../agents');
  const [spaces, agents] = await Promise.all([
    listReceptionSpacesReadOnly(userId), listReceptionAgentsReadOnly(userId),
  ]);
  return { spaces, agents };
}

/** Main-owned resolution. Expected paths are comparison data, never authority. */
export async function previewReceptionWorkspace(
  userId: string,
  input: ReceptionWorkspaceSelection,
  current?: Readonly<Conversation>,
): Promise<PreviewResult> {
  if (!safeId(input.conversationId)) return { error: 'conversation id is required' };
  const conversation = current ?? await getConversation(userId, input.conversationId);
  const marker = parseA2AConversationMarker(conversation?.a2a);
  if (!conversation || !marker) return { error: 'not an a2a conversation' };
  if (!isInboundMarker(marker)) return { error: 'not a reception conversation' };
  let root: string | null;
  let selection: string;
  if (marker.workspace !== undefined) {
    root = validateReceptionWorkspaceGrant(marker.workspace);
    if (!root) return { error: 'workspace grant is unavailable' };
    selection = 'granted';
  } else {
    if ((input.spaceId !== undefined && typeof input.spaceId !== 'string')
      || (input.workspace !== undefined && typeof input.workspace !== 'string')) return { error: 'workspace is not a directory' };
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
    const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
    if (spaceId && workspace) return { error: 'workspace is not a directory' };
    if (spaceId) {
      const { getSpace } = await import('../spaces');
      if (!safeId(spaceId) || !(await getSpace(userId, spaceId))) return { error: 'space not found' };
      const { spaceWorkspaceDir, userSpacesDir } = await import('../../paths');
      const candidate = spaceWorkspaceDir(userId, spaceId);
      if (!isPathAllowed(candidate, [userSpacesDir(userId)])) return { error: 'workspace is not a directory' };
      root = receptionDirectory(candidate, true);
      selection = `space:${spaceId}`;
    } else if (workspace) {
      root = receptionDirectory(workspace);
      selection = 'custom';
    } else {
      const { resolveReceptionWorkspaceReadOnly } = await import('../group_chat/conv_workspace');
      const candidate = await resolveReceptionWorkspaceReadOnly(userId, input.conversationId, conversation);
      root = candidate ? receptionDirectory(candidate.root, candidate.source !== 'explicit') : null;
      if (conversation.space_id) {
        const { spaceWorkspaceDir, userSpacesDir } = await import('../../paths');
        if (!isPathAllowed(spaceWorkspaceDir(userId, conversation.space_id), [userSpacesDir(userId)])) root = null;
      }
      selection = `default:${candidate?.source || ''}`;
    }
    if (!root) return { error: 'workspace is not a directory' };
  }
  const { readState } = await import('../group_chat/state');
  const state = await readState(userId, input.conversationId);
  // A stateless digest binds the displayed root to the server's current inputs,
  // including title/slug/membership changes that happen to produce the same path.
  const snapshot = createHash('sha256').update(JSON.stringify([
    userId, input.conversationId, root, selection, conversation.title,
    conversation.space_id, conversation.project_id, conversation._cogseed_result_generation,
    state.workspace_dir, state.coding_project_dir, state.coding_project_dir_explicit,
  ])).digest('hex');
  return { preview: { root, snapshot } };
}

/** Confirm one main-resolved scope, then restore state before callers may run.
 * Marker-first durability permits a retry after state I/O failure. The run path
 * validates/restores the same grant again; it never invents a missing grant.
 *
 * `expectedMessageId`：调用方**实际显示给用户**的那条 pending 身份。提供时必须与
 * 当前绑定的 `messageId` 一致，否则在任何联系人/预览/mkdir/模型/写入之前返回
 * `reception_stale_pending`；`alreadyClaimed` 的恢复语义同样要求身份一致。缺省值
 * 只用于兼容旧调用方（不绑定身份）。 */
export async function confirmReception(
  userId: string,
  input: ReceptionWorkspaceSelection & {
    assistantAgentId?: unknown;
    expectedPreview?: unknown;
    expectedMessageId?: unknown;
  },
  deps: { setCodingProjectDir?: (userId: string, cid: string, workspace: string) => Promise<void>; now?: number } = {},
): Promise<{
  marker: A2AConversationMarker;
  question: InboundQuestion;
  duplicate?: boolean;
  workspace: string;
  assistantAgentId?: string;
} | { error: string; preview?: ReceptionWorkspacePreview }> {
  const cid = String(input.conversationId || '').trim();
  if (!safeId(cid)) return { error: 'conversation id is required' };
  const now = deps.now ?? Date.now();
  let failure: { error: string; preview?: ReceptionWorkspacePreview } = { error: 'not an a2a conversation' };
  let question: InboundQuestion | null = null;
  let duplicate = false;
  let stagingExpired = false;
  const committed = await updateConversationAtomic(userId, cid, async (current) => {
    const marker = parseA2AConversationMarker(current.a2a);
    if (!marker) return null;
    failure = { error: 'not a reception conversation' };
    if (!isInboundMarker(marker)) return null;
    failure = { error: 'reception is not waiting' };
    if (!['waiting', 'expired', 'active'].includes(marker.state)) return null;
    const pending = current.a2a_pending_reception;
    failure = { error: 'pending reception not found' };
    if (!pending || pending.conversationId !== cid || pending.peerUserId !== marker.peer_user_id) return null;
    // 决定绑定：Q1 的确认入口在 Q2 重开之后不能确认到 Q2，也不能借恢复语义放行。
    const expectedMessageId = parseExpectedMessageId(input.expectedMessageId);
    if ('error' in expectedMessageId) { failure = expectedMessageId; return null; }
    if (expectedMessageId.id && expectedMessageId.id !== pending.messageId) {
      failure = { error: 'reception_stale_pending' };
      return null;
    }
    const alreadyClaimed = (pending.state === 'claimed' || pending.state === 'running') && marker.state === 'active';
    // 首次确认必须在任何联系人/工作区/模型动作之前拒绝过期暂存。重复确认
    // （alreadyClaimed）恢复的是本人已经接受过的那次运行，不受暂存 TTL 影响。
    if (!alreadyClaimed && (marker.state === 'expired'
      || isReceptionStagingExpired(pending.receivedAt, now, current.created_at))) {
      failure = { error: 'reception_expired' };
      // 拒绝之后立即走同一套幂等清理，避免“确认入口”把正文留在绑定/台账里。
      stagingExpired = true;
      return null;
    }
    failure = { error: 'reception is not waiting' };
    if (!alreadyClaimed && marker.state !== 'waiting') return null;
    failure = { error: 'contact not found' };
    if (!(await getCachedContact(userId, marker.peer_user_id))) return null;
    // A duplicate can only restore its first grant, regardless of new selections.
    if (alreadyClaimed && !validateReceptionWorkspaceGrant(marker.workspace)) {
      failure = { error: 'workspace grant is unavailable' };
      return null;
    }
    const resolved = await previewReceptionWorkspace(userId, input, current);
    if ('error' in resolved) { failure = resolved; return null; }
    const expected = input.expectedPreview as Partial<ReceptionWorkspacePreview> | null;
    if (!alreadyClaimed && (!expected || expected.root !== resolved.preview.root || expected.snapshot !== resolved.preview.snapshot)) {
      failure = { error: 'workspace_preview_changed', preview: resolved.preview };
      return null;
    }
    const requestedAssistant = typeof input.assistantAgentId === 'string' ? input.assistantAgentId.trim() : '';
    let assistantAgentId = '';
    if (!alreadyClaimed && requestedAssistant) {
      const { resolveReceptionAssistant } = await import('./reception-run');
      assistantAgentId = await resolveReceptionAssistant(userId, requestedAssistant);
      if (assistantAgentId !== requestedAssistant) { failure = { error: 'assistant_unavailable' }; return null; }
    }
    const workspace = resolved.preview.root;
    if (!marker.workspace) {
      try { fs.mkdirSync(workspace, { recursive: true }); }
      catch { failure = { error: 'workspace is not a directory' }; return null; }
    }
    if (validateReceptionWorkspaceGrant(workspace) !== workspace) {
      failure = { error: 'workspace grant is unavailable' }; return null;
    }
    duplicate = alreadyClaimed;
    question = {
      messageId: pending.messageId, conversationId: pending.conversationId,
      fromAccount: pending.peerUserId, text: pending.text,
      ...(pending.peerName ? { fromName: pending.peerName } : {}),
    };
    return {
      a2a: alreadyClaimed ? marker : {
        ...transitionA2AConversation(marker, 'active'), workspace,
        ...(assistantAgentId ? { assistant_agent_id: assistantAgentId } : {}),
      },
      a2a_pending_reception: { ...pending, state: pending.state === 'running' ? 'running' : 'claimed' },
    };
  });
  if (!committed || !question) {
    if (stagingExpired) await expireStaleReceptions(userId, { now }).catch(() => undefined);
    return failure;
  }
  const marker = parseA2AConversationMarker(committed.a2a)!;
  const workspace = validateReceptionWorkspaceGrant(marker.workspace);
  if (!workspace) return { error: 'workspace grant is unavailable' };
  if (deps.setCodingProjectDir) await deps.setCodingProjectDir(userId, cid, workspace);
  else {
    const { setCodingProjectDir } = await import('../group_chat/state');
    await setCodingProjectDir(userId, cid, workspace, { explicit: true });
  }
  return { marker, question, workspace, ...(duplicate ? { duplicate: true } : {}),
    ...(marker.assistant_agent_id ? { assistantAgentId: marker.assistant_agent_id } : {}) };
}

/**
 * 接收方拒绝这次来访（waiting → refused）。
 *
 * 不发任何消息给对端：拒绝本身就是「不回答」，替对端编一句礼貌话会变成替本人发言。
 * 同一联系人之后再来问题会重新走一次确认（`refused` 不是永久拉黑，删除联系人才是）。
 *
 * `expectedMessageId` 与 `confirmReception` 同义：提供时必须是当前 pending 的身份，
 * 否则不写库并返回 `reception_stale_pending`（Q1 的「暂不接待」不能拒绝掉 Q2）。
 */
export async function declineReception(
  userId: string,
  conversationId: string,
  options: { now?: number; expectedMessageId?: unknown } = {},
): Promise<{ marker: A2AConversationMarker } | { error: string }> {
  const cid = String(conversationId || '').trim();
  if (!cid) return { error: 'conversation id is required' };
  const now = options.now ?? Date.now();
  let transitionError = 'not an a2a conversation';
  let next: A2AConversationMarker | null = null;
  let stagingExpired = false;
  await updateConversationAtomic(userId, cid, (current) => {
    const marker = parseA2AConversationMarker(current.a2a);
    if (!marker) return null;
    transitionError = 'not a reception conversation';
    if (!isInboundMarker(marker)) return null;
    transitionError = 'reception is not waiting';
    if (marker.state !== 'waiting') return null;
    const pending = current.a2a_pending_reception;
    const expectedMessageId = parseExpectedMessageId(options.expectedMessageId);
    if ('error' in expectedMessageId) { transitionError = expectedMessageId.error; return null; }
    if (expectedMessageId.id && (!pending || pending.messageId !== expectedMessageId.id)) {
      transitionError = 'reception_stale_pending';
      return null;
    }
    if (pending && isReceptionStagingExpired(pending.receivedAt, now, current.created_at)) {
      // 过期的暂存不能被“拒绝”成 refused：refused 不在过期扫描范围内，原问题
      // 正文会永久留在台账里。交给清理路径按 expired + 脱敏处理。
      transitionError = 'reception_expired';
      stagingExpired = true;
      return null;
    }
    next = transitionA2AConversation(marker, 'refused');
    return { a2a: next, a2a_pending_reception: undefined };
  });
  if (stagingExpired) {
    // 幂等清理：转 expired、清正文，并让台账墓碑与恢复链路一致。
    await expireStaleReceptions(userId, { now }).catch(() => undefined);
    return { error: 'reception_expired' };
  }
  if (!next) return { error: transitionError };
  return { marker: next };
}

export interface PendingReception {
  conversationId: string;
  messageId: string;
  fromAccount: string;
  peerName: string;
  fromName: string;
  text: string;
  receivedAt?: string;
  workspacePreview?: string;
  defaultWorkspace?: string;
  defaultAgentId?: string;
}

/**
 * 重启后仍在等本人确认的来访（收件箱是渲染层内存，重启就丢了）。
 *
 * 持久状态只有会话 marker（receiver + waiting）和会话记录本身，所以这里从这两处
 * 重建：marker 决定「等谁确认」，记录里最后一条对端消息就是待回答的问题原文。
 *
 * 这是纯读投影：超过暂存截止的条目既不返回，也不在这里落盘。清理由
 * `expireStaleReceptions` 在既有启动恢复/收件箱读取前的写路径执行。
 */
export async function listPendingReceptions(
  userId: string,
  options: { now?: number } = {},
): Promise<PendingReception[]> {
  const now = options.now ?? Date.now();
  const { listConversations } = await import('../chats');
  const conversations = await listConversations(userId);
  const pending: PendingReception[] = [];
  for (const conversation of conversations) {
    const marker = parseA2AConversationMarker((conversation as { a2a?: unknown }).a2a);
    if (!marker || !isInboundMarker(marker) || marker.state !== 'waiting') continue;
    const entry = conversation.a2a_pending_reception;
    if (!entry || entry.conversationId !== conversation.conversation_id
      || entry.peerUserId !== marker.peer_user_id) continue;
    // 清理 sweep 还没跑也不能把过期暂存露给界面：TTL 是投影的硬边界。
    if (isReceptionStagingExpired(entry.receivedAt, now, conversation.created_at)) continue;
    const contact = await getCachedContact(userId, marker.peer_user_id);
    const scope = await previewReceptionWorkspace(userId, {
      conversationId: entry.conversationId, workspace: contact?.defaultWorkspace,
    }, conversation);
    pending.push({
      ...('preview' in scope ? { workspacePreview: scope.preview.root } : {}),
      ...(contact?.defaultWorkspace ? { defaultWorkspace: contact.defaultWorkspace } : {}),
      ...(contact?.defaultAgentId ? { defaultAgentId: contact.defaultAgentId } : {}),
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      fromAccount: String(marker.peer_user_id || entry.peerUserId || ''),
      peerName: String(marker.peer_name || ''),
      fromName: String(entry.peerName || marker.peer_name || ''),
      text: entry.text,
      ...(entry.receivedAt ? { receivedAt: entry.receivedAt } : {}),
    });
  }
  return pending;
}

/**
 * 把过期等待项收敛为终态（方案 C09）：marker `waiting → expired`，清空暂存正文，
 * 只保留脱敏原因与原消息时间。重复调用是空操作；不会延长或重算截止时间。
 *
 * 只会动仍在 `waiting`/已 `expired` 且 pending 仍处于 `pending` 的来访——
 * 已确认（claimed/running）的运行不在这里改写。
 */
export async function expireStaleReceptions(
  userId: string,
  options: { now?: number; isCurrent?: () => boolean } = {},
): Promise<{ expired: number; scrubbed: number }> {
  if (!safeId(userId)) return { expired: 0, scrubbed: 0 };
  const now = options.now ?? Date.now();
  const { listConversations } = await import('../chats');
  const conversations = await listConversations(userId);
  // 台账按需读取一次：没有过期候选时不付全量读成本。
  let ledgerEntries: Awaited<ReturnType<typeof readReceptionLedger>> | null = null;
  const ledgerStillHoldsPlaintext = async (messageId: string): Promise<boolean> => {
    if (ledgerEntries === null) {
      ledgerEntries = await readReceptionLedger(userId).catch(() => []);
    }
    return ledgerEntries.some((row) => row.messageId === messageId && row.status !== 'expired');
  };
  // 会话绑定与本地台账必须同时收敛；放在事务提交之后，确认/清理的竞态由事务
  // 决定谁赢——只有确实由本次清理写掉绑定，才允许把台账改成终态。
  const scrubLedger = async (messageId: string, conversationId: string, peerUserId: string) => {
    if (!(await ledgerStillHoldsPlaintext(messageId))) return;
    await expireReceptionEntries(userId, [{ messageId, conversationId, peerUserId }], options.isCurrent)
      .catch((error) => {
        log.warn('reception ledger expiry failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  let expired = 0;
  let scrubbed = 0;
  for (const conversation of conversations) {
    if (options.isCurrent && !options.isCurrent()) break;
    const marker = parseA2AConversationMarker((conversation as { a2a?: unknown }).a2a);
    if (!marker || !isInboundMarker(marker) || (marker.state !== 'waiting' && marker.state !== 'expired')) continue;
    const entry = conversation.a2a_pending_reception;
    if (!entry || entry.conversationId !== conversation.conversation_id
      || entry.peerUserId !== marker.peer_user_id
      || entry.state === 'claimed' || entry.state === 'running') continue;
    // expired 状态也要把历史遗留的正文补清；waiting 必须先到截止时间。
    const stale = marker.state === 'expired'
      || isReceptionStagingExpired(entry.receivedAt, now, conversation.created_at);
    if (!stale) continue;
    if (marker.state === 'expired' && entry.text === '' && entry.expired_reason === 'stale') {
      // 绑定已经收敛：补上一次在写台账前中断的清理（幂等，不重写已过期的行）。
      await scrubLedger(entry.messageId, entry.conversationId, entry.peerUserId);
      continue;
    }
    let transitioned = false;
    const updated = await updateConversationAtomic(userId, conversation.conversation_id, (current) => {
      const currentMarker = parseA2AConversationMarker((current as { a2a?: unknown }).a2a);
      const pending = current.a2a_pending_reception;
      if (!currentMarker || !isInboundMarker(currentMarker)
        || (currentMarker.state !== 'waiting' && currentMarker.state !== 'expired')
        || !pending || pending.messageId !== entry.messageId
        || pending.conversationId !== current.conversation_id
        || pending.peerUserId !== currentMarker.peer_user_id
        || pending.state === 'claimed' || pending.state === 'running') return null;
      const stillStale = currentMarker.state === 'expired'
        || isReceptionStagingExpired(pending.receivedAt, now, current.created_at);
      if (!stillStale) return null;
      if (currentMarker.state === 'waiting') transitioned = true;
      return {
        a2a: currentMarker.state === 'waiting'
          ? transitionA2AConversation(currentMarker, 'expired') : currentMarker,
        a2a_pending_reception: {
          ...pending,
          text: '',
          expired_reason: 'stale',
        },
      };
    }, undefined, options.isCurrent);
    if (!updated) continue;
    await scrubLedger(entry.messageId, entry.conversationId, entry.peerUserId);
    if (transitioned) expired += 1;
    scrubbed += 1;
  }
  if (expired > 0) {
    log.info('a2a stale reception staging expired', { expired, scrubbed });
  }
  return { expired, scrubbed };
}
