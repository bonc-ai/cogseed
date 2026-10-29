/**
 * Trusted reception context projection (B1 / E08).
 *
 * A trusted inbound A2A turn must never read the local resumable model session:
 * that session also holds the receiver's private conversation with the same
 * assistant, private tool output and whatever the model was told on local
 * turns. Sharing it would hand a visitor the host's side of the chat.
 *
 * The external turn therefore runs on an in-memory `Session` rebuilt from the
 * *durable conversation transcript* (`<cid>.jsonl`) — never from the local
 * session file. Only entries both sides already saw are replayed, and a pair is
 * admitted only when the transcript itself carries the host-owned ownership
 * relation:
 *
 *   - a peer question: a row authored by the peer actor (`a2a_<peerUserId>`)
 *     with a stable message id (the reception runner writes `a2a-in-<hash>`);
 *   - the answer to that peer: the settled reply row whose persisted
 *     `turn_id` is exactly `turn-<question id>` — the execution id the
 *     reception runner hands to the bus (`reception-run.ts`,
 *     `dispatchTurnId = turn-${receptionMessageId(messageId)}`). The same row
 *     must be a terminal model bubble addressed to the host user.
 *
 * Pairing never falls back to row order, "the last settled bubble", or a
 * local-user boundary. A row whose ownership cannot be established (no id, no
 * `turn_id`, a legacy answer without the terminal marker, a local turn's own
 * reply, a nested dispatch's bubble) is excluded. That matters under
 * concurrency: a local turn can start first, a peer question can be enqueued
 * while it runs, and the local assistant's private reply can then be persisted
 * *after* the peer question. Order alone would pair the peer with that private
 * reply; the ownership relation cannot.
 *
 * The transcript is the host's own record of what was actually delivered, so
 * the projection:
 *   - survives a restart and a session-cache eviction (it never reads the
 *     model session file);
 *   - keeps continuity across external turns (Q1/A1 is visible to Q2);
 *   - never widens: a local turn's reply carries a different (random) `turn_id`
 *     and is never the answer to a peer question.
 *
 * Fail-closed direction is "less history", never "local history": an unreadable
 * transcript, a malformed row, an unmatched question or an answer without the
 * owner field simply contributes nothing. The caller keeps the in-memory
 * session either way.
 *
 * This module is deliberately data-only (rows in → turns out) plus a tiny
 * structural replay helper; the runner owns Session construction so the model
 * layer stays the only place that touches `#core-agent`.
 */

import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import type { TrustedReceptionScope } from './reception-scope';

const log = createLogger('a2a');

/** The host user actor id in the persisted conversation transcript. */
const USER_ACTOR_ID = 'user';

/** Tail window scanned for pair candidates. Older pairs are out of context anyway. */
export const RECEPTION_HISTORY_SCAN_ROWS = 400;
/** Maximum number of replayed Q/A pairs (most recent kept). */
export const RECEPTION_HISTORY_MAX_TURNS = 16;
/** Per-entry ceiling; bounds a hostile/pathological peer message. */
export const RECEPTION_HISTORY_MAX_ENTRY_CHARS = 8_000;

/** One allowed external-history pair: the peer's words and the answer it got. */
export interface ReceptionHistoryTurn {
  readonly question: string;
  readonly answer: string;
}

/**
 * Subset of a persisted `GroupMessage` row this projection depends on. Rows are
 * untrusted JSONL input, so every field is validated before use.
 */
interface ConversationRowLike {
  /** Stable per-message id; the peer question's id anchors the pair. */
  id?: unknown;
  from?: unknown;
  to?: unknown;
  text?: unknown;
  turn_end?: unknown;
  system_kind?: unknown;
  /** Host-owned actor-execution id (`QueueItem.turnId`) persisted on the row. */
  turn_id?: unknown;
}

/**
 * The reception runner dispatches a question's answer under the deterministic
 * execution id `turn-<question id>` (`reception-run.ts:680`). This projection
 * relies on that persisted host-owned relation, not on row adjacency.
 */
const RECEPTION_ANSWER_TURN_PREFIX = 'turn-';

function answerTurnIdForQuestion(questionId: string): string {
  return `${RECEPTION_ANSWER_TURN_PREFIX}${questionId}`;
}

function rowText(row: ConversationRowLike): string {
  return typeof row.text === 'string' ? row.text.trim() : '';
}

function rowAddressesUser(row: ConversationRowLike): boolean {
  return Array.isArray(row.to) && row.to.some((id) => id === USER_ACTOR_ID);
}

function isSettledReply(row: ConversationRowLike, peerActorId: string): boolean {
  // Host status rows (`reply_interrupted`, review cards) are not answers the
  // peer received. Only a terminal, model-authored bubble counts.
  if (typeof row.from !== 'string' || !row.from) return false;
  if (row.from === USER_ACTOR_ID || row.from === peerActorId) return false;
  if (row.system_kind !== undefined) return false;
  if (row.turn_end !== true) return false;
  if (!rowAddressesUser(row)) return false;
  return rowText(row).length > 0;
}

