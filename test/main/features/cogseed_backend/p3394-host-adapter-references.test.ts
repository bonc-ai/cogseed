/**
 * T1 引用信封化 — buildP3394OutboundEnvelope 的 payload.metadata.references
 * 槽位（Tutti 式 "@" 引用经 P3394 可达）：快照落位、数量/文本截断、与
 * goal 共存、无引用时不产生 metadata.references。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getP3394BridgeInfo: vi.fn(),
  getP3394OutboundHub: vi.fn(),
  resolveP3394Peer: vi.fn(),
}));

vi.mock('../../../../src/main/features/p3394_bridge/app-wiring', () => ({
  getP3394BridgeInfo: mocks.getP3394BridgeInfo,
  getP3394OutboundHub: mocks.getP3394OutboundHub,
  resolveP3394Peer: mocks.resolveP3394Peer,
}));

// isolate: session-store 写 COGSEED_RUNTIME_VARIANT 之下，指向 scratch 变体
process.env.COGSEED_RUNTIME_VARIANT = 'p3394-host-adapter-ref-test-' + Math.random().toString(36).slice(2, 8);

import { buildP3394OutboundEnvelope } from '../../../../src/main/features/cogseed_backend/p3394-host-adapter';

describe('buildP3394OutboundEnvelope › metadata.references (T1)', () => {
  beforeEach(() => {
    mocks.getP3394BridgeInfo.mockReturnValue(null);
    mocks.getP3394OutboundHub.mockReturnValue(null);
    mocks.resolveP3394Peer.mockResolvedValue(null);
  });

  it('carries quote snapshots in payload.metadata.references alongside goal', () => {
    const env = buildP3394OutboundEnvelope('hermes', 'review this', 'src-key', {
      scopeKey: 'conv-ref-1',
      goal: 'req:r1',
      references: [
        { source_cid: 'c1', source_msg_id: 'm1', from_actor: 'user', from_name: '子安', source_ts: 't1', text: '原始需求' },
      ],
    });
    const refs = (env.payload.metadata as { references?: Array<Record<string, unknown>> }).references;
    expect(refs).toHaveLength(1);
    expect(refs![0]).toMatchObject({ source_cid: 'c1', source_msg_id: 'm1', from_actor: 'user', from_name: '子安', text: '原始需求' });
    expect((env.payload.metadata as { goal?: string }).goal).toBe('req:r1');
  });

  it('caps reference count at 20 and per-reference text at 500 chars', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      source_cid: 'c', source_msg_id: `m${i}`, from_actor: 'user', source_ts: 't', text: 'x'.repeat(800),
    }));
    const env = buildP3394OutboundEnvelope('hermes', 'msg', 'src', { scopeKey: 'conv-ref-2', references: many });
    const refs = (env.payload.metadata as { references?: Array<Record<string, unknown>> }).references;
    expect(refs).toHaveLength(20);
    expect(String(refs![0].text).length).toBe(500);
  });

  it('omits metadata.references (and metadata entirely) when no goal and no references', () => {
    const env = buildP3394OutboundEnvelope('hermes', 'plain', 'src', { scopeKey: 'conv-ref-3' });
    expect(env.payload.metadata).toBeUndefined();
  });
});
