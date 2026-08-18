import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compactOutboxFile,
  outboxFilePath,
  outboxListForReplay,
  outboxMarkCompleted,
  outboxMarkFailed,
  outboxMarkSent,
  outboxRecordSubmitted,
} from '../../../../src/main/features/p3394_bridge/outbound-outbox';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

const SCRATCH_VARIANT = 'p3394-outbox-test-' + Math.random().toString(36).slice(2, 8);
process.env.ORKAS_RUNTIME_VARIANT = SCRATCH_VARIANT;

function envelope(id: string): P3394Envelope {
  return {
    message_id: 'msg-' + id,
    session_id: 'ses-' + id,
    task_id: 'tsk-' + id,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'hermes' }],
    payload: { parts: [{ type: 'text', text: 'hello' }] },
    idempotency_key: 'idem-' + id,
  };
}

describe('p3394 transactional outbox', () => {
  beforeEach(() => {
    const file = path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT, 'p3394-outbox.jsonl');
    try { fs.unlinkSync(file); } catch { /* absent */ }
  });

  it('submitted records are replayable and carry the envelope snapshot', () => {
    outboxRecordSubmitted(envelope('a'), 'hermes');
    const replay = outboxListForReplay();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ message_id: 'msg-a', peer: 'hermes', status: 'submitted' });
    expect(replay[0].envelope.recipients[0].agent_id).toBe('hermes');
  });

  it('sent (delivered, reply lost) records stay replayable — at-least-once', () => {
    outboxRecordSubmitted(envelope('b'), 'hermes');
    outboxMarkSent('msg-b');
    expect(outboxListForReplay()).toHaveLength(1);
    expect(outboxListForReplay()[0].status).toBe('sent');
  });

  it('completed and failed records leave the replay set', () => {
    outboxRecordSubmitted(envelope('c'), 'hermes');
    outboxMarkSent('msg-c');
    outboxMarkCompleted('msg-c');
    outboxRecordSubmitted(envelope('d'), 'hermes');
    outboxMarkFailed('msg-d', 'ECONNREFUSED');
    expect(outboxListForReplay()).toHaveLength(0);
  });

  it('folds status events per message id (latest wins)', () => {
    outboxRecordSubmitted(envelope('e'), 'hermes');
    outboxMarkFailed('msg-e', 'first failure');
    outboxRecordSubmitted(envelope('e'), 'hermes'); // 重试重新提交
    const replay = outboxListForReplay();
    expect(replay).toHaveLength(1);
    expect(replay[0].status).toBe('submitted');
  });

  it('replayed envelopes preserve the exact semantic message (M-03)', () => {
    const original = { ...envelope('f'), reply_to: 'msg-parent' };
    outboxRecordSubmitted(original, 'hermes');
    outboxMarkSent('msg-f');
    const replay = outboxListForReplay();
    expect(replay).toHaveLength(1);
    // 重放快照与原始信封完全一致：重试/重放不产生新的语义 Message，
    // message_id / idempotency_key / reply_to 全部保持原值。
    expect(replay[0].envelope).toEqual(original);
    expect(replay[0].envelope.message_id).toBe('msg-f');
    expect(replay[0].envelope.idempotency_key).toBe('idem-f');
    expect(replay[0].envelope.reply_to).toBe('msg-parent');
  });

  it('P1-4 fail-closed: a write failure is surfaced, not silently swallowed', () => {
    // 用目录顶替 outbox 文件路径 → openSync 'a' 必然失败（EISDIR）。
    // 修复前 appendSecure 的 catch 会静默吞掉写入错误并继续，记录丢失无人知晓。
    const file = outboxFilePath();
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    try {
      expect(() => outboxMarkSent('msg-fail-closed')).toThrow();
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  it('P1-4 compact: folds to the active replay set with an atomic replacement (no truncation, no tmp residue)', () => {
    // active：c1（sent）+ c2（submitted）应保留；terminal：c3（completed）+
    // c4（failed）应被折叠丢弃。
    outboxRecordSubmitted(envelope('c1'), 'hermes');
    outboxMarkSent('msg-c1');
    outboxRecordSubmitted(envelope('c2'), 'hermes');
    outboxRecordSubmitted(envelope('c3'), 'hermes');
    outboxMarkSent('msg-c3');
    outboxMarkCompleted('msg-c3');
    outboxRecordSubmitted(envelope('c4'), 'hermes');
    outboxMarkFailed('msg-c4', 'gone');

    const file = outboxFilePath();
    const outcome = compactOutboxFile(file);

    expect(outboxListForReplay().map((r) => r.message_id).sort()).toEqual(['msg-c1', 'msg-c2']);
    expect(outcome.after).toBeLessThan(outcome.before);
    // 原子替换后文件仍是合法 JSONL、权限保持 0600、无残留临时文件。
    expect(outboxListForReplay()).toHaveLength(2);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter((name) => name.includes('compact.tmp'))).toHaveLength(0);
    // 幂等：再次 compact 不改变重放集（文件未被截断/损坏）。
    compactOutboxFile(file);
    expect(outboxListForReplay().map((r) => r.message_id).sort()).toEqual(['msg-c1', 'msg-c2']);
  });
});
