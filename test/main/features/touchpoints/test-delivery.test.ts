import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manager: {
    listInstances: vi.fn(),
    sendProactive: vi.fn(),
  },
  registry: {
    getInstance: vi.fn(),
  },
}));

vi.mock('../../../../src/main/features/messaging/manager', () => mocks.manager);
vi.mock('../../../../src/main/features/messaging/registry', () => mocks.registry);

import { testApprovalCardDelivery } from '../../../../src/main/features/touchpoints/test-delivery';
import { readTouchpointLedgerForTest } from '../../../../src/main/features/touchpoints/ledger';

function connectedFeishuInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'feishu-1',
    platform: 'feishu_lark',
    enabled: true,
    status: { kind: 'connected', checkedAt: '2026-08-10T13:00:00.000Z' },
    ownerExternalUserId: 'ou_owner',
    ...overrides,
  };
}

describe('touchpoint test approval card delivery', () => {
  beforeEach(() => {
    mocks.manager.listInstances.mockReset();
    mocks.manager.sendProactive.mockReset();
    mocks.registry.getInstance.mockReset();
    mocks.registry.getInstance.mockResolvedValue(connectedFeishuInstance());
  });

  it('creates an intent and sends an interactive card with an input field', async () => {
    mocks.manager.listInstances.mockResolvedValue([connectedFeishuInstance()]);
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_test_1', attempts: 1 } });

    const result = await testApprovalCardDelivery('user-1');

    expect(result).toMatchObject({ ok: true, status: 'sent', externalDeliveryId: 'om_test_1' });
    expect(result.intentId).toBeTruthy();

    // The card sent to the owner carries the input field and signed buttons.
    const call = mocks.manager.sendProactive.mock.calls[0][1] as {
      recipientId: string;
      card?: Record<string, unknown>;
    };
    expect(call.recipientId).toBe('ou_owner');
    const elements = (call.card?.elements as Array<Record<string, unknown>>) || [];
    const input = elements.find((element) => element.tag === 'input');
    expect((input as Record<string, unknown>)?.name).toBe('tp_content');
    const actionRow = elements.find((element) => element.tag === 'action');
    expect((actionRow?.actions as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(2);

    // The intent is recorded in the real ledger as sent, with the input
    // contract preserved so the receipt loop can consume it.
    const ledgerState = await readTouchpointLedgerForTest('user-1');
    const intent = ledgerState.intents[result.intentId as string];
    expect(intent).toMatchObject({
      status: 'sent',
      template: 'task_approval',
      userId: 'user-1',
      externalDeliveryId: 'om_test_1',
    });
    expect(intent?.actionContract?.input?.label).toBeTruthy();
    expect(intent?.actionContract?.allowedActions).toContain('approve');
  });

  it('prefers a connected instance over a disconnected one', async () => {
    mocks.manager.listInstances.mockResolvedValue([
      connectedFeishuInstance({ id: 'feishu-off', status: { kind: 'error' } }),
      connectedFeishuInstance({ id: 'feishu-on', status: { kind: 'connected' } }),
    ]);
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_test_2', attempts: 1 } });

    await testApprovalCardDelivery('user-1');

    expect(mocks.manager.sendProactive.mock.calls[0][1]).toMatchObject({ instanceId: 'feishu-on' });
  });

  it('reports instance_unknown when no feishu instance is available', async () => {
    mocks.manager.listInstances.mockResolvedValue([]);

    const result = await testApprovalCardDelivery('user-1');

    expect(result).toMatchObject({ ok: false, code: 'instance_unknown' });
    expect(mocks.manager.sendProactive).not.toHaveBeenCalled();
  });

  it('marks the intent failed when delivery errors', async () => {
    mocks.manager.listInstances.mockResolvedValue([connectedFeishuInstance()]);
    mocks.manager.sendProactive.mockRejectedValue(new Error('boom'));

    const result = await testApprovalCardDelivery('user-1');

    expect(result.ok).toBe(false);
    expect(result.status).toMatch(/failed|retry_pending/);
    const ledgerState = await readTouchpointLedgerForTest('user-1');
    const intent = ledgerState.intents[result.intentId as string];
    expect(['failed', 'retry_pending']).toContain(intent?.status);
  });
});
