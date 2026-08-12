import { randomUUID } from 'crypto';
import { t } from '../../../i18n';
import { signTouchpointAction } from '../sign';
import type { TouchpointActionKind, TouchpointIntent } from '../types';
import type { JsonCompatibleValue } from '../../messaging/types';

/** Card header template by priority: urgent and high get attention colors. */
function headerTemplate(priority: TouchpointIntent['priority']): string {
  if (priority === 'urgent') return 'red';
  if (priority === 'high') return 'orange';
  return 'blue';
}

/** Button visual type by action: approvals are primary, dismissals danger. */
const ACTION_BUTTON_TYPES: Readonly<Record<TouchpointActionKind, string>> = {
  open: 'default',
  snooze: 'default',
  confirm: 'primary',
  reject: 'danger',
  edit: 'default',
  approve: 'primary',
  adjust: 'default',
  retry: 'default',
  forget_source: 'default',
  revoke_grant: 'danger',
};

function buildTouchpointButton(intent: TouchpointIntent, action: TouchpointActionKind): Record<string, JsonCompatibleValue> {
  const occurredAt = new Date().toISOString();
  const actionId = randomUUID();
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: t(`touchpoints.card.button.${action}`) },
    type: ACTION_BUTTON_TYPES[action] || 'default',
    // The envelope travels inside the button value so `card.action.trigger`
    // events carry everything the receipt contract needs. Values are limited
    // to JSON primitives by the adapter normalization, so the signature is a
    // digest string rather than an object.
    value: {
      action: 'touchpoint',
      intent_id: intent.intentId,
      action_id: actionId,
      user_id: intent.userId,
      occurred_at: occurredAt,
      signature: signTouchpointAction(intent.intentId, intent.userId, action, occurredAt),
      kind: action,
    },
  };
}

/** Interactive card for an actionable touchpoint intent. Every button in the
 * intent's action contract carries a signed receipt envelope; clicks route
 * back through the messaging card-action pipeline into the touchpoint
 * ledger's `consumeTouchpointAction`. */
export function buildTouchpointCard(intent: TouchpointIntent): Record<string, JsonCompatibleValue> {
  const body = intent.content.body?.trim();
  const elements: Array<Record<string, JsonCompatibleValue>> = [
    { tag: 'markdown', content: [intent.content.title.trim(), body].filter(Boolean).join('\n\n').slice(0, 1500) },
  ];
  if (intent.actionContract?.allowedActions.length) {
    elements.push({
      tag: 'action',
      actions: intent.actionContract.allowedActions.map((action) => buildTouchpointButton(intent, action)),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: intent.content.title.trim().slice(0, 120), tag: 'plain_text' },
      template: headerTemplate(intent.priority),
    },
    elements,
  };
}

/** Terminal replacement card shown after a touchpoint action is consumed, so
 * the same buttons cannot be clicked twice (mirrors the resolved approval
 * card in the messaging manager). */
export function buildResolvedTouchpointCard(action: TouchpointActionKind): Record<string, JsonCompatibleValue> {
  const label = t(`touchpoints.card.button.${action}`);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `✅ ${label}`, tag: 'plain_text' },
      template: 'green',
    },
    elements: [
      { tag: 'markdown', content: `✅ **${label}** — ${t('touchpoints.card.resolved')}` },
    ],
  };
}
