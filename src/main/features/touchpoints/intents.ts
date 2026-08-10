import { TouchpointContractError } from './errors';
import {
  assertTouchpointUserId,
  normalizeTouchpointIdentifier,
  normalizeTouchpointTimestamp,
} from './events';
import {
  TOUCHPOINT_ACTION_KINDS,
  TOUCHPOINT_CHANNELS,
  TOUCHPOINT_PRIORITIES,
  TOUCHPOINT_TEMPLATES,
  type TouchpointActionContract,
  type TouchpointActionEnvelope,
  type TouchpointActionEnvelopeInput,
  type TouchpointActionKind,
  type TouchpointChannel,
  type TouchpointDomainEvent,
  type TouchpointIntent,
  type TouchpointIntentInput,
  type TouchpointPriority,
  type TouchpointTemplate,
} from './types';

const CHANNEL_SET = new Set<string>(TOUCHPOINT_CHANNELS);
const TEMPLATE_SET = new Set<string>(TOUCHPOINT_TEMPLATES);
const PRIORITY_SET = new Set<string>(TOUCHPOINT_PRIORITIES);
const ACTION_SET = new Set<string>(TOUCHPOINT_ACTION_KINDS);

const EVENT_TEMPLATE_MAP: Readonly<Record<TouchpointDomainEvent['kind'], readonly TouchpointTemplate[]>> = {
  'briefing.ready': ['daily_briefing'],
  'ontology.confirmation_required': ['ontology_confirmation'],
  'task.approval_required': ['task_approval'],
  'task.completed': ['task_result'],
  'task.failed': ['task_failure'],
  'deadline.risk_detected': ['deadline_risk'],
  'calendar.conflict_detected': ['calendar_conflict'],
  'touchpoint.binding_changed': ['binding_status'],
};

const REQUIRED_ACTION_TEMPLATES = new Set<TouchpointTemplate>([
  'ontology_confirmation',
  'task_approval',
]);

function normalizeActionContract(
  template: TouchpointTemplate,
  contract: TouchpointActionContract | undefined,
): TouchpointActionContract | undefined {
  if (!contract) {
    if (REQUIRED_ACTION_TEMPLATES.has(template)) {
      throw new TouchpointContractError('invalid_action_contract', 'This touchpoint template requires actions.', 'actionContract');
    }
    return undefined;
  }
  if (contract.version !== 1 || !Array.isArray(contract.allowedActions) || contract.allowedActions.length === 0) {
    throw new TouchpointContractError('invalid_action_contract', 'Touchpoint action contract is invalid.', 'actionContract');
  }
  const allowedActions: TouchpointActionKind[] = [];
  const seen = new Set<string>();
  for (const rawAction of contract.allowedActions) {
    if (!ACTION_SET.has(rawAction)) {
      throw new TouchpointContractError('invalid_action_contract', 'Touchpoint action contract contains an unsupported action.', 'actionContract.allowedActions');
    }
    if (seen.has(rawAction)) continue;
    seen.add(rawAction);
    allowedActions.push(rawAction as TouchpointActionKind);
  }
  if (!allowedActions.length) {
    throw new TouchpointContractError('invalid_action_contract', 'Touchpoint action contract has no actions.', 'actionContract.allowedActions');
  }
  return { version: 1, allowedActions };
}

export function createTouchpointIntent(
  userId: string,
  event: TouchpointDomainEvent,
  input: TouchpointIntentInput,
): TouchpointIntent {
  const normalizedUserId = assertTouchpointUserId(userId);
  if (event.userId !== normalizedUserId) {
    throw new TouchpointContractError('user_mismatch', 'Touchpoint event belongs to another user.', 'event.userId');
  }
  if (!CHANNEL_SET.has(input.channel)) {
    throw new TouchpointContractError('unsupported_channel', 'Touchpoint channel is unsupported.', 'channel');
  }
  if (!TEMPLATE_SET.has(input.template)) {
    throw new TouchpointContractError('unsupported_template', 'Touchpoint template is unsupported.', 'template');
  }
  if (!PRIORITY_SET.has(input.priority)) {
    throw new TouchpointContractError('unsupported_priority', 'Touchpoint priority is unsupported.', 'priority');
  }

  const channel = input.channel as TouchpointChannel;
  const template = input.template as TouchpointTemplate;
  const priority = input.priority as TouchpointPriority;
  if (!EVENT_TEMPLATE_MAP[event.kind].includes(template)) {
    throw new TouchpointContractError('template_event_mismatch', 'Touchpoint template does not match the domain event.', 'template');
  }

  const availableFrom = normalizeTouchpointTimestamp(input.availableFrom, 'availableFrom');
  const expiresAt = normalizeTouchpointTimestamp(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(availableFrom)) {
    throw new TouchpointContractError('invalid_delivery_window', 'Touchpoint intent expires before it becomes available.', 'expiresAt');
  }
  const actionContract = normalizeActionContract(template, input.actionContract);
  const createdAt = new Date().toISOString();

  return {
    version: 1,
    intentId: normalizeTouchpointIdentifier(input.intentId, 'intentId', 160),
    userId: normalizedUserId,
    eventId: normalizeTouchpointIdentifier(event.eventId, 'eventId', 160),
    channel,
    template,
    priority,
    availableFrom,
    expiresAt,
    dedupeKey: normalizeTouchpointIdentifier(input.dedupeKey, 'dedupeKey', 512, true),
    requiresAction: Boolean(actionContract),
    ...(actionContract ? { actionContract } : {}),
    status: 'planned',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export function validateTouchpointActionEnvelope(
  userId: string,
  intent: TouchpointIntent,
  input: TouchpointActionEnvelopeInput,
  now = new Date(),
): TouchpointActionEnvelope {
  const normalizedUserId = assertTouchpointUserId(userId);
  if (intent.userId !== normalizedUserId || input.userId !== normalizedUserId) {
    throw new TouchpointContractError('user_mismatch', 'Touchpoint action belongs to another user.', 'userId');
  }
  const intentId = normalizeTouchpointIdentifier(input.intentId, 'intentId', 160);
  if (intent.intentId !== intentId) {
    throw new TouchpointContractError('intent_mismatch', 'Touchpoint action references another intent.', 'intentId');
  }
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) {
    throw new TouchpointContractError('invalid_timestamp', 'Touchpoint validation time is invalid.', 'now');
  }
  if (nowTimestamp > Date.parse(intent.expiresAt)) {
    throw new TouchpointContractError('intent_expired', 'Touchpoint intent has expired.', 'intentId');
  }
  if (!ACTION_SET.has(input.action) || !intent.actionContract?.allowedActions.includes(input.action as TouchpointActionKind)) {
    throw new TouchpointContractError('action_not_allowed', 'Touchpoint action is not allowed by this intent.', 'action');
  }
  const signature = typeof input.signature === 'string' ? input.signature.trim() : '';
  if (signature.length < 8 || signature.length > 512 || /[\u0000-\u001f\u007f]/.test(signature)) {
    throw new TouchpointContractError('invalid_signature', 'Touchpoint action signature is invalid.', 'signature');
  }

  return {
    version: 1,
    actionId: normalizeTouchpointIdentifier(input.actionId, 'actionId', 160),
    intentId,
    userId: normalizedUserId,
    action: input.action as TouchpointActionKind,
    occurredAt: normalizeTouchpointTimestamp(input.occurredAt, 'occurredAt'),
    signature,
  };
}
