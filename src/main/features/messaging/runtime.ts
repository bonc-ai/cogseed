/**
 * Per-instance messaging runtime: owns the adapter connection lifecycle
 * state, the bound-conversation bus listeners, the outbound delivery ledger
 * path (idempotent send + retry + restart recovery), and the Feishu
 * streaming-card state machine. The manager orchestrates runtimes (start/stop,
 * status broadcast, inbound policy) and keeps the global registries; this
 * class holds everything that is scoped to one running instance.
 */

import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { subscribe, type GroupEvent } from '../group_chat/bus';
import type { GroupMessage, WakeRequestSummary } from '../group_chat/visibility';
import * as ledger from './ledger';
import type {
  DeliveryLedgerEntry,
  InboundEnvelope,
  MessagingAdapter,
  MessagingBinding,
  MessagingInstance,
} from './types';
import { MAX_TOOL_LINES, toolLinesFromProcessEvent } from './tool-chrome';
import {
  CARD_FLUSH_DELAY_MS,
  CARD_MAX_TEXT_LENGTH,
  isCardAdapter,
  cardStateKey,
  cardEventTurnId,
  buildStreamCard,
} from './stream-card';

const log = createLogger('messaging:runtime');

export const OUTBOUND_MAX_ATTEMPTS = 3;
export const OUTBOUND_RETRY_DELAYS_MS = [1_000, 5_000] as const;
const MAX_RETRY_TIMER_DELAY_MS = 2_147_000_000;

interface CardStreamState {
  messageId?: string;
  accumulated: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** A flush is in flight. Prevents the debounce from scheduling a second
   * concurrent flush while the first is awaiting the network — two parallel
   * flushes both see an empty `messageId` and each create their own card. */
  flushing: boolean;
}

interface OutboundMessage {
  /** Stable per-message id used as the delivery idempotency key. All inbound
   * platforms normalize their native ids (Feishu `om_*`, iLink numeric ids)
   * to strings before this point, so the id is always present. */
  id: string;
  from?: string;
  text?: string;
  dispatch?: boolean;
}

export interface RuntimeOptions {
  uid: string;
  instanceId: string;
  instance: MessagingInstance;
  adapter: MessagingAdapter;
  /** Live check that this runtime is still the registered one for its
   * (uid, instanceId) pair. Injected by the manager so this class never
   * imports the manager (no circular dependency). */
  isCurrent: () => boolean;
}

export class RuntimeInstance {
  readonly uid: string;
  readonly instanceId: string;
  instance: MessagingInstance;
  readonly adapter: MessagingAdapter;
  readonly controller = new AbortController();
  started: Promise<void> = Promise.resolve();
  readonly listeners = new Map<string, () => void>();
  readonly outboundDeliveries = new Set<Promise<void>>();
  active = true;
  statusWrite: Promise<void> = Promise.resolve();
  readonly bindingContexts = new Map<string, MessagingBinding>();
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Streaming-card state keyed by `binding.key + turn_id`. */
  readonly cardStates = new Map<string, CardStreamState>();
  /** Rendered tool-call chrome lines keyed by turn_id, for both card and
   * plain-text reply paths. */
  readonly toolLinesByTurn = new Map<string, string[]>();
  /** Wechat-personal only: `contextTokenRef` captured per inbound at
   * processing time, keyed by the group-chat user message id the inbound
   * produced. The turn-end handler consumes the entry for the completing
   * turn (via the event's `source_msg_id`) so an interleaved later inbound
   * can never supply the token for an earlier turn's reply. */
  readonly turnSourceRefs = new Map<string, string>();
  private readonly isCurrent: () => boolean;

  constructor(options: RuntimeOptions) {
    this.uid = options.uid;
    this.instanceId = options.instanceId;
    this.instance = options.instance;
    this.adapter = options.adapter;
    this.isCurrent = options.isCurrent;
  }

