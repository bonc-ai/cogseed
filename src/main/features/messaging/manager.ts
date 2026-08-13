import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { t } from '../../i18n';
import { createBurstMerger, FEISHU_BURST_DEFAULTS, type BurstBatch, type BurstMerger } from './burst-merge';
import { isCardAdapter } from './stream-card';
import { safeId } from '../../storage';
import * as groupChat from '../group_chat';
import * as projects from '../projects';
import * as wakeService from '../p3394/wake-service';
import * as ontologyCandidates from '../personal_ontology_candidates';
import * as touchpointLedger from '../touchpoints/ledger';
import * as touchpointActions from '../touchpoints/actions';
import { buildResolvedTouchpointCard, TOUCHPOINT_CARD_INPUT_ID } from '../touchpoints/feishu/card';
import type { TouchpointActionKind } from '../touchpoints/types';
import * as registry from './registry';
import * as bindings from './bindings';
import * as ledger from './ledger';
import { evaluateInboundPolicy, stripBotMention } from './policy';
import { matchInboundCommand, dispatchInboundCommand } from './commands';
import { isValidFeishuOpenId } from './types';
import { createAdapter } from './adapters';
import { RuntimeInstance } from './runtime';
import type {
  AdapterCallbacks,
  CardActionEnvelope,
  DeliveryLedgerEntry,
  InboundEnvelope,
  JsonCompatibleValue,
  MessagingAdapter,
  MessagingInboundResult,
  MessagingInstance,
  MessagingInstanceClient,
  MessagingInstanceInternal,
  MessagingInstanceStatus,
  MessagingPlatform,
  MessagingPlatformCatalogEntry,
  WorkspaceScope,
} from './types';

const log = createLogger('messaging:manager');

/** How long a freshly configured Feishu bot accepts the first direct message
 * as its owner (no manual open id needed). The window is short so a bot that
 * is not configured by its owner cannot be claimed by a random first sender. */
export const OWNER_BINDING_WINDOW_MS = 5 * 60 * 1000;

/** uid\u0000instanceId → window deadline for owner auto-binding. */
const ownerBindingWindows = new Map<string, number>();

function ownerBindingKey(uid: string, instanceId: string): string {
  return `${uid}\u0000${instanceId}`;
}

/** Open (or refresh) the owner auto-binding window for a Feishu bot that has
 * credentials but no configured owner. Called after credentials are written
 * or the instance is enabled; the renderer shows the "send a message to bind"
 * hint at the same time. */
export function openOwnerBindingWindow(uid: string, instanceId: string): void {
  assertUserId(uid);
  assertInstanceId(instanceId);
  ownerBindingWindows.set(ownerBindingKey(uid, instanceId), Date.now() + OWNER_BINDING_WINDOW_MS);
}

/** Live binding-window status for the settings UI. Returns null when no
 * window is open (or it expired). */
export function getOwnerBindingStatus(
  uid: string,
  instanceId: string,
): { binding: true; expiresAt: string; remainingMs: number } | null {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const deadline = ownerBindingWindows.get(ownerBindingKey(uid, instanceId));
  if (deadline === undefined) return null;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    ownerBindingWindows.delete(ownerBindingKey(uid, instanceId));
    return null;
  }
  return { binding: true, expiresAt: new Date(deadline).toISOString(), remainingMs };
}

/** Bind the sender of the first direct message as the instance owner while
 * the binding window is open. Runs before inbound policy so a freshly
 * configured bot (whose allowlist is still empty) can still be claimed.
 * Returns true when an owner was written. */
async function tryAutoBindOwner(
  uid: string,
  envelope: InboundEnvelope,
  instanceId: string,
  platform: MessagingPlatform,
): Promise<boolean> {
  if (platform !== 'feishu_lark' || envelope.isGroup) return false;
  const key = ownerBindingKey(uid, instanceId);
  const deadline = ownerBindingWindows.get(key);
  if (deadline === undefined) return false;
  if (deadline <= Date.now()) {
    ownerBindingWindows.delete(key);
    return false;
  }
  const current = await registry.getInstance(uid, instanceId);
  if (!current || current.ownerExternalUserId) return false;
  const openId = envelope.externalUserId?.trim() || '';
  if (!openId || !isValidFeishuOpenId(openId)) return false;
  await registry.updateInstance(uid, instanceId, {
    ownerExternalUserId: openId,
    ...(envelope.externalUserName?.trim() ? { ownerExternalUserName: envelope.externalUserName.trim().slice(0, 120) } : {}),
    ownerIdentitySource: 'auto',
  });
  ownerBindingWindows.delete(key);
  log.info('messaging owner auto-bound from direct message', { instanceId, source: 'auto' });
  return true;
}

/** True when the inbound text is a session-reset slash command. */
function isNewSessionCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '/new' || trimmed.startsWith('/new ')
    || trimmed === '/reset' || trimmed.startsWith('/reset ');
}

const runtimes = new Map<string, Map<string, RuntimeInstance>>();
const liveStatuses = new Map<string, Map<string, MessagingInstanceStatus>>();
const lifecycleLocks = new Map<string, Mutex>();

export const PLATFORM_CATALOG: readonly MessagingPlatformCatalogEntry[] = [
  {
    platform: 'telegram',
    displayName: 'Telegram',
    description: 'Telegram Bot API，支持双向对话和长轮询。',
    available: true,
    twoWay: true,
  },
  {
    platform: 'feishu_lark',
    displayName: '飞书 / Lark',
    description: '飞书开放平台事件订阅，支持双向对话。',
    available: true,
    twoWay: true,
  },
  {
    platform: 'wechat_personal',
    displayName: '个人微信',
    description: '微信官方 iLink 通道，扫码绑定后长轮询双向对话。',
    available: true,
    twoWay: true,
  },
  {
    platform: 'wecom',
    displayName: '企业微信',
    description: '企业微信智能机器人官方扫码创建，使用 WebSocket 长连接双向对话。',
    available: true,
    twoWay: true,
  },
];

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function assertInstanceId(instanceId: string): void {
  if (!registry.isValidInstanceId(instanceId)) throw new Error('invalid messaging instance id');
}

function runtimeMap(uid: string): Map<string, RuntimeInstance> {
  let map = runtimes.get(uid);
  if (!map) {
    map = new Map();
    runtimes.set(uid, map);
  }
  return map;
}

