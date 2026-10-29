/**
 * A2A relay client (H-04).
 *
 * The hub carries cross-side messages; this module is the client's end of it.
 *
 * Identity (T2.2): every call takes the local `userId` and uses that identity's
 * normal Hub session. There is no environment-token fallback — that fixture made
 * "not signed in" indistinguishable from "signed in", and let an old identity keep
 * sending after sign-out. Failures still degrade instead of blocking a conversation.
 */

import { createLogger } from '../../logger';
import { hasHubSession, withHubSession, throwIfHubUnauthorized } from '../hub_account/transport';
import { HubApiError } from '../hub_account/client';
import { A2A_QUESTION_MAX_LENGTH } from './outbound-intent';

const log = createLogger('a2a-relay-client');

export interface RelayMessage {
  messageId: string;
  fromAccount: string;
  toAccount: string;
  conversationId: string;
  kind: 'question' | 'answer' | 'correction';
  text: string;
  /** 发送方显示名（Hub 联表带回；缺失时界面退化为无名称）。 */
  fromName?: string;
  createdAt: string;
}

const TIMEOUT_MS = 5_000;

/** Map a transport-level session failure onto this module's public error codes. */
function sessionFailureCode(reason: 'no_session' | 'network' | 'auth'): string {
  if (reason === 'no_session') return 'HUB_NOT_CONFIGURED';
  if (reason === 'auth') return 'HUB_AUTH_REQUIRED';
  return 'HUB_UNREACHABLE';
}

async function requestDetailed<T>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; isCurrent?: () => boolean } = {},
): Promise<{ ok: true; data: T | null } | { ok: false; code: string }> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, code: 'HUB_NOT_CONFIGURED' };
  if (init.isCurrent && !init.isCurrent()) return { ok: false, code: 'HUB_NOT_CONFIGURED' };
  const result = await withHubSession(uid, async ({ baseUrl, token, isCurrent }) => {
    // Freshness may await token rotation. A destructive poll must still belong
    // to its captured active local identity when the GET actually starts.
    if (!isCurrent() || (init.isCurrent && !init.isCurrent())) return { ok: false as const, code: 'HUB_NOT_CONFIGURED' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init.method || (init.body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { code?: string } } | null;
      throwIfHubUnauthorized(res.status, json?.error?.code);
      if (!res.ok || !json || json.ok === false) return { ok: false as const, code: 'HUB_BAD_RESPONSE' };
      return { ok: true as const, data: (json.data ?? null) as T | null };
    } catch (error) {
      if (error instanceof HubApiError) throw error;
      // 网络失败/超时：调用方决定是等待重试还是报错。
      return { ok: false as const, code: 'HUB_UNREACHABLE' };
    } finally {
      clearTimeout(timer);
    }
  });
  if ('reason' in result) return { ok: false, code: sessionFailureCode(result.reason) };
  return result.value;
}

async function request<T>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; isCurrent?: () => boolean } = {},
): Promise<T | null> {
  const detailed = await requestDetailed<T>(userId, path, init);
  return detailed.ok ? detailed.data : null;
}

/** 只有当前身份持有正常登录会话时，relay 才可用。 */
export function relayConfigured(userId: string): boolean {
  return hasHubSession(userId);
}

export interface RelaySendFailure {
  /** Hub 的错误码（NOT_CONTACT / QUESTIONS_DISABLED / …）；网络类为 HUB_*。 */
  code: string;
}

/**
 * 发一条跨方消息；失败时把原因带出来。
 *
 * 发送侧要能区分「对方关了接收提问」「已不是联系人」与「网络不通」——只说"失败"
 * 会让用户反复重试一个服务端明确拒绝的动作。
 */
export async function sendRelayMessageDetailed(userId: string, input: {
  to: string;
  conversationId: string;
  kind: RelayMessage['kind'];
  text: string;
  requestId?: string;
}): Promise<{ ok: true; messageId: string } | { ok: false; code: string }> {
  const to = String(input.to || '').trim();
  const text = String(input.text || '').trim();
  const conversationId = String(input.conversationId || '').trim();
  const requestId = String(input.requestId || '').trim();
  const uid = String(userId || '').trim();
  if (!to || !text || text.length > A2A_QUESTION_MAX_LENGTH
    || !conversationId || (input.requestId !== undefined && !requestId)) {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  if (!uid) return { ok: false, code: 'HUB_NOT_CONFIGURED' };

  // Freeze the idempotent envelope before any session/refresh await.
  const body = JSON.stringify({ to, conversationId, kind: input.kind, text, ...(requestId ? { requestId } : {}) });
  const outcome = await withHubSession(uid, async ({ baseUrl, token }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/v1/a2a/relay/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(requestId ? { 'idempotency-key': requestId } : {}),
        },
        body,
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { messageId?: string }; error?: { code?: string } }
        | null;
      throwIfHubUnauthorized(res.status, json?.error?.code);
      const messageId = String(json?.data?.messageId || '').trim();
      if (!res.ok || !json || json.ok === false || !messageId) {
        return {
          ok: false as const,
          code: String(json?.error?.code || (res.ok ? 'HUB_BAD_RESPONSE' : `HUB_${res.status}`)),
        };
      }
      return { ok: true as const, messageId };
    } catch (error) {
      if (error instanceof HubApiError) throw error;
      return { ok: false as const, code: 'HUB_UNREACHABLE' };
    } finally {
      clearTimeout(timer);
    }
  });
  if ('reason' in outcome) return { ok: false, code: sessionFailureCode(outcome.reason) };
  return outcome.value;
}

export async function sendRelayMessage(userId: string, input: {
  to: string;
  conversationId: string;
  kind: RelayMessage['kind'];
  text: string;
  requestId?: string;
}): Promise<{ messageId: string } | null> {
  const sent = await sendRelayMessageDetailed(userId, input);
  return sent.ok ? { messageId: sent.messageId } : null;
}

export async function pollRelayMessages(
  userId: string,
  since?: string,
  options: { isCurrent?: () => boolean } = {},
): Promise<RelayMessage[] | null> {
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const data = await request<{ messages: RelayMessage[] }>(userId, `/api/v1/a2a/relay/messages${query}`, options);
  return data && Array.isArray(data.messages) ? data.messages : null;
}

/** 供调用点打日志时使用（不含 token / 正文）。 */
export function noteRelayFailure(code: string): void {
  log.info('relay call failed', { code });
}
