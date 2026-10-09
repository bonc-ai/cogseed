/**
 * In-memory append-first event bus primitives.
 *
 * This module deliberately stops at the envelope, sequence, replay, and
 * subscription boundary. Persistence, lifecycle, and dispatch adapters can
 * build on this contract without making the event bus aware of event-store or
 * Coordinator implementations.
 */

import {
  canSeeVisibility,
  normalizeVisibilityScope,
  type VisibilityKind,
  type VisibilityPrincipal,
  type VisibilityScope,
  type VisibilitySubject,
} from './visibility-policy';

export interface EventEnvelope<TPayload = unknown> extends Omit<VisibilitySubject, 'scope'> {
  eventId: string;
  sequence: number;
  ownerUserId: string;
  scope: VisibilityScope;
  kind: VisibilityKind;
  payload: TPayload;
  occurredAt?: string;
  dedupeKey?: string;
}

export type EventInput<TPayload = unknown> = Omit<EventEnvelope<TPayload>, 'sequence' | 'scope'> & {
  scope: VisibilitySubject['scope'];
};

export interface EventQuery<TPayload = unknown> {
  afterSequence?: number;
  principal?: VisibilityPrincipal;
  filter?: (event: EventEnvelope<TPayload>) => boolean;
  limit?: number;
}

export interface EventSubscription<TPayload = unknown> {
  snapshot(): EventEnvelope<TPayload>[];
}

export interface EventBus<TPayload = unknown> {
  append(input: EventInput<TPayload>): EventEnvelope<TPayload>;
  appendMany(inputs: readonly EventInput<TPayload>[]): EventEnvelope<TPayload>[];
  read(query?: EventQuery<TPayload>): EventEnvelope<TPayload>[];
  replay(query?: EventQuery<TPayload>): EventEnvelope<TPayload>[];
  subscribe(query?: EventQuery<TPayload>): EventSubscription<TPayload>;
  size(): number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidEventInput<TPayload>(input: EventInput<TPayload>): asserts input is EventInput<TPayload> {
  if (!input || typeof input !== 'object') {
    throw new TypeError('event input must be an object');
  }
  if (!nonEmptyString(input.eventId)) {
    throw new TypeError('eventId must be a non-empty string');
  }
  if (!nonEmptyString(input.ownerUserId)) {
    throw new TypeError('ownerUserId must be a non-empty string');
  }
  if (!nonEmptyString(input.kind)) {
    throw new TypeError('event kind must be a non-empty string');
  }
  if (normalizeVisibilityScope(input.scope).kind === 'unknown') {
    throw new TypeError('event scope must contain a supported identity');
  }
}

function normalizeAfterSequence(afterSequence: number | undefined): number {
  if (afterSequence === undefined) return 0;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError('afterSequence must be a non-negative integer');
  }
  return afterSequence;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative integer');
  }
  return limit;
}

function matchesQuery<TPayload>(event: EventEnvelope<TPayload>, query: EventQuery<TPayload>): boolean {
  if (event.sequence <= normalizeAfterSequence(query.afterSequence)) return false;
  if (query.principal && !canSeeVisibility(query.principal, event)) return false;
  return query.filter ? query.filter(event) : true;
}

export function createEventBus<TPayload = unknown>(): EventBus<TPayload> {
  const events: EventEnvelope<TPayload>[] = [];
  const byEventId = new Map<string, EventEnvelope<TPayload>>();

  const read = (query: EventQuery<TPayload> = {}): EventEnvelope<TPayload>[] => {
    const limit = normalizeLimit(query.limit);
    if (limit === 0) return [];

    const matching = events.filter((event) => matchesQuery(event, query));
    return limit === undefined ? matching : matching.slice(0, limit);
  };

  return {
    append(input) {
      assertValidEventInput(input);
      const existing = byEventId.get(input.eventId);
      if (existing) return existing;

      const event: EventEnvelope<TPayload> = Object.freeze({
        ...input,
        scope: normalizeVisibilityScope(input.scope),
        sequence: events.length + 1,
      });
      events.push(event);
      byEventId.set(event.eventId, event);
      return event;
    },

    appendMany(inputs) {
      return inputs.map((input) => this.append(input));
    },

    read,

    replay(query) {
      return read(query);
    },

    subscribe(query = {}) {
      return {
        snapshot: () => read(query),
      };
    },

    size() {
      return events.length;
    },
  };
}
