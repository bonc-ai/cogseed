export const P3394_ENVELOPE_VERSION = 'p3394/1.0' as const;

export const P3394_ENVELOPE_LIMITS = {
  maxIdentityFieldChars: 256,
  maxTextChars: 128_000,
  maxDataJsonChars: 256_000,
  maxMetadataJsonChars: 64_000,
  maxPayloadParts: 64,
  maxRecipients: 128,
} as const;

export const P3394_ENVELOPE_KINDS = [
  'message',
  'task',
  'event',
  'artifact',
  'control',
  'error',
] as const;

export const P3394_ENVELOPE_PERFORMATIVES = [
  'request',
  'response',
  'inform',
  'accept',
  'reject',
  'cancel',
  'error',
  'negotiate',
] as const;

/** Envelope roles (SDK design §8): requester initiates, responder answers,
 *  observer participates without owning the exchange. */
export const P3394_ENVELOPE_ROLES = ['requester', 'responder', 'observer'] as const;

export const P3394_PAYLOAD_PART_TYPES = [
  'text',
  'json',
  'resource',
  'artifact',
  'image',
  'audio',
  'control',
] as const;

export type P3394EnvelopeKind = typeof P3394_ENVELOPE_KINDS[number];
export type P3394EnvelopePerformative = typeof P3394_ENVELOPE_PERFORMATIVES[number];
export type P3394EnvelopeRole = typeof P3394_ENVELOPE_ROLES[number];
export type P3394PayloadPartType = typeof P3394_PAYLOAD_PART_TYPES[number];

export interface P3394EnvelopeParticipant {
  agent_id: string;
  alias?: string;
  channel_instance_id?: string;
  /** Delegation chain: upstream agent ids that authorized this sender
   *  (SDK design §8, guide §15: every delegation hop is recorded). */
  delegation?: string[];
}

export interface P3394PayloadPart {
  type: P3394PayloadPartType;
  text?: string;
  data?: unknown;
  uri?: string;
  media_type?: string;
  digest?: string;
  /** Optional human-friendly file name hint for resource/artifact parts. */
  name?: string;
}

export interface P3394MessagePayload {
  parts: P3394PayloadPart[];
  metadata?: Record<string, unknown>;
}

export interface P3394Envelope {
  /** Protocol version this envelope conforms to (guide §6.1, SDK design §8).
   *  Required when present on the wire; the validator normalizes absent
   *  values to the current bridge version for backward compatibility. */
  spec_version: string;
  message_id: string;
  session_id: string;
  task_id?: string;
  kind: P3394EnvelopeKind;
  performative: P3394EnvelopePerformative;
  /** Optional conversation role of the sender (SDK design §8). */
  role?: P3394EnvelopeRole;
  sender: P3394EnvelopeParticipant;
  recipients: P3394EnvelopeParticipant[];
  payload: P3394MessagePayload;
  reply_to?: string;
  traceparent?: string;
  extensions?: Record<string, unknown>;
  idempotency_key: string;
}

export type P3394EnvelopeValidationReason =
  | 'invalid_envelope'
  | 'missing_message_id'
  | 'missing_session_id'
  | 'missing_idempotency_key'
  | 'missing_sender'
  | 'missing_payload'
  | 'invalid_payload_metadata'
  | 'empty_recipients'
  | 'unsupported_kind'
  | 'unsupported_performative'
  | 'unsupported_spec_version'
  | 'unsupported_role'
  | 'invalid_delegation'
  | 'malformed_sender'
  | 'malformed_recipient'
  | 'invalid_payload_part'
  | 'text_too_large'
  | 'data_too_large'
  | 'metadata_too_large';

export interface P3394EnvelopeValidationError {
  reason: P3394EnvelopeValidationReason;
  field: string;
  message: string;
}

export type P3394EnvelopeValidationResult =
  | { ok: true; envelope: P3394Envelope }
  | { ok: false; error: P3394EnvelopeValidationError };

const KINDS = new Set<string>(P3394_ENVELOPE_KINDS);
const PERFORMATIVES = new Set<string>(P3394_ENVELOPE_PERFORMATIVES);
const ROLES = new Set<string>(P3394_ENVELOPE_ROLES);
const PART_TYPES = new Set<string>(P3394_PAYLOAD_PART_TYPES);

