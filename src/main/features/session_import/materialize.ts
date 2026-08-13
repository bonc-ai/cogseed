/**
 * Session materialization (stage 3).
 *
 * Turns an extraction result into a real Orkas conversation the user can open
 * from the sidebar and continue chatting in. The raw imported history is NOT
 * copied; instead a single compact "seed" message carries the summary, so the
 * continued conversation starts with a clean, bounded context.
 *
 * What it writes:
 *   1. A new conversation via `createConversation` (kind:'normal'), titled from
 *      the imported session and tagged with an idempotency id so re-running
 *      import on the same source session returns the existing conversation
 *      instead of duplicating it.
 *   2. One `GroupMessage` seed appended to the conversation's main jsonl:
 *        - `text`      → human-facing summary (rendered with an "imported"
 *                        banner by the renderer via `system_kind`-less content)
 *        - `model_text`→ the same brief phrased as durable context so the model
 *                        picks up where the previous agent left off.
 *      `from` is the commander actor so it reads as an assistant-side brief,
 *      not a user turn.
 *
 * Idempotency: the conversation id is derived deterministically from
 * `source + sourceId`, so the same imported session always maps to the same
 * conversation. `createConversation` returns the existing conv unchanged when
 * the id already exists; we then skip re-seeding.
 */

import { createHash } from 'node:crypto';

import { createConversation, updateConversation } from '../chats';
import { COMMANDER_ID, USER_ID } from '../group_chat/state';
import type { GroupMessage } from '../group_chat/visibility';
import { conversationMessageFile } from '../../util/project-layout';
import { appendJsonlAtomic, genId12, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import type { ExtractionResult } from './extractor';

const log = createLogger('session-import:materialize');

export interface MaterializeInput {
  userId: string;
  source: 'claude' | 'codex' | 'workbuddy';
  sourceId: string;
  /** Original project path, used only to enrich the title. */
  projectPath?: string;
  /** First user message snippet from the picker, used for the title when the
   *  summary is empty. */
  titleHint?: string;
  extraction: ExtractionResult;
}

export interface MaterializeResult {
  conversationId: string;
  created: boolean;
  seeded: boolean;
  degraded: boolean;
}

/** Deterministic, collision-safe conversation id for an imported session, so
 *  repeated imports are idempotent. `safeId` guarantees the id is accepted by
 *  `createConversation`'s explicit-id path. */
function importedConversationId(source: string, sourceId: string): string {
  const hash = createHash('sha256').update(`${source}:${sourceId}`).digest('hex').slice(0, 20);
  const id = `imp-${source}-${hash}`;
  return safeId(id) ? id : `imp-${hash}`;
}

/** Build a short title from the summary head or the picker hint. */
function buildTitle(input: MaterializeInput): string {
  const src = input.extraction.sessionSummary || input.titleHint || '';
  const firstLine = src.split('\n').map((l) => l.trim()).find(Boolean) || '导入的会话';
  const title = firstLine.slice(0, 40);
  return `⤴ ${title}`;
}

/** Compose the seed message body. Human text gets an "imported / distilled"
 *  banner; model_text carries the same brief as durable pickup context. */
function buildSeed(input: MaterializeInput): { text: string; modelText: string } {
  const summary = input.extraction.sessionSummary.trim();
  const banner = input.extraction.degraded
    ? '[从 Claude Code 导入 · 未能自动提炼，以下为原始开头]'
    : '[从 Claude Code 导入 · 已提炼]';
  const text = `${banner}\n\n${summary}`;
  const modelText =
    `以下是用户从 Claude Code 导入的一段历史会话的提炼简报。` +
    `请把它当作已发生的上下文，在此基础上继续协助用户，不要重复已完成的工作：\n\n${summary}`;
  return { text, modelText };
}

/**
 * Materialize one imported session into a continuable conversation.
 * Idempotent on `source + sourceId`.
 */
export async function materializeSession(input: MaterializeInput): Promise<MaterializeResult> {
  const cid = importedConversationId(input.source, input.sourceId);

  const conv = await createConversation(input.userId, {
    kind: 'normal',
    conversationId: cid,
    title: buildTitle(input),
    imported: true,
    needs_welcome: true,
  });

  // If the conversation already had content (a prior import), don't re-seed.
  const msgFile = conversationMessageFile(input.userId, conv.conversation_id, conv.project_id ?? null);
  let alreadySeeded = false;
  try {
    const fs = await import('node:fs/promises');
    const existing = await fs.readFile(msgFile, 'utf8');
    alreadySeeded = existing.trim().length > 0;
  } catch {
    alreadySeeded = false;
  }

  if (alreadySeeded) {
    log.info(`skip re-seed cid=${conv.conversation_id} source=${input.source}:${input.sourceId}`);
    return {
      conversationId: conv.conversation_id,
      created: false,
      seeded: false,
      degraded: !!input.extraction.degraded,
    };
  }

  const { text, modelText } = buildSeed(input);
  const seed: GroupMessage = {
    id: genId12(),
    ts: nowIso(),
    from: COMMANDER_ID,
    to: [USER_ID],
    text,
    model_text: modelText,
  };
  await appendJsonlAtomic<GroupMessage>(msgFile, seed);

  // Touch updated_at so the conversation sorts to the top of the sidebar list.
  await updateConversation(input.userId, conv.conversation_id, { updated_at: nowIso() }, conv.project_id ?? null);

  log.info(
    `materialized cid=${conv.conversation_id} source=${input.source}:${input.sourceId} degraded=${!!input.extraction.degraded}`,
  );

  return {
    conversationId: conv.conversation_id,
    created: true,
    seeded: true,
    degraded: !!input.extraction.degraded,
  };
}
