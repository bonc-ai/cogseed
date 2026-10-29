/** Durable A2A inbox and answer outbox, in the existing reception ledger.
 * Admission journals before the chat index commit; generation fences make
 * reconciliation safe. Receipts are retained so old message IDs cannot replay.
 * Dispatch/transport uncertainty is retained for inspection, never replayed.
 */
import { createHash } from 'node:crypto';
import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { userA2AReceptionLedgerFile } from '../../paths';
import { fileEditLock } from '../../util/locks';
import { normalizeA2AQuestionText } from './outbound-intent';

export interface ReceptionIdentity {
  messageId: string;
  conversationId: string;
  peerUserId: string;
  text: string;
  generation?: string;
  /** Original relay identity; absent on legacy receipts (never recoverable). */
  toAccount?: string;
  createdAt?: string;
}
export interface ReceptionLedgerEntry extends ReceptionIdentity {
  payloadHash: string;
  generation: string;
  requiresConfirmation?: boolean;
  peerName?: string;
  /**
   * `expired` 是暂存过期的**终态墓碑**：正文已清空，payloadHash 因此不可再校验，
   * 这条记录既不能重放、也不能被恢复成 pending。messageId/conversationId/createdAt
   * 保留下来，用于证明「这条原消息已经过期」，避免 id 被复用。
   */
  status: 'pending' | 'running' | 'uncertain' | 'answered' | 'failed' | 'expired';
  stage: 'admitted' | 'reserved' | 'dispatching' | 'enqueued' | 'answer' | 'sending' | 'sent';
  admission: 'prepared' | 'committed';
  at: string;
  error?: string;
  answer?: { text: string; requestId: string; payloadHash: string; ok: boolean; relayMessageId?: string };
}

/** 暂存过期的脱敏原因（写进台账 `error`，也是会话绑定的 `expired_reason` 口径）。 */
export const RECEPTION_EXPIRED_REASON = 'staging_expired';

export interface ReceptionExpiryIdentity {
  messageId: string;
  conversationId: string;
  peerUserId: string;
}

export function receptionPayloadHash(input: ReceptionIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    input.messageId, input.conversationId, input.peerUserId, normalizeA2AQuestionText(input.text), input.generation,
    ...(input.toAccount !== undefined || input.createdAt !== undefined ? [input.toAccount, input.createdAt] : []),
  ]), 'utf8').digest('hex');
}

export function validReceptionPayload(entry: ReceptionLedgerEntry): boolean {
  return typeof entry.messageId === 'string' && !!entry.messageId.trim()
    && safeId(entry.conversationId) && typeof entry.peerUserId === 'string' && !!entry.peerUserId.trim()
    && safeId(entry.generation) && !!entry.text && normalizeA2AQuestionText(entry.text) === entry.text
    && typeof entry.payloadHash === 'string' && entry.payloadHash === receptionPayloadHash(entry);
}

export function matchesReception(entry: ReceptionLedgerEntry, input: ReceptionIdentity): boolean {
  return validReceptionPayload(entry) && entry.messageId === input.messageId
    && entry.conversationId === input.conversationId && entry.peerUserId === input.peerUserId
    && entry.payloadHash === receptionPayloadHash({ ...input, generation: input.generation ?? entry.generation,
      toAccount: input.toAccount ?? entry.toAccount, createdAt: input.createdAt ?? entry.createdAt });
}

function ledgerFile(userId: string): string {
  if (!safeId(userId)) throw new Error('invalid user id');
  return userA2AReceptionLedgerFile(userId);
}

export async function readReceptionLedger(userId: string): Promise<ReceptionLedgerEntry[]> {
  const raw = await readJson<{ version?: number; entries?: ReceptionLedgerEntry[] }>(ledgerFile(userId), { strict: true }).catch(() => {
    // JSON.parse errors can embed private question/answer fragments. Do not
    // propagate the parser error or its cause into dispatch/recovery logs.
    throw new Error('Reception ledger unreadable; preserved for recovery');
  });
  if (raw && !Object.keys(raw).length) return [];
  if (raw?.version !== 1 || !Array.isArray(raw.entries)
    || raw.entries.some((row) => !row || typeof row.messageId !== 'string')) {
    throw new Error('invalid reception ledger');
  }
  return raw.entries;
}

async function writeLedger(userId: string, entries: ReceptionLedgerEntry[], isCurrent?: () => boolean): Promise<void> {
  await writeJson(ledgerFile(userId), { version: 1, entries }, isCurrent);
}

