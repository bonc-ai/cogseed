/**
 * A2A private instructions — what the receiver told their assistant, in their own
 * conversation (D-21/FR-32).
 *
 * These are the receiver's own words ("不要透露报价"), so they are local-only and are
 * injected into the reception run's context rather than shown to the peer. Keeping
 * them out of the marker matters: the marker describes the exchange, while these
 * describe a private standing instruction that may change per conversation.
 */

import * as fsp from 'node:fs/promises';
import { appendJsonl, safeId } from '../../storage';
import { userLocalRoot } from '../../paths';
import * as path from 'node:path';
import type { RuntimeTextContext } from '../cogseed_runtime/protocol';
import { isInboundMarker, type A2AConversationMarker } from './conversation-marker';
import { getConversation } from '../chats';

export interface A2AInstructionRecord {
  conversationId: string;
  text: string;
  at: string;
}

/** 单条指示可读但不宜过长：超出的部分不进入上下文，避免挤占接待预算。 */
export const A2A_INSTRUCTION_MAX_CHARS = 500;
/** 只把最近的若干条带入上下文；更早的视为已被后续指示覆盖。 */
export const A2A_INSTRUCTION_CONTEXT_LIMIT = 5;

function assertUserId(userId: string): string {
  if (!userId || !safeId(userId)) throw new Error('invalid user id');
  return userId;
}

function instructionsFile(userId: string): string {
  return path.join(userLocalRoot(assertUserId(userId)), 'a2a-instructions.jsonl');
}

export async function appendInstruction(
  userId: string,
  conversationId: string,
  text: string,
): Promise<A2AInstructionRecord> {
  const cid = String(conversationId || '').trim();
  if (!cid) throw new Error('conversation id is required');
  const body = String(text || '').trim().slice(0, A2A_INSTRUCTION_MAX_CHARS);
  if (!body) throw new Error('instruction text is required');
  const record: A2AInstructionRecord = { conversationId: cid, text: body, at: new Date().toISOString() };
  await appendJsonl(instructionsFile(userId), record);
  return record;
}

/** 读本会话的指示（按时间正序）。 */
export async function listInstructions(userId: string, conversationId: string): Promise<A2AInstructionRecord[]> {
  const file = instructionsFile(userId);
  let raw = '';
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows: A2AInstructionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as A2AInstructionRecord;
      if (!parsed || typeof parsed.text !== 'string') continue;
      if (conversationId && parsed.conversationId !== conversationId) continue;
      rows.push(parsed);
    } catch { /* 单行损坏不影响其余 */ }
  }
  return rows;
}

/**
 * Load the instruction context for a conversation, deciding from the stored marker.
 *
 * This is the seam the run assembly calls: it resolves "is this a reception run?"
 * itself, so a caller that forgets to check the marker cannot leak the receiver's
 * private orders into an ordinary conversation.
 */
export async function loadInstructionContext(
  userId: string,
  conversationId?: string | null,
): Promise<RuntimeTextContext | null> {
  const cid = String(conversationId || '').trim();
  if (!cid) return null;
  const conversation = await getConversation(userId, cid).catch(() => null);
  const marker = conversation?.a2a ?? null;
  if (!marker || !isInboundMarker(marker) || marker.state !== 'active') return null;
  const rows = await listInstructions(userId, cid);
  return buildInstructionContext(marker, rows);
}

/**
 * 接收方在来访会话里说的话，是否要记成一条私下指示（FR-32）。
 *
 * 设计口径是「不 @ 的消息仅本方可见」：在 A2A 会话里直接对助理说话＝交代口径，
 * 不是在跟对端说话。这里把它记下来供后续接待运行使用；带结构化点名的消息是发给
 * 某个收件人的任务，不算口径。只在 `role=receiver` 的会话里生效——发起方会话里的
 * 普通聊天与对方无关。
 */
export async function rememberReceiverInstruction(
  userId: string,
  conversationId: string | null | undefined,
  text: string,
  hasNamedRecipient: boolean,
): Promise<A2AInstructionRecord | null> {
  if (hasNamedRecipient) return null;
  const cid = String(conversationId || '').trim();
  const body = String(text || '').trim();
  if (!cid || !body) return null;
  const conversation = await getConversation(userId, cid).catch(() => null);
  const marker = conversation?.a2a ?? null;
  if (!marker || !isInboundMarker(marker)) return null;
  try {
    return await appendInstruction(userId, cid, body);
  } catch {
    return null;
  }
}

/**
 * Build the context item for a reception run, or null when it is not one.
 *
 * Only an active receiving conversation gets instructions injected: the initiator's
 * own conversation must not see them (they describe the other side's private
 * standing orders), and a waiting exchange is not running yet.
 */
export function buildInstructionContext(
  marker: A2AConversationMarker | null | undefined,
  instructions: readonly A2AInstructionRecord[],
): RuntimeTextContext | null {
  if (!marker || !isInboundMarker(marker) || marker.state !== 'active') return null;
  const recent = instructions.slice(-A2A_INSTRUCTION_CONTEXT_LIMIT);
  if (!recent.length) return null;
  const content = [
    '接收方本人对本会话的私下指示（仅本方可见，回答对方时须遵守）：',
    ...recent.map((row, index) => `${index + 1}. ${row.text}`),
  ].join('\n');
  return { type: 'text', content, label: 'a2a-receiver-instructions' };
}