function lifecycleLock(uid: string, instanceId: string): Mutex {
  const key = `${uid}:${instanceId}`;
  let lock = lifecycleLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    lifecycleLocks.set(key, lock);
  }
  return lock;
}

async function withLifecycle<T>(uid: string, instanceId: string, operation: () => Promise<T>): Promise<T> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  return lifecycleLock(uid, instanceId).runExclusive(operation);
}

function cloneStatus(status: MessagingInstanceStatus): MessagingInstanceStatus {
  return {
    kind: status.kind,
    checkedAt: status.checkedAt,
    ...(status.message ? { message: status.message } : {}),
    ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
  };
}

function setLiveStatus(uid: string, instanceId: string, status: MessagingInstanceStatus): void {
  let statuses = liveStatuses.get(uid);
  if (!statuses) {
    statuses = new Map();
    liveStatuses.set(uid, statuses);
  }
  statuses.set(instanceId, cloneStatus(status));
}

function clearLiveStatus(uid: string, instanceId: string): void {
  const statuses = liveStatuses.get(uid);
  if (!statuses) return;
  statuses.delete(instanceId);
  if (!statuses.size) liveStatuses.delete(uid);
}

function isCurrentRuntime(uid: string, runtime: RuntimeInstance): boolean {
  return runtime.active && runtimes.get(uid)?.get(runtime.instanceId) === runtime;
}

function withLiveStatus(uid: string, instance: MessagingInstanceClient): MessagingInstanceClient {
  const runtime = runtimes.get(uid)?.get(instance.id);
  const live = runtime && runtime.active ? liveStatuses.get(uid)?.get(instance.id) : undefined;
  return {
    ...instance,
    status: live ? cloneStatus(live) : cloneStatus(instance.status),
  };
}

function queueRuntimeStatus(uid: string, runtime: RuntimeInstance, nextStatus: MessagingInstanceStatus): void {
  if (!isCurrentRuntime(uid, runtime)) return;
  const snapshot = cloneStatus(nextStatus);
  const previous = liveStatuses.get(uid)?.get(runtime.instanceId);
  setLiveStatus(uid, runtime.instanceId, snapshot);
  // 状态 kind 变化才推送渲染层：心跳重复 connected 不刷屏，避免高频重渲染。
  if (!previous || previous.kind !== snapshot.kind) {
    broadcastMessagingStatus(runtime.instanceId, snapshot);
  }
  runtime.statusWrite = runtime.statusWrite
    .then(async () => {
      if (!isCurrentRuntime(uid, runtime)) return;
      await registry.updateStatus(uid, runtime.instanceId, snapshot);
    })
    .catch((error) => {
      log.warn('messaging status persistence failed', {
        instanceId: runtime.instanceId,
        error: (error as Error).message,
      });
    });
}

/** 实例状态变化广播给渲染层（kind 变化时）。channel 在 preload 的
 * `messaging:` 推送前缀白名单内。推送是尽力而为，失败不影响状态机。 */
let broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;

function broadcastMessagingStatus(instanceId: string, status: MessagingInstanceStatus): void {
  if (broadcastOverride) {
    broadcastOverride('messaging:instance-status', { instanceId, status: cloneStatus(status) });
    return;
  }
  try {
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (typeof ipc.broadcastToRenderer !== 'function') return;
    ipc.broadcastToRenderer('messaging:instance-status', { instanceId, status: cloneStatus(status) });
  } catch {
    /* push is best-effort */
  }
}

/**
 * Proactive (Commander-initiated) send to a fixed recipient — currently the
 * configured Feishu/Lark owner open id or the WeChat owner user id. Uses the
 * same ledger, idempotency key,
 * retry, and recovery machinery as ordinary replies, keyed on a caller-owned
 * stable source key so one tool call never sends twice. Waits for the
 * terminal outcome (`sent` / `failed` / `cancelled`) instead of returning on
 * the first `retry_pending`; an aborted signal cancels the delivery so no
 * retry timer or restart recovery can fire it later.
 */
export async function sendProactive(
  uid: string,
  input: {
    instanceId: string;
    recipientId: string;
    text: string;
    card?: Record<string, JsonCompatibleValue>;
    sourceKey: string;
    signal?: AbortSignal | null;
  },
): Promise<{ entry: DeliveryLedgerEntry }> {
  assertUserId(uid);
  const runtime = runtimes.get(uid)?.get(input.instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) {
    throw new Error('messaging instance is not running');
  }
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 12_000) : '';
  if (!text) throw new Error('proactive message text required');
  const sourceKey = typeof input.sourceKey === 'string' && input.sourceKey.trim()
    ? input.sourceKey.trim().slice(0, 160)
    : '';
  if (!sourceKey) throw new Error('proactive source key required');
  const recipientId = typeof input.recipientId === 'string' ? input.recipientId.trim() : '';
  if (!recipientId || recipientId.length > 512) throw new Error('proactive recipient required');
  const key = ledger.deliveryKey(input.instanceId, sourceKey);
  const begun = await ledger.beginDelivery(uid, {
    key,
    instanceId: input.instanceId,
    recipientId,
    recipientIdType: 'open_id',
    sourceMessageId: sourceKey,
    textHash: ledger.textHash(text),
    text,
    ...(input.card ? { card: input.card } : {}),
    idempotencyKey: `proactive-${ledger.textHash(sourceKey).slice(0, 24)}`,
  });
  if (!begun.duplicate) {
    if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
      await ledger.finishDelivery(uid, key, {
        status: 'cancelled',
        error: 'delivery cancelled because messaging instance stopped',
      });
    } else {
      await runtime.attemptDelivery(key, begun.entry);
    }
  }
  try {
    const terminal = await ledger.waitForDeliveryTerminal(uid, key, { signal: input.signal ?? null });
    if (terminal.status === 'cancelled') {
      throw new Error('proactive delivery cancelled');
    }
    return { entry: terminal };
  } catch (error) {
    if (input.signal?.aborted) {
      // Stop the retry timer / restart recovery from ever firing this send.
      await ledger.cancelDelivery(uid, key, 'proactive send aborted').catch(() => undefined);
      throw Object.assign(new Error('proactive send aborted'), { name: 'AbortError' });
    }
    throw error;
  }
}

