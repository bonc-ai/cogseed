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

  it('renders the declared input field above the buttons with a fixed field id', () => {
    const withInput = createTouchpointIntent('user-1', createTouchpointDomainEvent('user-1', {
      eventId: 'event-3',
      kind: 'task.approval_required',
      subject: { type: 'task', id: 'task-3' },
      occurredAt: '2026-08-10T13:00:00.000Z',
      summary: { title: '审批：王五请假', body: '下周五请一天假。' },
    }), {
      intentId: 'intent-3',
      channel: 'feishu',
      template: 'task_approval',
      priority: 'normal',
      availableFrom: '2026-08-10T13:00:00.000Z',
      expiresAt: '2026-08-11T13:00:00.000Z',
      dedupeKey: 'task:task-3:approval:event-3',
      actionContract: {
        version: 1,
        allowedActions: ['approve', 'reject'],
        input: { label: '审批意见', placeholder: '选填，例如同意但需补材料', required: true },
      },
    });
    const card = buildTouchpointCard(withInput) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;
    const input = elements.find((element) => element.tag === 'input');
    expect(input).toBeTruthy();
    expect((input as Record<string, unknown>).element_id).toBe('tp_content');
    expect((input as Record<string, unknown>).required).toBe(true);
    expect(JSON.stringify((input as Record<string, unknown>).label)).toContain('审批意见');
    expect(JSON.stringify((input as Record<string, unknown>).placeholder)).toContain('选填');
    // The input sits between the body markdown and the action row.
    const tags = elements.map((element) => element.tag);
    expect(tags.indexOf('input')).toBeGreaterThan(tags.indexOf('markdown'));
    expect(tags.indexOf('input')).toBeLessThan(tags.indexOf('action'));
    // Button-only intent renders no input element.
    const withoutInput = buildTouchpointCard(actionableIntent()) as Record<string, unknown>;
    expect((withoutInput.elements as Array<Record<string, unknown>>).some((element) => element.tag === 'input')).toBe(false);
  });

  it('builds a terminal resolved card without interactive buttons', () => {
    const resolved = buildResolvedTouchpointCard('approve') as Record<string, unknown>;
    expect(JSON.stringify(resolved)).toContain('✅');
    expect((resolved.header as { template: string }).template).toBe('green');
    const elements = resolved.elements as Array<Record<string, unknown>>;
    expect(elements.some((element) => element.tag === 'action')).toBe(false);
  });

  it('echoes submitted content back on the resolved card', () => {
    const resolved = buildResolvedTouchpointCard('approve', '同意，但需补充材料') as Record<string, unknown>;
    const markdown = (resolved.elements as Array<Record<string, unknown>>).find((element) => element.tag === 'markdown');
    expect(String(markdown?.content)).toContain('同意，但需补充材料');
    const plain = buildResolvedTouchpointCard('reject', '   ') as Record<string, unknown>;
    const plainMarkdown = (plain.elements as Array<Record<string, unknown>>).find((element) => element.tag === 'markdown');
    expect(String(plainMarkdown?.content)).not.toContain('>');
  });
});
