import { describe, expect, it } from 'vitest';
import { canReplyToPeer, planInboundA2A } from '../../../../src/main/features/a2a/inbound';
import type { A2AExtension } from '../../../../src/main/features/a2a/extensions';

/**
 * Inbound planning is where "对端不能替我决定" becomes code: the first question has
 * to wait for the receiver (D-04), a later question in an accepted exchange does
 * not (D-11), and a message addressed elsewhere or sent in the wrong direction is
 * rejected instead of being quietly stored.
 */
const local = 'cs_receiver';
const peer = 'cs_sender';
const question: A2AExtension = {
  conversation_id: 'a2a-0123456789abcdef0123',
  kind: 'question',
  visibility: 'cross',
  recipient_user: local,
  assistant_agent_id: 'agent-1',
};

describe('a2a inbound › routing', () => {
  it('rejects a message addressed to somebody else', () => {
    expect(planInboundA2A({ extension: { ...question, recipient_user: 'cs_other' }, localUserId: local, peerUserId: peer }))
      .toEqual({ rejected: 'not_for_me' });
  });

  it('rejects a local message that somehow reached the wire', () => {
    expect(planInboundA2A({
      extension: { ...question, visibility: 'local', recipient_user: undefined },
      localUserId: local,
      peerUserId: peer,
    })).toEqual({ rejected: 'not_cross' });
  });

  it('rejects a reply kind on the receiving side (D-24)', () => {
    expect(planInboundA2A({ extension: { ...question, kind: 'answer' }, localUserId: local, peerUserId: peer }))
      .toEqual({ rejected: 'wrong_direction' });
  });
});

describe('a2a inbound › confirmation rules', () => {
  it('opens a waiting exchange for the first question, without running (D-04)', () => {
    const plan = planInboundA2A({ extension: question, localUserId: local, peerUserId: peer });
    if ('rejected' in plan) throw new Error('expected a plan');
    expect(plan.kind).toBe('open');
    expect(plan.needsConfirmation).toBe(true);
    expect(plan.marker).toMatchObject({ inbound: true, peer_user_id: peer, state: 'waiting' });
    expect(plan.marker.exchange_id).toBe(question.conversation_id);
  });

  it('continues an accepted exchange without re-confirmation (D-11)', () => {
    const plan = planInboundA2A({
      extension: question,
      localUserId: local,
      peerUserId: peer,
      existingMarker: { inbound: true, peer_user_id: peer, state: 'active', workspace: '/ws/a' },
    });
    if ('rejected' in plan) throw new Error('expected a plan');
    expect(plan.kind).toBe('continue');
    expect(plan.needsConfirmation).toBe(false);
    // 接待范围沿用既有授权，不因新消息而变。
    expect(plan.marker.workspace).toBe('/ws/a');
  });

  it('treats a question from a different peer as a new exchange, not a continuation', () => {
    expect(planInboundA2A({
      extension: question,
      localUserId: local,
      peerUserId: peer,
      existingMarker: { inbound: true, peer_user_id: 'cs_someone_else', state: 'active' },
    })).toEqual({ rejected: 'wrong_direction' });
  });
});

describe('a2a inbound › outbound gate (R-10/R-11)', () => {
  it('only lets the receiver answer inside an active reception with real text', () => {
    const active = { role: 'receiver' as const, peer_user_id: peer, state: 'active' as const };
    expect(canReplyToPeer(active, true)).toBe(true);
    expect(canReplyToPeer(active, false)).toBe(false);
    expect(canReplyToPeer({ ...active, state: 'waiting' }, true)).toBe(false);
    expect(canReplyToPeer({ ...active, role: 'initiator' }, true)).toBe(false);
    expect(canReplyToPeer(null, true)).toBe(false);
  });
});
