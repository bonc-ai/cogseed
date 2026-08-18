/**
 * P3394 Transactional Outbox（指南 §12 第 8 步）——出站信封先落盘再发送，
 * 桥重启后把未确认的信封重放（at-least-once + 对端幂等去重）。
 *
 * 状态机：submitted（已落盘未送达）→ sent（已送达等回复）→ completed
 * （收到回复）| failed（投递失败）。重放集 = submitted + sent（sent 但回复
 * 丢失时重发，对端按 idempotency_key 幂等）。
 *
 * 存储为追加式 JSONL（事件溯源）：每条状态变化追加一行，读取时按
 * message_id 折叠出最新状态——简单、原子、可恢复。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import { p3394StateFile } from './runtime-paths';
import { redactP3394Secrets } from './secrets';
import type { P3394Envelope } from './envelope';

const log = createLogger('p3394-bridge:outbound-outbox');

/** Append with a private 0600 file (outbox snapshots carry the bridge
 *  token in extensions.reply_token — it must not be world-readable).
 *  openSync mode applies on create; chmodSync reasserts it on existing.
 *  P1-4: fail-closed — a swallowed write here would silently drop the
 *  at-least-once record that must be replayed after a crash. Any write error
 *  propagates to the caller so the omission cannot go unnoticed. */
