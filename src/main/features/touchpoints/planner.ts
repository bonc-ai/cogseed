import * as crypto from 'node:crypto';

import { createTouchpointIntent } from './intents';
import { evaluateTouchpointPolicy } from './policy';
import type {
  TouchpointActionContract,
  TouchpointDomainEvent,
  TouchpointIntent,
  TouchpointPolicyConfig,
  TouchpointPolicyDecision,
  TouchpointPriority,
  TouchpointTemplate,
} from './types';

interface EventPlan {
  template: TouchpointTemplate;
  priority: TouchpointPriority;
  ttlMs: number;
  actionContract?: TouchpointActionContract;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const EVENT_PLANS: Readonly<Record<TouchpointDomainEvent['kind'], EventPlan>> = {
  'briefing.ready': {
    template: 'daily_briefing',
    priority: 'normal',
    ttlMs: DAY_MS,
    actionContract: { version: 1, allowedActions: ['open', 'snooze', 'adjust'] },
  },
  'ontology.confirmation_required': {
    template: 'ontology_confirmation',
    priority: 'normal',
    ttlMs: 7 * DAY_MS,
    actionContract: { version: 1, allowedActions: ['confirm', 'reject', 'edit', 'forget_source'] },
  },
  'task.approval_required': {
    template: 'task_approval',
    priority: 'high',
    ttlMs: DAY_MS,
    actionContract: { version: 1, allowedActions: ['approve', 'adjust', 'reject'] },
  },
  'task.completed': {
    template: 'task_result',
    priority: 'normal',
    ttlMs: 7 * DAY_MS,
    actionContract: { version: 1, allowedActions: ['open'] },
  },
  'task.failed': {
    template: 'task_failure',
    priority: 'high',
    ttlMs: 3 * DAY_MS,
    actionContract: { version: 1, allowedActions: ['open', 'retry'] },
  },
  'deadline.risk_detected': {
    template: 'deadline_risk',
    priority: 'urgent',
    ttlMs: 2 * DAY_MS,
    actionContract: { version: 1, allowedActions: ['open', 'snooze'] },
  },
  'calendar.conflict_detected': {
    template: 'calendar_conflict',
    priority: 'high',
    ttlMs: 2 * DAY_MS,
    actionContract: { version: 1, allowedActions: ['open', 'adjust', 'snooze'] },
  },
  'touchpoint.binding_changed': {
    template: 'binding_status',
    priority: 'low',
    ttlMs: DAY_MS,
    actionContract: { version: 1, allowedActions: ['open', 'revoke_grant'] },
  },
};

function stableId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}

export interface PlannedTouchpointIntent {
  intent: TouchpointIntent;
  policyDecision: TouchpointPolicyDecision;
}

export function planTouchpointEvent(
  userId: string,
  event: TouchpointDomainEvent,
  policy: TouchpointPolicyConfig,
  now = new Date(),
): PlannedTouchpointIntent {
  const plan = EVENT_PLANS[event.kind];
  const policyDecision = evaluateTouchpointPolicy(plan.priority, policy, now);
  const availableFrom = policyDecision.availableFrom ?? now.toISOString();
  const expiresAt = new Date(Math.max(
    Date.parse(availableFrom) + 60_000,
    Date.parse(event.occurredAt) + plan.ttlMs,
  )).toISOString();
  const dedupeKey = `${event.kind}:${event.subject.type}:${event.subject.id}:${event.eventId}`;
  const intent = createTouchpointIntent(userId, event, {
    intentId: stableId('tpi', `${userId}\0${dedupeKey}\0feishu\0${plan.template}`),
    channel: 'feishu',
    template: plan.template,
    priority: plan.priority,
    availableFrom,
    expiresAt,
    dedupeKey,
    ...(plan.actionContract ? { actionContract: plan.actionContract } : {}),
  });
  return { intent, policyDecision };
}
