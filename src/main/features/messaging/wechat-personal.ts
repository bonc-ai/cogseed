import { randomBytes, randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { isTrustedIlinkBaseUrl } from './registry';
import { wechatCredentialFingerprint } from './wechat-state-store';
import type {
  AdapterCallbacks,
  InboundEnvelope,
  MessagingAdapter,
  MessagingInstance,
  MessagingInstanceInternal,
  MessagingInstanceStatus,
  MessagingPlatform,
  MessagingSecret,
  MessagingSendContext,
} from './types';

const log = createLogger('messaging:wechat-personal');

// Hermes wire constants (gateway/platforms/weixin.py): the app id is the
// literal "bot" for every request — never the account's ilink_bot_id — and
// the client version is (2<<16)|(2<<8)|0 = 131584. base_info merges
// channel_version into every POST body.
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const CHANNEL_VERSION = '2.2.0';
// Message enum values (Hermes): item types and message/state codes are
// numbers on the wire, not strings.
const ITEM_TEXT = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
// Wire-client bounds: REQUEST_TIMEOUT_MS caps a single HTTP call, and
// LONG_POLL_TIMEOUT_MS is the getupdates poll deadline — when the server
// holds the connection past it, the poll falls back to a fresh poll without
// an error status or backoff (see WechatPollDeadlineError).
const LONG_POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 35_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** checkHealth: last successful long poll within this window counts as connected. */
const HEALTH_STALE_MS = 90_000;

/** Long-poll deadline: the server held the connection without new messages.
 * Normal control flow — start() falls back to a fresh poll immediately, with
 * no error status and no failure-counter bump. */
class WechatPollDeadlineError extends Error {
  constructor() {
    super('wechat long poll deadline');
  }
}

export type WechatErrorClass = 'network' | 'reauth_required' | 'delivery_rejected';

export function buildHeaders(ilinkBotToken: string): Record<string, string> {
  return {
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${ilinkBotToken}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32LE(0))).toString('base64'),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    'Content-Type': 'application/json',
  };
}

export function classifyError(error: unknown): WechatErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  // Terminal reauth is signaled two ways: HTTP 401 (status check in request)
  // and ret=-14 in the JSON payload. Both are anchored so look-alikes such as
  // ret=-140 or an errmsg merely mentioning -14 stay transient network errors.
  if (message.startsWith('HTTP 401') || /ret\s*=\s*-14(\s|$)/.test(message)) return 'reauth_required';
  return 'network';
}

export class WechatPersonalAdapter implements MessagingAdapter {
  readonly platform: MessagingPlatform = 'wechat_personal';
  private readonly instance: MessagingInstance;
  private readonly uid: string;
  private readonly ownerExternalUserId: string;
  private readonly fingerprint: string;
  private readonly ilinkBotToken: string;
  private readonly ilinkBaseUrl: string;
  private readonly ilinkBotId: string;
  private callbacks: AdapterCallbacks | null = null;
  private generation = 0;
  private terminalError: Error | null = null;
  private lastPollAt = 0;
  private lastStatus: MessagingInstanceStatus = statusOf('disconnected');
  /** Consecutive network failures; drives the exponential backoff and is
   * reset by every successful poll. */
  private consecutiveFailures = 0;

  constructor(instance: MessagingInstance, secret: MessagingSecret, uid: string) {
    if (!secret.ilinkBotToken || !secret.ilinkBaseUrl || !secret.ilinkBotId) {
      throw new Error('iLink credentials missing');
    }
    if (!isTrustedIlinkBaseUrl(secret.ilinkBaseUrl)) throw new Error('untrusted iLink base url');
    this.instance = instance;
    this.uid = uid;
    this.ilinkBotToken = secret.ilinkBotToken;
    this.ilinkBaseUrl = secret.ilinkBaseUrl.replace(/\/+$/, '');
    this.ilinkBotId = secret.ilinkBotId;
    this.ownerExternalUserId = (instance as MessagingInstanceInternal).ownerExternalUserId || '';
    this.fingerprint = wechatCredentialFingerprint(this.ilinkBotId, this.ownerExternalUserId);
  }

