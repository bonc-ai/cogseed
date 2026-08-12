export const TOUCHPOINT_EVENT_KINDS = [
  'briefing.ready',
  'ontology.confirmation_required',
  'task.approval_required',
  'task.completed',
  'task.failed',
  'deadline.risk_detected',
  'calendar.conflict_detected',
  'touchpoint.binding_changed',
] as const;

export type TouchpointEventKind = (typeof TOUCHPOINT_EVENT_KINDS)[number];

export const TOUCHPOINT_CHANNELS = ['feishu'] as const;
export type TouchpointChannel = (typeof TOUCHPOINT_CHANNELS)[number];

export const TOUCHPOINT_TEMPLATES = [
  'daily_briefing',
  'ontology_confirmation',
  'task_approval',
  'task_result',
  'task_failure',
  'deadline_risk',
  'calendar_conflict',
  'binding_status',
] as const;

export type TouchpointTemplate = (typeof TOUCHPOINT_TEMPLATES)[number];

export const TOUCHPOINT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TouchpointPriority = (typeof TOUCHPOINT_PRIORITIES)[number];

export const TOUCHPOINT_INTENT_STATUSES = [
  'planned',
  'ready',
  'suppressed',
  'sending',
  'sent',
  'retry_pending',
  'failed',
  'expired',
  'cancelled',
] as const;

export type TouchpointIntentStatus = (typeof TOUCHPOINT_INTENT_STATUSES)[number];

export const TOUCHPOINT_ACTION_KINDS = [
  'open',
  'snooze',
  'confirm',
  'reject',
  'edit',
  'approve',
  'adjust',
  'retry',
  'forget_source',
  'revoke_grant',
] as const;

export type TouchpointActionKind = (typeof TOUCHPOINT_ACTION_KINDS)[number];

export interface TouchpointSubject {
  type: string;
  id: string;
}

export interface TouchpointEventSummary {
  title: string;
  body?: string;
}

export interface TouchpointDomainEvent {
  version: 1;
  eventId: string;
  userId: string;
  kind: TouchpointEventKind;
  subject: TouchpointSubject;
  occurredAt: string;
  summary: TouchpointEventSummary;
  contextRef?: string;
}

export interface TouchpointDomainEventInput {
  eventId: string;
  kind: TouchpointEventKind;
  subject: TouchpointSubject;
  occurredAt: string;
  summary: TouchpointEventSummary;
  contextRef?: string;
}

export interface TouchpointActionContract {
  version: 1;
  allowedActions: TouchpointActionKind[];
  /** Optional free-text input rendered above the card buttons. The card wires
   * it to the fixed field id `tp_content`; the submitted value travels back
   * in the action envelope's `content` (e.g. an approval note or a new
   * deadline). Omit for button-only receipts. */
  input?: {
    /** Short label shown above the input field. */
    label: string;
    /** Placeholder text inside the field. */
    placeholder?: string;
    /** Block submission until the field is filled (Feishu validates). */
    required?: boolean;
  };
}

export interface TouchpointIntent {
  version: 1;
  intentId: string;
  userId: string;
  eventId: string;
  subject: TouchpointSubject;
  content: TouchpointEventSummary;
  contextRef?: string;
  channel: TouchpointChannel;
  template: TouchpointTemplate;
  priority: TouchpointPriority;
  availableFrom: string;
  expiresAt: string;
  dedupeKey: string;
  requiresAction: boolean;
  actionContract?: TouchpointActionContract;
  status: TouchpointIntentStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  externalDeliveryId?: string;
  error?: string;
  nextAttemptAt?: string;
}

export interface TouchpointIntentInput {
  intentId: string;
  channel: TouchpointChannel;
  template: TouchpointTemplate;
  priority: TouchpointPriority;
  availableFrom: string;
  expiresAt: string;
  dedupeKey: string;
  actionContract?: TouchpointActionContract;
}

export interface TouchpointActionEnvelopeInput {
  actionId: string;
  intentId: string;
  userId: string;
  action: string;
  occurredAt: string;
  signature: string;
  /** Free-text content submitted with the action (card input field). */
  content?: string;
}

export interface TouchpointActionEnvelope {
  version: 1;
  actionId: string;
  intentId: string;
  userId: string;
  action: TouchpointActionKind;
  occurredAt: string;
  signature: string;
  /** Free-text content submitted with the action (card input field). */
  content?: string;
}

export interface TouchpointActionRecord {
  version: 1;
  actionId: string;
  intentId: string;
  userId: string;
  action: TouchpointActionKind;
  occurredAt: string;
  signatureHash: string;
  consumedAt: string;
  /** Free-text content submitted with the action (card input field). */
  content?: string;
}

export interface TouchpointLedgerFile {
  version: 1;
  intents: Record<string, TouchpointIntent>;
  actions: Record<string, TouchpointActionRecord>;
}


export interface TouchpointQuietHours {
  start: string;
  end: string;
  timeZone: string;
}

export interface TouchpointPolicyConfig {
  enabled: boolean;
  quietHours?: TouchpointQuietHours;
}

export interface TouchpointPolicyDecision {
  decision: 'deliver' | 'delay' | 'suppress';
  reason?: 'quiet_hours' | 'touchpoint_disabled';
  availableFrom?: string;
}

export interface TouchpointDeliveryResult {
  externalDeliveryId: string;
}

export interface TouchpointChannelAdapter {
  readonly channel: TouchpointChannel;
  send(userId: string, intent: TouchpointIntent): Promise<TouchpointDeliveryResult>;
}
