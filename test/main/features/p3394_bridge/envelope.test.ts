import { describe, expect, it } from 'vitest';
import {
  P3394_ENVELOPE_LIMITS,
  validateP3394Envelope,
  type P3394Envelope,
} from '../../../../src/main/features/p3394_bridge/envelope';

function validEnvelope(overrides: Partial<P3394Envelope> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-001',
    session_id: 'sess-001',
    task_id: 'task-001',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'agent-sender', alias: 'Sender', channel_instance_id: 'channel-a' },
    recipients: [{ agent_id: 'agent-recipient', alias: 'Recipient', channel_instance_id: 'channel-b' }],
    payload: {
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'json', data: { ok: true } },
      ],
      metadata: { goal: 'demo' },
    },
    reply_to: 'msg-parent',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
    extensions: { metadata: { priority: 'normal' } },
    idempotency_key: 'idem-001',
    ...overrides,
  };
}

describe('P3394 envelope validation', () => {
  it('accepts and preserves a valid p3394/1.0 envelope including identity and reply_to', () => {
    const envelope = validEnvelope();

    const result = validateP3394Envelope(envelope);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    expect(result.envelope.message_id).toBe('msg-001');
    expect(result.envelope.spec_version).toBe('p3394/1.0');
    expect(result.envelope.session_id).toBe('sess-001');
    expect(result.envelope.task_id).toBe('task-001');
    expect(result.envelope.sender).toEqual({
      agent_id: 'agent-sender',
      alias: 'Sender',
      channel_instance_id: 'channel-a',
    });
    expect(result.envelope.recipients[0]).toEqual({
      agent_id: 'agent-recipient',
      alias: 'Recipient',
      channel_instance_id: 'channel-b',
    });
    expect(result.envelope.payload.parts).toHaveLength(2);
    expect(result.envelope.payload.metadata).toEqual({ goal: 'demo' });
    expect(result.envelope.reply_to).toBe('msg-parent');
  });

  it('rejects missing required identity fields', () => {
    const result = validateP3394Envelope(validEnvelope({ session_id: '' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error.reason).toBe('missing_session_id');
    expect(result.error.field).toBe('session_id');
  });

  it('rejects empty recipients', () => {
    const result = validateP3394Envelope(validEnvelope({ recipients: [] }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error.reason).toBe('empty_recipients');
    expect(result.error.field).toBe('recipients');
  });

  it('rejects unsupported kinds and unsupported performatives with machine-readable codes', () => {
    const badKind = validateP3394Envelope(validEnvelope({ kind: 'unknown' as P3394Envelope['kind'] }));
    expect(badKind.ok).toBe(false);
    if (badKind.ok) throw new Error('expected validation failure');
    expect(badKind.error.reason).toBe('unsupported_kind');

    const badPerformative = validateP3394Envelope(
      validEnvelope({ performative: 'delegate' as P3394Envelope['performative'] }),
    );
    expect(badPerformative.ok).toBe(false);
    if (badPerformative.ok) throw new Error('expected validation failure');
    expect(badPerformative.error.reason).toBe('unsupported_performative');
    expect(badPerformative.error.field).toBe('performative');
  });

  it('rejects malformed sender and recipient identity objects', () => {
    const badSender = validateP3394Envelope(validEnvelope({ sender: { agent_id: ' ' } }));
    expect(badSender.ok).toBe(false);
    if (badSender.ok) throw new Error('expected validation failure');
    expect(badSender.error.reason).toBe('malformed_sender');

    const badRecipient = validateP3394Envelope(
      validEnvelope({ recipients: [{ agent_id: 'agent-ok' }, { agent_id: '' }] }),
    );
    expect(badRecipient.ok).toBe(false);
    if (badRecipient.ok) throw new Error('expected validation failure');
    expect(badRecipient.error.reason).toBe('malformed_recipient');
    expect(badRecipient.error.field).toBe('recipients[1]');
  });

  it('rejects invalid payload parts', () => {
    const missingText = validateP3394Envelope(validEnvelope({ payload: { parts: [{ type: 'text' }] } }));
    expect(missingText.ok).toBe(false);
    if (missingText.ok) throw new Error('expected validation failure');
    expect(missingText.error.reason).toBe('invalid_payload_part');
    expect(missingText.error.field).toBe('payload.parts[0].text');

    const unsupportedPart = validateP3394Envelope(
      validEnvelope({ payload: { parts: [{ type: 'video', uri: 'file:///tmp/demo.mp4' } as any] } }),
    );
    expect(unsupportedPart.ok).toBe(false);
    if (unsupportedPart.ok) throw new Error('expected validation failure');
    expect(unsupportedPart.error.reason).toBe('invalid_payload_part');
    expect(unsupportedPart.error.field).toBe('payload.parts[0].type');
  });

  it('rejects oversized text, data, and metadata by bounded constants', () => {
    const textResult = validateP3394Envelope(
      validEnvelope({ payload: { parts: [{ type: 'text', text: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxTextChars + 1) }] } }),
    );
    expect(textResult.ok).toBe(false);
    if (textResult.ok) throw new Error('expected validation failure');
    expect(textResult.error.reason).toBe('text_too_large');
    expect(textResult.error.field).toBe('payload.parts[0].text');

    const dataResult = validateP3394Envelope(
      validEnvelope({
        payload: { parts: [{ type: 'json', data: { blob: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxDataJsonChars + 1) } }] },
      }),
    );
    expect(dataResult.ok).toBe(false);
    if (dataResult.ok) throw new Error('expected validation failure');
    expect(dataResult.error.reason).toBe('data_too_large');
    expect(dataResult.error.field).toBe('payload.parts[0].data');

    const metadataResult = validateP3394Envelope(
      validEnvelope({ payload: { parts: [{ type: 'text', text: 'hello' }], metadata: { blob: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxMetadataJsonChars + 1) } } }),
    );
    expect(metadataResult.ok).toBe(false);
    if (metadataResult.ok) throw new Error('expected validation failure');
    expect(metadataResult.error.reason).toBe('metadata_too_large');
    expect(metadataResult.error.field).toBe('payload.metadata');
  });

  it('normalizes absent spec_version to the current bridge version', () => {
    const raw = { ...validEnvelope() } as Partial<P3394Envelope> & Record<string, unknown>;
    delete raw.spec_version;
    const result = validateP3394Envelope(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    expect(result.envelope.spec_version).toBe('p3394/1.0');
  });

  it('rejects an unsupported spec_version with a machine-readable code', () => {
    const result = validateP3394Envelope(validEnvelope({ spec_version: 'p3394/0.9' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error.reason).toBe('unsupported_spec_version');
    expect(result.error.field).toBe('spec_version');
  });

  it('accepts role requester/responder/observer and rejects unknown roles', () => {
    for (const role of ['requester', 'responder', 'observer'] as const) {
      const result = validateP3394Envelope(validEnvelope({ role }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.envelope.role).toBe(role);
    }
    const bad = validateP3394Envelope(validEnvelope({ role: 'admin' as P3394Envelope['role'] }));
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected validation failure');
    expect(bad.error.reason).toBe('unsupported_role');
  });

  it('accepts a sender delegation chain and rejects malformed delegation', () => {
    const ok = validateP3394Envelope(
      validEnvelope({ sender: { agent_id: 'agent-sender', delegation: ['did:example:coordinator'] } }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error(ok.error.reason);
    expect(ok.envelope.sender.delegation).toEqual(['did:example:coordinator']);

    const bad = validateP3394Envelope(
      validEnvelope({ sender: { agent_id: 'agent-sender', delegation: [''] } }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected validation failure');
    expect(bad.error.reason).toBe('invalid_delegation');
  });
});