  private async request<T extends object>(
    pathname: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T & { ret: number; errmsg?: string }> {
    // REQUEST_TIMEOUT_MS bounds a single HTTP call. The timeout signal's
    // timer is unref'd by the runtime, so a settled request never keeps the
    // process alive.
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.ilinkBaseUrl}${pathname}`, {
      method: 'POST',
      headers: buildHeaders(this.ilinkBotToken),
      body: JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, ...body }),
      redirect: 'error',
      signal: AbortSignal.any([signal, deadline]),
    });
    if (response.status === 401) throw new Error('HTTP 401');
    const text = await response.text();
    let parsed: { ret?: unknown; errmsg?: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON response (${response.status})`);
    }
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      throw new Error(`ret=${parsed.ret}${parsed.errmsg ? ` ${parsed.errmsg}` : ''}`);
    }
    return parsed as unknown as T & { ret: number; errmsg?: string };
  }

  async start(signal: AbortSignal, callbacks: AdapterCallbacks): Promise<void> {
    if (signal.aborted) return;
    if (this.callbacks) throw new Error('Wechat adapter already started');
    this.callbacks = callbacks;
    this.terminalError = null;
    this.consecutiveFailures = 0;
    this.generation += 1;
    const generation = this.generation;
    // A broken status callback must not wedge the adapter: clear callbacks so
    // a later start() is not blocked by the already-started guard, then
    // surface the failure to the caller.
    try {
      await callbacks.onStatus(statusOf('connecting'));
    } catch (error) {
      if (this.callbacks === callbacks) this.callbacks = null;
      throw error;
    }
    try {
      while (!signal.aborted && !this.terminalError) {
        try {
          const body = await this.getUpdates(generation, signal);
          if (generation !== this.generation || signal.aborted) return;
          await this.handleBatch(generation, body, signal);
        } catch (error) {
          if (generation !== this.generation || signal.aborted) return;
          // The long-poll deadline is normal control flow: the server held
          // the connection without new messages. Fall back to a fresh poll
          // immediately — no backoff, no error status, no failure bump.
          if (error instanceof WechatPollDeadlineError) continue;
          const cls = classifyError(error);
          if (cls === 'reauth_required') {
            this.terminalError = new Error('Wechat needs re-scan');
            await this.emitStatus(statusOf('error', '需要重新扫码'));
            return;
          }
          // Network-class failures: back off BEFORE surfacing the error
          // status. An abort landing while the failed request was in flight
          // settles during the wait, and the re-check below then exits
          // silently — an external abort or long-poll timeout is normal
          // control flow and must never be reported as an error status.
          // The wait grows exponentially from 2s (capped) per consecutive
          // failure; any successful poll resets the counter.
          const delay = Math.min(RETRY_BASE_MS * 2 ** this.consecutiveFailures, RETRY_MAX_MS);
          this.consecutiveFailures += 1;
          await abortableWait(delay, signal);
          if (generation !== this.generation || signal.aborted) return;
          await this.emitStatus(statusOf('error', 'Wechat connection error'));
          await this.emitStatus(statusOf('connecting'));
        }
      }
    } finally {
      // Emit before clearing callbacks: the disconnected push must reach this
      // start()'s callbacks, and emitStatus keeps a rejecting callback from
      // escaping start().
      if (!signal.aborted && !this.terminalError) await this.emitStatus(statusOf('disconnected'));
      if (this.callbacks === callbacks) this.callbacks = null;
    }
  }

  /** Status pushes are notifications: a rejecting onStatus callback must
   * never abort the poll loop or escape start()/finally. The initial
   * connecting emit is the one exception — see start(). */
  private async emitStatus(status: MessagingInstanceStatus): Promise<void> {
    try {
      await this.callbacks?.onStatus(status);
    } catch (error) {
      log.warn('wechat status callback failed', { instanceId: this.instance.id, error: logErrorSummary(error) });
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
  }

  async checkHealth(): Promise<MessagingInstanceStatus> {
    if (this.terminalError) return statusOf('error', this.terminalError.message);
    if (Date.now() - this.lastPollAt <= HEALTH_STALE_MS) return statusOf('connected');
    return statusOf('disconnected');
  }

  async sendMessage(
    chatId: string,
    text: string,
    lifecycleSignal?: AbortSignal,
    context?: MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    const stateStore = await import('./wechat-state-store');
    const tokenRef = typeof context?.contextTokenRef === 'string' ? context.contextTokenRef : '';
    let token = '';
    if (tokenRef) {
      // 回复场景：必须使用触发该轮的 token（tokenRef 编码 peerId）
      const peer = await stateStore.readWechatPeerToken(this.uid, this.instance.id, tokenRef);
      // 防御性校验：tokenRef 编码的 peerId 必须与回复目标一致，否则视为
      // 上下文缺失，绝不把某位 peer 的 token 发给另一位 peer。
      if (!peer || peer.peerId !== chatId) throw new Error('wechat_context_missing');
      token = peer.token;
    } else if (chatId === this.ownerExternalUserId) {
      // 主动消息场景（无入站触发的 ref）：仅允许发给 owner 本人
      const state = await stateStore.loadWechatState(this.uid, this.instance.id, this.fingerprint);
      token = state?.peers[chatId]?.contextToken || '';
    }
    if (!token || !chatId) throw new Error('wechat_context_missing');
    // 长回复按 4000 字符分块为多个 text_item，一次 send 完整送达，不做
    // 静默截断。
    const chunks = chunkText(text, 4_000);
    const clientId = typeof context?.idempotencyKey === 'string' && context.idempotencyKey
      ? context.idempotencyKey
      : randomUUID();
    const body = await this.request<{ msg_id?: string }>('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: chatId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: chunks.map((chunk) => ({ type: ITEM_TEXT, text_item: { text: chunk } })),
        context_token: token,
      },
    }, lifecycleSignal || new AbortController().signal);
    return body && typeof body.msg_id === 'string' ? { deliveryId: String(body.msg_id) } : {};
  }

  private async getUpdates(
    generation: number,
    signal: AbortSignal,
  ): Promise<{ get_updates_buf?: string; msgs?: RawWechatMessage[] }> {
    const stateStore = await import('./wechat-state-store');
    const state = await stateStore.loadWechatState(this.uid, this.instance.id, this.fingerprint);
    const cursor = state?.getUpdatesBuf || '';
    // LONG_POLL_TIMEOUT_MS is the poll deadline: a server that holds the
    // connection without new messages must not wedge the poll loop, and the
    // deadline is normal flow (WechatPollDeadlineError), never an error.
    const deadline = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
    let body: { get_updates_buf?: string; msgs?: RawWechatMessage[] } & { ret: number; errmsg?: string };
    try {
      body = await this.request<{ get_updates_buf?: string; msgs?: RawWechatMessage[] }>('/ilink/bot/getupdates', {
        get_updates_buf: cursor,
        long_polling: true,
      }, AbortSignal.any([signal, deadline]));
    } catch (error) {
      if (deadline.aborted && !signal.aborted) throw new WechatPollDeadlineError();
      throw error;
    }
    if (generation !== this.generation) throw new Error('generation changed');
    this.consecutiveFailures = 0;
    this.lastPollAt = Date.now();
    this.lastStatus = statusOf('connected');
    void this.emitStatus(this.lastStatus);
    return body;
  }

  /** 入站批处理：owner 前置过滤（仅 owner 写 peer state 并注入
   * contextTokenRef），非 owner 仍 dispatch 进 manager 产生 ledger 拒绝记录；
   * 全部 dispatch 终态后提交 cursor。 */
  private async handleBatch(
    generation: number,
    body: { get_updates_buf?: string; msgs?: RawWechatMessage[] },
    signal: AbortSignal,
  ): Promise<void> {
    const messages = Array.isArray(body.msgs) ? body.msgs : [];
    // 空批次（心跳）：没有消息可丢失，立即推进游标——游标内含服务器位置
    // 标记，必须逐轮单调推进；否则下一轮用空游标会让服务器从错误位置拉取
    // （Hermes 同款：每次响应都保存 get_updates_buf）。
    if (messages.length === 0) {
      if (generation === this.generation && !signal.aborted
        && typeof body.get_updates_buf === 'string' && body.get_updates_buf) {
        const stateStore = await import('./wechat-state-store');
        await stateStore.saveWechatCursor(this.uid, this.instance.id, this.fingerprint, body.get_updates_buf);
      }
      return;
    }
    const stateStore = await import('./wechat-state-store');
    const tasks: Array<Promise<unknown>> = [];
    for (const raw of messages) {
      if (generation !== this.generation || signal.aborted) return;
      // 回声过滤：bot 自己的消息（发送回执等 from_user_id == ilinkBotId）
      // 绝不能回灌 dispatch 循环造成死循环（Hermes 同样跳过）。
      if (typeof raw.from_user_id === 'string' && raw.from_user_id === this.ilinkBotId) continue;
      const envelope = normalizeInbound(this.instance, this.ownerExternalUserId, raw);
      if (!envelope) continue;
      // 仅 owner 写 peer state；非 owner 仍 dispatch 进 manager 产生 ledger 拒绝记录
      if (envelope.externalUserId === this.ownerExternalUserId) {
        const contextToken = typeof raw.context_token === 'string' ? raw.context_token.trim() : '';
        if (contextToken) {
          const tokenRef = await stateStore.saveWechatPeerToken(
            this.uid, this.instance.id, this.fingerprint,
            envelope.externalUserId, contextToken, Date.now(),
          );
          envelope.contextTokenRef = tokenRef;
        }
      }
      const dispatch = (this.callbacks?.onInbound(envelope) || Promise.resolve({ accepted: false, duplicate: false }))
        .catch((error: unknown) => {
          log.warn('wechat inbound dispatch failed', { instanceId: this.instance.id, error: logErrorSummary(error) });
          throw error;
        });
      tasks.push(dispatch);
    }
    const settled = await Promise.allSettled(tasks);
    if (generation !== this.generation || signal.aborted) return;
    const allTerminal = settled.every((result) => result.status === 'fulfilled');
    if (allTerminal && typeof body.get_updates_buf === 'string' && body.get_updates_buf) {
      await stateStore.saveWechatCursor(this.uid, this.instance.id, this.fingerprint, body.get_updates_buf);
    }
  }
}

