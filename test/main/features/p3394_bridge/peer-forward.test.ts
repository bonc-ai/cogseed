/**
 * P3394 peer-forward unit tests — the CogSeed-hosted relay for
 * "gateway A calls gateway B" without widening the gateway trust surface.
 *
 * All deps are injected fakes, so the tests cover the forwarding decision
 * logic (identity gates, idempotency, audit, relay shape) without network.
 */
import { describe, expect, it } from 'vitest';
import { forwardEnvelopeToPeer, type P3394PeerForwardDeps } from '../../../../src/main/features/p3394_bridge/peer-forward';
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

function makeDeps(overrides: Partial<P3394PeerForwardDeps> = {}): { deps: P3394PeerForwardDeps; calls: Call[]; audit: Array<Record<string, unknown>>; seen: Set<string> } {
  const calls: Call[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const registered = new Map<string, { identity: { agent_id: string }; endpoints?: string[] }>([
    ['node-a', { identity: { agent_id: 'node-a' }, endpoints: ['http://127.0.0.1:9100'] }],
    ['node-b', { identity: { agent_id: 'node-b' }, endpoints: ['http://127.0.0.1:9200'] }],
    // 远程/非回环 target（H-03：默认不可转发，需显式授权）。
    ['node-remote', { identity: { agent_id: 'node-remote' }, endpoints: ['http://192.168.1.50:9000'] }],
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
    audit: (record) => { audit.push(record as unknown as Record<string, unknown>); },
    isDuplicate: (key) => seen.has(key),
    markDuplicate: (key) => { seen.add(key); },
    bridgeInfo: { endpoint: 'http://127.0.0.1:8444', token: 'bridge-token' },
    ...overrides,
  };
  return { deps, calls, audit, seen };
}

describe('P3394 peer forwarding', () => {
  it('forwards to a registered target with the bridge reply endpoint and relays the reply to the sender', async () => {
    const { deps, calls, audit } = makeDeps();
    const envelope = makeEnvelope();

    const result = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // Hop 1: to the target, recipients rewritten, reply endpoint injected.
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
    // Hop 2: relay back to the original sender with the target's reply.
    expect(calls[1]!.agentId).toBe('node-a');
    expect(calls[1]!.envelope.recipients).toEqual([{ agent_id: 'node-a' }]);
    expect(calls[1]!.envelope.reply_to).toBe('msg-1');
    expect(calls[1]!.envelope.idempotency_key).toBe('forward-reply:idem-1');
    expect(calls[1]!.envelope.payload.parts[0]).toMatchObject({ type: 'text', text: 'B reviewed: ok' });
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

    for (const target of ['', 'node-a', 'cogseed', 'mate']) {
      const result = await forwardEnvelopeToPeer(envelope, target, deps);
      expect(result).toEqual({ ok: false, error: 'p3394_forward_invalid_target' });
    }
    expect(calls).toHaveLength(0);
  });

  it('is idempotent per (target, idempotency_key): a duplicate is acked without a second forward', async () => {
    const { deps, calls } = makeDeps();
    const envelope = makeEnvelope();

    const first = await forwardEnvelopeToPeer(envelope, 'node-b', deps);
    const second = await forwardEnvelopeToPeer(envelope, 'node-b', deps);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    // One forward + one relay on the first call only.
    expect(calls).toHaveLength(2);
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
});
