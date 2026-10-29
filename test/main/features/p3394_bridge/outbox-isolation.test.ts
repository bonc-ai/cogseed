import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compactOutboxFile,
  outboxListForReplay,
  outboxMarkIsolated,
  outboxRecordReplayFailure,
  outboxRequeueIsolated,
  outboxRecordSubmitted,
  outboxReplayDecision,
} from '../../../../src/main/features/p3394_bridge/outbound-outbox';

const cfgErr = 'p3394_peer_has_no_endpoint';

describe('p3394_bridge › outbox isolation', () => {
  let tmp = '';
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('decides isolate after 3 config-level failures, and keeps retrying transients', () => {
    // 三次阈值：前两次仍重试，第三次隔离。
    expect(outboxReplayDecision(cfgErr, 1, 3)).toBe('retry');
    expect(outboxReplayDecision(cfgErr, 2, 3)).toBe('retry');
    expect(outboxReplayDecision(cfgErr, 3, 3)).toBe('isolate');
    // 首次阈值：第一次就隔离。
    expect(outboxReplayDecision(cfgErr, 1, 1)).toBe('isolate');
    // 瞬时错误永远不隔离，任何阈值。
    expect(outboxReplayDecision('dial ECONNREFUSED', 9, 1)).toBe('retry');
    expect(outboxReplayDecision('p3394_peer_not_registered', 1, 3)).toBe('retry');
  });

  it('keeps the envelope of an isolated record when compacting', () => {
    const file = path.join(tmp, 'outbox.jsonl');
    const envelope = { message_id: 'm1', session_id: 's1' };
    fs.writeFileSync(file, [
      JSON.stringify({ at: '2026-10-18T00:00:00Z', message_id: 'm1', kind: 'envelope', peer: 'peer-a', envelope }),
      JSON.stringify({ at: '2026-10-18T00:00:01Z', message_id: 'm1', status: 'isolated', error: cfgErr }),
      JSON.stringify({ at: '2026-10-18T00:00:02Z', message_id: 'm2', kind: 'envelope', peer: 'peer-b', envelope: { message_id: 'm2' } }),
      JSON.stringify({ at: '2026-10-18T00:00:03Z', message_id: 'm2', status: 'completed' }),
    ].join('\n') + '\n', 'utf8');

    compactOutboxFile(file);
    const kept = fs.readFileSync(file, 'utf8');
    expect(kept).toContain('"m1"');        // isolated: envelope preserved
    expect(kept).toContain('"isolated"');  // and its status
    expect(kept).not.toContain('"m2"');    // completed: folded away
  });

  it('drops an isolated record from the replay set', () => {
    const envelope = { message_id: 'iso-1', session_id: 's1', sender: { agent_id: 'cogseed' }, recipients: [] } as never;
    outboxRecordSubmitted(envelope, 'peer-x');
    outboxMarkIsolated('iso-1', cfgErr);
    expect(outboxListForReplay().some((r) => r.message_id === 'iso-1')).toBe(false);
  });
});

describe('p3394_bridge › outbox requeue', () => {
  it('requeues an isolated record, resets its failure count, and re-isolates only after a fresh threshold', () => {
    const envelope = { message_id: 'iso-2', session_id: 's1', sender: { agent_id: 'cogseed' }, recipients: [] } as never;
    outboxRecordSubmitted(envelope, 'peer-y');
    // 3 次配置级失败 → 阈值 3 时隔离
    for (let i = 0; i < 3; i += 1) {
      const attempts = outboxRecordReplayFailure('iso-2', cfgErr);
      expect(outboxReplayDecision(cfgErr, attempts, 3)).toBe(attempts >= 3 ? 'isolate' : 'retry');
    }
    outboxMarkIsolated('iso-2', cfgErr);
    expect(outboxListForReplay().some((r) => r.message_id === 'iso-2')).toBe(false);

    // requeue 回到重放集
    expect(outboxRequeueIsolated('iso-2')).toBe(true);
    expect(outboxListForReplay().some((r) => r.message_id === 'iso-2')).toBe(true);

    // 计数已重置：下一次失败是第 1 次，不会立刻再隔离
    expect(outboxRecordReplayFailure('iso-2', cfgErr)).toBe(1);
    expect(outboxReplayDecision(cfgErr, 1, 3)).toBe('retry');

    // 从未隔离的记录 requeue 无效
    expect(outboxRequeueIsolated('iso-2')).toBe(false);
  });
});
