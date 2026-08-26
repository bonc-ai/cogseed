/**
 * Collab timeline parser — turns an existing group-chat jsonl into the relay
 * sequence the dashboard collaboration tab renders.
 *
 * The jsonl is already a fact ledger (GroupMessage per line: from/to/ts/
 * turn_id/dispatch). This module only structures it — participants, a
 * ts-ordered turn list, dispatch counts. It deliberately does NOT infer
 * intent or "why the commander picked agent X": if the reason exists at all
 * it lives in the message text itself. 画结构，不编意图。
 *
 * Malformed lines are skipped individually; one bad line never fails the
 * conversation.
 */

const COMMANDER = 'commander';
const USER = 'user';

export interface CollabTurn {
  messageId: string;
  from: string;
  to: string[];
  ts: string;
  turnId?: string;
  dispatch: boolean;
  textHead: string;
}

export interface CollabSummary {
  cid: string;
  /** Every actor seen in the conversation, including user/commander. */
  participants: string[];
  /** External agents only — conversations without them are plain chats. */
  agents: string[];
  /** All relayed messages in ts-ascending order. */
  turns: CollabTurn[];
  lastTs?: string;
  dispatchCount: number;
}

interface RawMessage {
  id?: unknown;
  ts?: unknown;
  from?: unknown;
  to?: unknown;
  turn_id?: unknown;
  dispatch?: unknown;
  text?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseGroupMessages(cid: string, lines: Array<string | RawMessage>): CollabSummary {
  const turns: CollabTurn[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    let msg: RawMessage | null = null;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        msg = JSON.parse(trimmed) as RawMessage;
      } catch {
        continue;
      }
    } else if (raw && typeof raw === 'object') {
      msg = raw;
    }
    if (!msg) continue;
    const id = str(msg.id);
    const from = str(msg.from);
    const ts = str(msg.ts);
    if (!id || !from || !ts || seen.has(id)) continue;
    seen.add(id);
    const to = Array.isArray(msg.to) ? msg.to.filter((t): t is string => typeof t === 'string' && !!t) : [];
    turns.push({
      messageId: id,
      from,
      to,
      ts,
      ...(str(msg.turn_id) ? { turnId: str(msg.turn_id) } : {}),
      dispatch: msg.dispatch === true,
      textHead: String(msg.text || '').slice(0, 80),
    });
  }
  turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const participants = [...new Set(turns.flatMap((t) => [t.from, ...t.to]))];
  const agents = participants.filter((p) => p !== USER && p !== COMMANDER);
  return {
    cid,
    participants,
    agents,
    turns,
    ...(turns.length ? { lastTs: turns[turns.length - 1].ts } : {}),
    dispatchCount: turns.filter((t) => t.dispatch).length,
  };
}
