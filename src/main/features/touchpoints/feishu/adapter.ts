import { t } from '../../../i18n';
import * as manager from '../../messaging/manager';
import * as registry from '../../messaging/registry';
import { buildTouchpointCard } from './card';
import type {
  TouchpointChannelAdapter,
  TouchpointDeliveryResult,
  TouchpointIntent,
} from '../types';

export type FeishuTouchpointAdapterErrorCode =
  | 'instance_not_found'
  | 'wrong_platform'
  | 'instance_disabled'
  | 'instance_not_connected'
  | 'owner_not_bound'
  | 'delivery_failed'
  | 'delivery_receipt_missing';

export class FeishuTouchpointAdapterError extends Error {
  readonly code: FeishuTouchpointAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: FeishuTouchpointAdapterErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'FeishuTouchpointAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}

function actionHint(intent: TouchpointIntent): string {
  if (intent.template === 'daily_briefing') return t('touchpoints.feishu.briefing_mate');
  if (intent.template === 'ontology_confirmation') return t('touchpoints.feishu.review_mate');
  if (intent.template === 'task_approval') return t('touchpoints.feishu.approve_mate');
  return t('touchpoints.feishu.open_mate');
}

export function renderFeishuTouchpointText(intent: TouchpointIntent): string {
  const parts = [`**${intent.content.title.trim()}**`];
  if (intent.content.body?.trim()) parts.push(intent.content.body.trim());
  parts.push(actionHint(intent));
  return parts.join('\n\n').slice(0, 12_000);
}

export function createFeishuTouchpointAdapter(options: { instanceId: string }): TouchpointChannelAdapter {
  const instanceId = typeof options.instanceId === 'string' ? options.instanceId.trim() : '';
  if (!instanceId) throw new FeishuTouchpointAdapterError('instance_not_found', 'Feishu messaging instance is required.');
  return {
    channel: 'feishu',
    async send(userId: string, intent: TouchpointIntent): Promise<TouchpointDeliveryResult> {
      const instance = await registry.getInstance(userId, instanceId);
      if (!instance) throw new FeishuTouchpointAdapterError('instance_not_found', 'Feishu messaging instance was not found.');
      if (instance.platform !== 'feishu_lark') {
        throw new FeishuTouchpointAdapterError('wrong_platform', 'Configured messaging instance is not Feishu or Lark.');
      }
      if (!instance.enabled) throw new FeishuTouchpointAdapterError('instance_disabled', 'Feishu messaging instance is disabled.');
      if (instance.status.kind !== 'connected') {
        throw new FeishuTouchpointAdapterError('instance_not_connected', 'Feishu messaging instance is not connected.', true);
      }
      if (!instance.ownerExternalUserId) {
        throw new FeishuTouchpointAdapterError('owner_not_bound', 'Feishu owner identity is not bound.');
      }
      try {
        // Actionable intents go out as interactive cards whose buttons carry
        // signed receipt envelopes; read-only intents stay plain text.
        const { entry } = await manager.sendProactive(userId, {
          instanceId,
          recipientId: instance.ownerExternalUserId,
          text: renderFeishuTouchpointText(intent),
          ...(intent.actionContract ? { card: buildTouchpointCard(intent) } : {}),
          sourceKey: `touchpoint:${intent.intentId}`,
          signal: null,
        });
        if (!entry.externalDeliveryId) {
          throw new FeishuTouchpointAdapterError('delivery_receipt_missing', 'Feishu delivery receipt is missing.', true);
        }
        return { externalDeliveryId: entry.externalDeliveryId };
      } catch (error) {
        if (error instanceof FeishuTouchpointAdapterError) throw error;
        throw new FeishuTouchpointAdapterError('delivery_failed', 'Feishu touchpoint delivery failed.', true);
      }
    },
  };
}
