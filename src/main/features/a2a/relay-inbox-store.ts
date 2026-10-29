/**
 * A2A 入站暂存（T3.3）：relay 拉到的正文先持久化，再校验关系与进入接待。
 *
 * 为什么需要它：`GET /api/v1/a2a/relay/messages` 是投递即删除。在此之前，
 * 一条消息若因为关系缓存未命中、Hub 暂时不可达或进程退出而没被受理，就永久
 * 消失了，对端只能重发——也就是现场看到的「首问要发两次」。
 *
 * 边界（R1，不夸大）：
 * - 只保护「响应已成功落盘之后」的恢复。拉取响应丢失、落盘前退出、Hub 重启
 *   丢内存队列都不在覆盖范围内。
 * - 不重放执行状态不确定的模型调用：这里只暂存**未进入接待**的原始消息。
 * - 正文只在本机 `local/` 域，不进同步域；日志与终止原因一律不带正文。
 */

import * as crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { createLogger } from '../../logger';
import { userA2ARelayInboxFile } from '../../paths';
import { readJson, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';

const log = createLogger('a2a-relay-inbox');

/** 单条正文上限，与 Hub 的字符串长度口径对齐（`a2a-relay.ts::MAX_TEXT`）。 */
export const RELAY_INBOX_MAX_TEXT = 4000;
/** 每个接收身份最多保留的待校验条数，沿用 relay 的容量口径。 */
export const RELAY_INBOX_CAPACITY = 50;
/** 有效期：自**原消息时间**起 10 分钟；重启或重试都不续期。 */
export const RELAY_INBOX_TTL_MS = 10 * 60 * 1000;
/** Terminal metadata lasts ten minutes beyond the later of original expiry or
 *  first persistence, at most 500 rows. Duplicates/settlement never renew it. */
export const RELAY_INBOX_TERMINAL_CAPACITY = 500;

const VERSION = 1;

export type InboxEntryState = 'waiting' | 'conflict' | 'terminated';

export interface InboxEntry {
  messageId: string;
  conversationId: string;
  fromAccount: string;
  /** Absent only in legacy records, which cannot be recovered as this account. */
  toAccount?: string;
  fromName?: string;
  /** 待校验正文。只在 waiting 期间保留；终止后清空。 */
  text: string;
  /** 载荷摘要：同 id 同摘要＝重复投递，同 id 异摘要＝冲突。 */
  payloadDigest: string;
  /** 原消息时间（TTL 起点，不因重启或重试改变）。 */
  receivedAt?: string;
  expiresAt?: string;
  state: InboxEntryState;
  /** 终止/冲突原因，不含正文。 */
  reason?: string;
  createdAt: string;
}

export interface WaitingInboxEntry extends InboxEntry {
  state: 'waiting';
  toAccount: string;
  receivedAt: string;
  expiresAt: string;
}

interface InboxFile {
  version: number;
  entries: InboxEntry[];
}

export interface StageInput {
  messageId: string;
  conversationId: string;
  fromAccount: string;
  toAccount?: string;
  fromName?: string;
  text: string;
  /** Required original Hub timestamp. Missing/invalid values are rejected. */
  receivedAt?: string;
}

export interface StageResult {
  waiting: number;
  duplicate: number;
  conflict: number;
  /** 因过期或容量被拒的条数（已留下不含正文的终止记录）。 */
  terminated: number;
  /** Only persisted, eligible canonical records from this batch. */
  eligible: WaitingInboxEntry[];
}

function digestOf(input: Pick<StageInput, 'conversationId' | 'fromAccount' | 'toAccount' | 'text' | 'receivedAt'>): string {
  const timestamp = Date.parse(String(input.receivedAt || ''));
  const receivedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : input.receivedAt;
  return crypto.createHash('sha256')
    .update(JSON.stringify([input.conversationId, input.fromAccount, input.toAccount, input.text, receivedAt]))
    .digest('hex');
}

async function readInbox(userId: string): Promise<InboxFile> {
  const path = userA2ARelayInboxFile(userId);
  if (!existsSync(path)) return { version: VERSION, entries: [] };
  const file = await readJson<InboxFile>(path, { strict: true }).catch(() => {
    // JSON parser diagnostics can contain fragments of the private payload.
    throw new Error('Relay inbox unreadable; preserved for recovery');
  });
  if (file?.version !== VERSION || !Array.isArray(file.entries)
    || file.entries.some((entry) => !entry || typeof entry.messageId !== 'string' || !entry.messageId
      || typeof entry.conversationId !== 'string' || !entry.conversationId
      || typeof entry.fromAccount !== 'string' || !entry.fromAccount
      || typeof entry.text !== 'string' || typeof entry.payloadDigest !== 'string'
      || !['waiting', 'conflict', 'terminated'].includes(entry.state)
      || !Number.isFinite(Date.parse(entry.createdAt))
      || (entry.state === 'waiting' && (!entry.receivedAt || !entry.expiresAt))
      || (entry.receivedAt !== undefined && !Number.isFinite(Date.parse(entry.receivedAt)))
      || (entry.expiresAt !== undefined && !Number.isFinite(Date.parse(entry.expiresAt)))
      || (entry.toAccount !== undefined && (typeof entry.toAccount !== 'string' || !entry.toAccount)))) {
    throw new Error('Invalid relay inbox; preserved for recovery');
  }
  // Terminal rows no longer own plaintext. Legacy unscoped rows are never
  // recoverable; maintenance terminates them without inventing a new digest.
  if (file.entries.some((entry) => entry.state === 'waiting' && entry.toAccount
    && entry.payloadDigest !== digestOf(entry))) {
    throw new Error('Invalid relay inbox digest; preserved for recovery');
  }
  return file;
}

async function writeInbox(userId: string, entries: InboxEntry[], isCurrent?: () => boolean): Promise<void> {
  await writeJson(userA2ARelayInboxFile(userId), { version: VERSION, entries }, isCurrent);
}

/** 终止一条记录：清空正文，只留状态与原因。 */
function terminate(entry: InboxEntry, reason: string, state: InboxEntryState = 'terminated'): InboxEntry {
  return { ...entry, state, reason, text: '' };
}

function newestFirst(a: InboxEntry, b: InboxEntry): number {
  return String(b.receivedAt).localeCompare(String(a.receivedAt));
}

function maintain(entries: InboxEntry[], now: number): InboxEntry[] {
  const current = entries.map((entry) => {
    if (entry.state !== 'waiting') return entry;
    if (!entry.toAccount) return terminate(entry, 'recipient_unscoped');
    if (entry.text.length > RELAY_INBOX_MAX_TEXT) return terminate(entry, 'oversize');
    if (!entry.expiresAt || !entry.receivedAt
      || Date.parse(entry.expiresAt) !== Date.parse(entry.receivedAt) + RELAY_INBOX_TTL_MS) {
      return terminate(entry, 'invalid_timestamp');
    }
    return now < Date.parse(entry.expiresAt) ? entry : terminate(entry, 'expired');
  });
  const waiting = current.filter((entry) => entry.state === 'waiting');
  const terminal = current.filter((entry) => entry.state !== 'waiting'
    && now < Math.max(Date.parse(entry.createdAt), Date.parse(entry.expiresAt ?? entry.createdAt)) + RELAY_INBOX_TTL_MS)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RELAY_INBOX_TERMINAL_CAPACITY);
  return [...waiting, ...terminal].sort(newestFirst);
}