  // ── Tool chrome ──────────────────────────────────────────────────────────

  /** Accumulate rendered tool lines for a turn (bounded to MAX_TOOL_LINES). */
  recordToolLines(event: Extract<GroupEvent, { type: 'process' }>): void {
    const lines = toolLinesFromProcessEvent(event);
    if (!lines.length) return;
    const turnId = cardEventTurnId(event);
    if (!turnId) return;
    let perTurn = this.toolLinesByTurn.get(turnId);
    if (!perTurn) {
      perTurn = [];
      this.toolLinesByTurn.set(turnId, perTurn);
    }
    for (const line of lines) {
      if (perTurn.length >= MAX_TOOL_LINES) perTurn.shift();
      perTurn.push(line);
    }
  }

  /** Tool lines of a turn, bounded to the card display cap. */
  toolLinesForTurn(turnId: string): string[] {
    const lines = this.toolLinesByTurn.get(turnId);
    if (!lines || !lines.length) return [];
    return lines.length > MAX_TOOL_LINES ? lines.slice(-MAX_TOOL_LINES) : lines;
  }

  /** Drop per-turn tool lines once the turn is finished. */
  clearToolLinesForTurn(turnId: string): void {
    this.toolLinesByTurn.delete(turnId);
  }

  // ── Context token references ─────────────────────────────────────────────

  /** Resolve the context token reference for one completing turn. The per-turn
   * capture (keyed by the user message id that triggered the turn) is
   * authoritative and is consumed on use; the binding's latest-inbound ref is
   * only a fallback for turns the manager cannot trace to an inbound (e.g.
   * nested agent turns carry their own synthetic source ids) and can never
   * override the per-turn capture. */
  resolveTurnContextTokenRef(
    turnSourceMsgId: string | undefined,
    binding: MessagingBinding,
  ): string | undefined {
    if (turnSourceMsgId) {
      const perTurn = this.turnSourceRefs.get(turnSourceMsgId);
      this.turnSourceRefs.delete(turnSourceMsgId);
      if (perTurn) return perTurn;
    }
    return binding.contextTokenRef;
  }

  // ── Outbound delivery ────────────────────────────────────────────────────

  /** One ledger-backed send attempt. Success finishes the delivery; failure
   * schedules a bounded retry, or a terminal `failed` when attempts are
   * exhausted. A stopped runtime cancels the delivery instead of retrying. */
  async attemptDelivery(key: string, entry: DeliveryLedgerEntry): Promise<void> {
    if (!this.isCurrent()) return;
    try {
      // Interactive-card sends (touchpoint intents) replay through sendCard;
      // file sends go through sendFile when the adapter supports it;
      // everything else stays on the plain-text path. Non-card/file adapters
      // fall back to text so an entry can never wedge a delivery.
      const receipt = entry.card && isCardAdapter(this.adapter)
        ? await this.adapter.sendCard(
          entry.recipientId,
          entry.card,
          this.controller.signal,
          deliveryContext(entry),
        )
        : entry.file && typeof this.adapter.sendFile === 'function'
          ? await this.adapter.sendFile(
            entry.recipientId,
            entry.file.path,
            entry.file.name,
            this.controller.signal,
            deliveryContext(entry),
          )
          : await this.adapter.sendMessage(
            entry.recipientId,
            entry.text || '',
            this.controller.signal,
            deliveryContext(entry),
          );
      await ledger.finishDelivery(this.uid, key, {
        status: 'sent',
        ...(receipt.deliveryId ? { externalDeliveryId: receipt.deliveryId } : {}),
      });
    } catch (error) {
      if (!this.isCurrent() || this.controller.signal.aborted) {
        await ledger.finishDelivery(this.uid, key, {
          status: 'cancelled',
          error: 'delivery cancelled because messaging instance stopped',
        });
        return;
      }
      const messageText = (error as Error).message || 'delivery failed';
      await this.scheduleRetry(key, messageText);
    }
  }

