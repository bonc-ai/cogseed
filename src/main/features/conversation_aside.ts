/**
 * Conversation Aside — a read-only side thread for asking about the main
 * conversation without polluting it.
 *
 * The problem: a user gets a proposal in a task conversation and does not
 * follow it. Asking in the main thread derails the task and mixes explanatory
 * chatter into the delivery record; asking in a fresh conversation loses all
 * context. This module gives the third option — full context in, nothing
 * written back.
 *
 * ARCHITECTURE — why this bypasses the group-chat bus:
 * The main send path is `conversations.sendStream` → `groupChat.send` →
 * `bus.ts::enqueue`. Reusing it is impossible here for two independent
 * reasons: it necessarily appends to the main message file (defeating the whole
 * point), and AGENTS.md fixes group-chat dispatch to the single
 * `bus.ts::enqueue` path, so a parallel dispatch route is out of bounds.
 *
 * So asides call `model/client.ts::streamChatWithModel` directly. The read-only
 * guarantee is therefore STRUCTURAL, not enforced: with no bus involvement
 * there is no tool registry, no worker wake, no artifact writer, and no
 * concurrent write path to guard. There is no check to bypass because there is
 * nothing wired up.
 *
 * Storage rides `conversationLayout().groupDir`, which means aside history is
 * removed by the existing `purgeGroupDir` call in
 * `chats._purgeDeletedConversationFiles` — deleting a conversation cleans up
 * its asides with no extra hook.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../logger';
import { appendJsonl, readJsonl, readJsonlWindow, safeId } from '../storage';
import { conversationLayout, conversationMessageReadFile } from '../util/project-layout';
import { maskId } from '../util/log-redact';
import type { MessageRecord } from './chats';

const log = createLogger('conversation-aside');

/** Context window around the anchor: the run-up matters, the tail does not. */
export const ASIDE_CONTEXT_BEFORE = 5;
export const ASIDE_CONTEXT_AFTER = 2;
/** Prior Q/A pairs replayed within one thread before the oldest is dropped. */
export const ASIDE_HISTORY_LIMIT = 6;
export const ASIDE_QUESTION_MAX = 2000;
const ANCHOR_EXCERPT_MAX = 280;

export interface AsideTurn {
  turnId: string;
  /** Main-conversation message index that triggered this turn. */
  anchorIndex: number;
  /**
   * Snapshot of the anchor text. Redundant on purpose: once the main
   * conversation pages, `anchorIndex` may not be resident, and without the
   * snapshot the aside history loses what it was pointing at.
   */
  anchorExcerpt: string;
  question: string;
  answer: string;
  /** Who answered — recorded for auditability, not for re-dispatch. */
  agentId: string;
  model: string;
  createdAt: string;
}

export interface AsideContextMessage {
  index: number;
  from: string;
  text: string;
  isAnchor: boolean;
}

export interface AsideContext {
  messages: AsideContextMessage[];
  anchorIndex: number;
  anchorExcerpt: string;
}

// ── paths ─────────────────────────────────────────────────────────────────

/**
 * Aside file for a conversation.
 *
 * Always resolved through `conversationLayout`: project-scoped and
 * project-less conversations live in different roots, and hand-built paths
 * would silently write project asides to the wrong place.
 */
export function asideFile(userId: string, cid: string, projectHint?: string | null): string {
  return path.join(conversationLayout(userId, cid, projectHint).groupDir, 'aside.jsonl');
}

// ── validation ────────────────────────────────────────────────────────────

function requireCid(cid: unknown): string {
  if (typeof cid !== 'string' || !safeId(cid)) throw new Error('invalid cid');
  return cid;
}

function requireAnchorIndex(value: unknown): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid anchor index');
  return index;
}

function requireQuestion(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error('empty question');
  if (text.length > ASIDE_QUESTION_MAX) throw new Error('question too long');
  return text;
}

function excerpt(text: unknown): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > ANCHOR_EXCERPT_MAX ? `${value.slice(0, ANCHOR_EXCERPT_MAX)}…` : value;
}

// ── context ───────────────────────────────────────────────────────────────

/**
 * Collect the anchor plus its neighbours.
 *
 * Reads an arbitrary window via `readJsonlWindow` rather than
 * `chats.getMessagesPageAtIndex`, which snaps to page boundaries — a
 * page-aligned window would not reliably contain the 5 messages preceding the
 * anchor.
 *
 * The anchor may be given as an index OR a message id. The id is the reliable
 * locator: renderer bubbles only carry `msgIndex` when the history was read
 * anchored (e.g. jumping from search), so a normally-opened conversation has no
 * index to offer. `msgId` is always stamped.
 *
 * Deleted records are filtered but still consume their index, so a supplied
 * index keeps pointing at the same message.
 */
