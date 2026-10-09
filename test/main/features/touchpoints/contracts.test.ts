import { describe, expect, it } from 'vitest';

import {
  createTouchpointDomainEvent,
  TouchpointContractError,
} from '../../../../src/main/features/touchpoints/events';
import {
  createTouchpointIntent,
  validateTouchpointActionEnvelope,
} from '../../../../src/main/features/touchpoints/intents';

describe('touchpoint domain contracts', () => {
  it('creates a normalized domain event without leaking arbitrary payload fields', () => {
    const event = createTouchpointDomainEvent('user-1', {
      eventId: ' event-1 ',
      kind: 'briefing.ready',
      subject: { type: 'briefing', id: ' briefing-1 ' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: {
        title: ' 今日简报 ',
        body: ' 3 项重要安排 ',
      },
      contextRef: 'briefing:briefing-1',
    });

    expect(event).toEqual({
      version: 1,
      eventId: 'event-1',
      userId: 'user-1',
      kind: 'briefing.ready',
      subject: { type: 'briefing', id: 'briefing-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '今日简报', body: '3 项重要安排' },
      contextRef: 'briefing:briefing-1',
    });
  });

  it.each([
    ['', 'invalid_user_id'],
    ['../user', 'invalid_user_id'],
  ])('rejects invalid user id %j', (userId, code) => {
    expect(() => createTouchpointDomainEvent(userId, {
      eventId: 'event-1',
      kind: 'briefing.ready',
      subject: { type: 'briefing', id: 'briefing-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '今日简报' },
    })).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects unsupported event kinds, invalid timestamps, and control characters', () => {
    const base = {
      eventId: 'event-1',
      kind: 'briefing.ready' as const,
      subject: { type: 'briefing', id: 'briefing-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '今日简报' },
    };

    expect(() => createTouchpointDomainEvent('user-1', { ...base, kind: 'other.event' as never }))
      .toThrowError(expect.objectContaining({ code: 'unsupported_event_kind' }));
    expect(() => createTouchpointDomainEvent('user-1', { ...base, occurredAt: 'not-a-time' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_timestamp' }));
    expect(() => createTouchpointDomainEvent('user-1', { ...base, eventId: 'event\u0000bad' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_identifier' }));
  });

  it('creates a deterministic intent with an event-compatible template', () => {
    const event = createTouchpointDomainEvent('user-1', {
      eventId: 'event-1',
      kind: 'ontology.confirmation_required',
      subject: { type: 'ontology_candidate', id: 'candidate-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '确认课程截止日期' },
      contextRef: 'ontology:candidate-1',
    });

    const intent = createTouchpointIntent('user-1', event, {
      intentId: 'intent-1',
      channel: 'feishu',
      template: 'ontology_confirmation',
      priority: 'normal',
      availableFrom: '2026-08-10T01:00:00.000Z',
      expiresAt: '2026-08-11T01:00:00.000Z',
      dedupeKey: 'ontology:candidate-1:v1',
      actionContract: {
        version: 1,
        allowedActions: ['confirm', 'reject', 'edit'],
      },
    });

    expect(intent).toMatchObject({
      version: 1,
      intentId: 'intent-1',
      userId: 'user-1',
      eventId: 'event-1',
      channel: 'feishu',
      template: 'ontology_confirmation',
      status: 'planned',
      requiresAction: true,
      dedupeKey: 'ontology:candidate-1:v1',
    });
  });

  it('rejects cross-user events, incompatible templates, and invalid delivery windows', () => {
    const event = createTouchpointDomainEvent('user-1', {
      eventId: 'event-1',
      kind: 'briefing.ready',
      subject: { type: 'briefing', id: 'briefing-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '今日简报' },
    });

    expect(() => createTouchpointIntent('user-2', event, {
      intentId: 'intent-1',
      channel: 'feishu',
      template: 'daily_briefing',
      priority: 'normal',
      availableFrom: '2026-08-10T01:00:00.000Z',
      expiresAt: '2026-08-11T01:00:00.000Z',
      dedupeKey: 'briefing:2026-08-10',
    })).toThrowError(expect.objectContaining({ code: 'user_mismatch' }));

    expect(() => createTouchpointIntent('user-1', event, {
      intentId: 'intent-1',
      channel: 'feishu',
      template: 'task_approval',
      priority: 'normal',
      availableFrom: '2026-08-10T01:00:00.000Z',
      expiresAt: '2026-08-11T01:00:00.000Z',
      dedupeKey: 'briefing:2026-08-10',
    })).toThrowError(expect.objectContaining({ code: 'template_event_mismatch' }));

    expect(() => createTouchpointIntent('user-1', event, {
      intentId: 'intent-1',
      channel: 'feishu',
      template: 'daily_briefing',
      priority: 'normal',
      availableFrom: '2026-08-11T01:00:00.000Z',
      expiresAt: '2026-08-10T01:00:00.000Z',
      dedupeKey: 'briefing:2026-08-10',
    })).toThrowError(expect.objectContaining({ code: 'invalid_delivery_window' }));
  });

  it('validates a signed action envelope against the intent action contract and expiry', () => {
    const event = createTouchpointDomainEvent('user-1', {
      eventId: 'event-1',
      kind: 'task.approval_required',
      subject: { type: 'task', id: 'task-1' },
      occurredAt: '2026-08-10T00:30:00.000Z',
      summary: { title: '批准课程资料整理' },
    });
    const intent = createTouchpointIntent('user-1', event, {
      intentId: 'intent-1',
      channel: 'feishu',
      template: 'task_approval',
      priority: 'high',
      availableFrom: '2026-08-10T01:00:00.000Z',
      expiresAt: '2026-08-11T01:00:00.000Z',
      dedupeKey: 'task:task-1:approval:v1',
      actionContract: { version: 1, allowedActions: ['approve', 'adjust', 'reject'] },
    });

    const action = validateTouchpointActionEnvelope('user-1', intent, {
      actionId: 'action-1',
      intentId: 'intent-1',
      userId: 'user-1',
      action: 'approve',
      occurredAt: '2026-08-10T02:00:00.000Z',
      signature: 'sig_v1_abc123',
    }, new Date('2026-08-10T02:00:01.000Z'));

    expect(action).toMatchObject({
      version: 1,
      actionId: 'action-1',
      intentId: 'intent-1',
      userId: 'user-1',
      action: 'approve',
    });

    expect(() => validateTouchpointActionEnvelope('user-1', intent, {
      actionId: 'action-2',
      intentId: 'intent-1',
      userId: 'user-1',
      action: 'delete_everything',
      occurredAt: '2026-08-10T02:00:00.000Z',
      signature: 'sig_v1_abc123',
    }, new Date('2026-08-10T02:00:01.000Z'))).toThrowError(expect.objectContaining({ code: 'action_not_allowed' }));

    expect(() => validateTouchpointActionEnvelope('user-1', intent, {
      actionId: 'action-3',
      intentId: 'intent-1',
      userId: 'user-1',
      action: 'approve',
      occurredAt: '2026-08-11T02:00:00.000Z',
      signature: 'sig_v1_abc123',
    }, new Date('2026-08-11T02:00:01.000Z'))).toThrowError(expect.objectContaining({ code: 'intent_expired' }));
  });

  it('exposes structured contract errors with safe context', () => {
    try {
      createTouchpointDomainEvent('user-1', {
        eventId: '',
        kind: 'briefing.ready',
        subject: { type: 'briefing', id: 'briefing-1' },
        occurredAt: '2026-08-10T00:30:00.000Z',
        summary: { title: '今日简报' },
      });
      throw new Error('expected contract error');
    } catch (error) {
      expect(error).toBeInstanceOf(TouchpointContractError);
      expect(error).toMatchObject({ code: 'invalid_identifier', field: 'eventId' });
      expect(JSON.stringify(error)).not.toContain('token');
    }
  });
});
