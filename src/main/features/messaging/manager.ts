import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import * as groupChat from '../group_chat';
import { subscribe, type GroupEvent } from '../group_chat/bus';
import type { GroupMessage, WakeRequestSummary } from '../group_chat/visibility';
import * as projects from '../projects';
import * as wakeService from '../p3394/wake-service';
import * as registry from './registry';
import * as bindings from './bindings';
import * as ledger from './ledger';
import { evaluateInboundPolicy, stripBotMention } from './policy';
import { createAdapter } from './adapters';
import type {
  AdapterCallbacks,
  CardActionEnvelope,
  DeliveryLedgerEntry,
  InboundEnvelope,
  JsonCompatibleValue,
  MessagingAdapter,
  MessagingCardAdapter,
  MessagingInboundResult,
  MessagingInstance,
  MessagingInstanceClient,
  MessagingInstanceStatus,
  MessagingBinding,
  MessagingPlatformCatalogEntry,
  WorkspaceScope,
} from './types';

const log = createLogger('messaging:manager');

/** Initial attempt plus two bounded retries. The timer is owned by the
 * connector runtime and survives neither disable nor unbind, while the
 * persisted ledger survives a normal app shutdown for startup recovery. */
export const OUTBOUND_MAX_ATTEMPTS = 3;
export const OUTBOUND_RETRY_DELAYS_MS = [1_000, 5_000] as const;
const MAX_RETRY_TIMER_DELAY_MS = 2_147_000_000;
/** Debounce window for streaming-card updates. Process deltas arrive faster
 * than Feishu can accept card patches; flushing on a short timer keeps the
 * card interactive without flooding the API. */
const CARD_FLUSH_DELAY_MS = 400;
const CARD_MAX_TEXT_LENGTH = 12_000;
/** Per-turn cap on rendered tool lines; older lines are dropped so a long
 * tool-heavy turn cannot blow the card payload. */
const MAX_TOOL_LINES = 20;
/** Tool chrome preview length (mirrors Hermes `_tool_preview_max_len`). */
const TOOL_PREVIEW_MAX_LEN = 40;
/** System confirmation for the `/new` session-reset command (mirrors Hermes'
 * `gateway.reset.header_default` banner). */
const NEW_SESSION_CONFIRMATION = '已开始新的对话。请告诉我接下来要处理什么。';

/** True when the inbound text is a session-reset slash command. */
function isNewSessionCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '/new' || trimmed.startsWith('/new ')
    || trimmed === '/reset' || trimmed.startsWith('/reset ');
}

/** Display emoji per tool (mirrors Hermes' tool registry `emoji` fields). */
const TOOL_EMOJI: Record<string, string> = {
  web_search: '🔍',
  web_extract: '📄',
  read_file: '📖',
  write_file: '✍️',
  search_files: '🔎',
  terminal: '🖥️',
  run_command: '🖥️',
  process: '⚙️',
  vision_analyze: '👁️',
  analyze_image: '👁️',
  browser_navigate: '🌐',
  browser_click: '👆',
  browser_type: '⌨️',
  image_generate: '🎨',
  execute_code: '💻',
  delegate_task: '🎯',
};
const DEFAULT_TOOL_EMOJI = '⚙️';

/** Primary argument used for the one-line preview per tool (mirrors Hermes
 * `build_tool_preview`'s `primary_args` table). */
const TOOL_PREVIEW_PRIMARY_ARG: Record<string, string> = {
  web_search: 'query',
  web_extract: 'urls',
  read_file: 'path',
  write_file: 'path',
  patch: 'path',
  search_files: 'pattern',
  terminal: 'command',
  run_command: 'command',
  vision_analyze: 'question',
  analyze_image: 'question',
  browser_navigate: 'url',
  browser_click: 'ref',
  browser_type: 'text',
  image_generate: 'prompt',
  execute_code: 'code',
  delegate_task: 'goal',
  process: 'action',
};