/** Proactive file send to the owner: uploads and sends a local file through
 * the same idempotent delivery ledger as `sendProactive`. The text fallback
 * for recovery is a `[file] name` marker, so an adapter without `sendFile`
 * still delivers something instead of wedging. */
export async function sendProactiveFile(
  uid: string,
  input: {
    instanceId: string;
    recipientId: string;
    filePath: string;
    fileName: string;
    sourceKey: string;
    signal?: AbortSignal | null;
  },
): Promise<{ entry: DeliveryLedgerEntry }> {
  assertUserId(uid);
  const runtime = runtimes.get(uid)?.get(input.instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) {
    throw new Error('messaging instance is not running');
  }
  const filePath = typeof input.filePath === 'string' && input.filePath.trim() ? input.filePath.trim() : '';
  if (!filePath || filePath.length > 1024) throw new Error('proactive file path required');
  const fileName = typeof input.fileName === 'string' && input.fileName.trim()
    ? input.fileName.trim().slice(0, 240)
    : filePath.split('/').pop() || 'file';
  const sourceKey = typeof input.sourceKey === 'string' && input.sourceKey.trim()
    ? input.sourceKey.trim().slice(0, 160)
    : '';
  if (!sourceKey) throw new Error('proactive source key required');
  const recipientId = typeof input.recipientId === 'string' ? input.recipientId.trim() : '';
  if (!recipientId || recipientId.length > 512) throw new Error('proactive recipient required');
  const text = `[文件] ${fileName}`;
  const key = ledger.deliveryKey(input.instanceId, sourceKey);
  const begun = await ledger.beginDelivery(uid, {
    key,
    instanceId: input.instanceId,
    recipientId,
    recipientIdType: 'open_id',
    sourceMessageId: sourceKey,
    textHash: ledger.textHash(text),
    text,
    file: { path: filePath, name: fileName },
    idempotencyKey: `proactive-${ledger.textHash(sourceKey).slice(0, 24)}`,
  });
  if (!begun.duplicate) {
    if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
      await ledger.finishDelivery(uid, key, {
        status: 'cancelled',
        error: 'delivery cancelled because messaging instance stopped',
      });
    } else {
      await runtime.attemptDelivery(key, begun.entry);
    }
  }
  try {
    const terminal = await ledger.waitForDeliveryTerminal(uid, key, { signal: input.signal ?? null });
    if (terminal.status === 'cancelled') {
      throw new Error('proactive file delivery cancelled');
    }
    return { entry: terminal };
  } catch (error) {
    if (input.signal?.aborted) {
      await ledger.cancelDelivery(uid, key, 'proactive file send aborted').catch(() => undefined);
      throw Object.assign(new Error('proactive file send aborted'), { name: 'AbortError' });
    }
    throw error;
  }
}

const CHAT_LOCKS_MAX = 1000;
const chatLocks = new Map<string, Mutex>();

/** Per-user burst mergers; synthetic envelopes bypass them entirely. */
const burstMergers = new Map<string, BurstMerger<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }>>();

function chatLockKey(uid: string, instanceId: string, externalChatId: string): string {
  return `${uid}:${instanceId}:${externalChatId}`;
}

function getChatLock(uid: string, instanceId: string, externalChatId: string): Mutex {
  const key = chatLockKey(uid, instanceId, externalChatId);
  const existing = chatLocks.get(key);
  if (existing) {
    // LRU touch: re-insert so the most recently used lock sits last.
    chatLocks.delete(key);
    chatLocks.set(key, existing);
    return existing;
  }
  if (chatLocks.size >= CHAT_LOCKS_MAX) {
    let evicted = false;
    for (const [candidateKey, candidate] of chatLocks) {
      if (!candidate.isLocked()) {
        chatLocks.delete(candidateKey);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      // Every lock is held; drop the oldest regardless (Hermes behaves the
      // same way — the caller for that chat simply gets a fresh lock).
      const oldestKey = chatLocks.keys().next().value;
      if (oldestKey !== undefined) chatLocks.delete(oldestKey);
    }
  }
  const lock = new Mutex();
  chatLocks.set(key, lock);
  return lock;
}

async function handleInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  const loaded = await registry.getInstanceWithSecret(uid, envelope.instanceId);
  if (!loaded || loaded.instance.platform !== envelope.platform) {
    return { accepted: false, duplicate: false, reason: 'instance_not_found' };
  }
  const instance = loaded.instance;
  if (!instance.enabled) return { accepted: false, duplicate: false, reason: 'instance_disabled' };
  const key = ledger.inboundKey(instance.id, envelope.externalMessageId);
  // Idempotency reservation happens outside the per-chat lock: the ledger is
  // itself atomic, so a concurrent duplicate of an in-flight message is
  // rejected immediately instead of queueing behind the lock.
  const reservation = await ledger.reserveInbound(uid, key, envelope.receivedAt);
  if (reservation.duplicate) return { accepted: false, duplicate: true, cid: reservation.entry.cid };
  const lock = getChatLock(uid, instance.id, envelope.externalChatId);
  return lock.runExclusive(() => handleInboundLocked(uid, envelope, instance, key));
}

function mergerFor(uid: string): BurstMerger<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }> {
  let merger = burstMergers.get(uid);
  if (!merger) {
    merger = createBurstMerger(FEISHU_BURST_DEFAULTS, (batch) => {
      void flushBurstBatch(uid, batch);
    });
    burstMergers.set(uid, merger);
  }
  return merger;
}

/** Flush one merged batch: mark the trailing message ids as seen so a lone
 * redelivery is rejected as a duplicate, then dispatch as a single envelope
 * carrying the first message id. Every enqueued promise settles: the first
 * caller resolves with the merged dispatch result, trailing callers resolve
 * as merged duplicates (or all fail when the dispatch errors). */