function truncateEntry(text: string): string {
  if (text.length <= RECEPTION_HISTORY_MAX_ENTRY_CHARS) return text;
  return `${text.slice(0, RECEPTION_HISTORY_MAX_ENTRY_CHARS)}\n…[truncated]`;
}

/**
 * Project the allowed external history out of conversation rows.
 *
 * Ownership is authoritative, order is only presentation. A peer question is
 * answered only by a settled reply whose persisted `turn_id` is exactly
 * `turn-<question id>`; the answer must also be a terminal model bubble
 * addressed to the host user. Questions and their (possibly later) answers may
 * therefore be interleaved with local turns, nested dispatches, retries or any
 * other transcript writer without borrowing an unrelated bubble.
 *
 * Rows that cannot be tied to that relation are dropped:
 *   - peer rows without a stable id;
 *   - assistant rows without `turn_id` (legacy rows) or with another turn id;
 *   - non-terminal segments (`turn_end !== true`), host status rows and rows
 *     that do not address the host user;
 *   - local user rows and other peers' rows.
 *
 * The trailing question of the *current* turn has no answer row yet, so it is
 * never duplicated into history. The result is bounded (most recent 16 pairs,
 * per-entry ceiling).
 */
export function projectReceptionHistory(
  rows: readonly ConversationRowLike[],
  peerActorId: string,
): ReceptionHistoryTurn[] {
  const peer = typeof peerActorId === 'string' ? peerActorId.trim() : '';
  if (!peer) return [];

  // Pass 1: index terminal model replies by their host-owned execution id.
  // Last writer wins for a duplicated end marker; the relation itself is exact.
  const settledByTurnId = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const turnId = typeof row.turn_id === 'string' ? row.turn_id.trim() : '';
    if (!turnId) continue;
    if (!isSettledReply(row, peer)) continue;
    settledByTurnId.set(turnId, rowText(row));
  }

  // Pass 2: pairs in transcript order, each question carrying only its own
  // owned answer.
  const turns: ReceptionHistoryTurn[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const from = typeof row.from === 'string' ? row.from : '';
    if (from !== peer) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const question = rowText(row);
    if (!id || !question) continue;
    const answer = settledByTurnId.get(answerTurnIdForQuestion(id));
    if (answer === undefined) continue;
    turns.push({
      question: truncateEntry(question),
      answer: truncateEntry(answer),
    });
  }

  return turns.length > RECEPTION_HISTORY_MAX_TURNS
    ? turns.slice(-RECEPTION_HISTORY_MAX_TURNS)
    : turns;
}

/**
 * Load the allowed external history for a frozen reception scope.
 *
 * Degrades to no history (never to local history) when the transcript is
 * unreadable; the caller still runs the external turn on a fresh in-memory
 * session, so the failure direction is loss of continuity, not disclosure.
 */
export async function loadReceptionHistory(
  userId: string,
  scope: TrustedReceptionScope,
): Promise<ReceptionHistoryTurn[]> {
  if (!safeId(userId) || !scope || typeof scope !== 'object') return [];
  if (!safeId(scope.conversationId)) return [];
  if (typeof scope.sourceActorId !== 'string' || !scope.sourceActorId) return [];
  try {
    const file = conversationMessageReadFile(userId, scope.conversationId);
    const rows = await readJsonl<ConversationRowLike>(file, RECEPTION_HISTORY_SCAN_ROWS);
    return projectReceptionHistory(rows, scope.sourceActorId);
  } catch (error) {
    log.warn('reception history projection unavailable', {
      user_id: maskId(userId),
      cid: maskId(scope.conversationId),
      error: logErrorRef(error),
    });
    return [];
  }
}

/**
 * Structural view of the in-memory Session used for replay. Declared here so the
 * feature layer never imports `#core-agent`; the runner passes its real
 * `Session` instance, which satisfies this shape.
 */
export interface ReceptionHistorySessionLike {
  beginUserTurn(content: Array<{ type: 'text'; text: string }>): number;
  addAssistantMessage(content: Array<{ type: 'text'; text: string }>): void;
  completeActiveTurn(outcome?: string): void;
}

/**
 * Rebuild allowed Q/A history into an in-memory session as completed turns, so
 * the current external turn is appended after them and the model sees the same
 * continuity a resumed conversation would have. No outcome marker is recorded:
 * these were normal completed exchanges.
 */
export function replayReceptionHistory(
  session: ReceptionHistorySessionLike,
  turns: readonly ReceptionHistoryTurn[] | undefined,
): void {
  if (!session || !Array.isArray(turns) || !turns.length) return;
  for (const turn of turns) {
    if (!turn || typeof turn.question !== 'string' || typeof turn.answer !== 'string') continue;
    session.beginUserTurn([{ type: 'text', text: turn.question }]);
    session.addAssistantMessage([{ type: 'text', text: turn.answer }]);
    session.completeActiveTurn();
  }
}
