import {
  readCogSeedTaskEvents,
  subscribeCogSeedDashboardChanges,
  type CogSeedDashboardChange,
} from './event-store';
import { archiveCogSeedTask, markCogSeedTaskRecoverable, retryCogSeedTask } from './lifecycle';
import type { CogSeedRuntimeController, ResumeCogSeedTaskInput, StartCogSeedTaskInput } from './runtime-controller';
import { assertCogSeedAgentId, assertCogSeedConnectorId, assertCogSeedKbSourceId, assertCogSeedRequestId, assertCogSeedSessionId, assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import { listCogSeedConnectors } from './connector-store';
import { cogseedConnectorManager } from './connector-manager';
import { cogseedKbManager } from './cogseed-kb-store';
import { createCogSeedTask, listCogSeedSessions, listCogSeedTasks, readCogSeedSession, readCogSeedTask, readCogSeedTaskByRequestId } from './task-store';
import { readCogSeedCoordination } from './coordinator';
import { cogseedCollaborationStore } from './collaboration-store-adapter';
import { resolveCogSeedSessionIdentity } from './actor-session-facade';
import { computeCogSeedBoardGroupProgress } from './board-group-status';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../collaboration_control/types';
import type { CollaborationScope } from '../collaboration_control/ports';
import type { CogSeedSessionRecord, CogSeedTaskEvent, CogSeedTaskRecord, CogSeedTaskStatus } from './types';
import { t } from '../../i18n';
import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
  type CogSeedAgentExecutionContext,
} from './agent-execution-context';
import {
  cogseedWorktreeManager,
  type CogSeedWorktreeCreateInput,
  type CogSeedWorktreeRemoveInput,
} from './worktree-manager';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildCogSeedAgentRegistryProjection,
  type CogSeedRendererAgentRegistryProjection,
} from './agent-registry-projection';
import { cogSeedRequestFingerprint } from './request-fingerprint';

const MAX_TASK_CHARS = 64_000;
const MAX_PROFILE_ID_CHARS = 300;
const MAX_CONTEXT_ITEMS = 100;
const MAX_ATTACHMENT_ITEMS = 100;

interface CogSeedIpcController extends Pick<CogSeedRuntimeController, 'startCogSeedTask' | 'cancelCogSeedTask' | 'retryCogSeedTask' | 'resumeCogSeedTask' | 'retryCogSeedResultDelivery' | 'runtimeStatus' | 'restartRuntime' | 'recoverOrphanedTasks'> {}

async function resolveCogSeedRuntimeController(deps: CogSeedIpcServiceDeps): Promise<CogSeedIpcController> {
  return deps.controller ?? (await import('./runtime-controller')).cogseedRuntimeController;
}

async function reconcileCogSeedHostAgentDirectory(): Promise<void> {
  const host = await import('../cogseed-agent-registry-host');
  await host.syncCogSeedHostAgentDirectory();
}

export interface CogSeedIpcServiceDeps {
  controller?: CogSeedIpcController;
  readTask?: typeof readCogSeedTask;
  readTaskByRequestId?: typeof readCogSeedTaskByRequestId;
  admitTask?: typeof createCogSeedTask;
  retryTask?: typeof retryCogSeedTask;
  archiveTask?: typeof archiveCogSeedTask;
  readEvents?: typeof readCogSeedTaskEvents;
  subscribeDashboardChanges?: typeof subscribeCogSeedDashboardChanges;
  resolveAgentExecutionContext?: typeof resolveCogSeedAgentExecutionContext;
  listSessions?: typeof listCogSeedSessions;
  readSession?: typeof readCogSeedSession;
  listTasks?: typeof listCogSeedTasks;
  readCoordination?: typeof readCogSeedCoordination;
  readWorkflowRun?: (scope: CollaborationScope, runId: string) => Promise<WorkflowRun | null>;
  readWorkflowContext?: (scope: CollaborationScope, contextId: string) => Promise<SharedTaskContext | null>;
  readWorkflowEvents?: (scope: CollaborationScope, afterSequence?: number, limit?: number) => Promise<CollaborationEvent[]>;
  readGroupChatWorkflowRun?: (userId: string, conversationId: string, runId: string) => Promise<WorkflowRun | null>;
  readGroupChatWorkflowContext?: (userId: string, conversationId: string, contextId: string) => Promise<SharedTaskContext | null>;
  readGroupChatWorkflowEvents?: (userId: string, conversationId: string, limit?: number) => Promise<CollaborationEvent[]>;
  isConversationAvailable?: (userId: string, conversationId: string) => Promise<boolean>;
  countConversationAgents?: (userId: string, conversationId: string) => Promise<number | null>;
  ensureRunCenterConversation?: (input: {
    userId: string;
    conversationId: string;
    requestId: string;
    task: string;
    agentId: string;
  }) => Promise<void>;
  abortGroupChat?: (userId: string, conversationId: string) => Promise<unknown>;
  retryGroupChat?: (input: { userId: string; cid: string; failedMessageId: string; visibleText: string; requestId: string }) => Promise<{ ok: boolean; error?: string }>;
  worktreeManager?: Pick<typeof cogseedWorktreeManager, 'resolve' | 'list' | 'create' | 'remove'>;
  listAgentRegistry?: (userId: string) => Promise<CogSeedRendererAgentRegistryProjection>;
  reconcileAgentDirectory?: () => Promise<void>;
}

export interface CogSeedTaskEventsInput {
  taskId: string;
  afterSequence?: number;
  limit?: number;
}

export interface CogSeedTaskRetryInput {
  taskId: string;
  requestId: string;
}


export type CogSeedRendererTaskAction = 'retry' | 'skip' | 'resume' | 'recover-result' | 'abort' | 'archive';
export type CogSeedRendererCollaborationAction = 'retry-step' | 'skip-step' | 'approve-gate' | 'reject-gate' | 'dismiss-conflict';

export type CogSeedRendererTitleKey =
  | 'run_center.task_kind_cogseed'
  | 'run_center.task_kind_local_cli'
  | 'run_center.task_kind_agent_conversation'
  | 'run_center.task_kind_group_chat'
  | 'run_center.task_kind_commander_turn'
  | 'run_center.task_kind_agent_turn'
  | 'run_center.task_kind_worker_turn'
  | 'run_center.workflow_step';

export interface CogSeedRendererActionSet {
  retry: boolean;
  skip: boolean;
  resume: boolean;
  recoverResult: boolean;
  abort: boolean;
  archive: boolean;
}

export interface CogSeedRendererSessionSummary {
  sessionId: string;
  title: string;
  titleKey: CogSeedRendererTitleKey;
  latestTaskId?: string;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  activeTaskCount: number;
  latestStatus: CogSeedTaskStatus | 'idle';
  hasRecovery: boolean;
  executionId?: string;
  runtimeKind?: string;
  conversationMode: CogSeedRendererConversationMode;
  participantCount: number;
  resumable: boolean;
  resultDeliveryState: CogSeedRendererResultDeliveryState;
}

export type CogSeedRendererConversationMode = 'standard' | 'agent' | 'group' | 'legacy';
export type CogSeedRendererResultDeliveryState = 'not-applicable' | 'pending' | 'delivered' | 'pending-recovery' | 'unknown';

export type CogSeedRendererBoardColumn = 'pending' | 'running' | 'attention' | 'completed' | 'archived';

export interface CogSeedRendererBoardTask extends CogSeedRendererTaskSummary {
  column: CogSeedRendererBoardColumn;
  sessionTitle: string;
  sessionTitleKey: CogSeedRendererTitleKey;
  groupId?: string;
  conversationId?: string;
}

export interface CogSeedRendererBoardGroup {
  groupId: string;
  coordinationId?: string;
  parentTaskId: string;
  title: string;
  titleKey: CogSeedRendererTitleKey;
  status: CogSeedTaskStatus;
  updatedAt: string;
  progress: {
    total: number;
    completed: number;
    failed: number;
    active: number;
    attention: number;
  };
}

export interface CogSeedRendererBoardProjection {
  schemaVersion: 1;
  updatedAt?: string;
  tasks: CogSeedRendererBoardTask[];
  groups: CogSeedRendererBoardGroup[];
  counts: Record<CogSeedRendererBoardColumn, number>;
}

export interface CogSeedRendererDiagnostics {
  schemaVersion: 1;
  generatedAt: string;
  taskCount: number;
  sessionCount: number;
  activeTaskCount: number;
  attentionTaskCount: number;
  sourceCounts: Record<CogSeedRendererTaskSummary['sourceKind'], number>;
  statusCounts: Partial<Record<CogSeedTaskStatus, number>>;
  errorCodes: Array<{ code: string; count: number }>;
  runtime: { activeTaskCount: number; stateMatchesProjection: boolean };
  coverage: { liveInvalidation: true; payloadRedaction: true; manualRefresh: true };
}

