import { describe, expect, it } from 'vitest';
import {
  a2aConversationLabelKey,
  canTransitionA2AState,
  isA2AConversation,
  parseA2AConversationMarker,
  transitionA2AConversation,
  type A2AConversationMarker,
} from '../../../../src/main/features/a2a/conversation-marker';

/**
 * The marker decides whether a conversation is labelled A2A and what it may do
 * next. Two invariants matter: a corrupt field must not make an ordinary
 * conversation look like A2A, and「进行中」has no exit while the relationship holds
 * (D-19) — only removing the contact ends it.
 */
const base: A2AConversationMarker = {
  role: 'initiator',
  peer_user_id: 'cs_bob',
  peer_name: 'Bob',
  state: 'waiting',
};

describe('a2a marker › parsing', () => {
  it('keeps a well-formed marker', () => {
    expect(parseA2AConversationMarker(base)).toMatchObject({ role: 'initiator', peer_user_id: 'cs_bob', state: 'waiting' });
  });

  it('returns null for anything that is not a marker', () => {
    expect(parseA2AConversationMarker(null)).toBeNull();
    expect(parseA2AConversationMarker('a2a')).toBeNull();
    expect(parseA2AConversationMarker({ ...base, role: 'owner' })).toBeNull();
    expect(parseA2AConversationMarker({ ...base, peer_user_id: '' })).toBeNull();
    expect(parseA2AConversationMarker({ ...base, state: 'closed' })).toBeNull();
  });

  it('drops an exchange id that is not in the a2a namespace', () => {
    const parsed = parseA2AConversationMarker({ ...base, exchange_id: 'conv-1' });
    expect(parsed?.exchange_id).toBeUndefined();
    expect(parseA2AConversationMarker({ ...base, exchange_id: 'a2a-abc' })?.exchange_id).toBe('a2a-abc');
  });
});

describe('a2a marker › labels', () => {
  it('labels the receiver as incoming and the initiator by state', () => {
    expect(isA2AConversation({ ...base, role: 'receiver' })).toBe(true);
    expect(a2aConversationLabelKey({ ...base, role: 'receiver', state: 'active' })).toBe('chat.a2a.incoming');
    // 接访会话在等**本人**确认：不能读成「等待对方接受」。
    expect(a2aConversationLabelKey({ ...base, role: 'receiver', state: 'waiting' })).toBe('chat.a2a.incoming_waiting');
    expect(a2aConversationLabelKey({ ...base, state: 'active' })).toBe('chat.a2a.active');
  });

  it('labels an expired inbound visit from the receiver point of view', () => {
    // 「过期」在提问方读作「对方未响应」，在来访方必须读作「我方未及时接待」。
    expect(a2aConversationLabelKey({ ...base, role: 'receiver', state: 'expired' }))
      .toBe('chat.a2a.incoming_expired');
    expect(a2aConversationLabelKey({ ...base, inbound: true, state: 'expired' }))
      .toBe('chat.a2a.incoming_expired');
    // 提问方（outgoing-only）仍使用提问方视角的 expired。
    expect(a2aConversationLabelKey({ ...base, state: 'expired' })).toBe('chat.a2a.expired');
  });

  it('stops labelling a conversation once the exchange ended', () => {
    expect(isA2AConversation({ ...base, state: 'ended' })).toBe(false);
  });
});

describe('a2a marker › transitions (D-19: no manual end while active)', () => {
  it('allows the accept path and the expiry path', () => {
    expect(canTransitionA2AState('waiting', 'active')).toBe(true);
    expect(canTransitionA2AState('waiting', 'expired')).toBe(true);
    expect(canTransitionA2AState('expired', 'active')).toBe(true);
  });

  it('forbids going back to waiting or reviving an ended exchange', () => {
    expect(canTransitionA2AState('active', 'waiting')).toBe(false);
    expect(canTransitionA2AState('ended', 'active')).toBe(false);
    expect(() => transitionA2AConversation({ ...base, state: 'ended' }, 'active')).toThrow(/invalid a2a transition/);
  });

  it('only ends an active exchange when the contact is removed', () => {
    const ended = transitionA2AConversation({ ...base, state: 'active' }, 'ended');
    expect(ended.state).toBe('ended');
    expect(isA2AConversation(ended)).toBe(false);
  });

describe('a2a marker › confirming sub-state (PRD §8)', () => {
  it('lets an active exchange enter and leave「确认中」', () => {
    const confirming = transitionA2AConversation({ ...base, state: 'active' }, 'confirming');
    expect(confirming.state).toBe('confirming');
    // 仍然是进行中的交换，A2A 标识继续显示。
    expect(isA2AConversation(confirming)).toBe(true);
    expect(transitionA2AConversation(confirming, 'active').state).toBe('active');
  });

  it('labels the initiator differently once the 5-minute window passed', () => {
    const confirming: A2AConversationMarker = { ...base, state: 'confirming' };
    expect(a2aConversationLabelKey(confirming)).toBe('chat.a2a.confirming');
    expect(a2aConversationLabelKey({ ...confirming, nudged: true })).toBe('chat.a2a.confirming_nudged');
  });

  it('forbids reaching「确认中」from a waiting exchange', () => {
    expect(canTransitionA2AState('waiting', 'confirming')).toBe(false);
  });
});
});
