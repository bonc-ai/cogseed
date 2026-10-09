export type AgentBackend = 'native' | 'core';

import { isAgentCapability, type AgentCapability } from './capability-catalog';

export type { AgentCapability } from './capability-catalog';

export type AgentBackendPreference = AgentBackend | 'auto';

export type AgentExecutionEventType =
  | 'started'
  | 'model_delta'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'cancelled';

export type AgentExecutionTerminalEventType = 'result' | 'error' | 'cancelled';

export type AgentExecutionTerminalEvent = AgentExecutionEvent & {
  type: AgentExecutionTerminalEventType;
};

export type AgentExecutionOutcomeStatus = 'completed' | 'failed' | 'cancelled';

export type AgentFallbackReason =
  | 'capability_gap'
  | 'explicit_compatibility';

export interface AgentTextContextItem {
  type: 'text';
  content: string;
  label?: string;
}

export interface AgentFileContextItem {
  type: 'file';
  path: string;
  label?: string;
}

export type AgentContextItem = AgentTextContextItem | AgentFileContextItem;

export interface AgentAttachment {
  type: 'file';
  path: string;
  name?: string;
}

export interface AgentExecutionRequest {
  userId: string;
  requestId: string;
  sessionId: string;
  task: string;
  context: readonly AgentContextItem[];
  attachments: readonly AgentAttachment[];
  requiredCapabilities: readonly AgentCapability[];
  backendPreference?: AgentBackendPreference;
  allowFallback: boolean;
  allowSideEffects: boolean;
}