function appendSecure(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  // chmod is defense-in-depth on the 0600 guarantee, not the write itself —
  // a chmod failure alone must not fail the append.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export type P3394OutboxStatus = 'submitted' | 'sent' | 'completed' | 'failed';

export interface P3394OutboxRecord {
  message_id: string;
  session_id: string;
  peer: string;
  envelope: P3394Envelope;
  status: P3394OutboxStatus;
  created_at: string;
  updated_at: string;
  error?: string;
}

interface P3394OutboxEvent {
  at: string;
  message_id: string;
  status: P3394OutboxStatus;
  error?: string;
}

export function outboxFilePath(): string {
  return p3394StateFile('p3394-outbox.jsonl');
}

/** L-01：outbox 是追加式事件溯源，长运行后无限增长。超过此阈值时折叠
 *  为"仅 active（submitted/sent）重放集"，丢弃已 terminal 的历史记录。
 *  outbox 是运行机制而非审计归档，重放集完整保留即不破坏 at-least-once。 */
const OUTBOX_COMPACT_BYTES = 5 * 1024 * 1024;
let outboxCompactCounter = 0;

/**
 * 折叠给定 outbox 文件为「仅 active（submitted/sent）重放集」，并做原子
 * 替换：先写同目录唯一临时文件（同文件系统），完整写出成功后 rename 覆盖。
 *
 * P1-4：旧的实现直接 `writeFileSync(file, …)` 覆盖原文件——非原子，进程在
 * 写入中途崩溃会截断整个 outbox（丢失所有未折叠的重放记录）。rename 在
 * POSIX 上原子：要么得到完整新文件、要么原文件原样保留，绝不截断。
 * 替换失败时抛出，由调用方决定（maybeCompactOutbox → warn 并继续追加写入）。
 */
export function compactOutboxFile(file: string): { before: number; after: number } {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const envelopes = new Map<string, { peer: string; envelope: P3394Envelope }>();
  const statuses = new Map<string, P3394OutboxEvent>();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as P3394OutboxEvent & { kind?: string; peer?: string; envelope?: P3394Envelope };
      if (event.kind === 'envelope' && event.message_id && event.envelope) {
        envelopes.set(event.message_id, { peer: event.peer || '', envelope: event.envelope });
      } else if (event.message_id && event.status) {
        statuses.set(event.message_id, { at: event.at, message_id: event.message_id, status: event.status, ...(event.error ? { error: event.error } : {}) });
      }
    } catch { /* skip malformed */ }
  }
  const keep: string[] = [];
  for (const [messageId, snapshot] of envelopes) {
    const status = statuses.get(messageId)?.status;
    if (!status || status === 'submitted' || status === 'sent') {
      keep.push(JSON.stringify({ at: statuses.get(messageId)?.at ?? new Date().toISOString(), message_id: messageId, kind: 'envelope', peer: snapshot.peer, envelope: snapshot.envelope }));
      if (status) keep.push(JSON.stringify(statuses.get(messageId)));
    }
  }
  // 唯一 tmp 名：避免并发 compact / 其它写者撞同一个 .tmp 文件。
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.compact.tmp`;
  try {
    fs.writeFileSync(tmp, keep.join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
  } catch (error) {
    // 临时文件写出/rename 失败：清理残留 tmp，原文件保持原样（原子性保证）。
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return { before: lines.length, after: keep.length };
}

function maybeCompactOutbox(): void {
  // 概率摊薄 stat 成本，但仍保证最终触发。
  outboxCompactCounter = (outboxCompactCounter + 1) % 256;
  if (outboxCompactCounter !== 0) return;
  const file = outboxFilePath();
  try { if (fs.statSync(file).size < OUTBOX_COMPACT_BYTES) return; } catch { return; }
  try {
    const outcome = compactOutboxFile(file);
    log.info('P3394 outbox compacted', { before: outcome.before, after: outcome.after });
  } catch (error) {
    // compact 失败不阻塞追加写入继续（原子替换已保证原文件未被破坏）。
    log.warn('P3394 outbox compact failed (append-only continues)', { error: error instanceof Error ? error.message : String(error) });
  }
}

function appendEvent(event: P3394OutboxEvent): void {
  appendSecure(outboxFilePath(), redactP3394Secrets(JSON.stringify(event)) + '\n');
  maybeCompactOutbox();
}

/** 落盘提交：submitted 事件 + 信封快照（同一文件内嵌信封，便于重放）。
 *  依赖 0600 文件权限保护 token 扩展字段；追加一行正则兜底防 token 串进
 *  事件字段。 */
export function outboxRecordSubmitted(envelope: P3394Envelope, peer: string): void {
  const now = new Date().toISOString();
  appendEvent({ at: now, message_id: envelope.message_id, status: 'submitted' });
  // 信封快照只随 submitted 事件存储一次（信封不可变）。
  appendSecure(outboxFilePath(), JSON.stringify({ at: now, message_id: envelope.message_id, kind: 'envelope', peer, envelope }) + '\n');
}

export function outboxMarkSent(messageId: string): void {
  appendEvent({ at: new Date().toISOString(), message_id: messageId, status: 'sent' });
}

export function outboxMarkCompleted(messageId: string): void {
  appendEvent({ at: new Date().toISOString(), message_id: messageId, status: 'completed' });
}

export function outboxMarkFailed(messageId: string, error: string): void {
  // 错误串可能携带 Bearer/key=value 等位置化 secret，落盘前统一脱敏。
  appendEvent({ at: new Date().toISOString(), message_id: messageId, status: 'failed', error: sanitizeLogTextForUpload(String(error)).slice(0, 300) });
}

/** 重放集：submitted / sent 状态的记录（按 message_id 折叠最新状态），
 *  重启后桥据此把未确认的出站信封重发。 */
export function outboxListForReplay(): P3394OutboxRecord[] {
  const file = outboxFilePath();
  if (!fs.existsSync(file)) return [];
  const envelopes = new Map<string, { peer: string; envelope: P3394Envelope; at: string }>();
  const statuses = new Map<string, P3394OutboxEvent>();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as P3394OutboxEvent & { kind?: string; peer?: string; envelope?: P3394Envelope };
      if (event.kind === 'envelope') {
        envelopes.set(event.message_id, { peer: event.peer || '', envelope: event.envelope as P3394Envelope, at: event.at });
        continue;
      }
      if (event.message_id && event.status) statuses.set(event.message_id, event);
    }
  } catch (error) {
    log.warn('P3394 outbox read failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
  const out: P3394OutboxRecord[] = [];
  for (const [messageId, snapshot] of envelopes) {
    const status = statuses.get(messageId);
    if (!status) continue;
    if (status.status !== 'submitted' && status.status !== 'sent') continue;
    out.push({
      message_id: messageId,
      session_id: snapshot.envelope.session_id,
      peer: snapshot.peer,
      envelope: snapshot.envelope,
      status: status.status,
      created_at: snapshot.at,
      updated_at: status.at,
      ...(status.error ? { error: status.error } : {}),
    });
  }
  return out;
}