export interface CogSeedRendererTaskSummary {
  taskId: string;
  sessionId: string;
  requestId: string;
  parentTaskId?: string;
  coordinationId?: string;
  status: CogSeedTaskStatus;
  title: string;
  titleKey: CogSeedRendererTitleKey;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  executionKind?: CogSeedTaskRecord['executionKind'];
  agentId?: string;
  conversationId?: string;
  executionId?: string;
  runtimeKind?: string;
  conversationMode: CogSeedRendererConversationMode;
  participantCount: number;
  resumable: boolean;
  resultDeliveryState: CogSeedRendererResultDeliveryState;
  worktreeName?: string;
  sourceKind: 'cogseed' | 'agent' | 'local-cli' | 'p3394-gateway' | 'agent-conversation' | 'group-chat';
  skillVersionPinStatus?: 'pinned' | 'unpinned';
  actions: CogSeedRendererActionSet;
}

export interface CogSeedRendererActorSummary {
  actorId: string;
  role: 'commander' | 'member_agent' | 'child_agent' | 'reviewer';
  displayName?: string;
  sessionId: string;
  taskId?: string;
  status: CogSeedTaskStatus | 'idle';
}

export interface CogSeedRendererTimelineEvent {
  eventId: string;
  taskId: string;
  sequence: number;
  type: CogSeedTaskEvent['type'];
  createdAt: string;
  summary: string;
  summaryKey: `run_center.event_${string}`;
  toolName?: string;
  isError?: boolean;
  errorCode?: string;
}

export interface CogSeedRendererWorkflowSummary {
  coordinationId?: string;
  workflowRunId?: string;
  status?: WorkflowRun['status'];
  phase?: string;
  childTaskIds: string[];
  steps: Array<{
    stepId: string;
    title: string;
    titleKey: CogSeedRendererTitleKey;
    actorId: string | null;
    type: string;
    status: string;
    dependsOn: string[];
    attemptCount: number;
    latestAttemptStatus?: string;
    failureCode?: string;
  }>;
}

export interface CogSeedRendererReviewSummary {
  gateId: string;
  stepId: string;
  name: string;
  status: string;
  reviewDecision?: string;
  reviewedBy?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface CogSeedRendererConflictSummary {
  conflictId: string;
  type: string;
  status: string;
  affectedStepIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CogSeedRendererCollaborationActivity {
  eventId: string;
  type: CollaborationEvent['type'];
  actorId?: string;
  stepId?: string;
  gateId?: string;
  createdAt: string;
}

export interface CogSeedRendererCollaborationSnapshot {
  schemaVersion: 1;
  sessionId: string;
  updatedAt: string;
  session: CogSeedRendererSessionSummary;
  task: CogSeedRendererTaskSummary | null;
  actors: CogSeedRendererActorSummary[];
  tasks: CogSeedRendererTaskSummary[];
  workflow: CogSeedRendererWorkflowSummary;
  reviews: CogSeedRendererReviewSummary[];
  conflicts: CogSeedRendererConflictSummary[];
  activity: CogSeedRendererCollaborationActivity[];
  recovery: {
    recoverable: boolean;
    taskIds: string[];
    lastEventAt?: string;
  };
  timeline: CogSeedRendererTimelineEvent[];
  actions: CogSeedRendererActionSet;
}

function rejectHiddenBackendFields(payload: Record<string, unknown>): void {
  const forbidden = ['allowFallback', 'backendPreference', 'kernelMode', 'mode', 'runtimeKernel'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`CogSeed does not accept Core/fallback field: ${key}`);
    }
  }
}

function asObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid CogSeed request');
  return payload as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, max: number, required = true): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) throw new Error(`${field} required`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} too long`);
  return text;
}

function boundedArray(value: unknown, field: string, max: number): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be array`);
  if (value.length > max) throw new Error(`${field} too long`);
  return value;
}

function optionalSessionId(value: unknown): string | undefined {
  const text = boundedString(value, 'sessionId', 120, false);
  return text ? assertCogSeedSessionId(text) : undefined;
}

function optionalProfileId(value: unknown): string | undefined {
  return boundedString(value, 'profileId', MAX_PROFILE_ID_CHARS, false);
}

function normalizeStartInput(payload: unknown): StartCogSeedTaskInput {
  const raw = asObject(payload);
  rejectHiddenBackendFields(raw);
  if (Object.prototype.hasOwnProperty.call(raw, 'workingDir')) {
    throw new Error('workingDir cannot be selected directly; use worktreeName');
  }
  const requestId = assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
  const task = boundedString(raw.task, 'task', MAX_TASK_CHARS) ?? '';
  const sessionId = optionalSessionId(raw.sessionId);
  const profileId = optionalProfileId(raw.profileId);
  const context = boundedArray(raw.context, 'context', MAX_CONTEXT_ITEMS);
  const attachments = boundedArray(raw.attachments, 'attachments', MAX_ATTACHMENT_ITEMS);
  const conversationId = boundedString(raw.conversationId, 'conversationId', 160, false);
  const agentId = boundedString(raw.agentId, 'agentId', 160, false);
  return {
    requestId,
    task,
    ...(sessionId ? { sessionId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(context ? { context } : {}),
    ...(attachments ? { attachments } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId: assertCogSeedAgentId(agentId) } : {}),
  };
}

function optionalWorktreeName(payload: unknown): string | undefined {
  const raw = asObject(payload);
  const name = boundedString(raw.worktreeName, 'worktreeName', 180, false);
  if (!name) return undefined;
  if (path.basename(name) !== name || !/^cogseed-worktree-[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('invalid managed worktree name');
  }
  return name;
}

function localCliFromExecutionContext(context: CogSeedAgentExecutionContext): StartCogSeedTaskInput['localCli'] {
  if (context.runtime.kind === 'in_process') return undefined;
  return {
    cli: context.runtime.cli,
    agentName: context.agentName,
    ...(context.runtime.model ? { model: context.runtime.model } : {}),
    ...(context.runtime.custom_args?.length ? { customArgs: context.runtime.custom_args } : {}),
    ...(context.runtime.cli_provider_id ? { cliProviderId: context.runtime.cli_provider_id } : {}),
    ...(context.runtime.kind === 'p3394-gateway' ? { viaP3394Gateway: true } : {}),
  };
}

export function cogSeedRunCenterConversationId(requestId: string): string {
  const digest = createHash('sha256').update(`run-center-conversation\0${requestId}`, 'utf8').digest('hex');
  return `run-center-${digest.slice(0, 16)}`;
}

async function defaultEnsureRunCenterConversation(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  task: string;
  agentId: string;
}): Promise<void> {
  const chats = await import('../chats');
  await chats.createConversation(input.userId, {
    kind: 'normal',
    conversationId: input.conversationId,
    title: chats.autoTitle(input.task),
    agentId: input.agentId,
  });
  const { appendProjectedUserTaskMessage } = await import('../group_chat/bus');
  await appendProjectedUserTaskMessage({
    uid: input.userId,
    cid: input.conversationId,
    agentId: input.agentId,
    requestId: input.requestId,
    text: input.task,
  });
}

async function defaultCountConversationAgents(userId: string, conversationId: string): Promise<number | null> {
  const conversation = await (await import('../chats')).getConversation(userId, conversationId);
  if (!conversation) return null;
  const agentIds = Array.isArray(conversation.agent_ids) ? conversation.agent_ids : [];
  return new Set([...agentIds, ...(conversation.agent_id ? [conversation.agent_id] : [])].filter(Boolean)).size;
}

function normalizeTaskId(payload: unknown): string {
  if (typeof payload === 'string') return assertCogSeedTaskId(payload.trim());
  const raw = asObject(payload);
  return assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
}

function normalizeRetryInput(payload: unknown): CogSeedTaskRetryInput {
  const raw = asObject(payload);
  rejectHiddenBackendFields(raw);
  return {
    taskId: assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''),
    requestId: assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? ''),
  };
}

function normalizeEventsInput(payload: unknown): CogSeedTaskEventsInput {
  const raw = typeof payload === 'string' ? { taskId: payload } : asObject(payload);
  return {
    taskId: assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''),
    afterSequence: Math.max(0, Math.floor(Number(raw.afterSequence) || 0)),
    limit: Math.max(1, Math.min(Math.floor(Number(raw.limit) || 200), 500)),
  };
}

function normalizeWorktreeCreateInput(payload: unknown): CogSeedWorktreeCreateInput {
  const raw = asObject(payload);
  return {
    branch: boundedString(raw.branch, 'branch', 200, false) ?? '',
    ...(raw.baseRef === undefined ? {} : { baseRef: boundedString(raw.baseRef, 'baseRef', 300, false) ?? '' }),
  };
}

