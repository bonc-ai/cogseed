/**
 * Claude session → CogSeed conversation import.
 *
 * Takes a Claude Code session file from ~/.claude/projects/ and materializes
 * it as a normal conversation in the user's chat list: createConversation
 * (cid = claude sessionId, so re-import is idempotent) + GroupMessage rows
 * appended in chronological order. The conversation is read-only history —
 * no actors are seeded, no dispatch happens; the rows are plain user /
 * commander messages so the UI renders them like any past chat.
 *
 * Constraints (AGENTS.md):
 *  - data lives under <uid>/cloud/chats/ (via chats.createConversation +
 *    group_chat append paths)
 *  - no eager parsing of arbitrary files; we only read the exact jsonl the
 *    picker listed (localAgents.listClaudeSessions)
 */

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger';
import * as chats from '../chats';
import { conversationMessageFile } from '../../util/project-layout';

const log = createLogger('local-agents:import-sessions');

/** Raw Claude Code jsonl line shape we care about. */
interface ClaudeLine {
  type?: string;
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
  timestamp?: string;
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ sessionId: string; error: string }>;
}

/** Pull plain text out of a Claude content payload (string or blocks). */
function _contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.find((c: any) => c && c.type === 'text' && typeof c.text === 'string');
    return text ? text.text : '';
  }
  return '';
}

/** Parse a Claude session jsonl into ordered {role, text, ts} rows. */
export async function parseClaudeSessionFile(filePath: string): Promise<Array<{ role: 'user' | 'assistant'; text: string; ts: string }>> {
  const raw = await fs.readFile(filePath, 'utf8');
  const rows: Array<{ role: 'user' | 'assistant'; text: string; ts: string }> = [];
  let lastTs = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: ClaudeLine;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    // Claude Code records every event with `type`; assistant turns use
    // type=assistant (or user with message.role=assistant on old formats).
    let role: 'user' | 'assistant' | null = null;
    if (obj.type === 'user' && obj.message?.role === 'user') role = 'user';
    else if (obj.type === 'assistant' && obj.message?.role === 'assistant') role = 'assistant';

    if (!role) continue;
    const text = _contentText(obj.message?.content).trim();
    if (!text) continue;

    const ts = obj.timestamp || '';
    if (ts) lastTs = ts;
    rows.push({ role, text, ts: lastTs });
  }

  return rows;
}

/**
 * Materialize one Claude session as a CogSeed conversation.
 * Idempotent: re-import with the same sessionId returns the existing
 * conversation untouched.
 */
export async function importClaudeSession(
  uid: string,
  session: { sessionId: string; filePath: string; firstMessage?: string; projectPath?: string },
): Promise<{ ok: true; cid: string } | { ok: false; error: string }> {
  if (!uid || !session?.sessionId || !session?.filePath) return { ok: false, error: 'missing session info' };

  try {
    const rows = await parseClaudeSessionFile(session.filePath);
    if (!rows.length) return { ok: false, error: 'no parseable messages' };

    // cid = claude session id (hex, safeId-compatible). createConversation
    // returns the existing conversation when the id is already present, so
    // re-imports are no-ops.
    const title = (session.firstMessage || '导入的 Claude 会话').slice(0, 60);
    const conv = await chats.createConversation(uid, {
      kind: 'normal',
      title,
      conversationId: session.sessionId,
      reviveDeleted: true,
    });
    const cid = conv.conversation_id;

    // Append rows if the message file is empty (fresh import). If it already
    // has content, this is a re-import — leave history untouched.
    const msgFile = conversationMessageFile(uid, cid, conv.project_id ?? null);
    const existing = await fs.readFile(msgFile, 'utf8').catch(() => '');
    if (existing.trim()) {
      log.info(`import skipped (already imported) user=${uid} sid=${session.sessionId} cid=${cid}`);
      return { ok: true, cid };
    }

    for (const row of rows) {
      const msg = {
        id: randomUUID().replace(/-/g, '').slice(0, 24),
        ts: row.ts || new Date().toISOString(),
        from: row.role === 'user' ? 'user' : 'commander',
        to: [],
        text: row.text,
      };
      await fs.appendFile(msgFile, JSON.stringify(msg) + '\n', 'utf8');
    }

    log.info(`imported claude session user=${uid} sid=${session.sessionId} cid=${cid} rows=${rows.length}`);
    return { ok: true, cid };
  } catch (err) {
    log.warn(`import claude session failed user=${uid} sid=${session.sessionId}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/** Import a batch of picked sessions; one failure does not stop the rest. */
export async function importClaudeSessions(
  uid: string,
  sessions: Array<{ sessionId: string; filePath: string; firstMessage?: string; projectPath?: string }>,
): Promise<ImportResult> {
  const result: ImportResult = { ok: true, imported: 0, skipped: 0, errors: [] };
  for (const s of sessions) {
    const r = await importClaudeSession(uid, s);
    if ('cid' in r) {
      result.imported += 1;
    } else {
      result.errors.push({ sessionId: s.sessionId, error: r.error });
    }
  }
  result.skipped = sessions.length - result.imported - result.errors.length;
  return result;
}

// Re-exported for tests without pulling in the whole feature module.
export const _test = { contentText: _contentText };