export async function buildAsideContext(
  userId: string,
  cid: string,
  anchor: number | { index?: number; msgId?: string },
  projectHint?: string | null,
): Promise<AsideContext> {
  const conversationId = requireCid(cid);
  const wantedId = typeof anchor === 'object' && anchor ? String(anchor.msgId || '') : '';
  const wantedIndex = typeof anchor === 'number'
    ? requireAnchorIndex(anchor)
    : (Number.isSafeInteger(Number(anchor?.index)) && Number(anchor?.index) >= 0
      ? Number(anchor?.index)
      : -1);
  if (!wantedId && wantedIndex < 0) throw new Error('invalid anchor');

  const file = conversationMessageReadFile(userId, conversationId, projectHint);

  // Resolving by id needs the record's position, so scan for it first. The read
  // is bounded by the conversation itself and only runs on the id path.
  let resolvedIndex = wantedIndex;
  if (wantedId) {
    const all = await readJsonlWindow<MessageRecord>(file, 0, Number.MAX_SAFE_INTEGER);
    const found = all.records.findIndex((record) => record && String(record.id ?? '') === wantedId);
    if (found < 0) throw new Error('anchor not found');
    resolvedIndex = found;
  }

  const start = Math.max(0, resolvedIndex - ASIDE_CONTEXT_BEFORE);
  const span = resolvedIndex - start + 1 + ASIDE_CONTEXT_AFTER;
  const page = await readJsonlWindow<MessageRecord>(file, start, span);

  const messages: AsideContextMessage[] = [];
  let anchorExcerptText = '';
  page.records.forEach((record, offset) => {
    if (!record || (record as { deleted_at?: string }).deleted_at) return;
    const index = start + offset;
    const text = String(record.text ?? '');
    const isAnchor = index === resolvedIndex;
    if (isAnchor) anchorExcerptText = excerpt(text);
    messages.push({ index, from: String(record.from ?? ''), text, isAnchor });
  });

  return { messages, anchorIndex: resolvedIndex, anchorExcerpt: anchorExcerptText };
}

/**
 * Render the model-facing prompt.
 *
 * The main-conversation context is included ONCE per request. Prior turns of
 * the same thread are replayed as Q/A pairs, so a fifth follow-up does not
 * carry five copies of the same transcript.
 */
export function buildAsidePrompt(context: AsideContext, history: readonly AsideTurn[], question: string): string {
  const transcript = context.messages
    .map((message) => `${message.isAnchor ? '→ ' : '  '}[${message.from}] ${message.text}`)
    .join('\n');
  const recent = history.slice(-ASIDE_HISTORY_LIMIT);
  const priorQa = recent.length
    ? `\n[本次追问的已有问答]\n${recent.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n\n')}\n`
    : '';
  return [
    '[主对话上下文 · 只读]',
    transcript || '(无可用上下文)',
    priorQa,
    '[用户选中的内容]',
    context.messages.find((message) => message.isAnchor)?.text || context.anchorExcerpt || '(未定位到选中消息)',
    '',
    '[用户的问题]',
    question,
  ].join('\n');
}

/**
 * System prompt for the explaining agent. States the read-only contract in the
 * prompt too, so the model does not offer to perform actions it has no way to
 * carry out.
 */
export function asideSystemPrompt(personaPrompt?: string): string {
  const base = [
    '你的职责是解释主对话中已经出现的内容，帮助用户理解。',
    '规则：',
    '1. 只解释，不执行。你没有任何工具、文件或命令权限，不要声称将要执行操作。',
    '2. 不臆造上下文之外的信息。上下文没有提到的，不要编。',
    '3. 不确定就直接说不确定，不要猜测后当作结论陈述。',
    '4. 你的回答不会写入主对话，不影响任务进行。',
  ].join('\n');
  return personaPrompt ? `${personaPrompt}\n\n---\n\n${base}` : base;
}

// ── persistence ───────────────────────────────────────────────────────────

export async function listAsideTurns(
  userId: string,
  cid: string,
  projectHint?: string | null,
): Promise<AsideTurn[]> {
  const conversationId = requireCid(cid);
  const rows = await readJsonl<AsideTurn>(asideFile(userId, conversationId, projectHint));
  // Malformed lines are skipped rather than failing the whole thread: a single
  // bad row must not make the user's history unreadable.
  return rows.filter((row): row is AsideTurn => !!row && typeof row.turnId === 'string');
}

export interface AppendAsideTurnInput {
  anchorIndex: number;
  anchorExcerpt: string;
  question: string;
  answer: string;
  agentId: string;
  model: string;
}

export async function appendAsideTurn(
  userId: string,
  cid: string,
  input: AppendAsideTurnInput,
  projectHint?: string | null,
): Promise<AsideTurn> {
  const conversationId = requireCid(cid);
  const turn: AsideTurn = {
    turnId: `aside-${randomUUID()}`,
    anchorIndex: requireAnchorIndex(input.anchorIndex),
    anchorExcerpt: excerpt(input.anchorExcerpt),
    question: requireQuestion(input.question),
    answer: String(input.answer ?? ''),
    agentId: String(input.agentId ?? ''),
    model: String(input.model ?? ''),
    createdAt: new Date().toISOString(),
  };
  const target = asideFile(userId, conversationId, projectHint);
  // appendJsonl creates the parent directory itself.
  await appendJsonl(target, turn);
  log.info('recorded aside turn', {
    user_id: maskId(userId),
    cid: maskId(conversationId),
    turn_id: maskId(turn.turnId),
    anchor_index: turn.anchorIndex,
  });
  return turn;
}