/**
 * 把一次拉取的入站消息写进暂存。
 *
 * 先落盘再校验关系是 T3 的顺序要求：暂存成功之后进程退出才谈得上恢复。
 */
export async function stageInboundMessages(
  userId: string,
  inputs: StageInput[],
  options: { now?: number; isCurrent?: () => boolean } = {},
): Promise<StageResult> {
  return fileEditLock(userA2ARelayInboxFile(userId)).runExclusive(async () => {
    const now = options.now ?? Date.now();
    const file = await readInbox(userId);
    const result: StageResult = { waiting: 0, duplicate: 0, conflict: 0, terminated: 0, eligible: [] };
    const keyOf = (entry: { messageId: string; toAccount?: string }) => JSON.stringify([entry.toAccount || undefined, entry.messageId]);
    const byId = new Map(maintain(file.entries, now).map((entry) => [keyOf(entry), entry]));

    for (const input of inputs) {
      const messageId = String(input.messageId || '').trim();
      const text = typeof input.text === 'string' ? input.text : '';
      const conversationId = String(input.conversationId || '').trim();
      const fromAccount = String(input.fromAccount || '').trim();
      const toAccount = String(input.toAccount || '').trim();
      if (!messageId || !conversationId || !fromAccount || !text) continue;

      const payloadDigest = digestOf({ conversationId, fromAccount, toAccount, text, receivedAt: input.receivedAt });
      const key = keyOf({ messageId, toAccount });
      const existing = byId.get(key);
      if (existing) {
        if (existing.payloadDigest === payloadDigest) {
          result.duplicate += 1;
          if (existing.state === 'waiting') result.eligible.push(existing as WaitingInboxEntry);
        } else {
          // 同 id 异载荷：**不动原消息**，另记一条不含正文的冲突墓碑。
          // 覆盖原项会让已排队的那份消失；静默丢弃又不留下可解释的原因。
          const tombstoneId = `${messageId}#conflict:${payloadDigest.slice(0, 8)}`;
          const tombstoneKey = keyOf({ messageId: tombstoneId, toAccount });
          if (!byId.has(tombstoneKey)) {
            byId.set(tombstoneKey, {
              messageId: tombstoneId,
              conversationId,
              fromAccount,
              ...(toAccount ? { toAccount } : {}),
              text: '',
              payloadDigest,
              receivedAt: existing.receivedAt,
              expiresAt: existing.expiresAt,
              state: 'conflict',
              reason: 'payload_conflict',
              createdAt: existing.createdAt,
            });
          }
          result.conflict += 1;
        }
        continue;
      }

      const parsedTime = Date.parse(String(input.receivedAt || ''));
      const validTime = Number.isFinite(parsedTime)
        && Number.isFinite(new Date(parsedTime + RELAY_INBOX_TTL_MS).getTime());
      const expiresMs = parsedTime + RELAY_INBOX_TTL_MS;
      const entry: InboxEntry = {
        messageId,
        conversationId,
        fromAccount,
        ...(toAccount ? { toAccount } : {}),
        ...(input.fromName ? { fromName: String(input.fromName) } : {}),
        text,
        payloadDigest,
        ...(validTime ? {
          receivedAt: new Date(parsedTime).toISOString(),
          expiresAt: new Date(expiresMs).toISOString(),
        } : {}),
        state: 'waiting',
        createdAt: new Date(now).toISOString(),
      };
      const waiting = [...byId.values()].filter((row) => row.state === 'waiting' && row.toAccount === toAccount);
      const reason = !toAccount ? 'recipient_unscoped' : !validTime ? 'invalid_timestamp'
        : text.length > RELAY_INBOX_MAX_TEXT ? 'oversize' : now >= expiresMs ? 'expired'
          : waiting.length >= RELAY_INBOX_CAPACITY ? 'capacity' : undefined;
      if (reason) {
        byId.set(key, terminate(entry, reason));
        result.terminated += 1;
        continue;
      }
      byId.set(key, entry);
      result.waiting += 1;
      result.eligible.push(entry as WaitingInboxEntry);
    }

    if (options.isCurrent && !options.isCurrent()) throw new Error('Relay identity changed');
    await writeInbox(userId, maintain([...byId.values()], now), options.isCurrent);
    if (result.terminated) {
      log.warn('relay inbox terminated inbound messages', {
        rejectedCount: result.terminated,
      });
    }
    return result;
  });
}