export interface AgentExecutionEvent {
  type: AgentExecutionEventType;
  requestId: string;
  sessionId: string;
  backend: AgentBackend;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutionOutcome {
  requestId: string;
  sessionId: string;
  backend: AgentBackend;
  status: AgentExecutionOutcomeStatus;
  text?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCapabilityGap {
  backend: AgentBackend;
  missingCapabilities: readonly AgentCapability[];
  fallbackAllowed: boolean;
  fallbackReason?: AgentFallbackReason;
}

export const AGENT_EXECUTION_FORBIDDEN_FIELDS = Object.freeze([
  'cid',
  'gconv',
  'gmember',
  'conversation_id',
  'conversationId',
  'full_transcript',
  'fullTranscript',
  'transcript',
  'transcript_path',
  'transcriptPath',
]);

const AGENT_BACKENDS: readonly AgentBackend[] = ['native', 'core'];
const AGENT_BACKEND_PREFERENCES: readonly AgentBackendPreference[] = ['auto', ...AGENT_BACKENDS];
const AGENT_EXECUTION_EVENT_TYPES: readonly AgentExecutionEventType[] = [
  'started',
  'model_delta',
  'tool_call',
  'tool_result',
  'result',
  'error',
  'cancelled',
];
const AGENT_EXECUTION_TERMINAL_EVENT_TYPES: readonly AgentExecutionTerminalEventType[] = ['result', 'error', 'cancelled'];
const AGENT_FALLBACK_REASONS: readonly AgentFallbackReason[] = [
  'capability_gap',
  'explicit_compatibility',
];

const REQUEST_KEYS = new Set([
  'userId',
  'requestId',
  'sessionId',
  'task',
  'context',
  'attachments',
  'requiredCapabilities',
  'backendPreference',
  'allowFallback',
  'allowSideEffects',
]);

const EVENT_KEYS = new Set([
  'type',
  'requestId',
  'sessionId',
  'backend',
  'text',
  'metadata',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function hasForbiddenField(value: Record<string, unknown>): boolean {
  return AGENT_EXECUTION_FORBIDDEN_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function containsForbiddenField(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return false;
  }
  if (typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    if (!isDenseArray(value)) return true;
    return value.some((item) => containsForbiddenField(item, seen));
  }

  if (!isRecord(value)) return true;
  if (hasForbiddenField(value)) return true;
  return Object.values(value).some((item) => containsForbiddenField(item, seen));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function hasOnlyKnownKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isAgentBackend(value: unknown): value is AgentBackend {
  return typeof value === 'string' && (AGENT_BACKENDS as readonly string[]).includes(value);
}

export function isAgentBackendPreference(value: unknown): value is AgentBackendPreference {
  return typeof value === 'string' && (AGENT_BACKEND_PREFERENCES as readonly string[]).includes(value);
}

export function isAgentFallbackReason(value: unknown): value is AgentFallbackReason {
  return typeof value === 'string' && (AGENT_FALLBACK_REASONS as readonly string[]).includes(value);
}

export function isTerminalAgentExecutionEvent(value: unknown): value is AgentExecutionTerminalEvent {
  return isAgentExecutionEvent(value)
    && (AGENT_EXECUTION_TERMINAL_EVENT_TYPES as readonly string[]).includes(value.type);
}

export function isValidAgentExecutionEventSequence(events: readonly unknown[]): events is readonly AgentExecutionEvent[] {
  let terminalSeen = false;
  let requestId: string | null = null;
  let sessionId: string | null = null;
  let backend: AgentBackend | null = null;

  for (const [index, event] of events.entries()) {
    if (!isAgentExecutionEvent(event)) return false;
    if (index === 0 && event.type !== 'started') return false;
    if (terminalSeen) return false;

    if (requestId === null) {
      requestId = event.requestId;
      sessionId = event.sessionId;
      backend = event.backend;
    } else if (event.requestId !== requestId || event.sessionId !== sessionId || event.backend !== backend) {
      return false;
    }

    if (isTerminalAgentExecutionEvent(event)) terminalSeen = true;
  }

  return terminalSeen;
}

function isAgentContextItem(value: unknown): value is AgentContextItem {
  if (!isRecord(value)) return false;
  if (hasForbiddenField(value)) return false;
  if (value.type === 'text') {
    return hasOnlyKnownKeys(value, new Set(['type', 'content', 'label']))
      && typeof value.content === 'string'
      && isOptionalString(value.label);
  }
  if (value.type === 'file') {
    return hasOnlyKnownKeys(value, new Set(['type', 'path', 'label']))
      && typeof value.path === 'string'
      && isOptionalString(value.label);
  }
  return false;
}

function isAgentAttachment(value: unknown): value is AgentAttachment {
  return isRecord(value)
    && !hasForbiddenField(value)
    && hasOnlyKnownKeys(value, new Set(['type', 'path', 'name']))
    && value.type === 'file'
    && typeof value.path === 'string'
    && isOptionalString(value.name);
}

export function isAgentExecutionRequest(value: unknown): value is AgentExecutionRequest {
  if (!isRecord(value)) return false;
  if (hasForbiddenField(value)) return false;
  if (!hasOnlyKnownKeys(value, REQUEST_KEYS)) return false;
  return typeof value.userId === 'string'
    && typeof value.requestId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.task === 'string'
    && isDenseArray(value.context)
    && value.context.every(isAgentContextItem)
    && isDenseArray(value.attachments)
    && value.attachments.every(isAgentAttachment)
    && isDenseArray(value.requiredCapabilities)
    && value.requiredCapabilities.every(isAgentCapability)
    && (value.backendPreference === undefined || isAgentBackendPreference(value.backendPreference))
    && typeof value.allowFallback === 'boolean'
    && typeof value.allowSideEffects === 'boolean';
}

export function assertAgentExecutionRequest(value: unknown): asserts value is AgentExecutionRequest {
  if (!isRecord(value)) throw new Error('agent execution request must be an object');
  const forbidden = AGENT_EXECUTION_FORBIDDEN_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(value, field));
  if (forbidden) throw new Error(`agent execution request contains forbidden field: ${forbidden}`);
  if (!isAgentExecutionRequest(value)) throw new Error('invalid agent execution request shape');
}

export function isAgentExecutionEvent(value: unknown): value is AgentExecutionEvent {
  if (!isRecord(value)) return false;
  if (hasForbiddenField(value)) return false;
  if (!hasOnlyKnownKeys(value, EVENT_KEYS)) return false;
  return typeof value.type === 'string'
    && (AGENT_EXECUTION_EVENT_TYPES as readonly string[]).includes(value.type)
    && typeof value.requestId === 'string'
    && typeof value.sessionId === 'string'
    && isAgentBackend(value.backend)
    && isOptionalString(value.text)
    && (value.metadata === undefined || (isRecord(value.metadata) && !containsForbiddenField(value.metadata)));
}