function toolPreviewText(name: string, args: Record<string, unknown>): string {
  const key = TOOL_PREVIEW_PRIMARY_ARG[name];
  const raw = key ? args[key] : undefined;
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? args);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > TOOL_PREVIEW_MAX_LEN) return `${text.slice(0, TOOL_PREVIEW_MAX_LEN)}…`;
  return text;
}

/** Render one tool-call chrome line, e.g. `🔍 web_search: "site:openai.com …"`
 * (mirrors Hermes `format_tool_event`). */
function renderToolLine(name: string, args: Record<string, unknown>): string {
  const emoji = TOOL_EMOJI[name] || DEFAULT_TOOL_EMOJI;
  return `${emoji} ${name}: "${toolPreviewText(name, args)}"`;
}

/** Extract tool-call lines from a process event. Returns [] for non-tool
 * events. The bus tool shape is `{ type: 'event', event: { stream: 'tool',
 * data: { phase, name, arguments } } }`. */
function toolLinesFromProcessEvent(event: Extract<GroupEvent, { type: 'process' }>): string[] {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  if (data.type !== 'event') return [];
  const inner = data.event && typeof data.event === 'object' ? data.event as Record<string, unknown> : {};
  if (inner.stream !== 'tool') return [];
  const toolData = inner.data && typeof inner.data === 'object' ? inner.data as Record<string, unknown> : {};
  if (toolData.phase !== 'start') return [];
  const name = typeof toolData.name === 'string' && toolData.name ? toolData.name : '';
  if (!name) return [];
  const args = toolData.arguments && typeof toolData.arguments === 'object'
    ? toolData.arguments as Record<string, unknown>
    : {};
  return [renderToolLine(name, args)];
}

/** Accumulate rendered tool lines for a turn (bounded to MAX_TOOL_LINES). */
function recordToolLines(runtime: RuntimeInstance, event: Extract<GroupEvent, { type: 'process' }>): void {
  const lines = toolLinesFromProcessEvent(event);
  if (!lines.length) return;
  const turnId = cardEventTurnId(event);
  if (!turnId) return;
  let perTurn = runtime.toolLinesByTurn.get(turnId);
  if (!perTurn) {
    perTurn = [];
    runtime.toolLinesByTurn.set(turnId, perTurn);
  }
  for (const line of lines) {
    if (perTurn.length >= MAX_TOOL_LINES) perTurn.shift();
    perTurn.push(line);
  }
}

/** Tool lines of a turn, bounded to the card display cap. */
function toolLinesForTurn(runtime: RuntimeInstance, turnId: string): string[] {
  const lines = runtime.toolLinesByTurn.get(turnId);
  if (!lines || !lines.length) return [];
  return lines.length > MAX_TOOL_LINES ? lines.slice(-MAX_TOOL_LINES) : lines;
}

/** Drop per-turn tool lines once the turn is finished. */
function clearToolLinesForTurn(runtime: RuntimeInstance, turnId: string): void {
  runtime.toolLinesByTurn.delete(turnId);
}

interface CardStreamState {
  messageId?: string;
  accumulated: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** A flush is in flight. Prevents the debounce from scheduling a second
   * concurrent flush while the first is awaiting the network — two parallel
   * flushes both see an empty `messageId` and each create their own card. */
  flushing: boolean;
}

interface RuntimeInstance {
  instanceId: string;
  instance: MessagingInstance;
  adapter: MessagingAdapter;
  controller: AbortController;
  started: Promise<void>;
  listeners: Map<string, () => void>;
  outboundDeliveries: Set<Promise<void>>;
  active: boolean;
  statusWrite: Promise<void>;
  bindingContexts: Map<string, MessagingBinding>;
  statusListeners: Set<(status: MessagingInstanceStatus) => void>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryScheduledAt: number | null;
  /** Streaming-card state keyed by `binding.key + turn_id`. */
  cardStates: Map<string, CardStreamState>;
  /** Rendered tool-call chrome lines keyed by turn_id, for both card and
   * plain-text reply paths. */
  toolLinesByTurn: Map<string, string[]>;
}

