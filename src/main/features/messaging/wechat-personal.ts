import { randomBytes } from 'node:crypto';

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

const CLIENT_VERSION = 'pc-1.0.0';
const LONG_POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 35_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** checkHealth: last successful long poll within this window counts as connected. */
const HEALTH_STALE_MS = 90_000;

export type WechatErrorClass = 'network' | 'reauth_required' | 'delivery_rejected';

export function buildHeaders(ilinkBotId: string, ilinkBotToken: string): Record<string, string> {
  return {
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${ilinkBotToken}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32LE(0))).toString('base64'),
    'iLink-App-Id': ilinkBotId,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    'Content-Type': 'application/json',
  };
}

export function classifyError(error: unknown): WechatErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|401|ret=-14|ret":\s*-14|-14/.test(message)) return 'reauth_required';
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
    const response = await fetch(`${this.ilinkBaseUrl}${pathname}`, {
      method: 'POST',
      headers: buildHeaders(this.ilinkBotId, this.ilinkBotToken),
      body: JSON.stringify({ base_info: {}, ...body }),
      redirect: 'error',
      signal,
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
    this.generation += 1;
    const generation = this.generation;
    await callbacks.onStatus(statusOf('connecting'));
    try {
      while (!signal.aborted && !this.terminalError) {
        try {
          const body = await this.getUpdates(generation, signal);
          if (generation !== this.generation || signal.aborted) return;
          await this.handleBatch(generation, body, signal);
        } catch (error) {
          if (generation !== this.generation || signal.aborted) return;
          const cls = classifyError(error);
          if (cls === 'reauth_required') {
            this.terminalError = new Error('Wechat needs re-scan');
            await callbacks.onStatus(statusOf('error', '需要重新扫码'));
            return;
          }
          // Network-class failures: back off BEFORE surfacing the error
          // status. An abort landing while the failed request was in flight
          // settles during the wait, and the re-check below then exits
          // silently — an external abort or long-poll timeout is normal
          // control flow and must never be reported as an error status.
          await abortableWait(RETRY_BASE_MS, signal);
          if (generation !== this.generation || signal.aborted) return;
          await callbacks.onStatus(statusOf('error', 'Wechat connection error'));
          await callbacks.onStatus(statusOf('connecting'));
        }
      }
    } finally {
      if (this.callbacks === callbacks) this.callbacks = null;
      if (!signal.aborted && !this.terminalError) await callbacks.onStatus(statusOf('disconnected'));
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

  /** Task 5 completes inbound/outbound handling. */
  sendMessage(
    _chatId: string,
    _text: string,
    _signal?: AbortSignal,
    _context?: MessagingSendContext,
  ): Promise<{ deliveryId?: string }> {
    throw new Error('not implemented');
  }

  private async getUpdates(
    generation: number,
    signal: AbortSignal,
  ): Promise<{ get_updates_buf?: string; messages?: RawWechatMessage[] }> {
    const stateStore = await import('./wechat-state-store');
    const state = await stateStore.loadWechatState(this.uid, this.instance.id, this.fingerprint);
    const cursor = state?.getUpdatesBuf || '';
    const body = await this.request<{ get_updates_buf?: string; messages?: RawWechatMessage[] }>('/ilink/bot/getupdates', {
      get_updates_buf: cursor,
      long_polling: true,
    }, signal);
    if (generation !== this.generation) throw new Error('generation changed');
    this.lastPollAt = Date.now();
    this.lastStatus = statusOf('connected');
    void this.callbacks?.onStatus(this.lastStatus);
    return body;
  }

  /** Task 4 最小版：空批次直接返回；有消息时并发 dispatch 并等待终态后提交 cursor。
   * Task 5 补充 owner 过滤、tokenRef 注入与 state 写入。 */
  private async handleBatch(
    generation: number,
    body: { get_updates_buf?: string; messages?: RawWechatMessage[] },
    signal: AbortSignal,
  ): Promise<void> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return;
    const stateStore = await import('./wechat-state-store');
    const tasks: Array<Promise<unknown>> = [];
    for (const raw of messages) {
      if (generation !== this.generation || signal.aborted) return;
      const envelope = normalizeInbound(this.instance, this.ownerExternalUserId, raw);
      if (!envelope) continue;
      const dispatch = (this.callbacks?.onInbound(envelope) || Promise.resolve({ accepted: false, duplicate: false }))
        .catch((error: unknown) => {
          log.warn('wechat inbound dispatch failed', { instanceId: this.instance.id, error: logErrorSummary(error) });
          throw error;
        });
      tasks.push(dispatch);
    }
    if (tasks.length === 0) return;
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
  type?: string;
  text_item?: { text?: string };
}

interface RawWechatMessage {
  msg_id?: string;
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
  if (typeof raw.group_id === 'string' && raw.group_id) return null;
  const messageId = typeof raw.msg_id === 'string' ? raw.msg_id.trim() : '';
  const userId = typeof raw.from_user_id === 'string' ? raw.from_user_id.trim() : '';
  const contextToken = typeof raw.context_token === 'string' ? raw.context_token.trim() : '';
  if (!messageId || !userId || !contextToken) return null;
  const text = (raw.item_list || [])
    .filter((item) => item?.type === 'text_item')
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

export const _wechatTestHooks = {
  buildHeaders,
  classifyError,
  statusOf,
};
