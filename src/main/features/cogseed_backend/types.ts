export const MATE_AGENT_BACKEND_SCHEMA_VERSION = 1 as const;

export type MateActorRole = 'commander' | 'member' | 'child' | 'reviewer';
export type MateSessionKind = 'generic' | 'commander' | 'member';
export type MateSessionLifecycleState = 'active' | 'left' | 'aborted' | 'terminal';

export interface MateActorRecord {
  actorId: string;
  actorRole: MateActorRole;
  displayName: string;
  sessionId: string;
  lifecycleState: MateSessionLifecycleState;
  joinedAt: string;
  leftAt?: string;
}

export interface MateSessionLineage {
  parentTaskId?: string;
  retryOfTaskId?: string;
  coordinationId?: string;
  coordinationDepth?: number;
}

export type MateTaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recoverable';

export interface MateTaskRecord {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  executionId?: string;
  runtimeRunId?: string;
  runtimeWorkerId?: string;
  requestId: string;
  ownerId: string;
  status: MateTaskStatus;
  task: string;
  profileId?: string;
  retryOfTaskId?: string;
  lastResumeRequestId?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  errorCode?: string;
}

export interface MateSessionRecord {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
  sessionId: string;
  runtimeSessionId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** Canonical Mate session classification. Legacy records are hydrated as generic/commander. */
  sessionKind: MateSessionKind;
  actorRole: MateActorRole;
  actorId?: string;
  conversationId?: string;
  /** Public Orkas-compatible id, retained only as an alias; storage remains Mate-owned. */
  compatibilitySessionId?: string;
  commanderSessionId?: string;
  displayName?: string;
  lifecycleState: MateSessionLifecycleState;
  joinedAt?: string;
  leftAt?: string;
  roster?: MateActorRecord[];
  lineage?: MateSessionLineage;
}

export interface MateCommanderSession extends MateSessionRecord {
  sessionKind: 'commander';
  actorRole: 'commander';
  actorId: 'commander';
  conversationId: string;
  roster: MateActorRecord[];
}

export interface MateMemberSession extends MateSessionRecord {
  sessionKind: 'member';
  actorRole: 'member' | 'child' | 'reviewer';
  actorId: string;
  conversationId: string;
  commanderSessionId: string;
  displayName: string;
}

export interface MateRequestClaim {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
  requestId: string;
  taskId: string;
  ownerId: string;
  createdAt: string;
}

export type MateTaskEventType =
  | 'task.created'
  | 'task.queued'
  | 'task.started'
  | 'model.delta'
  | 'tool.started'
  | 'tool.finished'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.recoverable';

export interface MateTaskEvent {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  sessionId: string;
  sequence: number;
  type: MateTaskEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}


export interface MateCoordinationRecord {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
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