function normalizeWorktreeRemoveInput(payload: unknown): CogSeedWorktreeRemoveInput {
  const raw = asObject(payload);
  return {
    path: boundedString(raw.path, 'path', 4_096, false) ?? '',
    expectedBranch: boundedString(raw.expectedBranch, 'expectedBranch', 200, false) ?? '',
  };
}



const TERMINAL_TASK_STATUSES = new Set<CogSeedTaskStatus>(['completed', 'failed', 'cancelled']);

function rendererSafeIdentifier(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) return '';
  return text && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : '';
}

type ConversationAgentCountById = ReadonlyMap<string, number>;

function rendererTaskTitle(
  task: Partial<Pick<CogSeedTaskRecord, 'executionKind' | 'conversationId' | 'groupChatTurnId' | 'groupChatActorKind'>>,
  conversationAgentCounts?: ConversationAgentCountById,
): {
  title: string;
  titleKey: CogSeedRendererTitleKey;
} {
  if (task.executionKind === 'local-cli') {
    return { title: 'Local CLI task', titleKey: 'run_center.task_kind_local_cli' };
  }
  if (task.executionKind === 'group-chat') {
    if (!task.groupChatTurnId) {
      if (task.conversationId && (conversationAgentCounts?.get(task.conversationId) ?? 0) <= 1) {
        return { title: 'Agent conversation', titleKey: 'run_center.task_kind_agent_conversation' };
      }
      return { title: 'Group Chat run', titleKey: 'run_center.task_kind_group_chat' };
    }
    if (task.groupChatActorKind === 'worker') {
      return { title: 'Worker turn', titleKey: 'run_center.task_kind_worker_turn' };
    }
    if (task.groupChatActorKind === 'agent') {
      return { title: 'Agent turn', titleKey: 'run_center.task_kind_agent_turn' };
    }
    return { title: 'Commander turn', titleKey: 'run_center.task_kind_commander_turn' };
  }
  return { title: 'CogSeed task', titleKey: 'run_center.task_kind_cogseed' };
}

function rendererSessionTitle(
  tasks: CogSeedTaskRecord[],
  conversationAgentCounts?: ConversationAgentCountById,
): ReturnType<typeof rendererTaskTitle> {
  const groupChatRun = tasks.find((task) => task.executionKind === 'group-chat' && !task.groupChatTurnId);
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return rendererTaskTitle(groupChatRun ?? latest ?? {}, conversationAgentCounts);
}

function taskActions(task: Pick<CogSeedTaskRecord, 'status' | 'executionKind' | 'conversationId' | 'groupChatMessageId' | 'resultDeliveryState' | 'archivedAt'>, hasWorkflowStep = false): CogSeedRendererActionSet {
  const { status } = task;
  const archive = status === 'failed' && !task.archivedAt
    && task.resultDeliveryState !== 'pending'
    && task.resultDeliveryState !== 'pending-recovery';
  if (task.executionKind === 'group-chat') {
    return {
      retry: status === 'failed' && !!task.conversationId && !!task.groupChatMessageId,
      skip: false,
      resume: false,
      recoverResult: false,
      abort: status === 'created' || status === 'queued' || status === 'running',
      archive,
    };
  }
  return {
    retry: status === 'failed',
    skip: hasWorkflowStep && !TERMINAL_TASK_STATUSES.has(status),
    resume: status === 'recoverable',
    recoverResult: (task.resultDeliveryState === 'pending-recovery' || task.resultDeliveryState === 'pending')
      && (status === 'completed' || status === 'failed'),
    abort: !TERMINAL_TASK_STATUSES.has(status),
    archive,
  };
}

export function cogSeedRendererBoardColumn(status: CogSeedTaskStatus, archivedAt?: string): CogSeedRendererBoardColumn {
  if (archivedAt) return 'archived';
  if (status === 'created' || status === 'queued') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'waiting_user' || status === 'recoverable' || status === 'failed') return 'attention';
  if (status === 'completed') return 'completed';
  return 'archived';
}

function taskSummary(
  task: CogSeedTaskRecord,
  hasWorkflowStep = false,
  conversationAgentCounts?: ConversationAgentCountById,
): CogSeedRendererTaskSummary {
  const title = rendererTaskTitle(task, conversationAgentCounts);
  const participantCount = task.conversationId
    ? Math.max(0, conversationAgentCounts?.get(task.conversationId) ?? (task.agentId ? 1 : 0))
    : task.agentId ? 1 : 0;
  const conversationMode: CogSeedRendererConversationMode = task.executionKind === 'group-chat'
    ? participantCount > 1 ? 'group' : 'agent'
    : task.conversationId && task.agentId
      ? 'agent'
      : task.conversationId
        ? 'standard'
        : 'legacy';
  const actions = taskActions(task, hasWorkflowStep);
  const resultDeliveryState: CogSeedRendererResultDeliveryState = task.resultDeliveryState
    ?? (!task.conversationId || !task.agentId
      ? 'not-applicable'
      : TERMINAL_TASK_STATUSES.has(task.status)
        ? 'unknown'
        : 'pending');
  const sourceKind: CogSeedRendererTaskSummary['sourceKind'] = task.executionKind === 'group-chat'
    ? participantCount <= 1
      ? 'agent-conversation'
      : 'group-chat'
    : task.localCli?.viaP3394Gateway
      ? 'p3394-gateway'
      : task.executionKind === 'local-cli'
        ? 'local-cli'
        : task.agentId
          ? 'agent'
          : 'cogseed';
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    requestId: task.requestId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.coordinationId ? { coordinationId: task.coordinationId } : {}),
    status: task.status,
    ...title,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    sourceKind,
    conversationMode,
    participantCount,
    resumable: actions.resume,
    resultDeliveryState,
    ...(rendererSafeIdentifier(task.errorCode) ? { errorCode: rendererSafeIdentifier(task.errorCode) } : {}),
    ...(task.executionKind ? { executionKind: task.executionKind } : {}),
    ...(rendererSafeIdentifier(task.executionId) ? { executionId: rendererSafeIdentifier(task.executionId) } : {}),
    runtimeKind: task.localCli?.viaP3394Gateway
      ? 'p3394-gateway'
      : task.executionKind === 'local-cli'
        ? rendererSafeIdentifier(task.localCli?.cli) || 'local-cli'
        : task.executionKind || 'cogseed-native',
    ...(rendererSafeIdentifier(task.agentId) ? { agentId: rendererSafeIdentifier(task.agentId) } : {}),
    ...(rendererSafeIdentifier(task.conversationId, 160) ? { conversationId: rendererSafeIdentifier(task.conversationId, 160) } : {}),
    ...(task.workingDir && /^cogseed-worktree-[A-Za-z0-9._-]+$/.test(path.basename(task.workingDir))
      ? { worktreeName: path.basename(task.workingDir) }
      : {}),
    ...(task.skillVersionPinStatus ? { skillVersionPinStatus: task.skillVersionPinStatus } : {}),
    actions,
  };
}

function sessionSummary(
  session: CogSeedSessionRecord,
  tasks: CogSeedTaskRecord[],
  conversationAgentCounts?: ConversationAgentCountById,
): CogSeedRendererSessionSummary {
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const title = rendererSessionTitle(tasks, conversationAgentCounts);
  const latestSummary = latest ? taskSummary(latest, false, conversationAgentCounts) : null;
  return {
    sessionId: session.sessionId,
    ...title,
    ...(latest?.taskId ? { latestTaskId: latest.taskId } : {}),
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
    createdAt: session.createdAt,
    updatedAt: [session.updatedAt, ...tasks.map((task) => task.updatedAt)].sort().at(-1) ?? session.updatedAt,
    taskCount: tasks.length,
    activeTaskCount: tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status)).length,
    latestStatus: latest?.status ?? 'idle',
    hasRecovery: tasks.some((task) => task.status === 'recoverable'),
    ...(latestSummary?.executionId ? { executionId: latestSummary.executionId } : {}),
    ...(latestSummary?.runtimeKind ? { runtimeKind: latestSummary.runtimeKind } : {}),
    conversationMode: latestSummary?.conversationMode ?? 'legacy',
    participantCount: latestSummary?.participantCount ?? 0,
    resumable: tasks.some((task) => taskActions(task).resume),
    resultDeliveryState: latestSummary?.resultDeliveryState ?? 'not-applicable',
  };
}

function rendererSafeEventSummary(event: CogSeedTaskEvent): string {
  switch (event.type) {
    case 'task.created': return 'Task created.';
    case 'task.queued': return 'Task queued.';
    case 'task.started': return 'Task started.';
    case 'task.waiting_user': return 'Task is waiting for user input.';
    case 'task.completed': return 'Task completed.';
    case 'task.failed': return 'Task failed.';
    case 'task.cancelled': return 'Task cancelled.';
    case 'task.recoverable': return 'Task requires recovery.';
    case 'task.archived': return 'Task archived.';
    case 'tool.started': return 'Tool started.';
    case 'tool.finished': return event.payload.isError === true ? 'Tool failed.' : 'Tool finished.';
    default: return 'CogSeed task event.';
  }
}

