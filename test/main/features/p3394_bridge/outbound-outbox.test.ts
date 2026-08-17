import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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
});
