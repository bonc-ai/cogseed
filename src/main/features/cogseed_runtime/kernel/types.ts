import type { RuntimeAttachment, RuntimeContextItem, RuntimeSkillVersionPin } from '../protocol';

export type RuntimeKernelEventType =
  | 'started'
  | 'model_delta'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'cancelled';

export interface RuntimeToolPolicy {
  fileRead: 'none' | 'explicit_roots';
  fileWrite: 'none' | 'explicit_writable_roots';
  shell: 'none' | 'low_risk_only' | 'allow_with_confirmation';
  skillRun: 'none' | 'allowlisted_skills';
  network: 'none';
  connectors: 'none' | 'enabled';
}

export interface RuntimeKernelRequest {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  task: string;
  context: RuntimeContextItem[];
  attachments: RuntimeAttachment[];
  readOnlyRoots: string[];
  writableRoots: string[];
  toolPolicy: RuntimeToolPolicy;
  /** Main-process-derived capability grants (see protocol.RuntimeRunRequest). */
  capabilities: string[];
  agentId?: string;
  executionKind: 'cogseed-native';
  allowedSkillIds: string[];
  skillVersionPins: RuntimeSkillVersionPin[];
  modelProfile?: string;
  workingDir?: string;
}

export interface RuntimeKernelEvent {
  type: RuntimeKernelEventType;
  requestId: string;
  runtimeSessionId: string;
  text?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeKernelRunOptions {
  signal?: AbortSignal | null;
}

export interface RuntimeKernelSessionSummary {
  runtimeSessionId: string;
  version: number;
  kernel: 'cogseed-agent-native';
  recordCount: number;
  lastRequestId?: string;
}
