/**
 * A2A product extension carried on P3394 envelopes.
 *
 * The interop protocol already has a free-form `extensions` bag, so the A2A MVP
 * does not add a protocol: it claims one namespace (`a2a`) with the minimum the
 * MVP needs — which exchange a message belongs to, what it is, who it answers and
 * whether it may cross to the peer.
 *
 * Two rules are enforced here rather than trusted to call sites:
 * - **local never crosses** (D-16/R-09): only `cross` messages may be addressed to
 *   another account, and a local message carrying a peer recipient is rejected;
 * - **text only** (D-14/R-04): attachments, reasoning and tool details have no slot
 *   in this shape at all.
 *
 * One contact relation may own multiple conversation instances. A single instance
 * is shared bidirectionally by both clients, while its marker independently tracks
 * inbound and outgoing directions.
 *
 * Explicit instance ids use the unordered participants plus a request id, so both
 * sides compute the same id without a server round trip. Legacy fallback ids use
 * only the account pair.
 */

import { createHash } from 'node:crypto';

export const A2A_EXTENSION_KEY = 'a2a';

/** Existing outbound assistant identity; shared with authoritative roster-name refresh. */
export function a2aPeerAssistantActorId(accountId: string): string {
  const sanitized = String(accountId || '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 44);
  return `a2a_${sanitized || 'peer'}_assistant`;
}

export const A2A_KINDS = ['question', 'answer', 'correction'] as const;
export type A2AKind = typeof A2A_KINDS[number];

export const A2A_VISIBILITIES = ['cross', 'local'] as const;
export type A2AVisibility = typeof A2A_VISIBILITIES[number];

export interface A2AExtension {
  /** Stable id of the exchange; both participants derive the same value. */
  conversation_id: string;
  kind: A2AKind;
  /** The account this message is for. Absent only for a purely local message. */
  recipient_user?: string;
  /** The assistant that answers a question (D-01). */
  assistant_agent_id?: string;
  visibility: A2AVisibility;
}

export interface A2AExtensionError {
  ok: false;
  reason: string;
}

export type A2AExtensionResult = { ok: true; value: A2AExtension } | A2AExtensionError;

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const A2A_CONVERSATION_ID = /^a2a-[0-9a-f]{20}$/;

export function isA2AConversationId(value: unknown): value is string {
  return typeof value === 'string' && A2A_CONVERSATION_ID.test(value);
}

/**
 * Legacy deterministic account-pair fallback id.
 *
 * Sorting the pair keeps callers that omit an explicit mode stable. Explicit new
 * conversations use `a2aConversationInstanceId`, which also includes a request id.
 */
export function a2aConversationId(a: string, b: string): string {
  const pair = [String(a || '').trim(), String(b || '').trim()].sort().join('|');
  const digest = createHash('sha1').update(pair).digest('hex').slice(0, 20);
  return `a2a-${digest}`;
}

export function a2aConversationInstanceId(a: string, b: string, requestId: string): string {
  const pair = [String(a || '').trim(), String(b || '').trim()].sort().join('|');
  const request = String(requestId || '').trim();
  const digest = createHash('sha256').update(`${pair}|${request}`).digest('hex').slice(0, 20);
  return `a2a-${digest}`;
}

/**
 * Legacy compatibility helper for deterministic direction-bearing ids. Hashing
 * `from|to` keeps old stored references stable; current conversation markers do
 * not derive direction or ownership from this id.
 */
export function a2aDirectionalConversationId(from: string, to: string): string {
  const pair = `${String(from || '').trim()}|${String(to || '').trim()}`;
  const digest = createHash('sha1').update(pair).digest('hex').slice(0, 20);
  return `a2a-${digest}`;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Build the extension for a message.
 *
 * A cross message must name its recipient; a local message must not — that is the
 * one mistake that would leak private context to the peer, so it fails loudly here
 * instead of being filtered at send time.
 */
export function buildA2AExtension(input: {
  kind: A2AKind;
  visibility: A2AVisibility;
  conversation_id: string;
  recipient_user?: string;
  assistant_agent_id?: string;
}): A2AExtension {
  const visibility: A2AVisibility = A2A_VISIBILITIES.includes(input.visibility) ? input.visibility : 'local';
  const kind: A2AKind = A2A_KINDS.includes(input.kind) ? input.kind : 'question';
  const conversationId = boundedString(input.conversation_id, 120);
  if (!isA2AConversationId(conversationId)) throw new Error('a2a conversation id is invalid');
  const recipient = boundedString(input.recipient_user, 128);
  if (visibility === 'cross' && !recipient) throw new Error('a cross a2a message requires a recipient');
  if (visibility === 'local' && recipient) throw new Error('a local a2a message cannot name a peer recipient');
  const assistant = boundedString(input.assistant_agent_id, 128);
  return {
    conversation_id: conversationId,
    kind,
    visibility,
    ...(recipient ? { recipient_user: recipient } : {}),
    ...(assistant ? { assistant_agent_id: assistant } : {}),
  };
}

/** Read the `a2a` namespace out of an envelope's extensions bag. */
export function parseA2AExtension(extensions: unknown): A2AExtensionResult {
  if (!extensions || typeof extensions !== 'object') {
    return { ok: false, reason: 'extensions_missing' };
  }
  const raw = (extensions as Record<string, unknown>)[A2A_EXTENSION_KEY];
  if (raw === undefined) return { ok: false, reason: 'a2a_missing' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'a2a_not_object' };
  const value = raw as Record<string, unknown>;

  const conversationId = boundedString(value.conversation_id, 120);
  if (!isA2AConversationId(conversationId)) return { ok: false, reason: 'a2a_conversation_id_invalid' };

  const kind = boundedString(value.kind, 20) as A2AKind;
  if (!A2A_KINDS.includes(kind)) return { ok: false, reason: 'a2a_kind_invalid' };

  const visibility = boundedString(value.visibility, 10) as A2AVisibility;
  if (!A2A_VISIBILITIES.includes(visibility)) return { ok: false, reason: 'a2a_visibility_invalid' };

  const recipient = boundedString(value.recipient_user, 128);
  if (recipient && !ACCOUNT_ID.test(recipient)) return { ok: false, reason: 'a2a_recipient_user_invalid' };
  if (visibility === 'cross' && !recipient) return { ok: false, reason: 'a2a_cross_requires_recipient' };
  if (visibility === 'local' && recipient) return { ok: false, reason: 'a2a_local_forbids_recipient' };

  const assistant = boundedString(value.assistant_agent_id, 128);
  if (assistant && !ACCOUNT_ID.test(assistant)) return { ok: false, reason: 'a2a_assistant_agent_id_invalid' };

  return {
    ok: true,
    value: {
      conversation_id: conversationId,
      kind,
      visibility,
      ...(recipient ? { recipient_user: recipient } : {}),
      ...(assistant ? { assistant_agent_id: assistant } : {}),
    },
  };
}

/**
 * Whether a message may be handed to the peer at all. A local message in the
 * outbound path means a routing bug, so this answers before any network work.
 */
export function mayCrossToPeer(extension: A2AExtension): boolean {
  return extension.visibility === 'cross' && !!extension.recipient_user;
}

/** Wrap an extension into the bag shape an envelope expects. */
export function withA2AExtension(extension: A2AExtension, base?: Record<string, unknown>): Record<string, unknown> {
  return { ...(base || {}), [A2A_EXTENSION_KEY]: extension };
}
