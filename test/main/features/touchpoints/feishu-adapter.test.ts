import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registry: { getInstance: vi.fn() },
  manager: {
    sendProactive: vi.fn(),
    getLiveInstanceStatus: vi.fn(),
  },
}));

vi.mock('../../../../src/main/features/messaging/registry', () => mocks.registry);
vi.mock('../../../../src/main/features/messaging/manager', () => mocks.manager);

import { createTouchpointDomainEvent } from '../../../../src/main/features/touchpoints/events';
import { createTouchpointIntent } from '../../../../src/main/features/touchpoints/intents';
import {
  createFeishuTouchpointAdapter,
  renderFeishuTouchpointText,
} from '../../../../src/main/features/touchpoints/feishu/adapter';

function intent() {
  const event = createTouchpointDomainEvent('user-1', {
    eventId: 'event-1',
    kind: 'task.completed',
    subject: { type: 'task', id: 'task-1' },
    occurredAt: '2026-08-10T13:00:00.000Z',
    summary: { title: '课程资料整理完成', body: '已生成复习提纲和七天复习计划。' },
    contextRef: 'task:task-1',
  });
  return createTouchpointIntent('user-1', event, {
    intentId: 'intent-1',
    channel: 'feishu',
    template: 'task_result',
    priority: 'normal',
    availableFrom: '2026-08-10T13:00:00.000Z',
    expiresAt: '2026-08-11T13:00:00.000Z',
    dedupeKey: 'task:task-1:result:event-1',
    actionContract: { version: 1, allowedActions: ['open'] },
  });
}

describe('Feishu touchpoint adapter', () => {
  beforeEach(() => {
    mocks.registry.getInstance.mockReset();
    mocks.manager.sendProactive.mockReset();
    mocks.manager.getLiveInstanceStatus.mockReset();
    mocks.manager.getLiveInstanceStatus.mockResolvedValue({ kind: 'connected', checkedAt: '2026-08-10T13:00:00.000Z' });
  });

  it('renders domain content rather than internal ids or credentials', () => {
    const text = renderFeishuTouchpointText(intent());
    expect(text).toContain('课程资料整理完成');
    expect(text).toContain('已生成复习提纲和七天复习计划。');
    expect(text).toMatch(/Mate/);
    expect(text).not.toContain('intent-1');
    expect(text).not.toContain('task:task-1');
  });

  it('sends to the bound owner through the existing real messaging ledger', async () => {
    mocks.registry.getInstance.mockResolvedValue({
      id: 'feishu-1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'connected', checkedAt: '2026-08-10T13:00:00.000Z' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_123', attempts: 1 } });

    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    const result = await adapter.send('user-1', intent());

    expect(result).toEqual({ externalDeliveryId: 'om_123' });
    // 渠道原生投递（2026-08-26 理清）：sourceKey 原样直传
    expect(mocks.manager.sendProactive).toHaveBeenCalledWith('user-1', expect.objectContaining({
      instanceId: 'feishu-1',
      recipientId: 'ou_owner',
      sourceKey: `touchpoint:${intent().intentId}`,
    }));
  });

  it('sends an interactive card for actionable intents', async () => {
    mocks.registry.getInstance.mockResolvedValue({
      id: 'feishu-1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'connected' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_card', attempts: 1 } });

    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    await adapter.send('user-1', intent());

    const call = mocks.manager.sendProactive.mock.calls[0][1] as {
      card?: Record<string, unknown>;
    };
    expect(call.card).toBeTruthy();
    expect(call.card?.header).toBeTruthy();
  });

  it('stays plain text for read-only intents', async () => {
    mocks.registry.getInstance.mockResolvedValue({
      id: 'feishu-1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'connected' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.sendProactive.mockResolvedValue({ entry: { externalDeliveryId: 'om_text', attempts: 1 } });

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

    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    await adapter.send('user-1', readOnly);

    const call = mocks.manager.sendProactive.mock.calls[0][1] as {
      card?: Record<string, unknown>;
    };
    expect(call.card).toBeUndefined();
  });

  it.each([
    [null, 'instance_not_found'],
    [{ id: 'feishu-1', platform: 'wecom', enabled: true, status: { kind: 'connected' }, ownerExternalUserId: 'ou_owner' }, 'wrong_platform'],
    [{ id: 'feishu-1', platform: 'feishu_lark', enabled: false, status: { kind: 'disabled' }, ownerExternalUserId: 'ou_owner' }, 'instance_disabled'],
    [{ id: 'feishu-1', platform: 'feishu_lark', enabled: true, status: { kind: 'connected' } }, 'owner_not_bound'],
  ])('rejects unusable real connections: %s', async (instance, code) => {
    mocks.registry.getInstance.mockResolvedValue(instance);
    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    await expect(adapter.send('user-1', intent())).rejects.toMatchObject({ code });
    expect(mocks.manager.sendProactive).not.toHaveBeenCalled();
  });

  it('rejects delivery when the live connection status is not connected', async () => {
    // 磁盘状态被故意降级（normalizeStatus 从不落盘 connected），连接判断
    // 必须依赖 runtime 实时状态；实时状态缺失或非 connected 时拒绝投递。
    mocks.registry.getInstance.mockResolvedValue({
      id: 'feishu-1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'disconnected' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.getLiveInstanceStatus.mockResolvedValue(null);

    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    await expect(adapter.send('user-1', intent())).rejects.toMatchObject({
      code: 'instance_not_connected',
      retryable: true,
    });
    expect(mocks.manager.sendProactive).not.toHaveBeenCalled();
  });

  it('marks connection failures retryable without leaking message content into the error', async () => {
    mocks.registry.getInstance.mockResolvedValue({
      id: 'feishu-1',
      platform: 'feishu_lark',
      enabled: true,
      status: { kind: 'connected' },
      ownerExternalUserId: 'ou_owner',
    });
    mocks.manager.sendProactive.mockRejectedValue(new Error('WebSocket connection closed'));

    const adapter = createFeishuTouchpointAdapter({ instanceId: 'feishu-1' });
    await expect(adapter.send('user-1', intent())).rejects.toMatchObject({
      code: 'delivery_failed',
      retryable: true,
      message: 'Feishu touchpoint delivery failed.',
    });
  });
});