async function flushBurstBatch(uid: string, batch: BurstBatch<{ envelope: InboundEnvelope; resolve: (result: MessagingInboundResult) => void }>): Promise<void> {
  const first = batch.payloads[0].envelope;
  const firstResolve = batch.payloads[0].resolve;
  // Keys this batch marked as consumed. 'duplicate' is a terminal mark; if
  // the merged dispatch fails, these must be released to 'failed' (which
  // reserveInbound treats as recoverable) so a platform redelivery can
  // re-consume them — otherwise those messages are silently dropped even
  // though they were only swallowed into the failed batch.
  const markedDuplicateKeys: string[] = [];
  try {
    for (const id of batch.ids.slice(1)) {
      const key = ledger.inboundKey(first.instanceId, id);
      try {
        const reservation = await ledger.reserveInbound(uid, key, first.receivedAt);
        if (!reservation.duplicate) {
          await ledger.completeInbound(uid, key, { status: 'duplicate' });
          markedDuplicateKeys.push(key);
        }
      } catch {
        // Trailing ids are best-effort dedup markers; a bad id must not fail the batch.
      }
    }
    // 合并批次携带最后一条有效消息的 tokenRef：getupdates 多消息批次里
    // 靠前的 context_token 可能已陈旧（spec §3.1），回复必须绑定该轮
    // 最新的一条，而不是第一条。
    let lastTokenRef: string | undefined;
    for (const item of batch.payloads) {
      if (item.envelope.contextTokenRef) lastTokenRef = item.envelope.contextTokenRef;
    }
    const envelope: InboundEnvelope = {
      ...first,
      externalMessageId: batch.ids[0],
      text: batch.text,
      ...(lastTokenRef !== undefined ? { contextTokenRef: lastTokenRef } : {}),
    };
    const result = await handleInbound(uid, envelope);
    firstResolve(result);
    for (const item of batch.payloads.slice(1)) {
      item.resolve({ accepted: false, duplicate: true, reason: 'merged' });
    }
  } catch (error) {
    log.warn('messaging burst merge dispatch failed', {
      instanceId: first.instanceId,
      error: logErrorSummary(error),
    });
    // Release the trailing ids this batch marked: a redelivery of those ids
    // must be re-consumable instead of rejected forever as duplicates. Only
    // release keys that still carry this batch's 'duplicate' mark — a
    // concurrent later batch may already have re-consumed and re-marked the
    // same id, and releasing that would allow a third dispatch.
    for (const key of markedDuplicateKeys) {
      try {
        const current = await ledger.readInbound(uid, key);
        if (current?.status !== 'duplicate') continue;
        await ledger.completeInbound(uid, key, { status: 'failed', reason: 'burst_merge_failed' });
      } catch {
        // Best effort; a stale duplicate mark only blocks one redelivery.
      }
    }
    for (const item of batch.payloads) {
      item.resolve({ accepted: false, duplicate: false, reason: 'burst_merge_failed' });
    }
  }
}

/** Inbound entry for adapters: synthetic feedback envelopes dispatch
 * immediately; regular text goes through the burst merger so split platform
 * messages consume a single agent turn. */
export async function enqueueInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid inbound envelope');
  if (!envelope.instanceId || !envelope.externalMessageId || !envelope.externalChatId || !envelope.externalUserId || !envelope.text) {
    throw new Error('inbound envelope missing required fields');
  }
  if (envelope.synthetic) return handleInbound(uid, envelope);
  return new Promise<MessagingInboundResult>((resolve) => {
    const merger = mergerFor(uid);
    merger.push(`${envelope.instanceId}\u0000${envelope.externalChatId}`, {
      id: envelope.externalMessageId,
      text: envelope.text,
      payload: { envelope, resolve },
    });
  });
}

async function handleInboundLocked(
  uid: string,
  envelope: InboundEnvelope,
  instance: MessagingInstance,
  key: string,
): Promise<MessagingInboundResult> {
  log.info('messaging inbound envelope received', {
    instanceId: envelope.instanceId,
    platform: envelope.platform,
    externalMessageId: envelope.externalMessageId,
    isGroup: envelope.isGroup,
    textLen: typeof envelope.text === 'string' ? envelope.text.length : 0,
    mentionPresent: envelope.mentionPresent,
  });
  // A freshly configured bot can claim its owner from the first direct message
  // (before policy — the default allowlist still denies everyone).
  await tryAutoBindOwner(uid, envelope, instance.id, instance.platform);
  const decision = evaluateInboundPolicy(instance, envelope);
  if (!decision.allowed) {
    await ledger.completeInbound(uid, key, { status: 'rejected', reason: decision.reason || 'policy_rejected' });
    return { accepted: false, duplicate: false, reason: decision.reason };
  }
  const text = stripBotMention(envelope.text).slice(0, 12_000);
  if (!text) {
    await ledger.completeInbound(uid, key, { status: 'rejected', reason: 'empty_message' });
    return { accepted: false, duplicate: false, reason: 'empty_message' };
  }
  // Session-reset slashes rotate the bound conversation to a fresh cid and
  // confirm with a system message instead of consuming a Meta Agent turn
  // (mirrors Hermes' `/new` session reset).
  if (isNewSessionCommand(text)) {
    try {
      const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope, { forceNew: true });
      const runtime = runtimes.get(uid)?.get(instance.id);
      if (runtime) {
        const oldListener = runtime.listeners.get(binding.key);
        if (oldListener) {
          oldListener();
          runtime.listeners.delete(binding.key);
        }
        runtime.bindingContexts.set(binding.key, binding);
        await runtime.attachBindingListener(binding);
        await runtime.deliverConfirmationMessage(binding, envelope);
      } else {
        log.warn('messaging new-session: runtime not present, confirmation skipped', {
          instanceId: instance.id,
        });
      }
      await ledger.completeInbound(uid, key, { status: 'accepted', cid: binding.cid });
      return { accepted: true, duplicate: false, cid: binding.cid };
    } catch (error) {
      const message = (error as Error).message || 'messaging new-session dispatch failed';
      await ledger.completeInbound(uid, key, { status: 'failed', reason: message });
      throw new Error(`messaging new-session dispatch failed: ${message}`);
    }
  }
  // Personal-context slash commands（/权限 /遗忘）：consumed by registered
  // handlers; the reply goes through the same ledger-backed delivery as the
  // session-reset confirmation and never consumes an agent turn.
  const inboundCommand = matchInboundCommand(text);
  if (inboundCommand) {
    const outcome = await dispatchInboundCommand({ uid, instance, envelope, command: inboundCommand });
    if (outcome.consumed) {
      const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
      const runtime = runtimes.get(uid)?.get(instance.id);
      if (outcome.replyText && runtime) {
        await runtime.deliverText(binding, envelope, outcome.replyText);
      } else if (outcome.replyText) {
        log.warn('messaging command reply skipped: runtime not present', {
          instanceId: instance.id,
          command: inboundCommand.name,
        });
      }
      await ledger.completeInbound(uid, key, { status: 'accepted', cid: binding.cid });
      return { accepted: true, duplicate: false, cid: binding.cid };
    }
  }
  try {
    const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
    const runtime = runtimes.get(uid)?.get(instance.id);
    log.info('messaging inbound accepted, dispatching to group chat', {
      instanceId: instance.id,
      key,
      cid: binding.cid,
      runtimePresent: !!runtime,
      bindingKey: binding.key,
    });
    if (runtime) {
      // Refresh the live binding (replyToMessageId etc.) so outbound replies
      // reference the message they actually answer.
      runtime.bindingContexts.set(binding.key, binding);
      await runtime.attachBindingListener(binding);
    }
    const result = await groupChat.send({ userId: uid, cid: binding.cid, text });
    if (!result.ok) throw new Error(result.error || 'group chat enqueue failed');
    // Capture the inbound's context token reference keyed by the user message
    // this turn starts from, so the completing turn's reply resolves its own
    // ref even when a later inbound arrives while the turn is still in flight.
    if (runtime && result.msg?.id && envelope.contextTokenRef) {
      runtime.turnSourceRefs.set(result.msg.id, envelope.contextTokenRef);
    }
    await ledger.completeInbound(uid, key, { status: 'accepted', cid: binding.cid });
    return { accepted: true, duplicate: false, cid: binding.cid };
  } catch (error) {
    const message = (error as Error).message || 'messaging inbound dispatch failed';
    await ledger.completeInbound(uid, key, { status: 'failed', reason: message });
    throw new Error(`messaging inbound dispatch failed: ${message}`);
  }
}

