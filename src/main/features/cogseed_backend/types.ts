export const COGSEED_AGENT_BACKEND_SCHEMA_VERSION = 1 as const;

export type CogSeedActorRole = 'commander' | 'member' | 'child' | 'reviewer';
export type CogSeedSessionKind = 'generic' | 'commander' | 'member';
export type CogSeedSessionLifecycleState = 'active' | 'left' | 'aborted' | 'terminal';

export interface CogSeedActorRecord {
  actorId: string;
  actorRole: CogSeedActorRole;
  displayName: string;
  sessionId: string;
  lifecycleState: CogSeedSessionLifecycleState;
  joinedAt: string;
  leftAt?: string;
}

export interface CogSeedSessionLineage {
  parentTaskId?: string;
  retryOfTaskId?: string;
  coordinationId?: string;
  coordinationDepth?: number;
}

export type CogSeedTaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recoverable';

export type CogSeedTaskExecutionKind = 'cogseed-native' | 'local-cli' | 'group-chat';
export type CogSeedResultDeliveryState = 'not-applicable' | 'pending' | 'delivered' | 'pending-recovery';

export interface CogSeedLocalCliConfig {
  cli: string;
  agentName?: string;
  model?: string;
  customArgs?: string[];
  cliProviderId?: string;
  /** P3394 外接智能体标记：执行统一走托管 gateway（UMF），不再直跑
   *  local_agents runner —— wake 与对话分派共用同一条协议轨。 */
  viaP3394Gateway?: boolean;
}

export interface CogSeedTaskSkillVersionPin {
  skillId: string;
  version: string;
  manifestHash: string;
  revisionId?: string;
}

export interface CogSeedTaskRecord {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  executionId?: string;
  runtimeRunId?: string;
  runtimeWorkerId?: string;
  requestId: string;
  /** Internal SHA-256 of the canonical create request. It allows a request
   * claim interrupted after the task write to be repaired without storing a
   * second copy of the request payload. */
  requestFingerprint?: string;
  ownerId: string;
  status: CogSeedTaskStatus;
  task: string;
  conversationId?: string;
  agentId?: string;
  executionKind?: CogSeedTaskExecutionKind;
  /** Delivery of the terminal result into the bound CogSeed conversation.
   * Raw output remains in the execution path and is never copied into dashboard DTOs. */
  resultDeliveryState?: CogSeedResultDeliveryState;
  /** Privacy-safe Group Chat correlation ids. Message bodies are never copied here. */
  groupChatRunId?: string;
  groupChatTurnId?: string;
  groupChatSourceMessageId?: string;
  groupChatMessageId?: string;
  groupChatActorKind?: 'commander' | 'agent' | 'worker';
  /** Group Chat's authoritative collaboration identifiers. The Workflow data
   * remains in the conversation collaboration store; CogSeed only keeps the
   * safe correlation needed by renderer projections. */
  groupChatWorkflowRunId?: string;
  groupChatWorkflowStepId?: string;
  allowedSkillIds?: string[];
  skillVersionPins?: CogSeedTaskSkillVersionPin[];
  skillVersionPinStatus?: 'pinned' | 'unpinned';
  localCli?: CogSeedLocalCliConfig;
  profileId?: string;
  /** Explicit Commander-granted Recall ability assets for this task. */
  abilityAssetIds?: string[];
  /** Validated CLI working directory for this task. */
  workingDir?: string;
  retryOfTaskId?: string;
  lastResumeRequestId?: string;
  /** SHA-256 of the last resume payload; raw continuation data is not stored here. */
  lastResumeRequestFingerprint?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  /** User-hidden timestamp. Archiving removes a terminal run from default
   * dashboard lists without rewriting its lifecycle status or history. */
  archivedAt?: string;
  errorCode?: string;
  /** Optional durable bridge to the governed KSTAR records. */
  kstarTaskId?: string;
  kstarRequirementId?: string;
  kstarProjectionId?: string;
  kstarForecastId?: string;
}

export interface CogSeedSessionRecord {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  sessionId: string;
  runtimeSessionId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** Canonical CogSeed session classification. Legacy records are hydrated as generic/commander. */
  sessionKind: CogSeedSessionKind;
  actorRole: CogSeedActorRole;
  actorId?: string;
  conversationId?: string;
  /** Formal product Agent identity. Member sessions hydrate this from actorId. */
  agentId?: string;
  /** Public CogSeed-compatible id, retained only as an alias; storage remains CogSeed-owned. */
  compatibilitySessionId?: string;
  commanderSessionId?: string;
  displayName?: string;
  lifecycleState: CogSeedSessionLifecycleState;
  joinedAt?: string;
  leftAt?: string;
  roster?: CogSeedActorRecord[];
  lineage?: CogSeedSessionLineage;
  activeTaskId?: string;
}

export interface CogSeedCommanderSession extends CogSeedSessionRecord {
  sessionKind: 'commander';
  actorRole: 'commander';
  actorId: 'commander';
  conversationId: string;
  roster: CogSeedActorRecord[];
}

export interface CogSeedMemberSession extends CogSeedSessionRecord {
  sessionKind: 'member';
  actorRole: 'member' | 'child' | 'reviewer';
  actorId: string;
  conversationId: string;
  commanderSessionId: string;
  displayName: string;
}

export interface CogSeedRequestClaim {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  requestId: string;
  taskId: string;
  ownerId: string;
  createdAt: string;
  /** SHA-256 of canonical material request fields for replay conflict detection. */
  requestFingerprint?: string;
}

export type CogSeedTaskEventType =
  | 'task.created'
  | 'task.queued'
  | 'task.started'
  | 'task.waiting_user'
  | 'model.delta'
  | 'tool.started'
  | 'tool.finished'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.recoverable'
  | 'task.archived'
  | 'artifact';

export interface CogSeedTaskEvent {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  sessionId: string;
  sequence: number;
  type: CogSeedTaskEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}


export interface CogSeedCoordinationRecord {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  coordinationId: string;
  ownerId: string;
  parentTaskId: string;
  parentRuntimeSessionId: string;
  workflowRunId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  childTaskIds: string[];
  maxChildren: number;
  maxDepth: number;
  createdAt: string;
  updatedAt: string;
}