/** Clear a conversation's aside history. The main conversation is untouched. */
export async function clearAsideTurns(
  userId: string,
  cid: string,
  projectHint?: string | null,
): Promise<void> {
  const conversationId = requireCid(cid);
  try {
    await fs.unlink(asideFile(userId, conversationId, projectHint));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export const _internals = { excerpt, requireQuestion, requireAnchorIndex };

// ── ask ───────────────────────────────────────────────────────────────────

/**
 * Resolve the explaining agent: the conversation's bound agent when it is
 * present and enabled, otherwise the default model configuration. The aside
 * only borrows the model + persona — never the agent's skills, tools or memory
 * write path.
 */
export interface AsideAgentChoice {
  agentId: string;
  agentName?: string;
  personaPrompt?: string;
}

export async function resolveAsideAgent(
  boundAgentId: string | null | undefined,
  deps: {
    getAgent: (id: string) => Promise<{ agent_id: string; name?: string; workflow?: string } | null>;
    isAgentEnabled: (id: string) => boolean;
  },
): Promise<AsideAgentChoice> {
  if (boundAgentId && safeId(boundAgentId) && deps.isAgentEnabled(boundAgentId)) {
    const agent = await deps.getAgent(boundAgentId);
    if (agent) {
      return {
        agentId: agent.agent_id,
        ...(agent.name ? { agentName: agent.name } : {}),
        ...(agent.workflow ? { personaPrompt: agent.workflow } : {}),
      };
    }
  }
  // No bound agent (or it is disabled/missing): fall back to the default model
  // with no persona. Explaining does not require a specific identity.
  return { agentId: '' };
}

export interface AskAsideInput {
  cid: string;
  /** Preferred locator — always available on a rendered bubble. */
  anchorMsgId?: string;
  /** Only present when the history was read anchored (e.g. search jump). */
  anchorIndex?: number;
  question: string;
  projectHint?: string | null;
  boundAgentId?: string | null;
}

export interface AskAsideDeps {
  getAgent: (id: string) => Promise<{ agent_id: string; name?: string; workflow?: string } | null>;
  isAgentEnabled: (id: string) => boolean;
  /** Injected model call — keeps this module testable without a live provider. */
  stream: (opts: {
    userId: string;
    message: string;
    systemPrompt: string;
    sessionId: string;
    agentName?: string;
  }) => AsyncIterable<{ type: string; text?: string }>;
}

export interface AskAsideEvent {
  type: 'delta' | 'final' | 'error';
  text?: string;
  turn?: AsideTurn;
}

/**
 * Ask a question about the main conversation and stream the answer.
 *
 * The turn is persisted only after a successful answer: a failed or aborted
 * ask leaves no half-written record that would later replay as context.
 *
 * `sessionId` is deliberately aside-scoped (`aside-<cid>`) so the explanation
 * never shares session state with the task's own model session.
 */
export async function* askAside(
  userId: string,
  input: AskAsideInput,
  deps: AskAsideDeps,
): AsyncGenerator<AskAsideEvent, void, unknown> {
  const cid = requireCid(input.cid);
  const question = requireQuestion(input.question);
  const projectHint = input.projectHint ?? null;
  const anchorRef = input.anchorMsgId
    ? { msgId: input.anchorMsgId }
    : { index: requireAnchorIndex(input.anchorIndex) };

  const [context, history, agent] = await Promise.all([
    buildAsideContext(userId, cid, anchorRef, projectHint),
    listAsideTurns(userId, cid, projectHint),
    resolveAsideAgent(input.boundAgentId, deps),
  ]);
  const anchorIndex = context.anchorIndex;

  const prompt = buildAsidePrompt(context, history, question);
  const systemPrompt = asideSystemPrompt(agent.personaPrompt);

  let answer = '';
  try {
    for await (const event of deps.stream({
      userId,
      message: prompt,
      systemPrompt,
      sessionId: `aside-${cid}`,
      ...(agent.agentName ? { agentName: agent.agentName } : {}),
    })) {
      if (event.type === 'delta' && event.text) {
        answer += event.text;
        yield { type: 'delta', text: event.text };
      } else if (event.type === 'error') {
        yield { type: 'error', text: event.text || 'aside failed' };
        return;
      }
    }
  } catch (err) {
    log.warn('aside stream failed', { user_id: maskId(userId), cid: maskId(cid) });
    yield { type: 'error', text: (err as Error).message };
    return;
  }

  if (!answer.trim()) {
    yield { type: 'error', text: 'empty answer' };
    return;
  }

  const turn = await appendAsideTurn(userId, cid, {
    anchorIndex,
    anchorExcerpt: context.anchorExcerpt,
    question,
    answer,
    agentId: agent.agentId,
    model: '',
  }, projectHint);

  yield { type: 'final', text: answer, turn };
}