interface OutboundMessage {
  id?: string;
  from?: string;
  text?: string;
  dispatch?: boolean;
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
    description: '官方双向机器人能力不可用，暂不提供登录或扫码。',
    available: false,
    twoWay: false,
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
  setLiveStatus(uid, runtime.instanceId, snapshot);
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

function isMessageEvent(event: GroupEvent): event is Extract<GroupEvent, { type: 'message' }> {
  return event.type === 'message';
}

function messageFromEvent(event: Extract<GroupEvent, { type: 'message' }>): OutboundMessage {
  const message: GroupMessage = event.msg;
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ...(message.dispatch ? { dispatch: true } : {}),
  };
}

function deliveryContext(entry: { replyToMessageId?: string; threadId?: string; replyInThread?: boolean; idempotencyKey?: string }) {
  return {
    ...(entry.replyToMessageId ? { replyToMessageId: entry.replyToMessageId } : {}),
    ...(entry.threadId ? { threadId: entry.threadId } : {}),
    ...(entry.replyInThread ? { replyInThread: true } : {}),
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
  };
}

function beginDeliveryEntry(
  instanceId: string,
  binding: { externalChatId: string; replyToMessageId?: string; threadId?: string; replyInThread?: boolean },
  message: OutboundMessage,
  text: string,
  idempotencyKey?: string,
) {
  const key = ledger.deliveryKey(instanceId, message.id as string);
  return {
    key,
    instanceId,
    externalChatId: binding.externalChatId,
    sourceMessageId: message.id as string,
    textHash: ledger.textHash(text),
    text,
    ...(binding.replyToMessageId ? { replyToMessageId: binding.replyToMessageId } : {}),
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.replyInThread ? { replyInThread: true } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function attemptDelivery(
  uid: string,
  runtime: RuntimeInstance,
  key: string,
  entry: DeliveryLedgerEntry,
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime)) return;
  try {
    const receipt = await runtime.adapter.sendMessage(
      entry.externalChatId,
      entry.text || '',
      runtime.controller.signal,
      deliveryContext(entry),
    );
    await ledger.finishDelivery(uid, key, {
      status: 'sent',
      ...(receipt.deliveryId ? { externalDeliveryId: receipt.deliveryId } : {}),
    });
  } catch (error) {
    if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
      await ledger.finishDelivery(uid, key, {
        status: 'cancelled',
        error: 'delivery cancelled because messaging instance stopped',
      });
      return;
    }
    const messageText = (error as Error).message || 'delivery failed';
    await scheduleRetry(uid, runtime, key, messageText);
  }
}

async function scheduleRetry(uid: string, runtime: RuntimeInstance, key: string, messageText: string): Promise<void> {
  const entry = await ledger.getDelivery(uid, key);
  if (!entry) return;
  if (entry.attempts >= OUTBOUND_MAX_ATTEMPTS) {
    await ledger.finishDelivery(uid, key, { status: 'failed', error: messageText });
    log.warn('messaging delivery failed after retries', {
      instanceId: runtime.instanceId,
      key,
      attempts: entry.attempts,
      error: messageText,
    });
    return;
  }
  const delayMs = OUTBOUND_RETRY_DELAYS_MS[Math.min(entry.attempts - 1, OUTBOUND_RETRY_DELAYS_MS.length - 1)];
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  await ledger.finishDelivery(uid, key, { status: 'retry_pending', error: messageText, nextAttemptAt });
  await scheduleRetryTimer(uid, runtime);
}

async function retryDelayMs(uid: string, instanceId: string): Promise<number | null> {
  const nextAt = await ledger.nextRecoverableDeliveryAt(uid, instanceId);
  if (nextAt === null) return null;
  return Math.max(0, Math.min(nextAt - Date.now(), MAX_RETRY_TIMER_DELAY_MS));
}

