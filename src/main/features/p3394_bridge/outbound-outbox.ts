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
import type { P3394Envelope } from './envelope';

const log = createLogger('p3394-bridge:outbound-outbox');

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

function appendEvent(event: P3394OutboxEvent): void {
  const file = outboxFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

/** 落盘提交：submitted 事件 + 信封快照（同一文件内嵌信封，便于重放）。 */
export function outboxRecordSubmitted(envelope: P3394Envelope, peer: string): void {
  const now = new Date().toISOString();
  appendEvent({ at: now, message_id: envelope.message_id, status: 'submitted' });
  // 信封快照只随 submitted 事件存储一次（信封不可变）。
  fs.appendFileSync(outboxFilePath(), JSON.stringify({ at: now, message_id: envelope.message_id, kind: 'envelope', peer, envelope }) + '\n');
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
