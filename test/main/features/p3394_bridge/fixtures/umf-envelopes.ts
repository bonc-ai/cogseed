/**
 * Standard UMF envelope fixture catalog (Conformance Matrix V-02).
 *
 * Every fixture carries a stable id and the matrix requirement ids it
 * evidences, so `docs/P3394-Conformance-Matrix.md` can point at concrete
 * accepted/rejected shapes instead of prose. The rejected catalog is keyed by
 * `P3394EnvelopeValidationReason`, which makes coverage exhaustive at compile
 * time: adding a reason to the validator without a fixture here fails
 * typecheck, and removing one fails the same way.
 */

import {
  P3394_ENVELOPE_LIMITS,
  type P3394EnvelopeValidationReason,
} from '../../../../../src/main/features/p3394_bridge/envelope';

export interface P3394UmfEnvelopeFixture {
  /** Stable fixture id; A- = accepted, R- = rejected, followed by matrix ids. */
  id: string;
  /** Matrix requirement ids evidenced by this fixture (docs/P3394-Conformance-Matrix.md). */
  matrix: string[];
  /** Human-readable description of the shape being exercised. */
  name: string;
  input: unknown;
  expected: 'accept' | P3394EnvelopeValidationReason;
  /** Exact validator field reported for rejection fixtures. */
  field?: string;
}

/** Fully-valid envelope; every rejected fixture derives from this by breaking one thing. */
export function fullP3394Envelope(): Record<string, unknown> {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-001',
    session_id: 'sess-001',
    task_id: 'task-001',
    kind: 'message',
    performative: 'request',
    role: 'requester',
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
    extensions: { priority: 'normal' },
    idempotency_key: 'idem-001',
  };
}

function minimalEnvelope(): Record<string, unknown> {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-min',
    session_id: 'sess-min',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'agent-sender' },
    recipients: [{ agent_id: 'agent-recipient' }],
    payload: { parts: [{ type: 'text', text: 'hi' }] },
    idempotency_key: 'idem-min',
  };
}

function patch(partial: Record<string, unknown>): Record<string, unknown> {
  return { ...fullP3394Envelope(), ...partial };
}

function omitKey(key: string): Record<string, unknown> {
  const value = fullP3394Envelope();
  delete value[key];
  return value;
}

export const ACCEPTED_UMF_FIXTURES: P3394UmfEnvelopeFixture[] = [
  {
    id: 'A-M01-01',
    matrix: ['M-01', 'M-02', 'M-03', 'M-05', 'M-07'],
    name: 'full envelope: text+json parts, reply_to, traceparent, extensions, role, identity fields',
    input: fullP3394Envelope(),
    expected: 'accept',
  },
  {
    id: 'A-M01-02',
    matrix: ['M-01'],
    name: 'minimal valid envelope (no task_id/reply_to/role/extensions)',
    input: minimalEnvelope(),
    expected: 'accept',
  },
  {
    id: 'A-M01-03',
    matrix: ['M-01'],
    name: 'role requester',
    input: patch({ role: 'requester' }),
    expected: 'accept',
  },
  {
    id: 'A-M01-04',
    matrix: ['M-01'],
    name: 'role responder',
    input: patch({ role: 'responder' }),
    expected: 'accept',
  },
  {
    id: 'A-M01-05',
    matrix: ['M-01'],
    name: 'role observer',
    input: patch({ role: 'observer' }),
    expected: 'accept',
  },
  {
    id: 'A-M02-01',
    matrix: ['M-02', 'M-05'],
    name: 'all supported payload part types (text/json/control/resource/artifact/image/audio)',
    input: patch({
      message_id: 'msg-parts',
      payload: {
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'json', data: { a: 1 } },
          { type: 'control', data: { op: 'resume' } },
          { type: 'resource', uri: `p3394-object:sha256:${'a'.repeat(64)}`, name: 'res.bin' },
          {
            type: 'artifact',
            uri: `p3394-object:sha256:${'b'.repeat(64)}`,
            digest: `sha256:${'b'.repeat(64)}`,
            name: 'report.pdf',
            media_type: 'application/pdf',
          },
          { type: 'image', uri: 'https://example.test/img.png', media_type: 'image/png' },
          { type: 'audio', uri: 'https://example.test/a.mp3', media_type: 'audio/mpeg' },
        ],
      },
    }),
    expected: 'accept',
  },
  {
    id: 'A-M07-01',
    matrix: ['M-07'],
    name: 'sender delegation chain',
    input: patch({ sender: { agent_id: 'agent-sender', delegation: ['did:example:coordinator'] } }),
    expected: 'accept',
  },
];