async function scheduleRetryTimer(uid: string, runtime: RuntimeInstance): Promise<void> {
  if (runtime.retryTimer !== null) return;
  const delay = await retryDelayMs(uid, runtime.instanceId);
  if (delay === null) return;
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null;
    runtime.retryScheduledAt = null;
    void recoverDeliveries(uid, runtime);
  }, delay);
  runtime.retryScheduledAt = Date.now() + delay;
}

function clearRetryTimer(runtime: RuntimeInstance): void {
  if (runtime.retryTimer !== null) {
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.retryScheduledAt = null;
  }
}

async function recoverDeliveries(uid: string, runtime: RuntimeInstance): Promise<void> {
  if (!isCurrentRuntime(uid, runtime)) return;
  const due = await ledger.listRecoverableDeliveries(uid, runtime.instanceId);
  for (const entry of due) {
    if (!isCurrentRuntime(uid, runtime)) return;
    const begun = await ledger.beginDelivery(uid, beginDeliveryEntry(runtime.instanceId, entry, { id: entry.sourceMessageId, text: entry.text || '' }, entry.text || '', entry.idempotencyKey));
    if (begun.duplicate) continue;
    await attemptDelivery(uid, runtime, entry.key, begun.entry);
  }
  await scheduleRetryTimer(uid, runtime);
}

/** Send the session-reset confirmation through the same ledger-backed path
 * as ordinary replies, keyed on the inbound command message. */
async function deliverConfirmationMessage(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: MessagingBinding,
  envelope: InboundEnvelope,
): Promise<void> {
  const text = NEW_SESSION_CONFIRMATION;
  const key = ledger.deliveryKey(instance.id, envelope.externalMessageId);
  const begun = await ledger.beginDelivery(
    uid,
    beginDeliveryEntry(instance.id, binding, { id: envelope.externalMessageId, text }, text),
  );
  if (begun.duplicate) return;
  await attemptDelivery(uid, runtime, key, begun.entry);
}

async function deliverGroupMessage(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: MessagingBinding,
  message: OutboundMessage,
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime)) return;
  const sourceMessageId = typeof message.id === 'string' && message.id ? message.id : '';
  const text = typeof message.text === 'string' ? message.text.trim().slice(0, 12_000) : '';
  if (!sourceMessageId || !text || message.dispatch || message.from === 'user') return;
  const key = ledger.deliveryKey(instance.id, sourceMessageId);
  const begun = await ledger.beginDelivery(uid, beginDeliveryEntry(instance.id, binding, message, text));
  if (begun.duplicate) return;
  if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
    await ledger.finishDelivery(uid, key, {
      status: 'cancelled',
      error: 'delivery cancelled because messaging instance stopped',
    });
    return;
  }
  await attemptDelivery(uid, runtime, key, begun.entry);
}

function trackOutboundDelivery(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: MessagingBinding,
  message: OutboundMessage,
): void {
  const delivery = deliverGroupMessage(uid, runtime, instance, binding, message);
  runtime.outboundDeliveries.add(delivery);
  void delivery.then(
    () => {
      runtime.outboundDeliveries.delete(delivery);
    },
    (error) => {
      runtime.outboundDeliveries.delete(delivery);
      log.warn('messaging delivery callback failed', {
        instanceId: instance.id,
        error: (error as Error).message,
      });
    },
  );
}

async function waitForOutboundDeliveries(runtime: RuntimeInstance): Promise<void> {
  // Listeners are removed before this wait starts, but loop defensively in
  // case a callback that was already queued registers its delivery first.
  while (runtime.outboundDeliveries.size) {
    await Promise.allSettled(Array.from(runtime.outboundDeliveries));
  }
}

