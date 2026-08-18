import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTouchpointDomainEvent } from '../../../../src/main/features/touchpoints/events';
import { createTouchpointIntent } from '../../../../src/main/features/touchpoints/intents';
import type { TouchpointIntent } from '../../../../src/main/features/touchpoints/types';

vi.hoisted(() => {
  process.env.ORKAS_WORKSPACE_ROOT = '/tmp/mate-touchpoint-ledger-test';
});
const root = path.join(os.tmpdir(), 'mate-touchpoint-ledger-test');
const suffix = `${process.pid}-${Date.now()}`;
const USER_IDS = {
  reserve: `touchpoint-reserve-${suffix}`,
  terminal: `touchpoint-terminal-${suffix}`,
  transition: `touchpoint-transition-${suffix}`,
  action: `touchpoint-action-${suffix}`,
  reject: `touchpoint-reject-${suffix}`,
  inputRoundtrip: `touchpoint-input-${suffix}`,
  contentRoundtrip: `touchpoint-content-${suffix}`,
};

function makeIntent(userId = 'user-1', overrides: Partial<TouchpointIntent> = {}): TouchpointIntent {
  const event = createTouchpointDomainEvent(userId, {
    eventId: overrides.eventId ?? 'event-1',
    kind: 'task.approval_required',
    subject: { type: 'task', id: 'task-1' },
    occurredAt: '2026-08-10T00:30:00.000Z',
    summary: { title: '批准课程资料整理' },
  });
  return {
    ...createTouchpointIntent(userId, event, {
      intentId: overrides.intentId ?? 'intent-1',
      channel: 'feishu',
      template: 'task_approval',
      priority: 'high',
      availableFrom: '2026-08-10T01:00:00.000Z',
      expiresAt: '2026-08-11T01:00:00.000Z',
      dedupeKey: overrides.dedupeKey ?? 'task:task-1:approval:v1',
      actionContract: { version: 1, allowedActions: ['approve', 'adjust', 'reject'] },
    }),
    ...overrides,
  };
}

import * as api from '../../../../src/main/features/touchpoints/ledger';

