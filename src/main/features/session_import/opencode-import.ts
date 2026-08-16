/**
 * OpenCode session import.
 *
 * Reads an OpenCode session from `~/.local/share/opencode/opencode.db`
 * (SQLite, READ-ONLY). OpenCode stores human prose in the `part` table
 * (`{type:"text", text:"…"}`), not on the message row. We read text parts to
 * distill a short summary and materialize it like the other CLI sources.
 */

import { createLogger } from '../../logger';
import { listOpencodeSessions, readOpencodeSessionParts } from '../local_agents/opencode_sessions';

const log = createLogger('session-import:opencode');

export interface OpencodeImportResult {
  ok: boolean;
  conversationId?: string;
  alreadyImported?: boolean;
  reason?: string;
}

/** Single-line, length-capped text for titles/summaries. */
function condense(text: string, max: number): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

/** Distill a short human summary from an OpenCode session (first real user
 *  text part). Falls back to the session title — honest, never fabricated. */
export function opencodeSessionSummary(sessionId: string, title?: string): string {
  const parts = readOpencodeSessionParts(sessionId);
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p.role === 'user' && p.text.trim()) {
        return condense(p.text.trim(), 200) || (title || '从 OpenCode 导入的会话');
      }
    }
  }
  return title || '从 OpenCode 导入的会话';
}

/** Import an OpenCode session into a continuable conversation. */
export async function importOpencodeSession(
  userId: string,
  sessionId: string,
  titleHint?: string,
): Promise<OpencodeImportResult> {
  if (!sessionId) return { ok: false, reason: 'sessionId required' };

  let title = titleHint || '';
  try {
    const list = listOpencodeSessions();
    if (!('error' in list)) {
      const hit = list.sessions.find((s) => s.id === sessionId);
      if (hit && hit.title) title = hit.title;
    }
  } catch (err) {
    log.warn('opencode session title lookup failed', { sessionId, error: String(err) });
  }

  const sessionSummary = opencodeSessionSummary(sessionId, title);
  const extraction = {
    ok: true,
    sessionSummary,
    personal: [],
    rules: [],
    templates: [],
    degraded: false,
  };

  const { materializeSession } = await import('./materialize');
  const materialize = await materializeSession({
    userId,
    source: 'opencode',
    sourceId: sessionId,
    titleHint: title,
    extraction,
  });

  log.info(`imported opencode session=${sessionId} cid=${materialize.conversationId}`);
  return { ok: true, conversationId: materialize.conversationId, alreadyImported: materialize.created === false };
}