async function attachBindingListener(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: MessagingBinding,
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime) || runtime.listeners.has(binding.key)) return;
  const streamingEnabled = instance.responseMode === 'streaming_card' && isCardAdapter(runtime.adapter);
  log.info('messaging binding listener attached', { instanceId: instance.id, key: binding.key, cid: binding.cid, streamingEnabled });
  const unsubscribe = subscribe(uid, binding.cid, (event: GroupEvent) => {
    if (!isCurrentRuntime(uid, runtime)) {
      log.info('messaging bus event dropped: runtime no longer current', {
        instanceId: instance.id,
        key: binding.key,
        eventType: event.type,
      });
      return;
    }
    // The listener closure holds the binding snapshot from attach time; the
    // live binding (fresh replyToMessageId etc.) lives in bindingContexts and
    // is refreshed on every inbound message. Always send against the latest
    // so replies reference the message they actually answer.
    const currentBinding = runtime.bindingContexts.get(binding.key) || binding;
    if (event.type === 'wake_request') {
      // A pending agent wake inside this bound conversation surfaces as an
      // interactive approval card in the same Feishu chat.
      if (event.request.status === 'pending') {
        void sendWakeApprovalCard(runtime, currentBinding, event.request).catch((error) => {
          log.warn('messaging wake approval card send failed', {
            instanceId: instance.id,
            error: (error as Error).message,
          });
        });
      }
      return;
    }
    if (event.type === 'process') {
      // Tool chrome is collected for every response mode; the card path
      // renders it live while the plain-text path merges it at turn end.
      recordToolLines(runtime, event);
      if (streamingEnabled) handleCardProcessEvent(uid, runtime, currentBinding, event);
      return;
    }
    if (event.type === 'turn_silent') {
      if (streamingEnabled) handleCardTurnSilent(runtime, currentBinding, event);
      return;
    }
    if (!isMessageEvent(event) || event.turn_end !== true) return;
    log.info('messaging bus turn-end message event', {
      instanceId: instance.id,
      key: binding.key,
      msgId: event.msg?.id,
      textLen: typeof event.msg?.text === 'string' ? event.msg.text.length : 0,
    });
    void handleTurnEndMessage(uid, runtime, instance, currentBinding, event).catch((error) => {
      log.warn('messaging turn-end delivery failed', {
        instanceId: instance.id,
        error: (error as Error).message,
      });
    });
  });
  runtime.listeners.set(binding.key, unsubscribe);
}

/** Bridge a pending wake request into an interactive approval card on the
 * bound Feishu chat. Buttons route back through ingestCardAction → the wake
 * gate; the card is finalized by handleCardAction after the decision. */
async function sendWakeApprovalCard(
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  request: WakeRequestSummary,
): Promise<void> {
  const adapter = runtime.adapter;
  if (!isCardAdapter(adapter) || !adapter.sendApprovalCard) return;
  const agentLabel = request.agent_name || request.agent_id;
  await adapter.sendApprovalCard(binding.externalChatId, {
    wakeId: request.id,
    title: `需要你的审批：${agentLabel}`,
    description: request.objective.slice(0, 1500),
    allowSession: true,
    allowPermanent: false,
  });
}

function isCardAdapter(adapter: MessagingAdapter): adapter is MessagingCardAdapter {
  return typeof (adapter as MessagingCardAdapter).sendCard === 'function'
    && typeof (adapter as MessagingCardAdapter).updateCard === 'function';
}

function cardStateKey(bindingKey: string, turnId: string): string {
  return `${bindingKey}\u0000${turnId}`;
}

function cardEventTurnId(event: { turn_id?: string }): string {
  return typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : '';
}

function buildStreamCard(title: string, toolLines: string[], text: string): Record<string, JsonCompatibleValue> {
  const elements: Array<Record<string, JsonCompatibleValue>> = [];
  if (toolLines.length) {
    // Tool chrome in inline-code style so each call reads as a monospaced
    // chip, mirroring Hermes' progress bubbles on Feishu.
    elements.push({ tag: 'markdown', content: toolLines.map((line) => `\`${line}\``).join('\n') });
    elements.push({ tag: 'hr' });
  }
  elements.push({ tag: 'markdown', content: text || '…' });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title.slice(0, 120) },
    },
    elements,
  };
}