function statusOf(kind: MessagingInstanceStatus['kind'], message?: string): MessagingInstanceStatus {
  return {
    kind,
    checkedAt: new Date().toISOString(),
    ...(message ? { message: message.slice(0, 500) } : {}),
    ...(kind === 'connected' ? { connectedAt: new Date().toISOString() } : {}),
  };
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Raw iLink inbound message shape (fields are optional in the protocol). */
interface RawWechatItem {
  type?: number;
  text_item?: { text?: string };
}

interface RawWechatMessage {
  message_id?: string;
  from_user_id?: string;
  group_id?: string;
  item_list?: RawWechatItem[];
  context_token?: string;
  create_time?: number;
}

export function normalizeInbound(
  instance: MessagingInstance,
  ownerExternalUserId: string,
  raw: RawWechatMessage,
): InboundEnvelope | null {
  // Pure envelope shaping only. ownerExternalUserId is reserved for the
  // Task 5 owner pre-filter; context_token snapshotting (contextTokenRef) is
  // also Task 5 — this function must not set it.
  if (typeof raw.group_id === 'string' && raw.group_id) return null;
  const messageId = typeof raw.message_id === 'string' ? raw.message_id.trim() : '';
  const userId = typeof raw.from_user_id === 'string' ? raw.from_user_id.trim() : '';
  const contextToken = typeof raw.context_token === 'string' ? raw.context_token.trim() : '';
  if (!messageId || !userId || !contextToken) return null;
  // Hermes ITEM_TEXT=1：item type 是数字 1，不是字符串 'text_item'
  const text = (raw.item_list || [])
    .filter((item) => item?.type === 1)
    .map((item) => item.text_item?.text?.trim() || '')
    .filter(Boolean)
    .join('\n');
  if (!text) return null;
  return {
    platform: 'wechat_personal',
    instanceId: instance.id,
    externalMessageId: messageId,
    externalChatId: userId,
    externalUserId: userId,
    text: text.slice(0, 12_000),
    isGroup: false,
    mentionPresent: false,
    receivedAt: new Date().toISOString(),
  };
}

/** Split a reply into ≤ `max` UTF-16 units per chunk without splitting
 * surrogate pairs (emoji stay intact). The iLink protocol's `item_list` is
 * an array, so a long reply is sent as several `text_item` chunks in one
 * send and arrives complete instead of being silently truncated. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  let units = 0;
  for (const ch of text) {
    if (units + ch.length > max && current) {
      chunks.push(current);
      current = '';
      units = 0;
    }
    current += ch;
    units += ch.length;
  }
  if (current) chunks.push(current);
  return chunks;
}

export const _wechatTestHooks = {
  buildHeaders,
  classifyError,
  normalizeInbound,
  statusOf,
  chunkText,
};