/**
 * 取出仍未处理、且仍在有效期内的暂存项；顺手把已过期的转成终止态。
 *
 * 返回的条目仍带正文，调用方进入接待后必须 `settleInboxEntry`。
 */
export async function listWaitingInbox(
  userId: string,
  options: { now?: number; toAccount?: string; isCurrent?: () => boolean } = {},
): Promise<WaitingInboxEntry[]> {
  return fileEditLock(userA2ARelayInboxFile(userId)).runExclusive(async () => {
    const now = options.now ?? Date.now();
    const file = await readInbox(userId);
    const entries = maintain(file.entries, now);
    if (options.isCurrent && !options.isCurrent()) throw new Error('Relay identity changed');
    if (JSON.stringify(entries) !== JSON.stringify(file.entries)) await writeInbox(userId, entries, options.isCurrent);
    return entries
      .filter((entry): entry is WaitingInboxEntry => entry.state === 'waiting' && !!entry.text
        && (!options.toAccount || entry.toAccount === options.toAccount))
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  });
}

/**
 * 结算一条暂存：`done` 表示已进入接待（或权威判定为非联系人），正文不再保留。
 * 未结算的项会在下一轮轮询被重试。
 */
export async function settleInboxEntry(
  userId: string,
  messageId: string,
  reason: string,
  options: { toAccount?: string; payloadDigest?: string; isCurrent?: () => boolean } = {},
): Promise<boolean> {
  return fileEditLock(userA2ARelayInboxFile(userId)).runExclusive(async () => {
    const file = await readInbox(userId);
    let found = false;
    const entries = file.entries.map((entry) => {
      if (entry.messageId !== messageId || entry.state !== 'waiting'
        || (options.toAccount && entry.toAccount !== options.toAccount)
        || (options.payloadDigest && entry.payloadDigest !== options.payloadDigest)) return entry;
      found = true;
      return terminate(entry, reason);
  });
  if (options.isCurrent && !options.isCurrent()) return false;
  if (found) await writeInbox(userId, maintain(entries, Date.now()), options.isCurrent);
  return found;
  });
}