function clearCardTimer(state: CardStreamState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function flushCardUpdate(
  uid: string,
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  key: string,
  state: CardStreamState,
): Promise<void> {
  if (state.flushing) return;
  const turnId = key.split('\u0000')[1] || '';
  const flushedToolCount = toolLinesForTurn(runtime, turnId).length;
  if (!isCurrentRuntime(uid, runtime) || (!state.accumulated && flushedToolCount === 0)) return;
  state.flushing = true;
  const flushedLen = state.accumulated.length;
  try {
    const adapter = runtime.adapter;
    if (!isCardAdapter(adapter)) return;
    const toolLines = toolLinesForTurn(runtime, turnId);
    const card = buildStreamCard(runtime.instance.displayName, toolLines, state.accumulated);
    if (state.messageId) {
      await adapter.updateCard(state.messageId, card, runtime.controller.signal);
    } else {
      const receipt = await adapter.sendCard(binding.externalChatId, card, runtime.controller.signal, deliveryContext(binding));
      state.messageId = receipt.deliveryId;
      log.info('messaging streaming card created', {
        instanceId: runtime.instanceId,
        turnId: key.split('\u0000')[1] || '',
        deliveryId: receipt.deliveryId || '',
        textLen: state.accumulated.length,
      });
    }
  } catch (error) {
    if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) return;
    log.warn('messaging streaming card delivery failed', {
      instanceId: runtime.instanceId,
      hadMessageId: !!state.messageId,
      error: (error as Error).message,
    });
    clearCardTimer(state);
    runtime.cardStates.delete(key);
  } finally {
    state.flushing = false;
    // Deltas or tool lines that arrived while this flush was awaiting the
    // network were only accumulated (the debounce saw `flushing` and skipped
    // scheduling). Trail one more flush so the latest content still reaches
    // the card.
    if (isCurrentRuntime(uid, runtime)
      && (state.accumulated.length > flushedLen || toolLinesForTurn(runtime, turnId).length > flushedToolCount)) {
      scheduleCardFlush(uid, runtime, binding, key, state);
    }
  }
}

function scheduleCardFlush(
  uid: string,
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  key: string,
  state: CardStreamState,
): void {
  if (state.timer !== null || state.flushing) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushCardUpdate(uid, runtime, binding, key, state);
  }, CARD_FLUSH_DELAY_MS);
}

function handleCardProcessEvent(
  uid: string,
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  event: Extract<GroupEvent, { type: 'process' }>,
): void {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const isDelta = data.type === 'delta' && typeof data.text === 'string';
  if (!isDelta && !toolLinesFromProcessEvent(event).length) return;
  const turnId = cardEventTurnId(event);
  if (!turnId) return;
  const key = cardStateKey(binding.key, turnId);
  let state = runtime.cardStates.get(key);
  if (!state) {
    state = { accumulated: '', timer: null, flushing: false };
    runtime.cardStates.set(key, state);
    log.info('messaging streaming card state created', {
      instanceId: runtime.instanceId,
      turnId,
      cardStates: runtime.cardStates.size,
      keys: [...runtime.cardStates.keys()].map((k) => k.split('\u0000')[1] || ''),
    });
  }
  if (isDelta) {
    state.accumulated = (state.accumulated + data.text).slice(0, CARD_MAX_TEXT_LENGTH);
  }
  scheduleCardFlush(uid, runtime, binding, key, state);
}