/** Called inside chat admission authority, before its index write. */
export async function journalReception(userId: string, input: ReceptionIdentity & {
  generation: string; peerName?: string; requiresConfirmation?: boolean;
}, isCurrent?: () => boolean): Promise<boolean> {
  const text = normalizeA2AQuestionText(input.text);
  if (!text || !input.messageId.trim() || !safeId(input.conversationId)
    || !input.peerUserId.trim() || !safeId(input.generation)) return false;
  input = { ...input, text };
  return fileEditLock(ledgerFile(userId)).runExclusive(async () => {
    const entries = await readReceptionLedger(userId);
    if (isCurrent && !isCurrent()) return false;
    const existing = entries.filter((row) => row.messageId === input.messageId);
    if (existing.length) return existing.length === 1 && matchesReception(existing[0], input)
      && existing[0].generation === input.generation;
    entries.push({
      ...input, payloadHash: receptionPayloadHash(input), status: 'pending',
      stage: 'admitted', admission: 'prepared', at: nowIso(),
    });
    if (isCurrent && !isCurrent()) return false;
    await writeLedger(userId, entries, isCurrent);
    return true;
  });
}

/** Replace exactly one matching identity; a collision never replaces its owner. */
export async function updateReceptionEntry(
  userId: string,
  input: ReceptionIdentity & { generation: string },
  mutate: (entry: ReceptionLedgerEntry) => ReceptionLedgerEntry | null,
  isCurrent?: () => boolean,
): Promise<ReceptionLedgerEntry | null> {
  return fileEditLock(ledgerFile(userId)).runExclusive(async () => {
    const entries = await readReceptionLedger(userId);
    if (isCurrent && !isCurrent()) return null;
    const matching = entries.filter((row) => row.messageId === input.messageId);
    if (matching.length !== 1 || !matchesReception(matching[0], input)) return null;
    const current = matching[0];
    const next = mutate(current);
    if (!next || !matchesReception(next, current) || next.requiresConfirmation !== current.requiresConfirmation) return null;
    const updated = { ...next, at: nowIso() };
    entries[entries.indexOf(current)] = updated;
    if (isCurrent && !isCurrent()) return null;
    await writeLedger(userId, entries, isCurrent);
    return updated;
  });
}

/** Invalid/legacy payloads cannot be inferred from a mutable conversation slot. */
export async function quarantineReception(userId: string, messageId: string, error: string): Promise<void> {
  await fileEditLock(ledgerFile(userId)).runExclusive(async () => {
    const entries = await readReceptionLedger(userId);
    for (const entry of entries) {
      // 过期终态不再降级成 uncertain：否则重启恢复会把它当成待处理收据反复改写。
      if (entry.messageId === messageId && entry.status !== 'expired') {
        Object.assign(entry, { status: 'uncertain', error, at: nowIso() });
      }
    }
    await writeLedger(userId, entries);
  });
}

/**
 * 把过期暂存的台账条目收敛成脱敏终态：清空正文，保留 messageId/conversationId/
 * 原消息时间/admission 等身份字段。幂等；已过期且无正文的条目不再重写。
 *
 * 只处理 `pending` / 已 `expired` 的条目：已接受运行（running）、已回答/失败或
 * 不确定的收据不属于「过期清理」，绝不在这里改写。
 */
export async function expireReceptionEntries(
  userId: string,
  identities: ReceptionExpiryIdentity[],
  isCurrent?: () => boolean,
): Promise<number> {
  if (!identities.length) return 0;
  const wanted = new Map(identities.map((row) => [row.messageId, row]));
  return fileEditLock(ledgerFile(userId)).runExclusive(async () => {
    const entries = await readReceptionLedger(userId);
    if (isCurrent && !isCurrent()) return 0;
    let changed = 0;
    for (const entry of entries) {
      const identity = wanted.get(entry.messageId);
      if (!identity || entry.conversationId !== identity.conversationId
        || entry.peerUserId !== identity.peerUserId) continue;
      if (entry.status !== 'pending' && entry.status !== 'expired') continue;
      if (entry.status === 'expired' && entry.text === '' && entry.error === RECEPTION_EXPIRED_REASON) continue;
      entry.text = '';
      entry.status = 'expired';
      entry.error = RECEPTION_EXPIRED_REASON;
      entry.at = nowIso();
      changed += 1;
    }
    if (!changed) return 0;
    if (isCurrent && !isCurrent()) return 0;
    await writeLedger(userId, entries, isCurrent);
    return changed;
  });
}

export function receptionAnswerHash(entry: ReceptionIdentity, text: string): string {
  return createHash('sha256').update(JSON.stringify([
    receptionPayloadHash(entry), 'answer', text,
  ]), 'utf8').digest('hex');
}