function timelineSummary(event: CogSeedTaskEvent): CogSeedRendererTimelineEvent {
  const toolName = (event.type === 'tool.started' || event.type === 'tool.finished')
    ? rendererSafeIdentifier(event.payload.toolName || event.payload.name)
    : '';
  const errorCode = (event.type === 'task.failed' || event.type === 'task.recoverable' || event.type === 'tool.finished')
    ? rendererSafeIdentifier(event.payload.errorCode)
    : '';
  return {
    eventId: event.eventId,
    taskId: event.taskId,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    summary: rendererSafeEventSummary(event),
    summaryKey: `run_center.event_${event.type.replace(/\./g, '_')}`,
    ...(toolName ? { toolName } : {}),
    ...(event.type === 'tool.finished' && typeof event.payload.isError === 'boolean' ? { isError: event.payload.isError } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeProjectionInput(payload: unknown): { sessionId?: string; taskId?: string } {
  const raw = typeof payload === 'string' ? { sessionId: payload } : asObject(payload);
  const sessionId = raw.sessionId === undefined
    ? undefined
    : resolveCogSeedSessionIdentity(boundedString(raw.sessionId, 'sessionId', 120) ?? '').canonicalSessionId;
  const taskId = raw.taskId === undefined ? undefined : assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
  if (!sessionId && !taskId) throw new Error('sessionId or taskId required');
  return { ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) };
}

function normalizeActionInput(payload: unknown): { action: CogSeedRendererTaskAction; taskId?: string; requestId?: string; reason?: string } {
  const raw = asObject(payload);
  const action = boundedString(raw.action, 'action', 20) as CogSeedRendererTaskAction;
  if (!['retry', 'skip', 'resume', 'recover-result', 'abort', 'archive'].includes(action)) throw new Error('invalid CogSeed task action');
  const taskId = raw.taskId === undefined ? undefined : assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
  const requestId = raw.requestId === undefined ? undefined : assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
  const reason = boundedString(raw.reason, 'reason', 500, false);
  return { action, ...(taskId ? { taskId } : {}), ...(requestId ? { requestId } : {}), ...(reason ? { reason } : {}) };
}

export function createCogSeedIpcService(deps: CogSeedIpcServiceDeps = {}) {
  const readTask = deps.readTask ?? readCogSeedTask;
  const readTaskByRequestId = deps.readTaskByRequestId ?? readCogSeedTaskByRequestId;
  const admitTask = deps.admitTask ?? createCogSeedTask;
  const retryTask = deps.retryTask ?? retryCogSeedTask;
  const archiveTask = deps.archiveTask ?? archiveCogSeedTask;
  const readEvents = deps.readEvents ?? readCogSeedTaskEvents;
  const listSessions = deps.listSessions ?? listCogSeedSessions;
  const readSession = deps.readSession ?? readCogSeedSession;
  const listTasks = deps.listTasks ?? listCogSeedTasks;
  const readCoordination = deps.readCoordination ?? readCogSeedCoordination;
  const readWorkflowRun = deps.readWorkflowRun ?? ((scope, runId) => cogseedCollaborationStore.readRun(scope, runId));
  const readWorkflowContext = deps.readWorkflowContext ?? ((scope, contextId) => cogseedCollaborationStore.readContext(scope, contextId));
  const readWorkflowEvents = deps.readWorkflowEvents ?? ((scope, afterSequence, limit) => cogseedCollaborationStore.readEvents(scope, afterSequence, limit));
  const readGroupChatWorkflowRun = deps.readGroupChatWorkflowRun
    ?? (async (userId, conversationId, runId) => (await import('../group_chat/collaboration')).readWorkflowRun(userId, conversationId, runId));
  const readGroupChatWorkflowContext = deps.readGroupChatWorkflowContext
    ?? (async (userId, conversationId, contextId) => (await import('../group_chat/collaboration')).readSharedTaskContext(userId, conversationId, contextId));
  const readGroupChatWorkflowEvents = deps.readGroupChatWorkflowEvents
    ?? (async (userId, conversationId, limit) => (await import('../group_chat/collaboration')).readCollaborationEvents(userId, conversationId, limit));
  const isConversationAvailable = deps.isConversationAvailable
    ?? (async (userId, conversationId) => !!(await import('../chats')).getConversation(userId, conversationId));
  const countConversationAgents = deps.countConversationAgents ?? defaultCountConversationAgents;
  const ensureRunCenterConversation = deps.ensureRunCenterConversation ?? defaultEnsureRunCenterConversation;
  const abortGroupChat = deps.abortGroupChat ?? (async (userId, conversationId) => (await import('../group_chat')).abort(userId, conversationId));
  const retryGroupChat = deps.retryGroupChat ?? (async (input) => (await import('../group_chat')).retryFailedTurn(input));
  const worktreeManager = deps.worktreeManager ?? cogseedWorktreeManager;
  const listAgentRegistry = deps.listAgentRegistry ?? buildCogSeedAgentRegistryProjection;
  const reconcileAgentDirectory = deps.reconcileAgentDirectory ?? reconcileCogSeedHostAgentDirectory;
  const requestOperations = new Map<string, { fingerprint: string; promise: Promise<CogSeedRendererTaskSummary> }>();

  const singleFlightRequest = (
    userId: string,
    requestId: string,
    fingerprint: string,
    operation: () => Promise<CogSeedRendererTaskSummary>,
  ): Promise<CogSeedRendererTaskSummary> => {
    const key = `${userId}:${requestId}`;
    const inFlight = requestOperations.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) return Promise.reject(new Error('CogSeed request ID payload conflict'));
      return inFlight.promise;
    }
    const promise = Promise.resolve().then(operation);
    requestOperations.set(key, { fingerprint, promise });
    const clear = () => {
      if (requestOperations.get(key)?.promise === promise) requestOperations.delete(key);
    };
    void promise.then(clear, clear);
    return promise;
  };

  const conversationAgentCountsForTasks = async (userId: string, tasks: CogSeedTaskRecord[]): Promise<ConversationAgentCountById> => {
    const conversationIds = Array.from(new Set(tasks
      .filter((task) => task.conversationId)
      .map((task) => task.conversationId!)));
    const counts = new Map<string, number>();
    await Promise.all(conversationIds.map(async (conversationId) => {
      const count = await countConversationAgents(userId, conversationId).catch(() => null);
      if (count !== null) counts.set(conversationId, Math.max(0, count));
    }));
    return counts;
  };

  const visibleDashboardTasks = async (userId: string, tasks: CogSeedTaskRecord[]): Promise<CogSeedTaskRecord[]> => {
    const conversationIds = Array.from(new Set(tasks
      .filter((task) => task.conversationId
        && (task.executionKind === 'group-chat' || task.conversationId.startsWith('run-center-')))
      .map((task) => task.conversationId!)));
    if (!conversationIds.length) return tasks;
    const availability = await Promise.all(conversationIds.map(async (conversationId) => [
      conversationId,
      await isConversationAvailable(userId, conversationId),
    ] as const));
    const available = new Set(availability.filter(([, exists]) => exists).map(([conversationId]) => conversationId));
    return tasks.filter((task) => (
      !task.conversationId
      || (task.executionKind !== 'group-chat' && !task.conversationId.startsWith('run-center-'))
      || task.resultDeliveryState === 'pending'
      || task.resultDeliveryState === 'pending-recovery'
      || available.has(task.conversationId)
    ));
  };

  const prepareAgentStart = async (
    userId: string,
    input: StartCogSeedTaskInput,
  ): Promise<StartCogSeedTaskInput> => {
    if (!input.agentId) return input;
    const resolveAgent = deps.resolveAgentExecutionContext ?? resolveCogSeedAgentExecutionContext;
    const executionContext = await resolveAgent(
      userId,
      input.agentId,
      input.conversationId || `run-center-${input.requestId}`,
    );
    const localCli = localCliFromExecutionContext(executionContext);
    return {
      ...input,
      agentId: executionContext.agentId,
      executionKind: localCli ? 'local-cli' : 'cogseed-native',
      ...(localCli ? { localCli } : {}),
      ...(executionContext.skillList !== undefined ? { allowedSkillIds: executionContext.skillList } : {}),
      context: [...buildCogSeedAgentRuntimeContext(executionContext), ...(input.context ?? [])],
    };
  };

  return {
    async start(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const normalized = normalizeStartInput(payload);
      const worktreeName = optionalWorktreeName(payload);
      const operationFingerprint = cogSeedRequestFingerprint('create', { ipcOperation: 'start', ...normalized, worktreeName });
      return singleFlightRequest(userId, normalized.requestId, operationFingerprint, async () => {
        const controller = await resolveCogSeedRuntimeController(deps);
        const existing = await readTaskByRequestId(userId, normalized.requestId);
        const workingDir = worktreeName ? await worktreeManager.resolve(userId, worktreeName) : undefined;
        const needsConversation = !!normalized.agentId && !normalized.conversationId;
        const normalizedWithConversation = needsConversation
          ? { ...normalized, conversationId: cogSeedRunCenterConversationId(normalized.requestId) }
          : normalized;
        const input = await prepareAgentStart(userId, {
          ...normalizedWithConversation,
          ...(workingDir ? { workingDir } : {}),
        });
        if (existing?.status === 'created' && !existing.runtimeWorkerId && input.conversationId
          && !(await isConversationAvailable(userId, input.conversationId))) {
          const admitted = await admitTask(userId, input);
          return taskSummary(await markCogSeedTaskRecoverable(userId, admitted.task.taskId, 'conversation_unavailable'));
        }
        if (!existing && needsConversation && input.agentId && input.conversationId) {
          await ensureRunCenterConversation({
            userId,
            conversationId: input.conversationId,
            requestId: input.requestId,
            task: input.task,
            agentId: input.agentId,
          });
        } else if (!existing && input.agentId && input.conversationId
          && !(await isConversationAvailable(userId, input.conversationId))) {
          throw new Error('CogSeed conversation is unavailable');
        }
        return taskSummary(await controller.startCogSeedTask(userId, input));
      });
    },

    async worktrees(userId: string) {
      assertCogSeedUserId(userId);
      return worktreeManager.list(userId);
    },

    async createWorktree(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      return worktreeManager.create(userId, normalizeWorktreeCreateInput(payload));
    },

    async removeWorktree(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      return worktreeManager.remove(userId, normalizeWorktreeRemoveInput(payload));
    },

    async reassign(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      rejectHiddenBackendFields(raw);
      const taskId = assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
      const requestId = assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
      const agentId = assertCogSeedAgentId(boundedString(raw.agentId, 'agentId', 160) ?? '');
      const operationFingerprint = cogSeedRequestFingerprint('retry', { ipcOperation: 'reassign', taskId, agentId });
      return singleFlightRequest(userId, requestId, operationFingerprint, async () => {
        const previous = await readTask(userId, taskId);
        if (!previous) throw new Error('CogSeed task not found');
        const existing = await readTaskByRequestId(userId, requestId);
        const needsConversation = !previous.conversationId;
        const input = await prepareAgentStart(userId, {
          requestId,
          task: previous.task,
          agentId,
          conversationId: previous.conversationId || cogSeedRunCenterConversationId(requestId),
          ...(previous.workingDir ? { workingDir: previous.workingDir } : {}),
          retryOfTaskId: previous.taskId,
        });
        if (existing?.status === 'created' && !existing.runtimeWorkerId && input.conversationId
          && !(await isConversationAvailable(userId, input.conversationId))) {
          const admitted = await admitTask(userId, input);
          return taskSummary(await markCogSeedTaskRecoverable(userId, admitted.task.taskId, 'conversation_unavailable'));
        }
        if (!existing && needsConversation && input.agentId && input.conversationId) {
          await ensureRunCenterConversation({
            userId,
            conversationId: input.conversationId,
            requestId: input.requestId,
            task: input.task,
            agentId: input.agentId,
          });
        } else if (!existing && input.conversationId
          && !(await isConversationAvailable(userId, input.conversationId))) {
          throw new Error('CogSeed conversation is unavailable');
        }
        const controller = await resolveCogSeedRuntimeController(deps);
        return taskSummary(await controller.startCogSeedTask(userId, input));
      });
    },

    async read(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const taskId = normalizeTaskId(payload);
      const task = await readTask(userId, taskId);
      if (!task) throw new Error('CogSeed task not found');
      return taskSummary(task, false, await conversationAgentCountsForTasks(userId, [task]));
    },

    async cancel(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const controller = await resolveCogSeedRuntimeController(deps);
      return taskSummary(await controller.cancelCogSeedTask(userId, normalizeTaskId(payload)));
    },

    async abort(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      return this.cancel(userId, payload);
    },

    async retry(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const input = normalizeRetryInput(payload);
      const controller = await resolveCogSeedRuntimeController(deps);
      const task = deps.retryTask ? await retryTask(userId, input.taskId, input.requestId) : await controller.retryCogSeedTask(userId, input.taskId, input.requestId);
      return taskSummary(task);
    },

    async resume(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      rejectHiddenBackendFields(raw);
      if (Object.prototype.hasOwnProperty.call(raw, 'workingDir')) {
        throw new Error('workingDir cannot be selected directly; use worktreeName');
      }
      const context = boundedArray(raw.context, 'context', MAX_CONTEXT_ITEMS);
      const attachments = boundedArray(raw.attachments, 'attachments', MAX_ATTACHMENT_ITEMS);
      const worktreeName = optionalWorktreeName(payload);
      const workingDir = worktreeName ? await worktreeManager.resolve(userId, worktreeName) : undefined;
      const profileId = optionalProfileId(raw.profileId);
      const input: ResumeCogSeedTaskInput = {
        requestId: assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? ''),
        continuation: boundedString(raw.continuation, 'continuation', MAX_TASK_CHARS) ?? '',
        ...(profileId ? { profileId } : {}),
        ...(context ? { context } : {}),
        ...(attachments ? { attachments } : {}),
        ...(workingDir ? { workingDir } : {}),
      };
      const controller = await resolveCogSeedRuntimeController(deps);
      const task = await controller.resumeCogSeedTask(userId, assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''), input);
      return taskSummary(task);
    },

    async kbIndex(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      const sourceId = assertCogSeedKbSourceId(boundedString(raw.sourceId, 'sourceId', 200) ?? '');
      const title = boundedString(raw.title, 'title', 500) ?? '';
      const content = boundedString(raw.content, 'content', 5_000_000) ?? '';
      return cogseedKbManager.indexText(userId, { sourceId, title, content });
    },

    async kbSearch(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      const query = boundedString(raw.query, 'query', 2_000) ?? '';
      return cogseedKbManager.search(userId, query, { k: Math.max(1, Math.min(Math.floor(Number(raw.k) || 10), 50)) });
    },

    async kbRead(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      return cogseedKbManager.readSource(userId, assertCogSeedKbSourceId(boundedString(raw.sourceId, 'sourceId', 200) ?? ''));
    },

    async kbSources(userId: string) {
      assertCogSeedUserId(userId);
      return cogseedKbManager.listSources(userId);
    },

    async connectors(userId: string) {
      assertCogSeedUserId(userId);
      const records = await listCogSeedConnectors(userId);
      return records.map(({ transport: _transport, ...publicRecord }) => publicRecord);
    },

    async connectorTools(userId: string, payload: unknown) {
      assertCogSeedUserId(userId);
      const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const connectorId = typeof raw.connectorId === 'string' ? assertCogSeedConnectorId(raw.connectorId) : undefined;
      return connectorId ? cogseedConnectorManager.listTools(userId, connectorId) : cogseedConnectorManager.listAllTools(userId);
    },

    async sessions(userId: string) {
      return this.sessionListProjection(userId);
    },

    async session(userId: string, payload: unknown) {
      return this.sessionProjection(userId, payload);
    },

    async board(userId: string): Promise<CogSeedRendererBoardProjection> {
      return this.boardProjection(userId);
    },

    async agents(userId: string): Promise<CogSeedRendererAgentRegistryProjection> {
      assertCogSeedUserId(userId);
      // A P3394 peer first registers as a live runtime node. Reconcile it into
      // the persisted Agent directory before taking the Run Center snapshot so
      // local external Agents are selectable immediately, not only after the
      // separate AI team screen has been opened.
      await reconcileAgentDirectory().catch(() => undefined);
      return listAgentRegistry(userId);
    },

    async boardProjection(userId: string): Promise<CogSeedRendererBoardProjection> {
      assertCogSeedUserId(userId);
      const [sessions, allTasks] = await Promise.all([listSessions(userId), listTasks(userId)]);
      const tasks = await visibleDashboardTasks(userId, allTasks);
      const groupChatModes = await conversationAgentCountsForTasks(userId, tasks);
      const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
      const taskById = new Map(tasks.map((task) => [task.taskId, task]));
      const tasksBySession = new Map<string, CogSeedTaskRecord[]>();
      for (const task of tasks) {
        const sessionTasks = tasksBySession.get(task.sessionId) ?? [];
        sessionTasks.push(task);
        tasksBySession.set(task.sessionId, sessionTasks);
      }
      const parents = new Set(tasks.map((task) => task.parentTaskId).filter((id): id is string => !!id));
      const rootTaskId = (task: CogSeedTaskRecord): string => {
        let current = task;
        const visited = new Set<string>();
        while (current.parentTaskId && !visited.has(current.parentTaskId)) {
          visited.add(current.parentTaskId);
          const parent = taskById.get(current.parentTaskId);
          if (!parent) break;
          current = parent;
        }
        return current.taskId;
      };
      const groupIdForTask = (task: CogSeedTaskRecord): string | undefined => task.coordinationId
        || (task.parentTaskId || parents.has(task.taskId) ? rootTaskId(task) : undefined);
      const boardTasks: CogSeedRendererBoardTask[] = tasks.map((task) => {
        const session = sessionById.get(task.sessionId);
        const groupId = groupIdForTask(task);
        const sessionTitle = rendererSessionTitle(tasksBySession.get(task.sessionId) ?? [task], groupChatModes);
        return {
          ...taskSummary(task, false, groupChatModes),
          column: cogSeedRendererBoardColumn(task.status, task.archivedAt),
          sessionTitle: sessionTitle.title,
          sessionTitleKey: sessionTitle.titleKey,
          ...(groupId ? { groupId } : {}),
          ...(task.conversationId || session?.conversationId
            ? { conversationId: task.conversationId || session?.conversationId }
            : {}),
        };
      });
      const counts: Record<CogSeedRendererBoardColumn, number> = {
        pending: 0,
        running: 0,
        attention: 0,
        completed: 0,
        archived: 0,
      };
      for (const task of boardTasks) counts[task.column] += 1;

      const groupIds = Array.from(new Set(tasks.map(groupIdForTask).filter((id): id is string => !!id)));
      const groups: CogSeedRendererBoardGroup[] = groupIds.map((groupId) => {
        const members = tasks.filter((task) => groupIdForTask(task) === groupId);
        const parent = members.find((task) => !task.parentTaskId || !members.some((candidate) => candidate.taskId === task.parentTaskId)) ?? members[0]!;
        const title = rendererTaskTitle(parent, groupChatModes);
        return {
          groupId,
          ...(parent.coordinationId ? { coordinationId: parent.coordinationId } : {}),
          parentTaskId: parent.taskId,
          ...title,
          status: parent.status,
          updatedAt: members.map((task) => task.updatedAt).sort().at(-1) ?? parent.updatedAt,
          progress: computeCogSeedBoardGroupProgress(members),
        };
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      return {
        schemaVersion: 1,
        ...(boardTasks[0]?.updatedAt ? { updatedAt: boardTasks.map((task) => task.updatedAt).sort().at(-1) } : {}),
        tasks: boardTasks,
        groups,
        counts,
      };
    },

    async diagnostics(userId: string): Promise<CogSeedRendererDiagnostics> {
      assertCogSeedUserId(userId);
      const [allTasks, runtime] = await Promise.all([
        listTasks(userId),
        (await resolveCogSeedRuntimeController(deps)).runtimeStatus(),
      ]);
      const tasks = await visibleDashboardTasks(userId, allTasks);
      const groupChatModes = await conversationAgentCountsForTasks(userId, tasks);
      const summaries = tasks.map((task) => taskSummary(task, false, groupChatModes));
      const sourceCounts: CogSeedRendererDiagnostics['sourceCounts'] = {
        cogseed: 0,
        agent: 0,
        'local-cli': 0,
        'p3394-gateway': 0,
        'agent-conversation': 0,
        'group-chat': 0,
      };
      const statusCounts: CogSeedRendererDiagnostics['statusCounts'] = {};
      const errors = new Map<string, number>();
      for (const summary of summaries) {
        sourceCounts[summary.sourceKind] += 1;
        statusCounts[summary.status] = (statusCounts[summary.status] ?? 0) + 1;
        if (summary.errorCode) errors.set(summary.errorCode, (errors.get(summary.errorCode) ?? 0) + 1);
      }
      const activeTaskCount = summaries.filter((task) => ['created', 'queued', 'running', 'waiting_user'].includes(task.status)).length;
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        taskCount: summaries.length,
        sessionCount: new Set(summaries.map((task) => task.sessionId)).size,
        activeTaskCount,
        attentionTaskCount: summaries.filter((task) => task.status === 'failed' || task.status === 'recoverable' || task.status === 'waiting_user').length,
        sourceCounts,
        statusCounts,
        errorCodes: Array.from(errors, ([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
        runtime: {
          activeTaskCount: runtime.activeTaskCount,
          stateMatchesProjection: runtime.activeTaskIds.every((taskId) => tasks.some((task) => task.taskId === taskId && ['queued', 'running'].includes(task.status))),
        },
        coverage: { liveInvalidation: true, payloadRedaction: true, manualRefresh: true },
      };
    },


    async sessionListProjection(userId: string): Promise<CogSeedRendererSessionSummary[]> {
      assertCogSeedUserId(userId);
      const [sessions, allTasks] = await Promise.all([listSessions(userId), listTasks(userId)]);
      const tasks = await visibleDashboardTasks(userId, allTasks);
      const groupChatModes = await conversationAgentCountsForTasks(userId, tasks);
      return sessions
        .map((session) => ({ session, tasks: tasks.filter((task) => task.sessionId === session.sessionId) }))
        .filter((entry) => entry.tasks.length > 0)
        .map((entry) => sessionSummary(entry.session, entry.tasks, groupChatModes))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async sessionProjection(userId: string, payload: unknown): Promise<{ session: CogSeedRendererSessionSummary | null; collaboration: CogSeedRendererCollaborationSnapshot | null }> {
      assertCogSeedUserId(userId);
      const { sessionId, taskId } = normalizeProjectionInput(payload);
      const tasks = await visibleDashboardTasks(userId, await listTasks(userId));
      const visibleTaskById = new Map(tasks.map((task) => [task.taskId, task]));
      const requestedTask = taskId ? visibleTaskById.get(taskId) ?? null : null;
      if (taskId && !requestedTask) return { session: null, collaboration: null };
      if (sessionId && requestedTask && requestedTask.sessionId !== sessionId) {
        return { session: null, collaboration: null };
      }
      const resolvedSessionId = sessionId || requestedTask?.sessionId;
      const session = resolvedSessionId ? await readSession(userId, assertCogSeedSessionId(resolvedSessionId)) : null;
      if (!session) return { session: null, collaboration: null };
      if (session.conversationId && !await isConversationAvailable(userId, session.conversationId)) {
        return { session: null, collaboration: null };
      }
      const groupChatModes = await conversationAgentCountsForTasks(userId, tasks);
      const directTasks = tasks.filter((task) => task.sessionId === session.sessionId);
      const collaboration = directTasks.length
        ? await this.collaborationSnapshot(userId, taskId ? { taskId } : { sessionId: session.sessionId })
        : null;
      return { session: sessionSummary(session, directTasks, groupChatModes), collaboration };
    },

    async collaborationSnapshot(userId: string, payload: unknown): Promise<CogSeedRendererCollaborationSnapshot> {
      assertCogSeedUserId(userId);
      const input = normalizeProjectionInput(payload);
      const allTasks = await visibleDashboardTasks(userId, await listTasks(userId));
      const visibleTaskById = new Map(allTasks.map((task) => [task.taskId, task]));
      if (input.taskId && !visibleTaskById.has(input.taskId)) {
        throw new Error('CogSeed collaboration task not found');
      }
      let selected = input.taskId ? visibleTaskById.get(input.taskId) ?? null : null;
      if (input.sessionId && selected && selected.sessionId !== input.sessionId) {
        throw new Error('CogSeed session/task mismatch');
      }
      if (selected?.executionKind === 'group-chat' && selected.conversationId
        && !await isConversationAvailable(userId, selected.conversationId)) {
        throw new Error('Group Chat conversation is unavailable');
      }
      if (!selected && input.sessionId) {
        selected = [...allTasks].filter((task) => task.sessionId === input.sessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      }
      if (!selected) throw new Error('CogSeed collaboration task not found');
      if (input.sessionId && selected.sessionId !== input.sessionId) {
        throw new Error('CogSeed session/task mismatch');
      }
      const session = await readSession(userId, selected.sessionId);
      if (!session) throw new Error('CogSeed session not found');
      const groupChatModes = await conversationAgentCountsForTasks(userId, allTasks);

      const related: CogSeedTaskRecord[] = [];
      const visit = (task: CogSeedTaskRecord) => {
        if (related.some((item) => item.taskId === task.taskId)) return;
        related.push(task);
        for (const child of allTasks.filter((candidate) => candidate.parentTaskId === task.taskId)) visit(child);
      };
      if (input.sessionId) {
        for (const task of allTasks.filter((candidate) => candidate.sessionId === selected!.sessionId)) visit(task);
      } else {
        let root = selected;
        const ancestors = new Set<string>();
        while (root.parentTaskId && !ancestors.has(root.parentTaskId)) {
          ancestors.add(root.parentTaskId);
          const parent = allTasks.find((candidate) => candidate.taskId === root.parentTaskId);
          if (!parent) break;
          root = parent;
        }
        visit(root);
      }
      const coordination = selected.coordinationId ? await readCoordination(userId, selected.coordinationId) : null;
      const scope: CollaborationScope | null = coordination
        ? { ownerId: userId, domain: 'cogseed', scopeId: coordination.coordinationId }
        : null;
      const cogseedWorkflowRun = coordination?.workflowRunId && scope
        ? await readWorkflowRun(scope, coordination.workflowRunId)
        : null;
      const groupChatWorkflowTask = [selected, ...related]
        .filter((task) => task.executionKind === 'group-chat'
          && task.conversationId
          && task.groupChatWorkflowRunId
          && (!selected!.groupChatRunId || task.groupChatRunId === selected!.groupChatRunId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const groupChatWorkflowRun = groupChatWorkflowTask?.conversationId && groupChatWorkflowTask.groupChatWorkflowRunId
        ? await readGroupChatWorkflowRun(userId, groupChatWorkflowTask.conversationId, groupChatWorkflowTask.groupChatWorkflowRunId)
        : null;
      const workflowRun = cogseedWorkflowRun ?? groupChatWorkflowRun;
      const groupChatWorkflowContext = groupChatWorkflowRun && groupChatWorkflowTask?.conversationId
        ? await readGroupChatWorkflowContext(userId, groupChatWorkflowTask.conversationId, groupChatWorkflowRun.context_id)
        : null;
      const groupChatWorkflowEvents = groupChatWorkflowRun && groupChatWorkflowTask?.conversationId
        ? (await readGroupChatWorkflowEvents(userId, groupChatWorkflowTask.conversationId, 200))
          .filter((event) => event.run_id === groupChatWorkflowRun.id)
        : [];
      const [workflowContext, collaborationEvents, sessionRecords] = await Promise.all([
        groupChatWorkflowContext
          ? Promise.resolve(groupChatWorkflowContext)
          : workflowRun && scope ? readWorkflowContext(scope, workflowRun.context_id) : Promise.resolve(null),
        groupChatWorkflowEvents.length
          ? Promise.resolve(groupChatWorkflowEvents)
          : workflowRun && scope ? readWorkflowEvents(scope, 0, 200) : Promise.resolve([]),
        listSessions(userId),
      ]);
      const workflowStepIds = new Set(workflowRun?.steps.map((step) => step.result_ref).filter(Boolean) ?? []);
      const tasks = related.map((task) => taskSummary(task, workflowStepIds.has(task.taskId), groupChatModes));
      const directSessionTasks = allTasks.filter((task) => task.sessionId === session.sessionId);
      const sessionView = sessionSummary(session, directSessionTasks, groupChatModes);
      const eventLists = await Promise.all(related.map((task) => readEvents(userId, task.taskId, 0, 200)));
      const timeline = eventLists.flat().map(timelineSummary).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence).slice(-500);
      const actorRole = (role: string): CogSeedRendererActorSummary['role'] => {
        if (role === 'commander') return 'commander';
        if (role === 'reviewer') return 'reviewer';
        if (role === 'child') return 'child_agent';
        return 'member_agent';
      };
      const relatedSessionIds = new Set(related.map((task) => task.sessionId));
      const relevantSessions = sessionRecords.filter((record) => (
        relatedSessionIds.has(record.sessionId)
        || record.sessionId === session.commanderSessionId
        || (session.commanderSessionId && record.commanderSessionId === session.commanderSessionId)
        || (session.conversationId && record.conversationId === session.conversationId)
      ));
      const roster = relevantSessions.flatMap((record) => record.roster ?? []);
      const actorById = new Map<string, CogSeedRendererActorSummary>();
      for (const actor of roster) {
        const task = related.find((item) => item.sessionId === actor.sessionId || item.agentId === actor.actorId);
        actorById.set(actor.actorId, {
          actorId: rendererSafeIdentifier(actor.actorId) || actor.sessionId,
          role: actorRole(actor.actorRole),
          ...(actor.actorRole === 'commander' ? { displayName: 'Commander' } : {}),
          sessionId: actor.sessionId,
          ...(task?.taskId ? { taskId: task.taskId } : {}),
          status: task?.status ?? 'idle',
        });
      }
      const groupChatActorTasks = related
        .filter((task) => task.executionKind === 'group-chat' && !!task.groupChatTurnId)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.taskId.localeCompare(right.taskId));
      for (const task of groupChatActorTasks) {
        const actorId = task.agentId || 'commander';
        const existing = actorById.get(actorId);
        actorById.set(actorId, {
          actorId: rendererSafeIdentifier(actorId) || task.taskId,
          role: existing?.role
            ?? (task.groupChatActorKind === 'worker'
              ? 'child_agent'
              : actorId === 'commander'
                ? 'commander'
                : 'member_agent'),
          ...(existing?.displayName
            ? { displayName: existing.displayName }
            : actorId === 'commander'
              ? { displayName: 'Commander' }
              : {}),
          sessionId: existing?.sessionId ?? task.sessionId,
          taskId: task.taskId,
          status: task.status,
        });
      }
      for (const task of related.filter((item) => item.executionKind !== 'group-chat')) {
        const actorId = task.agentId || (task.parentTaskId ? `member:${task.taskId}` : 'commander');
        const existing = actorById.get(actorId);
        const actorSession = sessionRecords.find((record) => record.sessionId === task.sessionId);
        actorById.set(actorId, {
          actorId: rendererSafeIdentifier(actorId) || task.taskId,
          role: existing?.role
            ?? (task.agentId && task.agentId !== 'commander'
              ? actorSession?.actorRole === 'child'
                ? 'child_agent'
                : actorSession?.actorRole === 'reviewer'
                  ? 'reviewer'
                  : 'member_agent'
              : actorRole(actorSession?.actorRole || (task.parentTaskId ? 'member' : 'commander'))),
          ...(existing?.displayName ? { displayName: existing.displayName } : {}),
          sessionId: existing?.sessionId ?? task.sessionId,
          taskId: task.taskId,
          status: task.status,
        });
      }
      const executableAgentIds = new Set(related
        .map((task) => task.agentId)
        .filter((agentId): agentId is string => !!agentId && agentId !== 'commander'));
      const needsCommander = !!coordination || !!workflowRun || groupChatActorTasks.length > 0 || executableAgentIds.size !== 1;
      if (!needsCommander) actorById.delete('commander');
      else if (!actorById.has('commander')) {
        actorById.set('commander', {
          actorId: 'commander',
          role: 'commander',
          displayName: 'Commander',
          sessionId: selected.sessionId,
          taskId: selected.taskId,
          status: selected.status,
        });
      }
      const actors = Array.from(actorById.values());
      const recoveryEvents = timeline.filter((event) => event.type === 'task.recoverable');
      const workflow: CogSeedRendererWorkflowSummary = {
        ...(coordination?.coordinationId ? { coordinationId: coordination.coordinationId } : {}),
        ...(coordination?.workflowRunId ? { workflowRunId: coordination.workflowRunId } : {}),
        ...(workflowRun?.status ? { status: workflowRun.status } : {}),
        ...(rendererSafeIdentifier(workflowRun?.phase, 80) ? { phase: rendererSafeIdentifier(workflowRun?.phase, 80) } : {}),
        childTaskIds: coordination?.childTaskIds
          ?? related.filter((task) => task.parentTaskId).map((task) => task.taskId),
        steps: (workflowRun?.steps ?? []).map((step) => ({
          stepId: step.id,
          title: 'Workflow step',
          titleKey: 'run_center.workflow_step',
          actorId: rendererSafeIdentifier(step.actor_id) || null,
          type: step.type,
          status: step.status,
          dependsOn: step.depends_on,
          attemptCount: step.attempts?.length ?? 0,
          ...(step.attempts?.at(-1)?.status ? { latestAttemptStatus: step.attempts.at(-1)!.status } : {}),
          ...(step.attempts?.at(-1)?.failure_code
            ? { failureCode: rendererSafeIdentifier(step.attempts.at(-1)!.failure_code) }
            : {}),
        })),
      };
      const reviews: CogSeedRendererReviewSummary[] = (workflowContext?.gates ?? []).map((gate) => ({
        gateId: gate.id,
        stepId: gate.step_id,
        name: 'Review gate',
        status: gate.status,
        ...(gate.review_decision ? { reviewDecision: gate.review_decision } : {}),
        ...(rendererSafeIdentifier(gate.reviewed_by) ? { reviewedBy: rendererSafeIdentifier(gate.reviewed_by) } : {}),
        createdAt: gate.created_at,
        ...(gate.reviewed_at ? { reviewedAt: gate.reviewed_at } : {}),
      }));
      const conflicts: CogSeedRendererConflictSummary[] = (workflowContext?.conflicts ?? []).map((conflict) => ({
        conflictId: conflict.id,
        type: conflict.type,
        status: conflict.status,
        affectedStepIds: [...conflict.affected_step_ids],
        createdAt: conflict.created_at,
        updatedAt: conflict.updated_at,
      }));
      const activity: CogSeedRendererCollaborationActivity[] = collaborationEvents.map((event) => ({
        eventId: event.id,
        type: event.type,
        ...(rendererSafeIdentifier(event.actor_id) ? { actorId: rendererSafeIdentifier(event.actor_id) } : {}),
        ...(event.step_id ? { stepId: event.step_id } : {}),
        ...(event.gate_id ? { gateId: event.gate_id } : {}),
        createdAt: event.created_at,
      }));
      const hasSelectedWorkflowStep = workflow.steps.some((step) => step.stepId === selected.taskId);
      const primaryActions = taskActions(selected, hasSelectedWorkflowStep);
      return {
        schemaVersion: 1,
        sessionId: session.sessionId,
        updatedAt: [selected.updatedAt, ...related.map((task) => task.updatedAt), session.updatedAt].sort().at(-1) ?? session.updatedAt,
        session: sessionView,
        task: taskSummary(selected, hasSelectedWorkflowStep, groupChatModes),
        actors,
        tasks,
        workflow,
        reviews,
        conflicts,
        activity,
        recovery: {
          recoverable: related.some((task) => task.status === 'recoverable'),
          taskIds: related.filter((task) => task.status === 'recoverable').map((task) => task.taskId),
          ...(recoveryEvents.at(-1)?.createdAt ? { lastEventAt: recoveryEvents.at(-1)!.createdAt } : {}),
        },
        timeline,
        actions: primaryActions,
      };
    },

    async action(userId: string, payload: unknown): Promise<CogSeedRendererCollaborationSnapshot> {
      assertCogSeedUserId(userId);
      const input = normalizeActionInput(payload);
      if (!input.taskId) throw new Error('taskId required');
      if (input.action === 'skip') throw new Error('CogSeed workflow skip requires a workflow step scope');
      const task = await readTask(userId, input.taskId);
      if (!task) throw new Error('CogSeed task not found');
      if (input.action === 'archive') {
        await archiveTask(userId, input.taskId);
        return this.collaborationSnapshot(userId, { taskId: input.taskId });
      }
      if (task.executionKind === 'group-chat') {
        if (!task.conversationId) throw new Error('Group Chat task has no conversation');
        if (input.action === 'abort') {
          await abortGroupChat(userId, task.conversationId);
        } else if (input.action === 'retry') {
          if (!input.requestId) throw new Error('requestId required');
          if (!task.groupChatMessageId) throw new Error('Group Chat retry target is unavailable');
          const retried = await retryGroupChat({
            userId,
            cid: task.conversationId,
            failedMessageId: task.groupChatMessageId,
            visibleText: input.reason || t('dashboard.retry_user_message'),
            requestId: input.requestId,
          });
          if (!retried.ok) throw new Error(retried.error || 'Group Chat retry failed');
        } else {
          throw new Error('Group Chat task cannot be resumed from Dashboard');
        }
        return this.collaborationSnapshot(userId, { taskId: input.taskId });
      }
      const controller = await resolveCogSeedRuntimeController(deps);
      if (input.action === 'abort') await controller.cancelCogSeedTask(userId, input.taskId);
      else if (input.action === 'recover-result') await controller.retryCogSeedResultDelivery(userId, input.taskId);
      else if (!input.requestId) throw new Error('requestId required');
      else if (input.action === 'retry') await controller.retryCogSeedTask(userId, input.taskId, input.requestId);
      else if (input.action === 'resume') await controller.resumeCogSeedTask(userId, input.taskId, { requestId: input.requestId, continuation: input.reason || 'Resume task.' });
      return this.collaborationSnapshot(userId, { taskId: input.taskId });
    },

    async collaborationAction(userId: string, payload: unknown): Promise<CogSeedRendererCollaborationSnapshot> {
      assertCogSeedUserId(userId);
      const raw = asObject(payload);
      const taskId = assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
      const action = boundedString(raw.action, 'action', 80) as CogSeedRendererCollaborationAction;
      if (!['retry-step', 'skip-step', 'approve-gate', 'reject-gate', 'dismiss-conflict'].includes(action)) {
        throw new Error('invalid collaboration action');
      }
      const targetId = boundedString(raw.targetId, 'targetId', 160) ?? '';
      if (!/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error('invalid collaboration target');
      const task = await readTask(userId, taskId);
      if (!task) throw new Error('CogSeed task not found');
      if (task.executionKind === 'group-chat') {
        if (!task.conversationId) throw new Error('Group Chat task has no conversation');
        const groupChat = await import('../group_chat');
        if (action === 'approve-gate' || action === 'reject-gate') {
          await groupChat.reviewCollaborationGate(userId, task.conversationId, targetId, {
            decision: action === 'approve-gate' ? 'approve' : 'reject',
            reviewed_by: 'user',
          });
        } else if (action === 'dismiss-conflict') {
          await groupChat.resolveCollaborationConflict(userId, task.conversationId, targetId, {
            decision: 'reject',
            selected_proposal_ids: [],
            text: 'Dismissed from Run Center.',
          });
        } else {
          throw new Error('Group Chat workflow steps must be controlled from the conversation');
        }
        return this.collaborationSnapshot(userId, { taskId });
      }
      const derivedCoordinationId = `cogseed-coord-${task.taskId.slice('cogseed-task-'.length)}`;
      const coordination = task.coordinationId
        ? await readCoordination(userId, task.coordinationId)
        : await readCoordination(userId, derivedCoordinationId);
      if (!coordination?.workflowRunId) throw new Error('CogSeed workflow not found');
      const control = (await import('./cogseed-control-service')).cogseedControlService;
      if (action === 'retry-step') await control.retryCoordinationStep(userId, coordination.coordinationId, targetId);
      else if (action === 'skip-step') await control.skipCoordinationStep(userId, coordination.coordinationId, targetId, 'Skipped from Run Center.');
      else if (action === 'approve-gate' || action === 'reject-gate') {
        await control.reviewCoordinationGate(userId, coordination.coordinationId, targetId, action === 'approve-gate' ? 'approve' : 'reject');
      } else await control.dismissCoordinationConflict(userId, coordination.coordinationId, targetId, 'Dismissed from Run Center.');
      return this.collaborationSnapshot(userId, { taskId });
    },

    async runtimeStatus(userId: string) {
      assertCogSeedUserId(userId);
      const controller = await resolveCogSeedRuntimeController(deps);
      return controller.runtimeStatus();
    },

    async restartRuntime(userId: string) {
      assertCogSeedUserId(userId);
      const controller = await resolveCogSeedRuntimeController(deps);
      const restarted = await controller.restartRuntime();
      const recovery = await controller.recoverOrphanedTasks(userId);
      return { ...restarted, recovery };
    },

    async recover(userId: string) {
      assertCogSeedUserId(userId);
      const controller = await resolveCogSeedRuntimeController(deps);
      return controller.recoverOrphanedTasks(userId);
    },

    async events(userId: string, payload: unknown): Promise<{ events: CogSeedTaskEvent[]; afterSequence: number }> {
      assertCogSeedUserId(userId);
      const input = normalizeEventsInput(payload);
      const events = await readEvents(userId, input.taskId, input.afterSequence, input.limit);
      return { events, afterSequence: input.afterSequence ?? 0 };
    },

    async *streamEvents(userId: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<{ type: 'event'; event: CogSeedTaskEvent }, void, unknown> {
      assertCogSeedUserId(userId);
      const input = normalizeEventsInput(payload);
      const events = await readEvents(userId, input.taskId, input.afterSequence, input.limit);
      for (const event of events) {
        if (signal?.aborted) return;
        yield { type: 'event', event };
      }
    },

    async *streamDashboardChanges(
      userId: string,
      signal?: AbortSignal,
    ): AsyncGenerator<{ type: 'change'; change: CogSeedDashboardChange }, void, unknown> {
      assertCogSeedUserId(userId);
      const subscribe = deps.subscribeDashboardChanges ?? subscribeCogSeedDashboardChanges;
      const pending: CogSeedDashboardChange[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe(userId, (change) => {
        pending.push(change);
        wake?.();
        wake = null;
      });
      const onAbort = () => {
        wake?.();
        wake = null;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        while (!signal?.aborted) {
          if (!pending.length) {
            await new Promise<void>((resolve) => { wake = resolve; });
          }
          if (signal?.aborted) return;
          while (pending.length) {
            const change = pending.shift();
            if (change) yield { type: 'change', change };
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
      }
    },
  };
}

export const cogseedIpcService = createCogSeedIpcService();