/** Buttons on interactive cards are explicit operator actions: the clicker
 * must be an allowed user (no group-mention requirement), and the payload
 * decides the handler. Today the only wired action is wake approvals. */
async function handleCardAction(uid: string, action: CardActionEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  if (!action || typeof action !== 'object' || !action.instanceId || !action.externalUserId || !action.action) {
    return { accepted: false, duplicate: false, reason: 'invalid_card_action' };
  }
  const loaded = await registry.getInstanceWithSecret(uid, action.instanceId);
  if (!loaded || loaded.instance.platform !== action.platform) {
    return { accepted: false, duplicate: false, reason: 'instance_not_found' };
  }
  const instance = loaded.instance;
  if (!instance.enabled) return { accepted: false, duplicate: false, reason: 'instance_disabled' };
  if (!instance.policy.allowUserIds.includes(action.externalUserId)) {
    return { accepted: false, duplicate: false, reason: 'user_not_allowed' };
  }
  // 触达点意图卡片（touchpoint 特性产出）：按钮 value 携带签名回执信封，
  // 确认/拒绝等动作直接消费进触达点 ledger。
  if (action.action === 'touchpoint') {
    return handleTouchpointCardAction(uid, action);
  }
  // 候选确认卡片（personal_context 管线产出）：按钮 value 携带 candidate_id，
  // 确认/拒绝直接落 personal_ontology 候选池，无 wake_id。
  if (action.action === 'candidate_approve' || action.action === 'candidate_reject') {
    const candidateId = typeof action.payload.candidate_id === 'string' ? action.payload.candidate_id.trim() : '';
    if (!candidateId) return { accepted: false, duplicate: false, reason: 'invalid_card_action' };
    if (action.action === 'candidate_approve') {
      const result = await ontologyCandidates.confirmCandidate(uid, candidateId);
      if (!result.ok) return { accepted: false, duplicate: false, reason: 'candidate_confirm_failed' };
    } else {
      await ontologyCandidates.rejectCandidate(uid, candidateId);
    }
    void finalizeCandidateCard(uid, action);
    return { accepted: true, duplicate: false };
  }

  const wakeId = typeof action.payload.wake_id === 'string' && action.payload.wake_id.trim()
    ? action.payload.wake_id.trim()
    : '';
  if (!wakeId) return { accepted: false, duplicate: false, reason: 'unsupported_card_action' };
  if (action.action === 'approve' || action.action === 'approve_once'
    || action.action === 'approve_session' || action.action === 'approve_always') {
    await wakeService.approveWakeRequest(uid, wakeId);
    void finalizeApprovalCard(uid, action);
    return { accepted: true, duplicate: false };
  }
  if (action.action === 'deny') {
    await wakeService.rejectWakeRequest(uid, wakeId);
    void finalizeApprovalCard(uid, action);
    return { accepted: true, duplicate: false };
  }
  return { accepted: false, duplicate: false, reason: 'unsupported_card_action' };
}

/** Buttons on touchpoint intent cards carry a signed receipt envelope in
 * their value; clicking one consumes the action in the touchpoint ledger and
 * swaps the card for its terminal state. Duplicate clicks are idempotent —
 * the ledger returns the stored record and the card is not re-finalized. */
async function handleTouchpointCardAction(uid: string, action: CardActionEnvelope): Promise<MessagingInboundResult> {
  const payloadText = (field: string): string => {
    const entry = action.payload[field];
    return typeof entry === 'string' && entry.trim() ? entry.trim() : '';
  };
  const intentId = payloadText('intent_id');
  const actionId = payloadText('action_id');
  const envelopeUserId = payloadText('user_id');
  const kind = payloadText('kind');
  const occurredAt = payloadText('occurred_at');
  const signature = payloadText('signature');
  // Free-text content from the card input field; trimmed, capped, and
  // validated by the touchpoint receipt contract.
  const content = payloadText(TOUCHPOINT_CARD_INPUT_ID);
  if (!intentId || !actionId || !envelopeUserId || !kind || !occurredAt || !signature) {
    return { accepted: false, duplicate: false, reason: 'invalid_card_action' };
  }
  try {
    const outcome = await touchpointLedger.consumeTouchpointAction(uid, {
      actionId,
      intentId,
      userId: envelopeUserId,
      action: kind,
      occurredAt,
      signature,
      ...(content ? { content } : {}),
    });
    if (!outcome.duplicate) {
      void finalizeTouchpointCard(uid, action, kind as TouchpointActionKind, content);
      // Business effects (reschedule, update, …) run fire-and-forget; a
      // failing handler never changes the accepted receipt outcome.
      void touchpointActions.notifyTouchpointActionHandlers(uid, outcome.action).catch(() => undefined);
    }
    return { accepted: true, duplicate: outcome.duplicate };
  } catch (error) {
    log.warn('touchpoint card action rejected', {
      instanceId: action.instanceId,
      intentId,
      action: kind,
      error: logErrorSummary(error),
    });
    return { accepted: false, duplicate: false, reason: 'touchpoint_action_rejected' };
  }
}