  private async scheduleRetry(key: string, messageText: string): Promise<void> {
    const entry = await ledger.getDelivery(this.uid, key);
    if (!entry) return;
    if (entry.attempts >= OUTBOUND_MAX_ATTEMPTS) {
      await ledger.finishDelivery(this.uid, key, { status: 'failed', error: messageText });
      log.warn('messaging delivery failed after retries', {
        instanceId: this.instanceId,
        key,
        attempts: entry.attempts,
        error: messageText,
      });
      return;
    }
    const delayMs = OUTBOUND_RETRY_DELAYS_MS[Math.min(entry.attempts - 1, OUTBOUND_RETRY_DELAYS_MS.length - 1)];
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    await ledger.finishDelivery(this.uid, key, { status: 'retry_pending', error: messageText, nextAttemptAt });
    await this.scheduleRetryTimer();
  }

  private async retryDelayMs(): Promise<number | null> {
    const nextAt = await ledger.nextRecoverableDeliveryAt(this.uid, this.instanceId);
    if (nextAt === null) return null;
    return Math.max(0, Math.min(nextAt - Date.now(), MAX_RETRY_TIMER_DELAY_MS));
  }

  private async scheduleRetryTimer(): Promise<void> {
    if (this.retryTimer !== null) return;
    const delay = await this.retryDelayMs();
    if (delay === null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.recoverDeliveries();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Resume deliveries that were interrupted by a previous process restart. */
  async recoverDeliveries(): Promise<void> {
    if (!this.isCurrent()) return;
    const due = await ledger.listRecoverableDeliveries(this.uid, this.instanceId);
    for (const entry of due) {
      if (!this.isCurrent()) return;
      const begun = await ledger.beginDelivery(this.uid, beginDeliveryEntry(this.instanceId, entry, { id: entry.sourceMessageId, text: entry.text || '' }, entry.text || '', entry.idempotencyKey, entry.contextTokenRef));
      if (begun.duplicate) continue;
      await this.attemptDelivery(entry.key, begun.entry);
    }
    await this.scheduleRetryTimer();
  }

  /** Deliver one agent reply through the ledger path. Dispatch/user messages
   * are not replies and are skipped. */
  private async deliverGroupMessage(
    binding: MessagingBinding,
    message: OutboundMessage,
    turnSourceMsgId?: string,
    turnP3394MessageId?: string,
  ): Promise<void> {
    if (!this.isCurrent()) return;
    const sourceMessageId = typeof message.id === 'string' && message.id ? message.id : '';
    const text = typeof message.text === 'string' ? message.text.trim().slice(0, 12_000) : '';
    if (!sourceMessageId || !text || message.dispatch || message.from === 'user') return;
    const key = ledger.deliveryKey(this.instanceId, sourceMessageId);
    const begun = await ledger.beginDelivery(
      this.uid,
      beginDeliveryEntry(this.instanceId, binding, message, text, undefined, this.resolveTurnContextTokenRef(turnSourceMsgId, binding), turnP3394MessageId),
    );
    if (begun.duplicate) return;
    if (!this.isCurrent() || this.controller.signal.aborted) {
      await ledger.finishDelivery(this.uid, key, {
        status: 'cancelled',
        error: 'delivery cancelled because messaging instance stopped',
      });
      return;
    }
    await this.attemptDelivery(key, begun.entry);
  }

  private trackOutboundDelivery(
    binding: MessagingBinding,
    message: OutboundMessage,
    turnSourceMsgId?: string,
    turnP3394MessageId?: string,
  ): void {
    const delivery = this.deliverGroupMessage(binding, message, turnSourceMsgId, turnP3394MessageId);
    this.outboundDeliveries.add(delivery);
    void delivery.then(
      () => {
        this.outboundDeliveries.delete(delivery);
      },
      (error) => {
        this.outboundDeliveries.delete(delivery);
        log.warn('messaging delivery callback failed', {
          instanceId: this.instanceId,
          error: (error as Error).message,
        });
      },
    );
  }

  async waitForOutboundDeliveries(): Promise<void> {
    // Listeners are removed before this wait starts, but loop defensively in
    // case a callback that was already queued registers its delivery first.
    while (this.outboundDeliveries.size) {
      await Promise.allSettled(Array.from(this.outboundDeliveries));
    }
  }

  /** Send the session-reset confirmation through the same ledger-backed path
   * as ordinary replies, keyed on the inbound command message. */
  async deliverConfirmationMessage(binding: MessagingBinding, envelope: InboundEnvelope): Promise<void> {
    // Mirrors Hermes' `gateway.reset.header_default` banner.
    await this.deliverText(binding, envelope, t('messaging.new_session_confirmation'));
  }

  /** Ledger-backed text reply to an inbound message (slash-command replies,
   *  banners, system notices). Idempotent on the inbound message id: a
   *  redelivery of the same inbound message never sends twice. */
  async deliverText(binding: MessagingBinding, envelope: InboundEnvelope, text: string): Promise<void> {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return;
    const key = ledger.deliveryKey(this.instanceId, envelope.externalMessageId);
    const begun = await ledger.beginDelivery(
      this.uid,
      beginDeliveryEntry(this.instanceId, binding, { id: envelope.externalMessageId, text: trimmed }, trimmed, undefined, envelope.contextTokenRef, envelope.p3394MessageId),
    );
    if (begun.duplicate) return;
    await this.attemptDelivery(key, begun.entry);
  }

  // ── Binding bus listener ─────────────────────────────────────────────────

  /** Subscribe to the bound conversation's group-chat bus events and route
   * them into the reply/card machinery. One listener per binding key. */
  async attachBindingListener(binding: MessagingBinding): Promise<void> {
    if (!this.isCurrent() || this.listeners.has(binding.key)) return;
    const streamingEnabled = this.instance.responseMode === 'streaming_card' && isCardAdapter(this.adapter);
    log.info('messaging binding listener attached', { instanceId: this.instanceId, key: binding.key, cid: binding.cid, streamingEnabled });
    const unsubscribe = subscribe(this.uid, binding.cid, (event: GroupEvent) => {
      if (!this.isCurrent()) {
        log.info('messaging bus event dropped: runtime no longer current', {
          instanceId: this.instanceId,
          key: binding.key,
          eventType: event.type,
        });
        return;
      }
      // The listener closure holds the binding snapshot from attach time; the
      // live binding (fresh replyToMessageId etc.) lives in bindingContexts and
      // is refreshed on every inbound message. Always send against the latest
      // so replies reference the message they actually answer.
      const currentBinding = this.bindingContexts.get(binding.key) || binding;
      if (event.type === 'wake_request') {
        // A pending agent wake inside this bound conversation surfaces as an
        // interactive approval card in the same Feishu chat.
        if (event.request.status === 'pending') {
          void this.sendWakeApprovalCard(currentBinding, event.request).catch((error) => {
            log.warn('messaging wake approval card send failed', {
              instanceId: this.instanceId,
              error: (error as Error).message,
            });
          });
        }
        return;
      }
      if (event.type === 'process') {
        // Tool chrome is collected for every response mode; the card path
        // renders it live while the plain-text path merges it at turn end.
        this.recordToolLines(event);
        if (streamingEnabled) this.handleCardProcessEvent(currentBinding, event);
        return;
      }
      if (event.type === 'turn_silent') {
        // A silent turn produced no reply: release its captured context token
        // reference so it can never leak into a later delivery.
        if (event.source_msg_id) this.turnSourceRefs.delete(event.source_msg_id);
        if (streamingEnabled) this.handleCardTurnSilent(currentBinding, event);
        return;
      }
      if (!isMessageEvent(event) || event.turn_end !== true) return;
      log.info('messaging bus turn-end message event', {
        instanceId: this.instanceId,
        key: binding.key,
        msgId: event.msg?.id,
        textLen: typeof event.msg?.text === 'string' ? event.msg.text.length : 0,
      });
      void this.handleTurnEndMessage(currentBinding, event).catch((error) => {
        log.warn('messaging turn-end delivery failed', {
          instanceId: this.instanceId,
          error: (error as Error).message,
        });
      });
    });
    this.listeners.set(binding.key, unsubscribe);
  }

  // ── Approval cards ───────────────────────────────────────────────────────

  /** Bridge a pending wake request into an interactive approval card on the
   * bound Feishu chat. Buttons route back through ingestCardAction → the wake
   * gate; the card is finalized by handleCardAction after the decision. */
  private async sendWakeApprovalCard(
    binding: MessagingBinding,
    request: WakeRequestSummary,
  ): Promise<void> {
    const adapter = this.adapter;
    if (!isCardAdapter(adapter) || !adapter.sendApprovalCard) return;
    const agentLabel = request.agent_name || request.agent_id;
    await adapter.sendApprovalCard(binding.externalChatId, {
      wakeId: request.id,
      title: t('messaging.approval.title_needed', { agent: agentLabel }),
      description: request.objective.slice(0, 1500),
      allowSession: true,
      allowPermanent: false,
    }, this.controller.signal);
  }

  // ── Streaming cards ──────────────────────────────────────────────────────

  private clearCardTimer(state: CardStreamState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async flushCardUpdate(
    binding: MessagingBinding,
    key: string,
    state: CardStreamState,
  ): Promise<void> {
    if (state.flushing) return;
    const turnId = key.split('\u0000')[1] || '';
    const flushedToolCount = this.toolLinesForTurn(turnId).length;
    if (!this.isCurrent() || (!state.accumulated && flushedToolCount === 0)) return;
    state.flushing = true;
    const flushedLen = state.accumulated.length;
    try {
      const adapter = this.adapter;
      if (!isCardAdapter(adapter)) return;
      const toolLines = this.toolLinesForTurn(turnId);
      const card = buildStreamCard(this.instance.displayName, toolLines, state.accumulated);
      if (state.messageId) {
        await adapter.updateCard(state.messageId, card, this.controller.signal);
      } else {
        const receipt = await adapter.sendCard(binding.externalChatId, card, this.controller.signal, deliveryContext(binding));
        state.messageId = receipt.deliveryId;
        log.info('messaging streaming card created', {
          instanceId: this.instanceId,
          turnId: key.split('\u0000')[1] || '',
          deliveryId: receipt.deliveryId || '',
          textLen: state.accumulated.length,
        });
      }
    } catch (error) {
      if (!this.isCurrent() || this.controller.signal.aborted) return;
      log.warn('messaging streaming card delivery failed', {
        instanceId: this.instanceId,
        hadMessageId: !!state.messageId,
        error: (error as Error).message,
      });
      this.clearCardTimer(state);
      this.cardStates.delete(key);
    } finally {
      state.flushing = false;
      // Deltas or tool lines that arrived while this flush was awaiting the
      // network were only accumulated (the debounce saw `flushing` and skipped
      // scheduling). Trail one more flush so the latest content still reaches
      // the card.
      if (this.isCurrent()
        && (state.accumulated.length > flushedLen || this.toolLinesForTurn(turnId).length > flushedToolCount)) {
        this.scheduleCardFlush(binding, key, state);
      }
    }
  }

  private scheduleCardFlush(binding: MessagingBinding, key: string, state: CardStreamState): void {
    if (state.timer !== null || state.flushing) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushCardUpdate(binding, key, state);
    }, CARD_FLUSH_DELAY_MS);
  }

  private handleCardProcessEvent(
    binding: MessagingBinding,
    event: Extract<GroupEvent, { type: 'process' }>,
  ): void {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const isDelta = data.type === 'delta' && typeof data.text === 'string';
    if (!isDelta && !toolLinesFromProcessEvent(event).length) return;
    const turnId = cardEventTurnId(event);
    if (!turnId) return;
    const key = cardStateKey(binding.key, turnId);
    let state = this.cardStates.get(key);
    if (!state) {
      state = { accumulated: '', timer: null, flushing: false };
      this.cardStates.set(key, state);
      log.info('messaging streaming card state created', {
        instanceId: this.instanceId,
        turnId,
        cardStates: this.cardStates.size,
        keys: [...this.cardStates.keys()].map((k) => k.split('\u0000')[1] || ''),
      });
    }
    if (isDelta) {
      state.accumulated = (state.accumulated + data.text).slice(0, CARD_MAX_TEXT_LENGTH);
    }
    this.scheduleCardFlush(binding, key, state);
  }

  private async finalizeCardForTurnEnd(
    binding: MessagingBinding,
    event: Extract<GroupEvent, { type: 'message' }>,
  ): Promise<boolean> {
    const turnId = cardEventTurnId(event);
    if (!turnId) return false;
    const key = cardStateKey(binding.key, turnId);
    const state = this.cardStates.get(key);
    log.info('messaging streaming card finalize', {
      instanceId: this.instanceId,
      key,
      turnId,
      statePresent: !!state,
      cardStates: this.cardStates.size,
    });
    if (!state) return false;
    this.clearCardTimer(state);
    const message = messageFromEvent(event);
    const finalText = typeof message.text === 'string' && message.text.trim()
      ? message.text.trim().slice(0, CARD_MAX_TEXT_LENGTH)
      : state.accumulated;
    if (!state.messageId) {
      // The card was never created: its first flush was still pending when the
      // turn ended (the 400ms debounce or an in-flight sendCard won the race
      // against turn-end). Drop the draft and fall through to the plain-text
      // path so the final answer is still delivered instead of being lost.
      this.cardStates.delete(key);
      this.clearToolLinesForTurn(turnId);
      return false;
    }
    log.info('messaging streaming card finalize text', {
      instanceId: this.instanceId,
      messageId: state.messageId || '',
      finalTextLen: finalText.length,
      accumulatedLen: state.accumulated.length,
    });
    if (state.messageId && finalText) {
      const adapter = this.adapter;
      if (isCardAdapter(adapter)) {
        try {
          await adapter.updateCard(
            state.messageId,
            buildStreamCard(this.instance.displayName, this.toolLinesForTurn(turnId), finalText),
            this.controller.signal,
          );
          log.info('messaging streaming card finalized ok', {
            instanceId: this.instanceId,
            messageId: state.messageId,
          });
        } catch (error) {
          if (!this.isCurrent() || this.controller.signal.aborted) {
            this.cardStates.delete(key);
            return true;
          }
          log.warn('messaging streaming card finalize failed', {
            instanceId: this.instanceId,
            error: (error as Error).message,
          });
          this.cardStates.delete(key);
          // Fall through to the plain-text delivery path so the answer still arrives.
          return false;
        }
      }
    }
    this.cardStates.delete(key);
    this.clearToolLinesForTurn(turnId);
    return true;
  }

  private handleCardTurnSilent(
    binding: MessagingBinding,
    event: Extract<GroupEvent, { type: 'turn_silent' }>,
  ): void {
    const turnId = cardEventTurnId(event);
    if (!turnId) return;
    const key = cardStateKey(binding.key, turnId);
    const state = this.cardStates.get(key);
    if (!state) return;
    this.clearCardTimer(state);
    // An already-sent card keeps its accumulated content; a silent turn only
    // stops further updates. Unsent drafts are dropped without creating a card.
    this.cardStates.delete(key);
    this.clearToolLinesForTurn(turnId);
  }

  private async handleTurnEndMessage(
    binding: MessagingBinding,
    event: Extract<GroupEvent, { type: 'message' }>,
  ): Promise<void> {
    if (!this.isCurrent()) return;
    const turnId = cardEventTurnId(event);
    const message = messageFromEvent(event);
    log.info('messaging turn-end handling', {
      instanceId: this.instanceId,
      key: binding.key,
      responseMode: this.instance.responseMode,
      cardAdapter: isCardAdapter(this.adapter),
      turnId,
      cardStateCount: this.cardStates.size,
    });
    if (this.instance.responseMode === 'streaming_card' && isCardAdapter(this.adapter)) {
      if (await this.finalizeCardForTurnEnd(binding, event)) return;
      log.info('messaging turn-end card finalize skipped, falling back to text delivery', {
        instanceId: this.instanceId,
        key: binding.key,
        turnId,
      });
    }
    // Plain-text path: merge the turn's tool chrome into the reply so the tool
    // trail stays visible without emitting a second message (mirrors Hermes'
    // progress bubbles, folded into the final post).
    const toolLines = turnId ? this.toolLinesForTurn(turnId) : [];
    if (toolLines.length && typeof message.text === 'string') {
      message.text = `${toolLines.map((line) => `\`${line}\``).join('\n')}\n\n---\n\n${message.text}`;
    }
    this.trackOutboundDelivery(binding, message, event.source_msg_id, event.source_p3394_message_id);
    if (turnId) this.clearToolLinesForTurn(turnId);
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  /** Stop retry/card timers and drop per-turn state so a stopped runtime can
   * never fire stale deliveries or card updates. */
  disposeTimers(): void {
    this.clearRetryTimer();
    for (const state of this.cardStates.values()) this.clearCardTimer(state);
    this.cardStates.clear();
    this.toolLinesByTurn.clear();
    this.turnSourceRefs.clear();
  }
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

function deliveryContext(entry: { replyToMessageId?: string; threadId?: string; replyInThread?: boolean; idempotencyKey?: string; recipientIdType?: 'chat_id' | 'open_id'; contextTokenRef?: string }) {
  return {
    ...(entry.replyToMessageId ? { replyToMessageId: entry.replyToMessageId } : {}),
    ...(entry.threadId ? { threadId: entry.threadId } : {}),
    ...(entry.replyInThread ? { replyInThread: true } : {}),
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
    ...(entry.recipientIdType ? { recipientIdType: entry.recipientIdType } : {}),
    ...(entry.contextTokenRef ? { contextTokenRef: entry.contextTokenRef } : {}),
  };
}

function beginDeliveryEntry(
  instanceId: string,
  binding: { externalChatId?: string; recipientId?: string; recipientIdType?: 'chat_id' | 'open_id'; replyToMessageId?: string; threadId?: string; replyInThread?: boolean },
  message: OutboundMessage,
  text: string,
  idempotencyKey?: string,
  contextTokenRef?: string,
  p3394MessageId?: string,
) {
  // Defense in depth: every current call site (bus reply, confirmation, ledger
  // recovery) guarantees a non-empty id upstream; a missing one would silently
  // stringify into an "undefined" idempotency key and corrupt dedupe.
  if (!message.id) throw new Error('delivery requires a message id');
  const key = ledger.deliveryKey(instanceId, message.id);
  return {
    key,
    instanceId,
    recipientId: binding.recipientId || binding.externalChatId || '',
    recipientIdType: binding.recipientIdType === 'open_id' ? 'open_id' as const : 'chat_id' as const,
    ...(binding.externalChatId ? { externalChatId: binding.externalChatId } : {}),
    sourceMessageId: message.id as string,
    textHash: ledger.textHash(text),
    text,
    ...(binding.replyToMessageId ? { replyToMessageId: binding.replyToMessageId } : {}),
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.replyInThread ? { replyInThread: true } : {}),
    ...(contextTokenRef ? { contextTokenRef } : {}),
    ...(p3394MessageId ? { p3394MessageId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