async function finalizeCardForTurnEnd(
  uid: string,
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  event: Extract<GroupEvent, { type: 'message' }>,
): Promise<boolean> {
  const turnId = cardEventTurnId(event);
  if (!turnId) return false;
  const key = cardStateKey(binding.key, turnId);
  const state = runtime.cardStates.get(key);
  log.info('messaging streaming card finalize', {
    instanceId: runtime.instanceId,
    key,
    turnId,
    statePresent: !!state,
    cardStates: runtime.cardStates.size,
  });
  if (!state) return false;
  clearCardTimer(state);
  const message = messageFromEvent(event);
  const finalText = typeof message.text === 'string' && message.text.trim()
    ? message.text.trim().slice(0, CARD_MAX_TEXT_LENGTH)
    : state.accumulated;
  log.info('messaging streaming card finalize text', {
    instanceId: runtime.instanceId,
    messageId: state.messageId || '',
    finalTextLen: finalText.length,
    accumulatedLen: state.accumulated.length,
  });
  if (state.messageId && finalText) {
    const adapter = runtime.adapter;
    if (isCardAdapter(adapter)) {
      try {
        await adapter.updateCard(
          state.messageId,
          buildStreamCard(runtime.instance.displayName, toolLinesForTurn(runtime, turnId), finalText),
          runtime.controller.signal,
        );
        log.info('messaging streaming card finalized ok', {
          instanceId: runtime.instanceId,
          messageId: state.messageId,
        });
      } catch (error) {
        if (!isCurrentRuntime(uid, runtime) || runtime.controller.signal.aborted) {
          runtime.cardStates.delete(key);
          return true;
        }
        log.warn('messaging streaming card finalize failed', {
          instanceId: runtime.instanceId,
          error: (error as Error).message,
        });
        runtime.cardStates.delete(key);
        // Fall through to the plain-text delivery path so the answer still arrives.
        return false;
      }
    }
  }
  runtime.cardStates.delete(key);
  clearToolLinesForTurn(runtime, turnId);
  return true;
}

function handleCardTurnSilent(
  runtime: RuntimeInstance,
  binding: MessagingBinding,
  event: Extract<GroupEvent, { type: 'turn_silent' }>,
): void {
  const turnId = cardEventTurnId(event);
  if (!turnId) return;
  const key = cardStateKey(binding.key, turnId);
  const state = runtime.cardStates.get(key);
  if (!state) return;
  clearCardTimer(state);
  // An already-sent card keeps its accumulated content; a silent turn only
  // stops further updates. Unsent drafts are dropped without creating a card.
  runtime.cardStates.delete(key);
  clearToolLinesForTurn(runtime, turnId);
}