/** Replaces a resolved touchpoint card with its terminal state so the same
 * buttons cannot be clicked twice (mirrors the wake approval finalize).
 * Submitted content is echoed back on the resolved card. */
async function finalizeTouchpointCard(uid: string, action: CardActionEnvelope, kind: TouchpointActionKind, content?: string): Promise<void> {
  const runtime = runtimes.get(uid)?.get(action.instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) return;
  const adapter = runtime.adapter;
  if (!isCardAdapter(adapter)) return;
  try {
    await adapter.updateCard(action.externalMessageId, buildResolvedTouchpointCard(kind, content));
  } catch (error) {
    log.warn('touchpoint card finalize failed', {
      instanceId: action.instanceId,
      externalMessageId: action.externalMessageId,
      error: logErrorSummary(error),
    });
  }
}

/** Localized terminal label for an approval choice. Keys mirror the card
 * button action values so unknown choices fall back to the raw key. */
function approvalChoiceLabel(choice: string): string {
  return t(`messaging.approval.${choice}`);
}

/** Replaces a resolved approval card with a terminal state so the same
 * buttons cannot be clicked twice (mirrors Hermes' resolved card). */
function buildResolvedApprovalCard(choice: string, userName = ''): Record<string, JsonCompatibleValue> {
  const denied = choice === 'deny';
  const label = approvalChoiceLabel(choice);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `${denied ? '❌' : '✅'} ${label}`, tag: 'plain_text' },
      template: denied ? 'red' : 'green',
    },
    elements: [
      { tag: 'markdown', content: `${denied ? '❌' : '✅'} **${label}**${userName ? ` — ${userName}` : ''}` },
    ],
  };
}

async function finalizeApprovalCard(uid: string, action: CardActionEnvelope): Promise<void> {
  const runtime = runtimes.get(uid)?.get(action.instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) return;
  const adapter = runtime.adapter;
  if (!isCardAdapter(adapter)) return;
  try {
    await adapter.updateCard(action.externalMessageId, buildResolvedApprovalCard(action.action));
  } catch (error) {
    log.warn('messaging approval card finalize failed', {
      instanceId: action.instanceId,
      error: (error as Error).message,
    });
  }
}

/** Terminal card for a resolved personal-ontology candidate, so the same
 * buttons cannot be clicked twice (mirrors approval card finalize). */
function buildResolvedCandidateCard(approved: boolean): Record<string, JsonCompatibleValue> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        content: approved ? t('messaging.candidate_card.confirmed') : t('messaging.candidate_card.rejected'),
        tag: 'plain_text',
      },
      template: approved ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content: approved ? t('messaging.candidate_card.confirmed_detail') : t('messaging.candidate_card.rejected_detail'),
      },
    ],
  };
}

async function finalizeCandidateCard(uid: string, action: CardActionEnvelope): Promise<void> {
  const runtime = runtimes.get(uid)?.get(action.instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) return;
  const adapter = runtime.adapter;
  if (!isCardAdapter(adapter)) return;
  try {
    await adapter.updateCard(action.externalMessageId, buildResolvedCandidateCard(action.action === 'candidate_approve'));
  } catch (error) {
    log.warn('messaging candidate card finalize failed', {
      instanceId: action.instanceId,
      error: (error as Error).message,
    });
  }
}

async function startRuntime(uid: string, instanceId: string): Promise<void> {
  const map = runtimeMap(uid);
  if (map.has(instanceId)) return;
  const loaded = await registry.getInstanceWithSecret(uid, instanceId);
  if (!loaded || !loaded.instance.enabled) {
    clearLiveStatus(uid, instanceId);
    return;
  }
  // An enabled bot without an owner re-opens its binding window on startup,
  // so a legacy configuration can claim its owner by sending the first
  // direct message without touching the settings UI.
  if (loaded.instance.platform === 'feishu_lark' && !(loaded.instance as MessagingInstanceInternal).ownerExternalUserId) {
    openOwnerBindingWindow(uid, instanceId);
  }
  let adapter: MessagingAdapter;
  try {
    adapter = createAdapter(loaded.instance, loaded.secret, uid);
  } catch (error) {
    const message = (error as Error).message || 'messaging adapter initialization failed';
    await registry.updateStatus(uid, instanceId, { kind: 'error', message, checkedAt: new Date().toISOString() });
    throw new Error(`messaging adapter initialization failed: ${message}`);
  }

  let runtime: RuntimeInstance;
  runtime = new RuntimeInstance({
    uid,
    instanceId,
    instance: loaded.instance,
    adapter,
    isCurrent: () => runtimes.get(uid)?.get(instanceId) === runtime,
  });
  const callbacks: AdapterCallbacks = {
    onInbound: async (envelope) => {
      if (!isCurrentRuntime(uid, runtime)) return { accepted: false, duplicate: false, reason: 'instance_not_found' };
      return enqueueInbound(uid, envelope);
    },
    resolveDelivery: async (deliveryId) => ledger.getDeliveryByExternalId(uid, instanceId, deliveryId),
    onStatus: async (nextStatus) => {
      log.info('messaging adapter status change', { instanceId, kind: nextStatus.kind, message: nextStatus.message || '' });
      queueRuntimeStatus(uid, runtime, nextStatus);
    },
    onCardAction: async (action) => handleCardAction(uid, action),
  };

  map.set(instanceId, runtime);
  queueRuntimeStatus(uid, runtime, { kind: 'connecting', checkedAt: new Date().toISOString() });
  runtime.started = Promise.resolve()
    .then(() => adapter.start(runtime.controller.signal, callbacks))
    .catch(async (error) => {
      if (!isCurrentRuntime(uid, runtime)) return;
      const message = (error as Error).message || 'messaging adapter stopped unexpectedly';
      queueRuntimeStatus(uid, runtime, { kind: 'error', message, checkedAt: new Date().toISOString() });
      await runtime.statusWrite;
      log.warn('messaging runtime stopped unexpectedly', { instanceId, error: message });
    })
    .finally(async () => {
      log.info('messaging runtime lifecycle ended', { instanceId, wasCurrent: runtimes.get(uid)?.get(instanceId) === runtime });
      await runtime.statusWrite;
      if (runtimes.get(uid)?.get(instanceId) === runtime) {
        runtimes.get(uid)?.delete(instanceId);
        if (!runtimes.get(uid)?.size) runtimes.delete(uid);
        clearLiveStatus(uid, instanceId);
      }
    });

  try {
    const existingBindings = await bindings.listBindings(uid);
    for (const binding of existingBindings) {
      if (binding.instanceId === instanceId) await runtime.attachBindingListener(binding);
    }
    // Resume deliveries that were interrupted by a previous process restart.
    await runtime.recoverDeliveries();
  } catch (error) {
    log.warn('messaging binding listener restore failed', {
      instanceId,
      error: (error as Error).message,
    });
  }
}

