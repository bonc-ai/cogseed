/**
 * P3394 peer-forward unit tests — the CogSeed-hosted relay for
 * "gateway A calls gateway B" without widening the gateway trust surface.
 *
 * All deps are injected fakes, so the tests cover the forwarding decision
 * logic (identity gates, idempotency state machine, hop budget, audit,
 * relay shape + delivery-only relay) without network.
 */
import { describe, expect, it } from 'vitest';
import { MAX_FORWARD_HOPS, forwardEnvelopeToPeer, type P3394PeerForwardDeps } from '../../../../src/main/features/p3394_bridge/peer-forward';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function makeEnvelope(overrides: Partial<P3394Envelope> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-1',
    session_id: 'ses-1',
    task_id: 'tsk-1',
    kind: 'task',
    performative: 'request',
    role: 'requester',
    sender: { agent_id: 'node-a' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'please review' }] },
    idempotency_key: 'idem-1',
    ...overrides,
  };
}

interface Call { agentId: string; envelope: P3394Envelope }

/** 幂等账本 fake：与 app-wiring 同构的 pending/completed 状态机（P1-2）。 */
function makeDeps(overrides: Partial<P3394PeerForwardDeps> = {}): {
  deps: P3394PeerForwardDeps;
  /** sendAndWait 调用（转发到目标的等待调用）。 */
  calls: Call[];
  /** sendOnce 调用（回发 sender 的 delivery-only 中继）。 */
  sendOnceCalls: Call[];
  audit: Array<Record<string, unknown>>;
  completed: Set<string>;
  pending: Set<string>;
} {
  const calls: Call[] = [];
  const sendOnceCalls: Call[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const completed = new Set<string>();
  const pending = new Set<string>();
  const registered = new Map<string, { identity: { agent_id: string }; endpoints?: string[] }>([
    ['node-a', { identity: { agent_id: 'node-a' }, endpoints: ['http://127.0.0.1:9100'] }],
    ['node-b', { identity: { agent_id: 'node-b' }, endpoints: ['http://127.0.0.1:9200'] }],
    // 远程/非回环 target（H-03：默认不可转发，需显式授权）。
    ['node-remote', { identity: { agent_id: 'node-remote' }, endpoints: ['http://192.0.2.50:9000'] }],
  ]);
  const deps: P3394PeerForwardDeps = {
    resolveAgent: (id) => {
      const value = registered.get(id);
      return value ? { ok: true as const, value } : { ok: false as const, error: 'not_found' };
    },
    sendAndWait: async (agentId, envelope) => {
      calls.push({ agentId, envelope });
      return { text: agentId === 'node-b' ? 'B reviewed: ok' : 'relay delivered to A' };
    },
    sendOnce: async (agentId, envelope) => {
      sendOnceCalls.push({ agentId, envelope });
    },
    audit: (record) => { audit.push(record as unknown as Record<string, unknown>); },
    isDuplicate: (key) => completed.has(key) || pending.has(key),
    markPending: (key) => { pending.add(key); },
    markCompleted: (key) => { pending.delete(key); completed.add(key); },
    markFailed: (key) => { pending.delete(key); },
    bridgeInfo: { endpoint: 'http://127.0.0.1:8444', token: 'bridge-token' },
    ...overrides,
  };
  return { deps, calls, sendOnceCalls, audit, completed, pending };
}

describe('P3394 peer forwarding', () => {
  it('forwards to a registered target with the bridge reply endpoint and relays the reply to the sender', async () => {
    const { deps, calls, sendOnceCalls, audit } = makeDeps();
    const envelope = makeEnvelope();

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: true });
    // Hop 1: to the target via sendAndWait (a real reply is expected).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe('node-b');
    expect(calls[0]!.envelope.recipients).toEqual([{ agent_id: 'node-b' }]);
    expect(calls[0]!.envelope.extensions).toMatchObject({
      reply_endpoint: 'http://127.0.0.1:8444',
      reply_token: 'bridge-token',
      forward_from: 'node-a',
    });
    expect(calls[0]!.envelope.idempotency_key).toBe('idem-1');
    // M-03: 转发段用派生 session，避免与原 session 争用出站 waiter。
    expect(calls[0]!.envelope.session_id).toBe('fwd:ses-1');
    // First leg is hop #1 → the forwarded envelope carries hop_count = 1.
    expect(calls[0]!.envelope.extensions).toMatchObject({ hop_count: 1 });
    // P1-3: 回发 sender 的中继是终端消息——走 delivery-only 的 sendOnce，
    // 不得再走 sendAndWait（否则登记回复 waiter + outbox 残留重放）。
    expect(sendOnceCalls).toHaveLength(1);
    expect(sendOnceCalls[0]!.agentId).toBe('node-a');
    expect(sendOnceCalls[0]!.envelope.recipients).toEqual([{ agent_id: 'node-a' }]);
    expect(sendOnceCalls[0]!.envelope.reply_to).toBe('msg-1');
    expect(sendOnceCalls[0]!.envelope.idempotency_key).toBe('forward-reply:idem-1');
    expect(sendOnceCalls[0]!.envelope.payload.parts[0]).toMatchObject({ type: 'text', text: 'B reviewed: ok' });
    // Audit trail covers send + relay.
    const events = audit.map((record) => record.event);
    expect(events).toContain('peer.forward.send');
    expect(events).toContain('peer.forward.reply');
  });

  it('rejects an unregistered sender without forwarding', async () => {
    const { deps, calls, audit } = makeDeps();
    const envelope = makeEnvelope({ sender: { agent_id: 'stranger' } });

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_forward_sender_not_registered' });
    expect(calls).toHaveLength(0);
    expect(audit.some((record) => record.event === 'peer.forward.reject' && record.metadata?.reason === 'sender_not_registered')).toBe(true);
  });

  it('rejects an unregistered or endpoint-less target', async () => {
    const { deps, calls, audit } = makeDeps();
    const ghost = makeEnvelope();

    const result = await forwardEnvelopeToPeer(ghost, 'node-ghost', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_forward_target_not_registered' });
    expect(calls).toHaveLength(0);
    expect(audit.some((record) => record.event === 'peer.forward.reject' && record.metadata?.reason === 'target_not_registered')).toBe(true);
  });

  it('rejects invalid targets (empty, self, or the bridge itself)', async () => {
    const { deps, calls } = makeDeps();
    const envelope = makeEnvelope();

    for (const target of ['', 'node-a', 'cogseed', 'cogseed']) {
      const result = await forwardEnvelopeToPeer(envelope, target, deps);
      expect(result).toEqual({ ok: false, error: 'p3394_forward_invalid_target' });
    }
    expect(calls).toHaveLength(0);
  });

  it('is idempotent per (target, idempotency_key): a duplicate is acked without a second forward', async () => {
    const { deps, calls, sendOnceCalls, completed } = makeDeps();
    const envelope = makeEnvelope();

    const first = await forwardEnvelopeToPeer(envelope, 'node-b', deps);
    const second = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // 成功完成后 key 进入 completed：第二次不再转发。
    expect(completed.has('node-b:idem-1')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(sendOnceCalls).toHaveLength(1);
  });

  it('P1-2: a failed forward does NOT poison the idempotency key — the same key can be retried', async () => {
    // 第一次目标离线（sendAndWait 抛错）→ 失败。第二次同一 (target, idem_key)
    // 必须真正重新转发，而不是被当作重复直接 ack。
    const { deps, calls, sendOnceCalls, pending, completed } = makeDeps({
      sendAndWait: async (agentId, envelope) => {
        calls.push({ agentId, envelope });
        if (calls.length === 1) throw new Error('ECONNREFUSED');
        return { text: 'B reviewed: ok (retry)' };
      },
    });
    const envelope = makeEnvelope();

    const first = await forwardEnvelopeToPeer(envelope, 'node-b', deps);
    expect(first).toEqual({ ok: false, error: 'ECONNREFUSED' });
    // 失败后 pending 被释放，key 未进入 completed。
    expect(pending.has('node-b:idem-1')).toBe(false);
    expect(completed.has('node-b:idem-1')).toBe(false);

    const second = await forwardEnvelopeToPeer(envelope, 'node-b', deps);
    expect(second).toEqual({ ok: true });
    // 重试真正转发了（sendAndWait 共 2 次：1 次失败 + 1 次重试）并完成中继。
    expect(calls).toHaveLength(2);
    expect(sendOnceCalls).toHaveLength(1);
    expect(completed.has('node-b:idem-1')).toBe(true);
  });

  it('surfaces a delivery failure and audits it', async () => {
    const { deps, calls, audit } = makeDeps({
      sendAndWait: async (agentId) => {
        calls.push({ agentId, envelope: makeEnvelope() });
        if (agentId === 'node-b') throw new Error('p3394_reply_timeout');
        return { text: 'n/a' };
      },
    });
    const envelope = makeEnvelope();

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_reply_timeout' });
    expect(audit.some((record) => record.event === 'peer.forward.failed')).toBe(true);
  });

  it('H-03: rejects forwarding to a non-loopback target without explicit authorization', async () => {
    const { deps, calls, audit } = makeDeps();
    const envelope = makeEnvelope();

    const result = await forwardEnvelopeToPeer(envelope, 'node-remote', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_forward_target_remote_not_authorized' });
    expect(calls).toHaveLength(0);
    expect(audit.some((record) => record.event === 'peer.forward.reject' && record.metadata?.reason === 'target_remote_not_authorized')).toBe(true);
  });

  it('H-03: an explicit isForwardTargetAllowed sign-off permits a remote target', async () => {
    const { deps, calls } = makeDeps({ isForwardTargetAllowed: (target) => target === 'node-remote' });
    const envelope = makeEnvelope();

    const result = await forwardEnvelopeToPeer(envelope, 'node-remote', deps);

    expect(result).toEqual({ ok: true });
    expect(calls[0]!.agentId).toBe('node-remote');
    // 转发段仍是派生 session（M-03），远程 target 一并覆盖。
    expect(calls[0]!.envelope.session_id).toBe('fwd:ses-1');
  });

  it('enforces the forward hop budget (A↔B loop guard)', async () => {
    const { deps, calls, audit } = makeDeps();
    // 一个已经转发过的信封（hop_count 已达上限）不得被再次转发。
    const envelope = makeEnvelope({ extensions: { hop_count: MAX_FORWARD_HOPS } as never });

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_forward_too_many_hops' });
    expect(calls).toHaveLength(0);
    expect(audit.some((record) => record.event === 'peer.forward.reject' && record.metadata?.reason === 'too_many_hops')).toBe(true);
  });

  it('rejects a malformed hop_count (loop guard)', async () => {
    const { deps, calls } = makeDeps();
    const envelope = makeEnvelope({ extensions: { hop_count: 'bogus' } as never });

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: false, error: 'p3394_forward_too_many_hops' });
    expect(calls).toHaveLength(0);
  });
});
