import * as crypto from 'node:crypto';

import * as messagingManager from '../messaging/manager';
import { createTouchpointDomainEvent } from './events';
import { createTouchpointIntent } from './intents';
import { reserveTouchpointIntent } from './ledger';
import { dispatchTouchpointIntent } from './orchestrator';
import { createFeishuTouchpointAdapter } from './feishu/adapter';

export interface TestApprovalCardDeliveryResult {
  ok: boolean;
  code?: string;
  intentId?: string;
  status?: string;
  externalDeliveryId?: string;
  error?: string;
}

/** One-hour expiry keeps test intents from lingering in the ledger. */
const TEST_INTENT_TTL_MS = 60 * 60 * 1000;

/** Manual test entry point for the touchpoint receipt loop: creates a
 * `task_approval` intent with a declared input field, runs it through the
 * real ledger and the Feishu adapter, and sends an interactive card to the
 * bound owner. Clicking a button on that card exercises the full
 * card-action → consume → terminal-card path end to end. */
export async function testApprovalCardDelivery(
  userId: string,
  instanceId?: string,
): Promise<TestApprovalCardDeliveryResult> {
  const instances = await messagingManager.listInstances(userId);
  const candidates = instances.filter((instance) => instance.platform === 'feishu_lark' && instance.enabled);
  const target = instanceId?.trim()
    || candidates.find((instance) => instance.status.kind === 'connected')?.id
    || candidates[0]?.id;
  if (!target) return { ok: false, code: 'instance_unknown', error: '没有可用的飞书消息实例' };

  const now = new Date();
  const event = createTouchpointDomainEvent(userId, {
    eventId: `test-approval-${crypto.randomUUID()}`,
    kind: 'task.approval_required',
    subject: { type: 'task', id: 'touchpoint-test' },
    occurredAt: now.toISOString(),
    summary: {
      title: '触达点测试：审批卡片',
      body: '这是一张测试卡片：请在下方填写审批意见，然后点击按钮。',
    },
    contextRef: 'touchpoint:test',
  });
  const intent = createTouchpointIntent(userId, event, {
    intentId: `tp-test-${crypto.randomUUID().slice(0, 12)}`,
    channel: 'feishu',
    template: 'task_approval',
    priority: 'high',
    availableFrom: now.toISOString(),
    expiresAt: new Date(now.getTime() + TEST_INTENT_TTL_MS).toISOString(),
    dedupeKey: `test:approval:${crypto.randomUUID()}`,
    actionContract: {
      version: 1,
      allowedActions: ['approve', 'reject', 'snooze'],
      input: { label: '审批意见', placeholder: '选填，例如：同意，但需补材料' },
    },
  });
  await reserveTouchpointIntent(userId, intent);

  const adapter = createFeishuTouchpointAdapter({ instanceId: target });
  try {
    const sent = await dispatchTouchpointIntent(userId, intent.intentId, adapter);
    if (sent.status === 'sent') {
      return { ok: true, intentId: sent.intentId, status: sent.status, externalDeliveryId: sent.externalDeliveryId };
    }
    return { ok: false, code: 'delivery_failed', intentId: sent.intentId, status: sent.status, error: sent.error };
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : '触达点测试卡片发送失败';
    return { ok: false, code: 'delivery_failed', intentId: intent.intentId, error: message };
  }
}
