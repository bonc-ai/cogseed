import { describe, expect, it } from 'vitest';
import {
  A2A_EXTENSION_KEY,
  a2aConversationId,
  a2aConversationInstanceId,
  buildA2AExtension,
  isA2AConversationId,
  mayCrossToPeer,
  parseA2AExtension,
  withA2AExtension,
} from '../../../../src/main/features/a2a/extensions';

/**
 * The A2A extension is the privacy boundary between local context and what the
 * peer sees (D-16/R-09), so these cases pin the rejection rules rather than just
 * the happy path: a local message that names a peer must never be constructible,
 * and a parsed cross message must always carry its recipient.
 */
describe('a2a extension › conversation id', () => {
  it('is identical for both participants regardless of order', () => {
    expect(a2aConversationId('cs_alice', 'cs_bob')).toBe(a2aConversationId('cs_bob', 'cs_alice'));
    expect(a2aConversationId('cs_alice', 'cs_bob')).toMatch(/^a2a-[0-9a-f]{20}$/);
  });

  it('differs for different pairs and tolerates surrounding whitespace', () => {
    expect(a2aConversationId('cs_alice', 'cs_bob')).not.toBe(a2aConversationId('cs_alice', 'cs_carol'));
    expect(a2aConversationId(' cs_alice ', 'cs_bob')).toBe(a2aConversationId('cs_alice', 'cs_bob'));
  });

  it('derives one shared instance id from the unordered pair and request id', () => {
    const first = a2aConversationInstanceId('cs_alice', 'cs_bob', 'req-1');
    expect(first).toBe(a2aConversationInstanceId('cs_bob', 'cs_alice', 'req-1'));
    expect(first).toMatch(/^a2a-[0-9a-f]{20}$/);
    expect(first).not.toBe(a2aConversationId('cs_alice', 'cs_bob'));
  });

  it('creates different conversation instances for different request ids', () => {
    expect(a2aConversationInstanceId('cs_alice', 'cs_bob', 'req-1'))
      .not.toBe(a2aConversationInstanceId('cs_alice', 'cs_bob', 'req-2'));
  });

  it('accepts only the exact lowercase 20-hex A2A conversation id shape', () => {
    expect(isA2AConversationId(a2aConversationId('cs_alice', 'cs_bob'))).toBe(true);
    expect(isA2AConversationId(a2aConversationInstanceId('cs_alice', 'cs_bob', 'req-1'))).toBe(true);
    for (const value of [
      '',
      'a2a-',
      'a2a-0123456789abcdef012',
      'a2a-0123456789abcdef01234',
      'a2a-0123456789ABCDEF0123',
      'a2a-0123456789abcdef012g',
      '../a2a-0123456789abcdef0123',
    ]) {
      expect(isA2AConversationId(value)).toBe(false);
    }
  });
});

describe('a2a extension › build', () => {
  const id = a2aConversationId('a', 'b');

  it('builds a cross question with its recipient', () => {
    const extension = buildA2AExtension({
      kind: 'question', visibility: 'cross', conversation_id: id, recipient_user: 'cs_bob', assistant_agent_id: 'agent-1',
    });
    expect(extension).toMatchObject({ kind: 'question', visibility: 'cross', recipient_user: 'cs_bob' });
    expect(mayCrossToPeer(extension)).toBe(true);
  });

  it('refuses a cross message without a recipient', () => {
    expect(() => buildA2AExtension({ kind: 'question', visibility: 'cross', conversation_id: id }))
      .toThrow(/requires a recipient/);
  });

  it('refuses a local message that names a peer (the leak case)', () => {
    expect(() => buildA2AExtension({ kind: 'answer', visibility: 'local', conversation_id: id, recipient_user: 'cs_bob' }))
      .toThrow(/cannot name a peer recipient/);
  });

  it('never carries attachments or reasoning — the shape has no slot for them', () => {
    const extension = buildA2AExtension({
      kind: 'answer', visibility: 'local', conversation_id: id,
      // Extra fields are dropped by construction, not by a later filter.
      ...({ attachments: ['a.pdf'], reasoning: 'chain' } as Record<string, unknown>),
    } as any);
    expect(Object.keys(extension).sort()).toEqual(['conversation_id', 'kind', 'visibility']);
  });
});

describe('a2a extension › parse', () => {
  const base = { kind: 'question', visibility: 'cross', conversation_id: 'a2a-0123456789abcdef0123', recipient_user: 'cs_bob' };

  it('accepts a well-formed cross message', () => {
    const result = parseA2AExtension({ [A2A_EXTENSION_KEY]: base });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recipient_user).toBe('cs_bob');
  });

  it('rejects a look-alike namespace or a malformed id', () => {
    expect(parseA2AExtension({ other: base }).ok).toBe(false);
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: { ...base, conversation_id: 'conv-1' } }))
      .toMatchObject({ ok: false, reason: 'a2a_conversation_id_invalid' });
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: { ...base, conversation_id: 'a2a-0123456789ABCDEF0123' } }))
      .toMatchObject({ ok: false, reason: 'a2a_conversation_id_invalid' });
  });

  it('rejects unknown kind or visibility instead of guessing', () => {
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: { ...base, kind: 'chat' } }))
      .toMatchObject({ ok: false, reason: 'a2a_kind_invalid' });
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: { ...base, visibility: 'public' } }))
      .toMatchObject({ ok: false, reason: 'a2a_visibility_invalid' });
  });

  it('rejects a peer recipient smuggled onto a local message', () => {
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: { ...base, visibility: 'local' } }))
      .toMatchObject({ ok: false, reason: 'a2a_local_forbids_recipient' });
  });

  it('rejects a cross message that lost its recipient', () => {
    const { recipient_user: _drop, ...rest } = base;
    expect(parseA2AExtension({ [A2A_EXTENSION_KEY]: rest }))
      .toMatchObject({ ok: false, reason: 'a2a_cross_requires_recipient' });
  });

  it('round-trips through the envelope bag without disturbing other keys', () => {
    const extension = buildA2AExtension({ kind: 'answer', visibility: 'cross', conversation_id: base.conversation_id, recipient_user: 'cs_bob' });
    const bag = withA2AExtension(extension, { background: { job_id: 'bg-1' } });
    expect(bag.background).toEqual({ job_id: 'bg-1' });
    const parsed = parseA2AExtension(bag);
    expect(parsed.ok && parsed.value.kind).toBe('answer');
  });
});