async function stopRuntime(uid: string, instanceId: string): Promise<void> {
  const map = runtimes.get(uid);
  const runtime = map?.get(instanceId);
  if (!runtime) {
    clearLiveStatus(uid, instanceId);
    return;
  }
  runtime.active = false;
  map?.delete(instanceId);
  if (!map?.size) runtimes.delete(uid);
  runtime.disposeTimers();

  let stopFailure: Error | null = null;
  try {
    runtime.controller.abort();
    await runtime.adapter.stop();
  } catch (error) {
    stopFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const unsubscribe of runtime.listeners.values()) {
      try {
        unsubscribe();
      } catch (error) {
        log.warn('messaging binding listener cleanup failed', {
          instanceId,
          error: (error as Error).message,
        });
      }
    }
    runtime.listeners.clear();
    try {
      await runtime.waitForOutboundDeliveries();
      await runtime.started;
      await runtime.statusWrite;
    } finally {
      clearLiveStatus(uid, instanceId);
    }
  }
  if (stopFailure) throw new Error(`messaging adapter stop failed: ${stopFailure.message}`);
}

async function startInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, () => startRuntime(uid, instanceId));
}

export async function stopInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, () => stopRuntime(uid, instanceId));
}

function sameWorkspace(left: WorkspaceScope, right: WorkspaceScope): boolean {
  return left.type === right.type && left.projectId === right.projectId;
}

async function assertWorkspaceAvailable(uid: string, workspace: WorkspaceScope | undefined): Promise<void> {
  if (!workspace || workspace.type === 'default') return;
  if (!workspace.projectId || !safeId(workspace.projectId) || !await projects.projectExists(uid, workspace.projectId)) {
    throw new Error('messaging workspace project not found');
  }
}

async function existingClient(uid: string, instanceId: string): Promise<MessagingInstanceClient> {
  const instance = (await registry.listInstances(uid)).find((item) => item.id === instanceId);
  if (!instance) throw new Error('messaging instance not found');
  return withLiveStatus(uid, instance);
}

export async function createInstance(uid: string, input: registry.CreateMessagingInstanceInput): Promise<MessagingInstanceClient> {
  assertUserId(uid);
  await assertWorkspaceAvailable(uid, input.workspace);
  return registry.createInstance(uid, input);
}

export async function startForUser(uid: string): Promise<void> {
  assertUserId(uid);
  const instances = await registry.listInstances(uid);
  await Promise.all(instances.filter((instance) => instance.enabled).map((instance) => startInstance(uid, instance.id).catch((error) => {
    log.warn('messaging instance start failed', { instanceId: instance.id, error: (error as Error).message });
  })));
}

export async function stopForUser(uid: string): Promise<void> {
  assertUserId(uid);
  const instanceIds = Array.from(runtimes.get(uid)?.keys() || []);
  await Promise.all(instanceIds.map((instanceId) => stopInstance(uid, instanceId)));
  runtimes.delete(uid);
  liveStatuses.delete(uid);
}

export async function restartInstance(uid: string, instanceId: string): Promise<void> {
  await withLifecycle(uid, instanceId, async () => {
    const instance = await registry.getInstance(uid, instanceId);
    if (!instance) throw new Error('messaging instance not found');
    if (!(await registry.getInstanceWithSecret(uid, instanceId))) {
      throw new Error('messaging credentials required before restarting');
    }
    await stopRuntime(uid, instanceId);
    await startRuntime(uid, instanceId);
  });
}

export async function updateInstance(
  uid: string,
  instanceId: string,
  input: registry.UpdateMessagingInstanceInput,
): Promise<MessagingInstanceClient> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (!current) throw new Error('messaging instance not found');
    await assertWorkspaceAvailable(uid, input.workspace);
    const nextEnabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
    const existingCredentials = await registry.getInstanceWithSecret(uid, instanceId);
    const willHaveCredentials = !input.clearSecret && (input.secret !== undefined || !!existingCredentials);
    if (nextEnabled && !willHaveCredentials) {
      throw new Error('messaging credentials required before enabling');
    }
    const workspaceChanged = !!input.workspace && !sameWorkspace(current.workspace, input.workspace);
    if (workspaceChanged) await bindings.removeBindingsForInstance(uid, instanceId);

    const updated = await registry.updateInstance(uid, instanceId, input);
    // A Feishu bot that just got credentials or was just enabled, without an
    // owner yet, opens the auto-binding window: the first direct message
    // claims the sender as the owner (renderer shows the hint).
    if (updated.platform === 'feishu_lark' && !updated.ownerConfigured
      && (input.secret !== undefined || (typeof input.enabled === 'boolean' && input.enabled))) {
      openOwnerBindingWindow(uid, instanceId);
    }
    if (!nextEnabled) {
      if (current.enabled) {
        await ledger.cancelRecoverableDeliveriesForInstance(uid, instanceId, 'messaging instance disabled');
        try {
          await stopRuntime(uid, instanceId);
        } finally {
          await registry.updateStatus(uid, instanceId, { kind: 'disabled', checkedAt: new Date().toISOString() });
        }
        return { ...updated, status: { kind: 'disabled', checkedAt: new Date().toISOString() } };
      }
      return withLiveStatus(uid, updated);
    }
    if (current.enabled) await stopRuntime(uid, instanceId);
    await startRuntime(uid, instanceId);
    return existingClient(uid, instanceId);
  });
}