const circular: Record<string, unknown> = {};
circular.self = circular;

export const REJECTED_UMF_FIXTURES_BY_REASON: Record<
  P3394EnvelopeValidationReason,
  P3394UmfEnvelopeFixture[]
> = {
  invalid_envelope: [
    {
      id: 'R-M01-01',
      matrix: ['M-01'],
      name: 'non-object input (null)',
      input: null,
      expected: 'invalid_envelope',
      field: '$',
    },
    {
      id: 'R-M01-02',
      matrix: ['M-01'],
      name: 'blank task_id',
      input: patch({ task_id: '  ' }),
      expected: 'invalid_envelope',
      field: 'task_id',
    },
    {
      id: 'R-M03-01',
      matrix: ['M-03'],
      name: 'blank reply_to',
      input: patch({ reply_to: '' }),
      expected: 'invalid_envelope',
      field: 'reply_to',
    },
    {
      id: 'R-M01-03',
      matrix: ['M-01'],
      name: 'extensions is not an object',
      input: patch({ extensions: 'x' }),
      expected: 'invalid_envelope',
      field: 'extensions',
    },
  ],
  missing_spec_version: [
    {
      id: 'R-M01-04',
      matrix: ['M-01'],
      name: 'spec_version omitted',
      input: omitKey('spec_version'),
      expected: 'missing_spec_version',
      field: 'spec_version',
    },
  ],
  unsupported_spec_version: [
    {
      id: 'R-M01-05',
      matrix: ['M-01'],
      name: 'unsupported spec_version p3394/0.9',
      input: patch({ spec_version: 'p3394/0.9' }),
      expected: 'unsupported_spec_version',
      field: 'spec_version',
    },
  ],
  unsupported_role: [
    {
      id: 'R-M01-06',
      matrix: ['M-01'],
      name: 'unknown role admin',
      input: patch({ role: 'admin' }),
      expected: 'unsupported_role',
      field: 'role',
    },
  ],
  missing_message_id: [
    {
      id: 'R-M01-07',
      matrix: ['M-01'],
      name: 'blank message_id',
      input: patch({ message_id: '' }),
      expected: 'missing_message_id',
      field: 'message_id',
    },
  ],
  missing_session_id: [
    {
      id: 'R-M01-08',
      matrix: ['M-01'],
      name: 'blank session_id',
      input: patch({ session_id: ' ' }),
      expected: 'missing_session_id',
      field: 'session_id',
    },
  ],
  missing_idempotency_key: [
    {
      id: 'R-M01-09',
      matrix: ['M-01'],
      name: 'blank idempotency_key',
      input: patch({ idempotency_key: '' }),
      expected: 'missing_idempotency_key',
      field: 'idempotency_key',
    },
  ],
  unsupported_kind: [
    {
      id: 'R-M02-01',
      matrix: ['M-02'],
      name: 'unknown kind',
      input: patch({ kind: 'unknown' }),
      expected: 'unsupported_kind',
      field: 'kind',
    },
  ],
  unsupported_performative: [
    {
      id: 'R-M02-02',
      matrix: ['M-02'],
      name: 'unknown performative delegate',
      input: patch({ performative: 'delegate' }),
      expected: 'unsupported_performative',
      field: 'performative',
    },
  ],
  missing_sender: [
    {
      id: 'R-M07-01',
      matrix: ['M-07'],
      name: 'sender omitted',
      input: omitKey('sender'),
      expected: 'missing_sender',
      field: 'sender',
    },
  ],
  malformed_sender: [
    {
      id: 'R-M07-02',
      matrix: ['M-07'],
      name: 'sender with blank agent_id',
      input: patch({ sender: { agent_id: '  ' } }),
      expected: 'malformed_sender',
      field: 'sender',
    },
  ],
  empty_recipients: [
    {
      id: 'R-M01-10',
      matrix: ['M-01'],
      name: 'empty recipients array',
      input: patch({ recipients: [] }),
      expected: 'empty_recipients',
      field: 'recipients',
    },
  ],
  malformed_recipient: [
    {
      id: 'R-M07-03',
      matrix: ['M-07'],
      name: 'recipient with blank agent_id',
      input: patch({ recipients: [{ agent_id: '' }] }),
      expected: 'malformed_recipient',
      field: 'recipients[0]',
    },
  ],
  missing_payload: [
    {
      id: 'R-M01-11',
      matrix: ['M-01'],
      name: 'payload omitted',
      input: omitKey('payload'),
      expected: 'missing_payload',
      field: 'payload',
    },
    {
      id: 'R-M01-12',
      matrix: ['M-01'],
      name: 'payload.parts is empty',
      input: patch({ payload: { parts: [] } }),
      expected: 'missing_payload',
      field: 'payload.parts',
    },
  ],
  invalid_payload_part: [
    {
      id: 'R-M05-01',
      matrix: ['M-05'],
      name: 'text part without text',
      input: patch({ payload: { parts: [{ type: 'text' }] } }),
      expected: 'invalid_payload_part',
      field: 'payload.parts[0].text',
    },
    {
      id: 'R-M02-03',
      matrix: ['M-02'],
      name: 'unsupported part type video',
      input: patch({ payload: { parts: [{ type: 'video', uri: 'file:///tmp/demo.mp4' }] } }),
      expected: 'invalid_payload_part',
      field: 'payload.parts[0].type',
    },
    {
      id: 'R-M05-02',
      matrix: ['M-05'],
      name: 'json part with non-JSON-serializable data',
      input: patch({ payload: { parts: [{ type: 'json', data: circular }] } }),
      expected: 'invalid_payload_part',
      field: 'payload.parts[0].data',
    },
  ],
  text_too_large: [
    {
      id: 'R-M05-03',
      matrix: ['M-05'],
      name: 'text part over maxTextChars',
      input: patch({
        payload: { parts: [{ type: 'text', text: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxTextChars + 1) }] },
      }),
      expected: 'text_too_large',
      field: 'payload.parts[0].text',
    },
  ],
  data_too_large: [
    {
      id: 'R-M05-04',
      matrix: ['M-05'],
      name: 'json part over maxDataJsonChars',
      input: patch({
        payload: {
          parts: [{ type: 'json', data: { blob: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxDataJsonChars + 1) } }],
        },
      }),
      expected: 'data_too_large',
      field: 'payload.parts[0].data',
    },
  ],
  metadata_too_large: [
    {
      id: 'R-M05-05',
      matrix: ['M-05'],
      name: 'payload.metadata over maxMetadataJsonChars',
      input: patch({
        payload: {
          parts: [{ type: 'text', text: 'hi' }],
          metadata: { blob: 'x'.repeat(P3394_ENVELOPE_LIMITS.maxMetadataJsonChars + 1) },
        },
      }),
      expected: 'metadata_too_large',
      field: 'payload.metadata',
    },
  ],
  invalid_payload_metadata: [
    {
      id: 'R-M05-06',
      matrix: ['M-05'],
      name: 'payload.metadata is not an object',
      input: patch({ payload: { parts: [{ type: 'text', text: 'hi' }], metadata: 'not-an-object' } }),
      expected: 'invalid_payload_metadata',
      field: 'payload.metadata',
    },
  ],
  invalid_delegation: [
    {
      id: 'R-M07-04',
      matrix: ['M-07'],
      name: 'sender delegation with blank entry',
      input: patch({ sender: { agent_id: 'agent-sender', delegation: [''] } }),
      expected: 'invalid_delegation',
      field: 'sender.delegation[0]',
    },
  ],
};

/** Flat rejected catalog in insertion order; exhaustiveness is enforced by the Record keying above. */
export const REJECTED_UMF_FIXTURES: P3394UmfEnvelopeFixture[] = Object.values(
  REJECTED_UMF_FIXTURES_BY_REASON,
).flat();
