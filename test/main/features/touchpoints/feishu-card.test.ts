import { describe, expect, it } from 'vitest';

import { createTouchpointDomainEvent } from '../../../../src/main/features/touchpoints/events';
import { createTouchpointIntent } from '../../../../src/main/features/touchpoints/intents';
import { signTouchpointAction } from '../../../../src/main/features/touchpoints/sign';
import {
  buildResolvedTouchpointCard,
  buildTouchpointCard,
} from '../../../../src/main/features/touchpoints/feishu/card';

function actionableIntent() {
  const event = createTouchpointDomainEvent('user-1', {
    eventId: 'event-1',
    kind: 'task.approval_required',
    subject: { type: 'task', id: 'task-1' },
    occurredAt: '2026-08-10T13:00:00.000Z',
    summary: { title: '审批：张明请假', body: '下周三请一天假。' },
    contextRef: 'task:task-1',
  });
  return createTouchpointIntent('user-1', event, {
    intentId: 'intent-1',
    channel: 'feishu',
    template: 'task_approval',
    priority: 'high',
    availableFrom: '2026-08-10T13:00:00.000Z',
    expiresAt: '2026-08-11T13:00:00.000Z',
    dedupeKey: 'task:task-1:approval:event-1',
    actionContract: { version: 1, allowedActions: ['approve', 'snooze', 'reject'] },
  });
}

interface ButtonValue {
  action?: string;
  intent_id?: string;
  action_id?: string;
  user_id?: string;
  occurred_at?: string;
  signature?: string;
  kind?: string;
}

function buttonValues(card: Record<string, unknown>): ButtonValue[] {
  const actionElement = (card.elements as Array<Record<string, unknown>>).find((element) => element.tag === 'action');
  if (!actionElement) return [];
  return (actionElement.actions as Array<Record<string, unknown>>)
    .map((button) => button.value as ButtonValue)
    .filter((value) => !!value);
}

describe('Feishu touchpoint card', () => {
  it('renders one button per allowed action with a complete signed envelope', () => {
    const card = buildTouchpointCard(actionableIntent()) as Record<string, unknown>;
    const values = buttonValues(card);
    expect(values).toHaveLength(3);
    for (const value of values) {
      expect(value.action).toBe('touchpoint');
      expect(value.intent_id).toBe('intent-1');
      expect(value.user_id).toBe('user-1');
      expect(value.action_id).toBeTruthy();
      expect(value.occurred_at).toBeTruthy();
      expect(value.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(value.signature).toBe(
        signTouchpointAction('intent-1', 'user-1', value.kind as string, value.occurred_at as string),
      );
    }
    expect(values.map((value) => value.kind).sort()).toEqual(['approve', 'reject', 'snooze']);
  });

  it('renders title and body in visible text without leaking internal ids', () => {
    const card = buildTouchpointCard(actionableIntent()) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;
    const markdown = elements.find((element) => element.tag === 'markdown');
    expect(String(markdown?.content)).toContain('审批：张明请假');
    expect(String(markdown?.content)).toContain('下周三请一天假。');
    expect(String(markdown?.content)).not.toContain('intent-1');
    expect(String(markdown?.content)).not.toContain('task:task-1:approval');
  });

  it('uses an attention header for high-priority intents and omits actions when none are allowed', () => {
    const card = buildTouchpointCard(actionableIntent()) as Record<string, unknown>;
    expect((card.header as { template: string }).template).toBe('orange');
    const readOnly = createTouchpointIntent('user-1', createTouchpointDomainEvent('user-1', {
      eventId: 'event-2',
      kind: 'task.completed',
      subject: { type: 'task', id: 'task-2' },
      occurredAt: '2026-08-10T13:00:00.000Z',
      summary: { title: '任务完成', body: '已收尾。' },
    }), {
      intentId: 'intent-2',
      channel: 'feishu',
      template: 'task_result',
      priority: 'normal',
      availableFrom: '2026-08-10T13:00:00.000Z',
      expiresAt: '2026-08-11T13:00:00.000Z',
      dedupeKey: 'task:task-2:result:event-2',
    });
    expect(buttonValues(buildTouchpointCard(readOnly) as Record<string, unknown>)).toEqual([]);
  });

  it('builds a terminal resolved card without interactive buttons', () => {
    const resolved = buildResolvedTouchpointCard('approve') as Record<string, unknown>;
    expect(JSON.stringify(resolved)).toContain('✅');
    expect((resolved.header as { template: string }).template).toBe('green');
    const elements = resolved.elements as Array<Record<string, unknown>>;
    expect(elements.some((element) => element.tag === 'action')).toBe(false);
  });
});
