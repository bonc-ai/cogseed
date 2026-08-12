import { safeId } from '../../storage';
import { TouchpointContractError } from './errors';
import {
  TOUCHPOINT_EVENT_KINDS,
  type TouchpointDomainEvent,
  type TouchpointDomainEventInput,
  type TouchpointEventKind,
} from './types';

const EVENT_KIND_SET = new Set<string>(TOUCHPOINT_EVENT_KINDS);
const MAX_EVENT_ID_LENGTH = 160;
const MAX_SUBJECT_TYPE_LENGTH = 80;
const MAX_SUBJECT_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 240;
const MAX_BODY_LENGTH = 4_000;
const MAX_CONTEXT_REF_LENGTH = 512;
const FORBIDDEN_IDENTIFIER_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_TEXT_CHARACTERS = /[\u0000\u000b\u000c\u000e-\u001f\u007f]/;

function normalizeUserId(userId: string): string {
  if (!safeId(userId)) {
    throw new TouchpointContractError('invalid_user_id', 'Touchpoint user id is invalid.', 'userId');
  }
  return userId;
}

function normalizeIdentifier(value: string, field: string, maxLength: number, allowColon = false): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const pattern = allowColon ? /^[A-Za-z0-9_.:/-]+$/ : /^[A-Za-z0-9_.-]+$/;
  if (!normalized || normalized.length > maxLength || FORBIDDEN_IDENTIFIER_CHARACTERS.test(normalized) || !pattern.test(normalized)) {
    throw new TouchpointContractError('invalid_identifier', `Touchpoint ${field} is invalid.`, field);
  }
  return normalized;
}

function normalizeText(value: string, field: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || FORBIDDEN_TEXT_CHARACTERS.test(normalized)) {
    throw new TouchpointContractError('invalid_text', `Touchpoint ${field} is invalid.`, field);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return normalizeText(value, field, maxLength);
}

export function normalizeTouchpointTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TouchpointContractError('invalid_timestamp', `Touchpoint ${field} is invalid.`, field);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TouchpointContractError('invalid_timestamp', `Touchpoint ${field} is invalid.`, field);
  }
  return new Date(timestamp).toISOString();
}

export function assertTouchpointUserId(userId: string): string {
  return normalizeUserId(userId);
}

export function normalizeTouchpointIdentifier(value: string, field: string, maxLength = 256, allowColon = false): string {
  return normalizeIdentifier(value, field, maxLength, allowColon);
}

export function createTouchpointDomainEvent(
  userId: string,
  input: TouchpointDomainEventInput,
): TouchpointDomainEvent {
  const normalizedUserId = normalizeUserId(userId);
  if (!input || typeof input !== 'object') {
    throw new TouchpointContractError('invalid_identifier', 'Touchpoint event input is invalid.', 'event');
  }
  if (!EVENT_KIND_SET.has(input.kind)) {
    throw new TouchpointContractError('unsupported_event_kind', 'Touchpoint event kind is unsupported.', 'kind');
  }

  const kind = input.kind as TouchpointEventKind;
  const body = normalizeOptionalText(input.summary?.body, 'summary.body', MAX_BODY_LENGTH);
  const contextRef = input.contextRef === undefined
    ? undefined
    : normalizeIdentifier(input.contextRef, 'contextRef', MAX_CONTEXT_REF_LENGTH, true);

  return {
    version: 1,
    eventId: normalizeIdentifier(input.eventId, 'eventId', MAX_EVENT_ID_LENGTH),
    userId: normalizedUserId,
    kind,
    subject: {
      type: normalizeIdentifier(input.subject?.type, 'subject.type', MAX_SUBJECT_TYPE_LENGTH),
      id: normalizeIdentifier(input.subject?.id, 'subject.id', MAX_SUBJECT_ID_LENGTH),
    },
    occurredAt: normalizeTouchpointTimestamp(input.occurredAt, 'occurredAt'),
    summary: {
      title: normalizeText(input.summary?.title, 'summary.title', MAX_TITLE_LENGTH),
      ...(body ? { body } : {}),
    },
    ...(contextRef ? { contextRef } : {}),
  };
}

export { TouchpointContractError } from './errors';