async function handleTurnEndMessage(
  uid: string,
  runtime: RuntimeInstance,
  instance: MessagingInstance,
  binding: MessagingBinding,
  event: Extract<GroupEvent, { type: 'message' }>,
): Promise<void> {
  if (!isCurrentRuntime(uid, runtime)) return;
  const turnId = cardEventTurnId(event);
  const message = messageFromEvent(event);
  log.info('messaging turn-end handling', {
    instanceId: instance.id,
    key: binding.key,
    responseMode: instance.responseMode,
    cardAdapter: isCardAdapter(runtime.adapter),
    turnId,
    cardStateCount: runtime.cardStates.size,
  });
  if (instance.responseMode === 'streaming_card' && isCardAdapter(runtime.adapter)) {
    if (await finalizeCardForTurnEnd(uid, runtime, binding, event)) return;
    log.info('messaging turn-end card finalize skipped, falling back to text delivery', {
      instanceId: instance.id,
      key: binding.key,
      turnId,
    });
  }
  // Plain-text path: merge the turn's tool chrome into the reply so the tool
  // trail stays visible without emitting a second message (mirrors Hermes'
  // progress bubbles, folded into the final post).
  const toolLines = turnId ? toolLinesForTurn(runtime, turnId) : [];
  if (toolLines.length && typeof message.text === 'string') {
    message.text = `${toolLines.map((line) => `\`${line}\``).join('\n')}\n\n---\n\n${message.text}`;
  }
  trackOutboundDelivery(uid, runtime, instance, binding, message);
  if (turnId) clearToolLinesForTurn(runtime, turnId);
}

/** Per-chat serialization for inbound dispatch (mirrors Hermes
 * `_handle_message_with_guards`): messages arriving from the same external
 * chat are processed one at a time so concurrent turns cannot interleave.
 * Bounded LRU; eviction skips locks that are currently held. */
const CHAT_LOCKS_MAX = 1000;
const chatLocks = new Map<string, Mutex>();

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
        await attachBindingListener(uid, runtime, instance, binding);
        await deliverConfirmationMessage(uid, runtime, instance, binding, envelope);
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
      await attachBindingListener(uid, runtime, instance, binding);
    }
    const result = await groupChat.send({ userId: uid, cid: binding.cid, text });
    if (!result.ok) throw new Error(result.error || 'group chat enqueue failed');
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

const APPROVAL_CHOICE_LABELS: Record<string, string> = {
  approve: '已允许',
  approve_once: '已允许一次',
  approve_session: '已允许本次会话',
  approve_always: '已总是允许',
  deny: '已拒绝',
};

/** Replaces a resolved approval card with a terminal state so the same
 * buttons cannot be clicked twice (mirrors Hermes' resolved card). */
function buildResolvedApprovalCard(choice: string, userName = ''): Record<string, JsonCompatibleValue> {
  const denied = choice === 'deny';
  const label = APPROVAL_CHOICE_LABELS[choice] || choice;
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

async function startRuntime(uid: string, instanceId: string): Promise<void> {
  const map = runtimeMap(uid);
  if (map.has(instanceId)) return;
  const loaded = await registry.getInstanceWithSecret(uid, instanceId);
  if (!loaded || !loaded.instance.enabled) {
    clearLiveStatus(uid, instanceId);
    return;
  }
  let adapter: MessagingAdapter;
  try {
    adapter = createAdapter(loaded.instance, loaded.secret);
  } catch (error) {
    const message = (error as Error).message || 'messaging adapter initialization failed';
    await registry.updateStatus(uid, instanceId, { kind: 'error', message, checkedAt: new Date().toISOString() });
    throw new Error(`messaging adapter initialization failed: ${message}`);
  }

  const runtime: RuntimeInstance = {
    instanceId,
    instance: loaded.instance,
    adapter,
    controller: new AbortController(),
    started: Promise.resolve(),
    listeners: new Map(),
    outboundDeliveries: new Set(),
    active: true,
    statusWrite: Promise.resolve(),
    bindingContexts: new Map(),
    statusListeners: new Set(),
    retryTimer: null,
    retryScheduledAt: null,
    cardStates: new Map(),
    toolLinesByTurn: new Map(),
  };
  const callbacks: AdapterCallbacks = {
    onInbound: async (envelope) => {
      if (!isCurrentRuntime(uid, runtime)) return { accepted: false, duplicate: false, reason: 'instance_not_found' };
      return handleInbound(uid, envelope);
    },
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
      if (binding.instanceId === instanceId) await attachBindingListener(uid, runtime, loaded.instance, binding);
    }
    // Resume deliveries that were interrupted by a previous process restart.
    await recoverDeliveries(uid, runtime);
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
  clearRetryTimer(runtime);
  for (const state of runtime.cardStates.values()) clearCardTimer(state);
  runtime.cardStates.clear();
  runtime.toolLinesByTurn.clear();

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
      await waitForOutboundDeliveries(runtime);
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

async function stopInstance(uid: string, instanceId: string): Promise<void> {
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

export async function health(uid: string, instanceId: string): Promise<MessagingInstanceStatus> {
  return withLifecycle(uid, instanceId, async () => {
    const loaded = await registry.getInstanceWithSecret(uid, instanceId);
    if (!loaded) throw new Error('messaging credentials required before checking connection');
    const runtime = runtimes.get(uid)?.get(instanceId);
    const result = runtime && isCurrentRuntime(uid, runtime)
      ? await runtime.adapter.checkHealth()
      : await createAdapter(loaded.instance, loaded.secret).checkHealth();
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

export const _managerTestHooks = {
  runtimeMap,
  handleInbound,
  handleCardAction,
  buildResolvedApprovalCard,
  stopInstance,
  liveStatuses,
  renderToolLine,
  toolLinesFromProcessEvent,
};
