/**
 * Decision 2 · phase-2 outbox ledger (`kind: 'background_result'`).
 *
 * Phase 2 has no reply waiter and no envelope snapshot; it is a terminal
 * notification keyed by job_id. It must still be durable, idempotent, and
 * isolate after repeated conversation-delivery failures.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  compactOutboxFile,
  outboxBackgroundResultDelivered,
  outboxBackgroundResultStatus,
  outboxFilePath,
  outboxListForReplay,
  outboxMarkBackgroundResultDelivered,
  outboxMarkBackgroundResultIsolated,
  outboxRecordBackgroundResult,
  outboxRecordBackgroundResultFailure,
  outboxRequeueBackgroundResult,
  outboxRecordSubmitted,
} from '../../../../src/main/features/p3394_bridge/outbound-outbox';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

// isolate: redirect the whole variant tree to a scratch base instead of
// inventing variant names (runtime-paths validates them now).
const SCRATCH_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-p3394-bg-outbox-'));
process.env.COGSEED_VARIANT_BASE_DIR = SCRATCH_BASE;
process.env.COGSEED_RUNTIME_VARIANT = 'cogseed';

afterAll(() => {
  fs.rmSync(SCRATCH_BASE, { recursive: true, force: true });
});

function envelope(id: string): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
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

describe('p3394 outbox › background_result', () => {
  beforeEach(() => {
    try { fs.unlinkSync(outboxFilePath()); } catch { /* absent */ }
  });

  it('records an attempt, then becomes terminal when delivered (job_id idempotency)', () => {
    expect(outboxBackgroundResultStatus('bg-a-1')).toBeNull();
    expect(outboxRecordBackgroundResult('bg-a-1', 'hermes')).toBe(true);
    expect(outboxBackgroundResultStatus('bg-a-1')).toBe('submitted');
    expect(outboxBackgroundResultDelivered('bg-a-1')).toBe(false);

    outboxMarkBackgroundResultDelivered('bg-a-1');
    expect(outboxBackgroundResultDelivered('bg-a-1')).toBe(true);
    // Duplicate phase 2 after success must not be recorded for delivery again.
    expect(outboxRecordBackgroundResult('bg-a-1', 'hermes')).toBe(false);
  });

  it('counts delivery failures across boots and isolates after the budget', () => {
    expect(outboxRecordBackgroundResult('bg-a-2', 'hermes')).toBe(true);
    expect(outboxRecordBackgroundResultFailure('bg-a-2', 'sink down')).toBe(1);
    // A new boot re-records an attempt, but the budget must NOT reset.
    expect(outboxRecordBackgroundResult('bg-a-2', 'hermes')).toBe(true);
    expect(outboxRecordBackgroundResultFailure('bg-a-2', 'sink down')).toBe(2);
    expect(outboxRecordBackgroundResult('bg-a-2', 'hermes')).toBe(true);
    expect(outboxRecordBackgroundResultFailure('bg-a-2', 'sink down')).toBe(3);

    outboxMarkBackgroundResultIsolated('bg-a-2', 'sink down');
    expect(outboxBackgroundResultStatus('bg-a-2')).toBe('isolated');
    expect(outboxRecordBackgroundResult('bg-a-2', 'hermes')).toBe(false);
    expect(outboxRequeueBackgroundResult('bg-a-2')).toBe(true);
    expect(outboxBackgroundResultStatus('bg-a-2')).toBe('submitted');
    expect(outboxRecordBackgroundResultFailure('bg-a-2', 'still down')).toBe(1);
  });

  it('does not pollute the envelope replay set', () => {
    outboxRecordSubmitted(envelope('e1'), 'hermes');
    outboxRecordBackgroundResult('bg-a-3', 'hermes');
    const replay = outboxListForReplay();
    expect(replay).toHaveLength(1);
    expect(replay[0].message_id).toBe('msg-e1');
  });

  it('compaction keeps background_result rows (otherwise a delivered job would replay)', () => {
    outboxRecordSubmitted(envelope('e2'), 'hermes');
    outboxRecordBackgroundResult('bg-a-4', 'hermes');
    outboxMarkBackgroundResultDelivered('bg-a-4');
    compactOutboxFile(outboxFilePath());
    expect(outboxBackgroundResultDelivered('bg-a-4')).toBe(true);
    expect(outboxListForReplay()).toHaveLength(1);
  });
});
