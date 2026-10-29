/**
 * A2A consultations — the private "先问一下本人" step (R-11/D-7).
 *
 * When the receiving assistant reaches something only the receiver may decide, it
 * proposes a reply and waits. The consultation lives in the receiver's own
 * conversation: the initiator sees "B 的助理正在确认", never the question or the
 * answer (D-10).
 *
 * Local-only by design: this is the receiver's private deliberation, so it is
 * stored under `<uid>/local/` and never crosses to the peer — unlike the contact
 * roster, which is a cache of Hub state.
 */

import { readJson, safeId, writeJson } from '../../storage';
import { userA2AConsultationsFile } from '../../paths';

export const A2A_CONSULTATION_STATES = ['pending', 'approved', 'revised', 'declined', 'expired'] as const;
export type A2AConsultationState = typeof A2A_CONSULTATION_STATES[number];

export type A2AConsultationDecision = 'approve' | 'revise' | 'decline';

export interface A2AConsultationRecord {
  id: string;
  /** The receiver-side conversation the assistant asked in. */
  conversationId: string;
  peerUserId: string;
  peerName?: string;
  /** What the peer asked, in the assistant's words (shown to the receiver only). */
  question: string;
  /** The reply the assistant intends to send. */
  proposedReply: string;
  state: A2AConsultationState;
  createdAt: string;
  answeredAt?: string;
  /** The receiver's final wording when they revised; otherwise the proposed text. */
  finalReply?: string;
  /** When the 5-minute nudge fired (D-23); set once so it is not re-sent. */
  nudgedAt?: string;
}

interface ConsultationsFile { version: 1; consultations: A2AConsultationRecord[] }

const VERSION = 1 as const;

/** PRD D-23: after this long the assistant tells the peer "稍后回复" instead of waiting silently. */
export const A2A_CONSULTATION_NUDGE_MS = 5 * 60 * 1000;

function assertUserId(userId: string): string {
  if (!userId || !safeId(userId)) throw new Error('invalid user id');
  return userId;
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function readFile(userId: string): Promise<ConsultationsFile> {
  const raw = await readJson<ConsultationsFile>(userA2AConsultationsFile(assertUserId(userId)));
  const rows = Array.isArray(raw?.consultations) ? raw.consultations : [];
  return {
    version: VERSION,
    consultations: rows.filter((row) => row && typeof row.id === 'string'),
  };
}

async function writeFile(userId: string, rows: A2AConsultationRecord[]): Promise<void> {
  await writeJson(userA2AConsultationsFile(assertUserId(userId)), { version: VERSION, consultations: rows });
}

export async function createConsultation(
  userId: string,
  input: {
    conversationId: string;
    peerUserId: string;
    peerName?: string;
    question: string;
    proposedReply: string;
  },
): Promise<A2AConsultationRecord> {
  const conversationId = bounded(input.conversationId, 120);
  const peerUserId = bounded(input.peerUserId, 128);
  const question = bounded(input.question, 4000);
  const proposedReply = bounded(input.proposedReply, 4000);
  if (!conversationId) throw new Error('conversation id is required');
  if (!peerUserId) throw new Error('peer user id is required');
  if (!question) throw new Error('question is required');
  if (!proposedReply) throw new Error('proposed reply is required');

  const file = await readFile(userId);
  const record: A2AConsultationRecord = {
    id: `acons-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    peerUserId,
    ...(bounded(input.peerName, 120) ? { peerName: bounded(input.peerName, 120) } : {}),
    question,
    proposedReply,
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  await writeFile(userId, [...file.consultations, record]);
  return record;
}

export async function listConsultations(
  userId: string,
  filter?: { conversationId?: string; state?: A2AConsultationState },
): Promise<A2AConsultationRecord[]> {
  const file = await readFile(userId);
  return file.consultations
    .filter((row) => (!filter?.conversationId || row.conversationId === filter.conversationId))
    .filter((row) => (!filter?.state || row.state === filter.state))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Answer a pending consultation.
 *
 * - `approve` sends the proposed wording unchanged;
 * - `revise` needs new wording — the receiver's口径 replaces the assistant's, and
 *   silently falling back to the proposal would send words they never chose;
 * - `decline` sends nothing; the peer is told the question was not answered.
 */
export async function answerConsultation(
  userId: string,
  id: string,
  decision: A2AConsultationDecision,
  text?: string,
): Promise<A2AConsultationRecord | null> {
  const file = await readFile(userId);
  const record = file.consultations.find((row) => row.id === id);
  if (!record) return null;
  if (record.state !== 'pending') throw new Error('consultation is not pending');

  const decidedAt = new Date().toISOString();
  let next: A2AConsultationRecord;
  if (decision === 'revise') {
    const revised = bounded(text, 4000);
    if (!revised) throw new Error('revise requires the new wording');
    next = { ...record, state: 'revised', finalReply: revised, answeredAt: decidedAt };
  } else if (decision === 'approve') {
    next = { ...record, state: 'approved', finalReply: record.proposedReply, answeredAt: decidedAt };
  } else {
    next = { ...record, state: 'declined', answeredAt: decidedAt };
  }

  await writeFile(userId, file.consultations.map((row) => (row.id === id ? next : row)));
  return next;
}

/** Whether the 5-minute nudge window has passed while still pending (D-23). */
export function needsNudge(record: A2AConsultationRecord, now = Date.now()): boolean {
  if (record.state !== 'pending') return false;
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) && now - createdAt >= A2A_CONSULTATION_NUDGE_MS;
}

/**
 * Mark pending consultations whose 5-minute window has passed (D-23).
 *
 * The flag is what the initiator's side turns into「需要 B 本人确认，稍后回复」and
 * what makes the receiver's strip show that the peer is waiting. It is written once
 * (`nudgedAt`) so re-reading does not re-notify.
 */
export async function nudgePendingConsultations(userId: string, now = Date.now()): Promise<A2AConsultationRecord[]> {
  const file = await readFile(userId);
  const nudged: A2AConsultationRecord[] = [];
  const next = file.consultations.map((row) => {
    if (row.nudgedAt || !needsNudge(row, now)) return row;
    const updated: A2AConsultationRecord = { ...row, nudgedAt: new Date(now).toISOString() };
    nudged.push(updated);
    return updated;
  });
  if (nudged.length) await writeFile(userId, next);
  return nudged;
}

/** The text that may be sent to the peer, if any. */
export function outboundConsultationReply(record: A2AConsultationRecord): string | null {
  if (record.state === 'approved' || record.state === 'revised') return record.finalReply || null;
  return null;
}
