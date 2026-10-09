import { describe, expect, it, vi } from 'vitest';

import { createTouchpointDomainEvent } from '../../../../src/main/features/touchpoints/events';
import {
  dispatchTouchpointIntent,
  orchestrateTouchpointEvent,
} from '../../../../src/main/features/touchpoints/orchestrator';
import { evaluateTouchpointPolicy } from '../../../../src/main/features/touchpoints/policy';
import type { TouchpointChannelAdapter } from '../../../../src/main/features/touchpoints/types';

const suffix = `${process.pid}-${Date.now()}`;

function event(userId: string, kind: Parameters<typeof createTouchpointDomainEvent>[1]['kind'], eventId: string) {
  const templateSubjects = {
    'briefing.ready': { type: 'briefing', id: 'briefing-1' },
    'ontology.confirmation_required': { type: 'ontology_candidate', id: 'candidate-1' },
    'task.approval_required': { type: 'task', id: 'task-1' },
    'task.completed': { type: 'task', id: 'task-1' },
    'task.failed': { type: 'task', id: 'task-1' },
    'deadline.risk_detected': { type: 'deadline', id: 'deadline-1' },
    'calendar.conflict_detected': { type: 'calendar_conflict', id: 'conflict-1' },
    'touchpoint.binding_changed': { type: 'touchpoint_binding', id: 'binding-1' },
  } as const;
  return createTouchpointDomainEvent(userId, {
    eventId,
    kind,
    subject: templateSubjects[kind],
    occurredAt: '2026-08-10T12:30:00.000Z',
    summary: { title: `event ${kind}` },
    contextRef: `${templateSubjects[kind].type}:${templateSubjects[kind].id}`,
  });
}

describe('touchpoint proactive policy', () => {
  it('delays non-urgent delivery until quiet hours end in the configured timezone', () => {
    const decision = evaluateTouchpointPolicy('high', {
      enabled: true,
      quietHours: { start: '22:00', end: '07:30', timeZone: 'Asia/Shanghai' },
    }, new Date('2026-08-10T15:00:00.000Z'));

    expect(decision).toEqual({
      decision: 'delay',
      reason: 'quiet_hours',
      availableFrom: '2026-08-10T23:30:00.000Z',
    });
  });

  it('allows urgent delivery during quiet hours and suppresses a disabled touchpoint', () => {
    expect(evaluateTouchpointPolicy('urgent', {
      enabled: true,
      quietHours: { start: '22:00', end: '07:30', timeZone: 'Asia/Shanghai' },
    }, new Date('2026-08-10T15:00:00.000Z'))).toMatchObject({ decision: 'deliver' });

    expect(evaluateTouchpointPolicy('normal', { enabled: false }, new Date('2026-08-10T15:00:00.000Z')))
      .toEqual({ decision: 'suppress', reason: 'touchpoint_disabled' });
  });

  it('rejects malformed quiet-hour settings rather than guessing', () => {
    expect(() => evaluateTouchpointPolicy('normal', {
      enabled: true,
      quietHours: { start: '25:00', end: '07:30', timeZone: 'Asia/Shanghai' },
    }, new Date('2026-08-10T15:00:00.000Z'))).toThrowError(expect.objectContaining({ code: 'invalid_policy' }));
    expect(() => evaluateTouchpointPolicy('normal', {
      enabled: true,
      quietHours: { start: '22:00', end: '07:30', timeZone: 'Mars/Base' },
    }, new Date('2026-08-10T15:00:00.000Z'))).toThrowError(expect.objectContaining({ code: 'invalid_policy' }));
  });
});

describe('touchpoint orchestrator', () => {
  it('maps a domain event to one event-compatible intent and deduplicates repeats', async () => {
    const userId = `orchestrator-dedupe-${suffix}`;
    const domainEvent = event(userId, 'ontology.confirmation_required', 'event-ontology-1');
    const first = await orchestrateTouchpointEvent(userId, domainEvent, {
      policy: { enabled: true },
      now: new Date('2026-08-10T13:00:00.000Z'),
    });
    const duplicate = await orchestrateTouchpointEvent(userId, domainEvent, {
      policy: { enabled: true },
      now: new Date('2026-08-10T13:00:01.000Z'),
    });

    expect(first).toMatchObject({ status: 'planned', intent: { template: 'ontology_confirmation', requiresAction: true } });
    expect(duplicate).toMatchObject({ status: 'duplicate', intent: { intentId: first.intent.intentId } });
  });

  it('persists a suppressed intent for audit when the touchpoint is disabled', async () => {
    const userId = `orchestrator-suppress-${suffix}`;
    const result = await orchestrateTouchpointEvent(userId, event(userId, 'briefing.ready', 'event-briefing-1'), {
      policy: { enabled: false },
      now: new Date('2026-08-10T13:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'suppressed',
      reason: 'touchpoint_disabled',
      intent: { status: 'suppressed', template: 'daily_briefing' },
    });
  });

  it('dispatches an available intent exactly once and records the external delivery id', async () => {
    const userId = `orchestrator-send-${suffix}`;
    const planned = await orchestrateTouchpointEvent(userId, event(userId, 'task.completed', 'event-task-1'), {
      policy: { enabled: true },
      now: new Date('2026-08-10T13:00:00.000Z'),
    });
    const adapter: TouchpointChannelAdapter = {
      channel: 'feishu',
      send: vi.fn().mockResolvedValue({ externalDeliveryId: 'om_delivery_1' }),
    };

    const sent = await dispatchTouchpointIntent(userId, planned.intent.intentId, adapter, new Date('2026-08-10T13:00:01.000Z'));

    expect(sent).toMatchObject({ status: 'sent', externalDeliveryId: 'om_delivery_1', attempts: 1 });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    await expect(dispatchTouchpointIntent(userId, planned.intent.intentId, adapter, new Date('2026-08-10T13:00:02.000Z')))
      .rejects.toMatchObject({ code: 'intent_not_dispatchable' });
  });

  it('does not dispatch before availableFrom and records retryable failures', async () => {
    const userId = `orchestrator-retry-${suffix}`;
    const planned = await orchestrateTouchpointEvent(userId, event(userId, 'task.approval_required', 'event-task-approval-1'), {
      policy: {
        enabled: true,
        quietHours: { start: '22:00', end: '07:30', timeZone: 'Asia/Shanghai' },
      },
      now: new Date('2026-08-10T15:00:00.000Z'),
    });
    const adapter: TouchpointChannelAdapter = {
      channel: 'feishu',
      send: vi.fn().mockRejectedValue(Object.assign(new Error('bridge unavailable'), { retryable: true })),
    };

    await expect(dispatchTouchpointIntent(userId, planned.intent.intentId, adapter, new Date('2026-08-10T22:00:00.000Z')))
      .rejects.toMatchObject({ code: 'intent_not_available' });

    const retry = await dispatchTouchpointIntent(userId, planned.intent.intentId, adapter, new Date('2026-08-10T23:31:00.000Z'));
    expect(retry).toMatchObject({ status: 'retry_pending', attempts: 1, error: 'bridge unavailable' });
  });
});