export async function setEnabled(uid: string, instanceId: string, enabled: boolean): Promise<MessagingInstanceClient> {
  if (typeof enabled !== 'boolean') throw new Error('invalid enabled value');
  return updateInstance(uid, instanceId, { enabled });
}

export async function unbindInstance(uid: string, instanceId: string): Promise<MessagingInstanceClient> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (!current) throw new Error('messaging instance not found');
    await ledger.cancelRecoverableDeliveriesForInstance(uid, instanceId, 'messaging instance unbound');
    const client = await registry.updateInstance(uid, instanceId, { enabled: false, clearSecret: true });
    try {
      await stopRuntime(uid, instanceId);
    } finally {
      await registry.updateStatus(uid, instanceId, {
        kind: 'disconnected',
        checkedAt: new Date().toISOString(),
        message: 'credentials removed',
      });
    }
    return {
      ...client,
      status: { kind: 'disconnected', checkedAt: new Date().toISOString(), message: 'credentials removed' },
    };
  });
}

export async function deleteInstance(uid: string, instanceId: string): Promise<boolean> {
  return withLifecycle(uid, instanceId, async () => {
    const current = await registry.getInstance(uid, instanceId);
    if (current?.enabled) await registry.updateInstance(uid, instanceId, { enabled: false });
    await ledger.cancelRecoverableDeliveriesForInstance(uid, instanceId, 'messaging instance deleted');
    try {
      await stopRuntime(uid, instanceId);
    } catch (error) {
      log.warn('messaging instance stopped with cleanup error during deletion', {
        instanceId,
        error: (error as Error).message,
      });
    }

    const results = await Promise.allSettled([
      bindings.removeBindingsForInstance(uid, instanceId),
      ledger.removeEntriesForInstance(uid, instanceId),
      registry.deleteInstance(uid, instanceId),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length) throw new Error(`messaging instance cleanup incomplete: ${failures.join('; ')}`);
    clearLiveStatus(uid, instanceId);
    return true;
  });
}

export async function listInstances(uid: string): Promise<MessagingInstanceClient[]> {
  assertUserId(uid);
  const instances = await registry.listInstances(uid);
  return instances.map((instance) => withLiveStatus(uid, instance));
}

/** Live connection status for one instance, or null when no runtime is
 * registered. Disk state is deliberately degraded (`registry.normalizeStatus`
 * never persists `connected`), so proactive senders must check the live
 * status here instead of the persisted one — reading the file shows a
 * connected instance as disconnected. */
export async function getLiveInstanceStatus(
  uid: string,
  instanceId: string,
): Promise<MessagingInstanceStatus | null> {
  assertUserId(uid);
  const runtime = runtimes.get(uid)?.get(instanceId);
  const live = runtime && runtime.active ? liveStatuses.get(uid)?.get(instanceId) : undefined;
  return live ? cloneStatus(live) : null;
}

export async function health(uid: string, instanceId: string): Promise<MessagingInstanceStatus> {
  return withLifecycle(uid, instanceId, async () => {
    const loaded = await registry.getInstanceWithSecret(uid, instanceId);
    if (!loaded) throw new Error('messaging credentials required before checking connection');
    const runtime = runtimes.get(uid)?.get(instanceId);
    const result = runtime && isCurrentRuntime(uid, runtime)
      ? await runtime.adapter.checkHealth()
      : await createAdapter(loaded.instance, loaded.secret, uid).checkHealth();
    if (runtime && isCurrentRuntime(uid, runtime)) {
      queueRuntimeStatus(uid, runtime, result);
      await runtime.statusWrite;
    } else {
      await registry.updateStatus(uid, instanceId, result);
    }
    return cloneStatus(result);
  });
}

export async function ingestInbound(uid: string, envelope: InboundEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid inbound envelope');
  if (!envelope.instanceId || !envelope.externalMessageId || !envelope.externalChatId || !envelope.externalUserId || !envelope.text) {
    throw new Error('inbound envelope missing required fields');
  }
  return handleInbound(uid, envelope);
}

export async function ingestCardAction(uid: string, action: CardActionEnvelope): Promise<MessagingInboundResult> {
  assertUserId(uid);
  return handleCardAction(uid, action);
}

/** Send an interactive approval card through a running instance. The wake
 * bridge (or any future caller) uses this to surface approvals on Feishu. */
export async function sendApprovalCard(
  uid: string,
  instanceId: string,
  chatId: string,
  approval: {
    wakeId: string;
    title: string;
    description: string;
    allowSession?: boolean;
    allowPermanent?: boolean;
    replyToMessageId?: string;
  },
): Promise<{ deliveryId?: string }> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  const runtime = runtimes.get(uid)?.get(instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) throw new Error('messaging instance is not running');
  if (!isCardAdapter(runtime.adapter) || !runtime.adapter.sendApprovalCard) {
    throw new Error('approval cards are not supported by this instance');
  }
  return runtime.adapter.sendApprovalCard(chatId, approval, runtime.controller.signal);
}

/**
 * 通用交互卡片投递（候选确认等 personal_context 场景）。
 * 只接受结构化 card 对象 + chatId；调用方均为主进程内部模块，
 * 卡片内容由构造方（features/personal_context）负责，不接收用户直通内容。
 */
export async function sendInteractiveCard(
  uid: string,
  instanceId: string,
  chatId: string,
  card: Record<string, JsonCompatibleValue>,
): Promise<{ deliveryId?: string }> {
  assertUserId(uid);
  assertInstanceId(instanceId);
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.length > 512) throw new Error('invalid chat id');
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('invalid card payload');
  const runtime = runtimes.get(uid)?.get(instanceId);
  if (!runtime || !isCurrentRuntime(uid, runtime)) throw new Error('messaging instance is not running');
  if (!isCardAdapter(runtime.adapter) || !runtime.adapter.sendCard) {
    throw new Error('interactive cards are not supported by this instance');
  }
  return runtime.adapter.sendCard(chatId, card, runtime.controller.signal);
}

export const _managerTestHooks = {
  runtimeMap,
  handleInbound,
  handleCardAction,
  buildResolvedApprovalCard,
  stopInstance,
  liveStatuses,
  enqueueInbound,
  setBroadcastOverride: (fn: ((channel: string, payload: unknown) => void) | null): void => {
    broadcastOverride = fn;
  },
};