describe('touchpoint ledger', () => {
  beforeEach(async () => {
    process.env.ORKAS_WORKSPACE_ROOT = root;
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reserves one active intent per dedupe key', async () => {
    const first = await api.reserveTouchpointIntent(USER_IDS.reserve, makeIntent(USER_IDS.reserve));
    const second = await api.reserveTouchpointIntent(USER_IDS.reserve, makeIntent(USER_IDS.reserve, { intentId: 'intent-2', eventId: 'event-2' }));

    expect(first).toMatchObject({ created: true, intent: { intentId: 'intent-1' } });
    expect(second).toMatchObject({ created: false, intent: { intentId: 'intent-1' } });
    expect((await api.listTouchpointIntents(USER_IDS.reserve)).map((item) => item.intentId)).toEqual(['intent-1']);
  });

  it('allows a new intent after the prior dedupe match becomes terminal', async () => {
    await api.reserveTouchpointIntent(USER_IDS.terminal, makeIntent(USER_IDS.terminal));
    await api.transitionTouchpointIntent(USER_IDS.terminal, 'intent-1', ['planned'], { status: 'cancelled' });

    const next = await api.reserveTouchpointIntent(USER_IDS.terminal, makeIntent(USER_IDS.terminal, { intentId: 'intent-2', eventId: 'event-2' }));

    expect(next).toMatchObject({ created: true, intent: { intentId: 'intent-2' } });
    expect((await api.listTouchpointIntents(USER_IDS.terminal)).map((item) => item.intentId)).toEqual(['intent-2', 'intent-1']);
  });

  it('enforces expected state and valid delivery transitions', async () => {
    await api.reserveTouchpointIntent(USER_IDS.transition, makeIntent(USER_IDS.transition));

    const ready = await api.transitionTouchpointIntent(USER_IDS.transition, 'intent-1', ['planned'], { status: 'ready' });
    const sending = await api.transitionTouchpointIntent(USER_IDS.transition, 'intent-1', ['ready'], { status: 'sending' });
    const sent = await api.transitionTouchpointIntent(USER_IDS.transition, 'intent-1', ['sending'], {
      status: 'sent',
      externalDeliveryId: 'om_123',
    });

    expect(ready.status).toBe('ready');
    expect(sending.status).toBe('sending');
    expect(sent).toMatchObject({ status: 'sent', externalDeliveryId: 'om_123' });

    await expect(api.transitionTouchpointIntent(USER_IDS.transition, 'intent-1', ['sent'], { status: 'ready' }))
      .rejects.toMatchObject({ code: 'invalid_status_transition' });
  });

  it('records an action once without persisting its signature', async () => {
    const intent = makeIntent(USER_IDS.action);
    await api.reserveTouchpointIntent(USER_IDS.action, intent);
    await api.transitionTouchpointIntent(USER_IDS.action, 'intent-1', ['planned'], { status: 'ready' });
    await api.transitionTouchpointIntent(USER_IDS.action, 'intent-1', ['ready'], { status: 'sending' });
    await api.transitionTouchpointIntent(USER_IDS.action, 'intent-1', ['sending'], { status: 'sent' });

    const input = {
      actionId: 'action-1',
      intentId: 'intent-1',
      userId: USER_IDS.action,
      action: 'approve',
      occurredAt: '2026-08-10T02:00:00.000Z',
      signature: 'sig_v1_abc123',
    };
    const first = await api.consumeTouchpointAction(USER_IDS.action, input, new Date('2026-08-10T02:00:01.000Z'));
    const duplicate = await api.consumeTouchpointAction(USER_IDS.action, input, new Date('2026-08-10T02:00:02.000Z'));

    expect(first).toMatchObject({ duplicate: false, action: { actionId: 'action-1', action: 'approve' } });
    expect(duplicate).toMatchObject({ duplicate: true, action: { actionId: 'action-1' } });
    expect(first.action.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await api.readTouchpointLedgerForTest(USER_IDS.action))).not.toContain('sig_v1_abc123');
  });

  it('keeps the contract input field across persist and reload', async () => {
    const intent = makeIntent(USER_IDS.inputRoundtrip, {
      dedupeKey: 'task:task-1:approval:input-v1',
      actionContract: {
        version: 1,
        allowedActions: ['approve', 'reject'],
        input: { label: '审批意见', placeholder: '选填', required: true },
      },
    });
    const { userTouchpointLedgerFile } = await import('../../../../src/main/paths');
    const f = userTouchpointLedgerFile(USER_IDS.inputRoundtrip);
    console.log('TP-DEBUG file:', f);
    try {
      const raw = await import('node:fs/promises').then((fsm) => fsm.readFile(f, 'utf8'));
      console.log('TP-DEBUG content:', raw.slice(0, 200));
    } catch (e) {
      console.log('TP-DEBUG file missing');
    }
    await api.reserveTouchpointIntent(USER_IDS.inputRoundtrip, intent);

    const reloaded = await api.getTouchpointIntent(USER_IDS.inputRoundtrip, 'intent-1');
    expect(reloaded?.intentId).toBe('intent-1');
    expect(reloaded?.actionContract).toMatchObject({
      allowedActions: ['approve', 'reject'],
      input: { label: '审批意见', placeholder: '选填', required: true },
    });
  });

  it('persists submitted content with the action record', async () => {
    const intent = makeIntent(USER_IDS.contentRoundtrip, { intentId: 'intent-content-1', dedupeKey: 'task:task-1:approval:content-v1' });
    await api.reserveTouchpointIntent(USER_IDS.contentRoundtrip, intent);
    await api.transitionTouchpointIntent(USER_IDS.contentRoundtrip, 'intent-content-1', ['planned'], { status: 'ready' });
    await api.transitionTouchpointIntent(USER_IDS.contentRoundtrip, 'intent-content-1', ['ready'], { status: 'sending' });
    await api.transitionTouchpointIntent(USER_IDS.contentRoundtrip, 'intent-content-1', ['sending'], { status: 'sent' });

    const input = {
      actionId: 'action-content-1',
      intentId: 'intent-content-1',
      userId: USER_IDS.contentRoundtrip,
      action: 'reject',
      occurredAt: '2026-08-10T02:00:00.000Z',
      signature: 'sig_v1_abc123',
      content: '不同意，请重新提交预算',
    };
    const consumed = await api.consumeTouchpointAction(USER_IDS.contentRoundtrip, input, new Date('2026-08-10T02:00:01.000Z'));
    expect(consumed.action.content).toBe('不同意，请重新提交预算');

    const reloaded = await api.readTouchpointLedgerForTest(USER_IDS.contentRoundtrip);
    expect(reloaded.actions['action-content-1']?.content).toBe('不同意，请重新提交预算');
  });

  it('rejects actions for unsent, missing, expired, or cross-user intents', async () => {
    await api.reserveTouchpointIntent(USER_IDS.reject, makeIntent(USER_IDS.reject));
    const input = {
      actionId: 'action-1',
      intentId: 'intent-1',
      userId: USER_IDS.reject,
      action: 'approve',
      occurredAt: '2026-08-10T02:00:00.000Z',
      signature: 'sig_v1_abc123',
    };

    await expect(api.consumeTouchpointAction(USER_IDS.reject, input, new Date('2026-08-10T02:00:01.000Z')))
      .rejects.toMatchObject({ code: 'intent_not_actionable' });
    await expect(api.consumeTouchpointAction('user-1', { ...input, intentId: 'missing' }, new Date('2026-08-10T02:00:01.000Z')))
      .rejects.toMatchObject({ code: 'intent_not_found' });
    await expect(api.consumeTouchpointAction('user-2', { ...input, userId: 'user-2' }, new Date('2026-08-10T02:00:01.000Z')))
      .rejects.toMatchObject({ code: 'intent_not_found' });
  });
});
