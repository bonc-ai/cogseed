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

/** Fixed input field id carried by every touchpoint card form. The adapter
 * merges `card.action.form` into the action payload under this key, and the
 * messaging manager forwards it as the envelope's `content`. */
export const TOUCHPOINT_CARD_INPUT_ID = 'tp_content';

/** Interactive card for an actionable touchpoint intent. Every button in the
 * intent's action contract carries a signed receipt envelope; clicks route
 * back through the messaging card-action pipeline into the touchpoint
 * ledger's `consumeTouchpointAction`. When the contract declares an input
 * field, it is rendered above the buttons and its submitted value travels
 * back as the envelope's `content`. */
export function buildTouchpointCard(intent: TouchpointIntent): Record<string, JsonCompatibleValue> {
  const body = intent.content.body?.trim();
  const elements: Array<Record<string, JsonCompatibleValue>> = [
    { tag: 'markdown', content: [intent.content.title.trim(), body].filter(Boolean).join('\n\n').slice(0, 1500) },
  ];
  const input = intent.actionContract?.input;
  if (input) {
    elements.push({
      tag: 'input',
      name: TOUCHPOINT_CARD_INPUT_ID,
      label: { tag: 'plain_text', content: input.label.slice(0, 120) },
      ...(input.placeholder ? { placeholder: { tag: 'plain_text', content: input.placeholder.slice(0, 120) } } : {}),
      ...(input.required === true ? { required: true } : {}),
    });
  }
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
 * card in the messaging manager). Submitted `content` is echoed back so the
 * user sees exactly what was recorded. */
export function buildResolvedTouchpointCard(
  action: TouchpointActionKind,
  content?: string,
): Record<string, JsonCompatibleValue> {
  const label = t(`touchpoints.card.button.${action}`);
  const note = typeof content === 'string' && content.trim() ? content.trim().slice(0, 2_000) : '';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { content: `✅ ${label}`, tag: 'plain_text' },
      template: 'green',
    },
    elements: [
      { tag: 'markdown', content: note
        ? `✅ **${label}** — ${t('touchpoints.card.resolved')}\n\n> ${note}`
        : `✅ **${label}** — ${t('touchpoints.card.resolved')}` },
    ],
  };
}