function fail(
  reason: P3394EnvelopeValidationReason,
  field: string,
  message: string,
): P3394EnvelopeValidationResult {
  return { ok: false, error: { reason, field, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyBoundedString(
  value: unknown,
  maxChars = P3394_ENVELOPE_LIMITS.maxIdentityFieldChars,
): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars;
}

function jsonSize(value: unknown): number | null {
  try {
    return JSON.stringify(value).length;
  } catch {
    return null;
  }
}

function validateParticipant(
  value: unknown,
  field: string,
  reason: 'malformed_sender' | 'malformed_recipient',
): P3394EnvelopeValidationResult | null {
  if (!isRecord(value) || !isNonEmptyBoundedString(value.agent_id)) {
    return fail(reason, field, `${field}.agent_id must be a non-empty bounded string`);
  }
  if (value.alias !== undefined && !isNonEmptyBoundedString(value.alias)) {
    return fail(reason, `${field}.alias`, `${field}.alias must be a non-empty bounded string when provided`);
  }
  if (value.channel_instance_id !== undefined && !isNonEmptyBoundedString(value.channel_instance_id)) {
    return fail(
      reason,
      `${field}.channel_instance_id`,
      `${field}.channel_instance_id must be a non-empty bounded string when provided`,
    );
  }
  if (value.delegation !== undefined) {
    if (!Array.isArray(value.delegation) || value.delegation.length > 16) {
      return fail('invalid_delegation', `${field}.delegation`, `${field}.delegation must be a bounded string array when provided`);
    }
    for (let index = 0; index < value.delegation.length; index += 1) {
      if (!isNonEmptyBoundedString(value.delegation[index])) {
        return fail(
          'invalid_delegation',
          `${field}.delegation[${index}]`,
          `${field}.delegation entries must be non-empty bounded strings`,
        );
      }
    }
  }
  return null;
}

function validatePayloadPart(part: unknown, index: number): P3394EnvelopeValidationResult | null {
  const field = `payload.parts[${index}]`;
  if (!isRecord(part) || typeof part.type !== 'string' || !PART_TYPES.has(part.type)) {
    return fail('invalid_payload_part', `${field}.type`, `${field}.type must be a supported payload part type`);
  }

  if (part.text !== undefined) {
    if (typeof part.text !== 'string') {
      return fail('invalid_payload_part', `${field}.text`, `${field}.text must be a string when provided`);
    }
    if (part.text.length > P3394_ENVELOPE_LIMITS.maxTextChars) {
      return fail('text_too_large', `${field}.text`, `${field}.text exceeds the envelope text limit`);
    }
  }

  if (part.data !== undefined) {
    const size = jsonSize(part.data);
    if (size === null) {
      return fail('invalid_payload_part', `${field}.data`, `${field}.data must be JSON-serializable`);
    }
    if (size > P3394_ENVELOPE_LIMITS.maxDataJsonChars) {
      return fail('data_too_large', `${field}.data`, `${field}.data exceeds the envelope data limit`);
    }
  }

  for (const key of ['uri', 'media_type', 'digest', 'name'] as const) {
    if (part[key] !== undefined && !isNonEmptyBoundedString(part[key])) {
      return fail(
        'invalid_payload_part',
        `${field}.${key}`,
        `${field}.${key} must be a non-empty bounded string when provided`,
      );
    }
  }

  if (part.type === 'text' && part.text === undefined) {
    return fail('invalid_payload_part', `${field}.text`, 'text payload parts require text');
  }
  if ((part.type === 'json' || part.type === 'control') && part.data === undefined) {
    return fail('invalid_payload_part', `${field}.data`, `${part.type} payload parts require data`);
  }
  if (
    (part.type === 'resource' || part.type === 'artifact' || part.type === 'image' || part.type === 'audio')
    && part.uri === undefined
    && part.data === undefined
  ) {
    return fail('invalid_payload_part', `${field}.uri`, `${part.type} payload parts require uri or data`);
  }

  return null;
}

export function validateP3394Envelope(input: unknown): P3394EnvelopeValidationResult {
  if (!isRecord(input)) {
    return fail('invalid_envelope', '$', 'envelope must be an object');
  }

  // spec_version: optional on the wire for backward compatibility; when
  // present it must match the bridge version, and the normalized envelope
  // always carries the current version (guide §6.1: spec_version defaults
  // to p3394/1.0).
  if (input.spec_version !== undefined) {
    if (typeof input.spec_version !== 'string' || input.spec_version.trim() !== P3394_ENVELOPE_VERSION) {
      return fail('unsupported_spec_version', 'spec_version', 'spec_version is not supported by this bridge');
    }
  }
  if (input.role !== undefined && (typeof input.role !== 'string' || !ROLES.has(input.role))) {
    return fail('unsupported_role', 'role', 'role is not supported by p3394/1.0');
  }

  if (!isNonEmptyBoundedString(input.message_id)) {
    return fail('missing_message_id', 'message_id', 'message_id is required');
  }
  if (!isNonEmptyBoundedString(input.session_id)) {
    return fail('missing_session_id', 'session_id', 'session_id is required');
  }
  if (input.task_id !== undefined && !isNonEmptyBoundedString(input.task_id)) {
    return fail('invalid_envelope', 'task_id', 'task_id must be a non-empty bounded string when provided');
  }
  if (!isNonEmptyBoundedString(input.idempotency_key)) {
    return fail('missing_idempotency_key', 'idempotency_key', 'idempotency_key is required');
  }

  if (typeof input.kind !== 'string' || !KINDS.has(input.kind)) {
    return fail('unsupported_kind', 'kind', 'kind is not supported by p3394/1.0');
  }
  if (typeof input.performative !== 'string' || !PERFORMATIVES.has(input.performative)) {
    return fail('unsupported_performative', 'performative', 'performative is not supported by p3394/1.0');
  }

  if (input.sender === undefined) {
    return fail('missing_sender', 'sender', 'sender is required');
  }
  const senderError = validateParticipant(input.sender, 'sender', 'malformed_sender');
  if (senderError) return senderError;

  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    return fail('empty_recipients', 'recipients', 'recipients must contain at least one recipient');
  }
  if (input.recipients.length > P3394_ENVELOPE_LIMITS.maxRecipients) {
    return fail('malformed_recipient', 'recipients', 'recipients exceeds the envelope recipient limit');
  }
  for (let index = 0; index < input.recipients.length; index += 1) {
    const recipientError = validateParticipant(
      input.recipients[index],
      `recipients[${index}]`,
      'malformed_recipient',
    );
    if (recipientError) return recipientError;
  }

  if (!isRecord(input.payload)) {
    return fail('missing_payload', 'payload', 'payload must be an object with a parts array');
  }
  if (!Array.isArray(input.payload.parts) || input.payload.parts.length === 0) {
    return fail('missing_payload', 'payload.parts', 'payload.parts must contain at least one part');
  }
  if (input.payload.parts.length > P3394_ENVELOPE_LIMITS.maxPayloadParts) {
    return fail('invalid_payload_part', 'payload.parts', 'payload.parts exceeds the envelope part limit');
  }
  for (let index = 0; index < input.payload.parts.length; index += 1) {
    const payloadError = validatePayloadPart(input.payload.parts[index], index);
    if (payloadError) return payloadError;
  }
  if (input.payload.metadata !== undefined) {
    if (!isRecord(input.payload.metadata)) {
      return fail('invalid_payload_metadata', 'payload.metadata', 'payload.metadata must be an object when provided');
    }
    const payloadMetadataSize = jsonSize(input.payload.metadata);
    if (payloadMetadataSize === null) {
      return fail('invalid_payload_metadata', 'payload.metadata', 'payload.metadata must be JSON-serializable');
    }
    if (payloadMetadataSize > P3394_ENVELOPE_LIMITS.maxMetadataJsonChars) {
      return fail('metadata_too_large', 'payload.metadata', 'payload.metadata exceeds the envelope metadata limit');
    }
  }

  for (const key of ['reply_to', 'traceparent'] as const) {
    if (input[key] !== undefined && !isNonEmptyBoundedString(input[key])) {
      return fail('invalid_envelope', key, `${key} must be a non-empty bounded string when provided`);
    }
  }

  if (input.extensions !== undefined) {
    if (!isRecord(input.extensions)) {
      return fail('invalid_envelope', 'extensions', 'extensions must be an object when provided');
    }
    const size = jsonSize(input.extensions);
    if (size === null) {
      return fail('invalid_envelope', 'extensions', 'extensions must be JSON-serializable');
    }
    if (size > P3394_ENVELOPE_LIMITS.maxMetadataJsonChars) {
      return fail('metadata_too_large', 'extensions', 'extensions exceeds the envelope metadata limit');
    }
  }

  // Normalize: absent spec_version defaults to the current bridge version
  // so downstream consumers can rely on it being present.
  const normalized: P3394Envelope = {
    ...(input as unknown as P3394Envelope),
    spec_version: P3394_ENVELOPE_VERSION,
  };
  return { ok: true, envelope: normalized };
}
