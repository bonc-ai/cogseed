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
import { fileEditLock } from '../../util/locks';

export const A2A_CONSULTATION_STATES = ['pending', 'approved', 'revised', 'declined', 'expired'] as const;
export type A2AConsultationState = typeof A2A_CONSULTATION_STATES[number];

export type A2AConsultationDecision = 'approve' | 'revise' | 'decline';
export type ConsultationCreationError = 'INVALID_INPUT' | 'INTENT_UNAVAILABLE';

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
  /** Owner may revise or decline a failed request, but cannot approve it. */
  creationError?: ConsultationCreationError;
  state: A2AConsultationState;
  createdAt: string;
  answeredAt?: string;
  /** The receiver's final wording when they revised; otherwise the proposed text. */
  finalReply?: string;
  /** When the 5-minute nudge fired (D-23); set once so it is not re-sent. */
  nudgedAt?: string;
  /** Host-only binding; legacy unbound rows are never delivered. */
  sourceMessageId?: string;
  turnId?: string;
  toAccount?: string;
  generation?: string;
  workspace?: string;
  delivery?: ConsultationDelivery;
  nudgeDelivery?: ConsultationDelivery;
}

export interface ConsultationDelivery {
  state: 'prepared' | 'sending' | 'sent' | 'failed' | 'uncertain';
  requestId: string;
  text: string;
  payloadHash: string;
  relayMessageId?: string;
  error?: string;
  /** Nudge attempts are persisted before POST; unknown effects never retry. */
  attempts?: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
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
  const raw = await readJson<ConsultationsFile>(userA2AConsultationsFile(assertUserId(userId)), { strict: true }).catch(() => {
    throw new Error('Consultations file unreadable; preserved for recovery');
  });
  if (raw && Object.keys(raw).length && (raw.version !== VERSION || !Array.isArray(raw.consultations))) throw new Error('invalid consultations file');
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
    sourceMessageId?: string;
    turnId?: string;
    toAccount?: string;
    generation?: string;
    workspace?: string;
    /** Restored from the local creation journal; never reset on recovery. */
    createdAt?: string;
    creationError?: ConsultationCreationError;
  },
): Promise<A2AConsultationRecord> {
  const conversationId = bounded(input.conversationId, 120);
  const peerUserId = bounded(input.peerUserId, 128);
  const question = bounded(input.question, 4000);
  const proposedReply = bounded(input.proposedReply, 4000);
  if (!conversationId) throw new Error('conversation id is required');
  if (!peerUserId) throw new Error('peer user id is required');
  if (!question) throw new Error('question is required');
  if (!proposedReply && !input.creationError) throw new Error('proposed reply is required');
  if (input.createdAt !== undefined && !Number.isFinite(Date.parse(input.createdAt))) throw new Error('invalid consultation creation time');

  return fileEditLock(userA2AConsultationsFile(assertUserId(userId))).runExclusive(async () => {
    const file = await readFile(userId);
    const previous = input.sourceMessageId && file.consultations.find(row => row.sourceMessageId === input.sourceMessageId && row.conversationId === conversationId);
    if (previous) return previous;
    const record: A2AConsultationRecord = {
      id: `acons-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      peerUserId,
      ...(bounded(input.peerName, 120) ? { peerName: bounded(input.peerName, 120) } : {}),
      question,
      proposedReply,
      ...(input.creationError ? { creationError: input.creationError } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId, turnId: input.turnId, toAccount: input.toAccount, generation: input.generation, workspace: input.workspace } : {}),
      state: 'pending',
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await writeFile(userId, [...file.consultations, record]);
    return record;
  });
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

/** Atomic mutation shared by local decisions and the delivery service. */
export async function updateConsultation(
  userId: string, id: string,
  update: (record: A2AConsultationRecord) => A2AConsultationRecord,
): Promise<A2AConsultationRecord | null> {
  return fileEditLock(userA2AConsultationsFile(assertUserId(userId))).runExclusive(async () => {
    const file = await readFile(userId);
    const record = file.consultations.find(row => row.id === id);
    if (!record) return null;
    const next = update(record);
    await writeFile(userId, file.consultations.map(row => row.id === id ? next : row));
    return next;
  });
}

/** Local-only decision primitive. Production IPC uses the delivery service. */
export async function answerConsultation(
  userId: string, id: string, decision: A2AConsultationDecision, text?: string,
): Promise<A2AConsultationRecord | null> {
  return updateConsultation(userId, id, record => {
    if (!['approve', 'revise', 'decline'].includes(decision)) throw new Error('invalid consultation decision');
    if (record.state !== 'pending') throw new Error('consultation is not pending');
    if (decision === 'approve' && (record.creationError || !record.proposedReply.trim())) throw new Error('consultation requires revised wording or refusal');
    const finalReply = decision === 'revise' ? bounded(text, 4000) : decision === 'approve' ? record.proposedReply : undefined;
    if (decision === 'revise' && !finalReply) throw new Error('revise requires the new wording');
    return { ...record, state: decision === 'approve' ? 'approved' : decision === 'revise' ? 'revised' : 'declined',
      ...(finalReply ? { finalReply } : {}), answeredAt: new Date().toISOString() };
  });
}

/** Whether the 5-minute nudge window has passed while still pending (D-23). */
export function needsNudge(record: A2AConsultationRecord, now = Date.now()): boolean {
  if (record.state !== 'pending') return false;
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) && now - createdAt >= A2A_CONSULTATION_NUDGE_MS;
}

/**
 * Legacy local marker primitive. Production uses consultation-service recovery
 * to persist an outbox receipt and mark nudgedAt only after relay acknowledgement.
 *
 * The flag is what the initiator's side turns into「需要 B 本人确认，稍后回复」and
 * what makes the receiver's strip show that the peer is waiting. It is written once
 * (`nudgedAt`) so re-reading does not re-notify.
 */
export async function nudgePendingConsultations(userId: string, now = Date.now()): Promise<A2AConsultationRecord[]> {
  return fileEditLock(userA2AConsultationsFile(assertUserId(userId))).runExclusive(async () => {
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
  });
}

/** The text that may be sent to the peer, if any. */
export function outboundConsultationReply(record: A2AConsultationRecord): string | null {
  if (record.state === 'approved' || record.state === 'revised') return record.finalReply || null;
  return null;
}
