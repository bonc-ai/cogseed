import { readCogSeedTaskEvents } from './event-store';
import { retryCogSeedTask } from './lifecycle';
import { recoverCogSeedTasks } from './recovery';
import type { CogSeedRuntimeController, ResumeCogSeedTaskInput, StartCogSeedTaskInput } from './runtime-controller';
import { assertCogSeedConnectorId, assertCogSeedKbSourceId, assertCogSeedRequestId, assertCogSeedSessionId, assertCogSeedTaskId, assertCogSeedUserId } from './paths';
import { listCogSeedConnectors } from './connector-store';
import { cogseedConnectorManager } from './connector-manager';
import { cogseedKbManager } from './cogseed-kb-store';
import { listCogSeedSessions, listCogSeedTasks, readCogSeedSession, readCogSeedTask } from './task-store';
import { readCogSeedCoordination } from './coordinator';
import { cogseedCollaborationStore } from './collaboration-store-adapter';
import { resolveCogSeedSessionIdentity } from './actor-session-facade';
import { computeCogSeedBoardGroupProgress } from './board-group-status';
import type { CollaborationEvent, SharedTaskContext, WorkflowRun } from '../collaboration_control/types';
import type { CollaborationScope } from '../collaboration_control/ports';
import type { CogSeedSessionRecord, CogSeedTaskEvent, CogSeedTaskRecord, CogSeedTaskStatus } from './types';
import { t } from '../../i18n';

const MAX_TASK_CHARS = 64_000;
const MAX_PROFILE_ID_CHARS = 300;
const MAX_CONTEXT_ITEMS = 100;
const MAX_ATTACHMENT_ITEMS = 100;

interface CogSeedIpcController extends Pick<CogSeedRuntimeController, 'startCogSeedTask' | 'cancelCogSeedTask' | 'retryCogSeedTask' | 'resumeCogSeedTask' | 'runtimeStatus' | 'restartRuntime'> {}

async function resolveCogSeedRuntimeController(deps: CogSeedIpcServiceDeps): Promise<CogSeedIpcController> {
  return deps.controller ?? (await import('./runtime-controller')).cogseedRuntimeController;
}

export interface CogSeedIpcServiceDeps {
  controller?: CogSeedIpcController;
  readTask?: typeof readCogSeedTask;
  retryTask?: typeof retryCogSeedTask;
  readEvents?: typeof readCogSeedTaskEvents;
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
  abortGroupChat?: (userId: string, conversationId: string) => Promise<unknown>;
  retryGroupChat?: (input: { userId: string; cid: string; failedMessageId: string; visibleText: string; requestId: string }) => Promise<{ ok: boolean; error?: string }>;
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


export type CogSeedRendererTaskAction = 'retry' | 'skip' | 'resume' | 'abort';

export type CogSeedRendererTitleKey =
  | 'run_center.task_kind_cogseed'
  | 'run_center.task_kind_local_cli'
  | 'run_center.task_kind_group_chat'
  | 'run_center.task_kind_commander_turn'
  | 'run_center.task_kind_agent_turn'
  | 'run_center.task_kind_worker_turn'
  | 'run_center.workflow_step';

export interface CogSeedRendererActionSet {
  retry: boolean;
  skip: boolean;
  resume: boolean;
  abort: boolean;
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
}

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
  const requestId = assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
  const task = boundedString(raw.task, 'task', MAX_TASK_CHARS) ?? '';
  const sessionId = optionalSessionId(raw.sessionId);
  const profileId = optionalProfileId(raw.profileId);
  const context = boundedArray(raw.context, 'context', MAX_CONTEXT_ITEMS);
  const attachments = boundedArray(raw.attachments, 'attachments', MAX_ATTACHMENT_ITEMS);
  const workingDir = boundedString(raw.workingDir, 'workingDir', 2_000, false);
  const conversationId = boundedString(raw.conversationId, 'conversationId', 160, false);
  return {
    requestId,
    task,
    ...(sessionId ? { sessionId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(context ? { context } : {}),
    ...(attachments ? { attachments } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
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



const TERMINAL_TASK_STATUSES = new Set<CogSeedTaskStatus>(['completed', 'failed', 'cancelled']);

function rendererSafeIdentifier(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) return '';
  return text && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : '';
}

function rendererTaskTitle(task: Partial<Pick<CogSeedTaskRecord, 'executionKind' | 'groupChatTurnId' | 'groupChatActorKind'>>): {
  title: string;
  titleKey: CogSeedRendererTitleKey;
} {
  if (task.executionKind === 'local-cli') {
    return { title: 'Local CLI task', titleKey: 'run_center.task_kind_local_cli' };
  }
  if (task.executionKind === 'group-chat') {
    if (!task.groupChatTurnId) {
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

function rendererSessionTitle(tasks: CogSeedTaskRecord[]): ReturnType<typeof rendererTaskTitle> {
  const groupChatRun = tasks.find((task) => task.executionKind === 'group-chat' && !task.groupChatTurnId);
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return rendererTaskTitle(groupChatRun ?? latest ?? {});
}

function taskActions(task: Pick<CogSeedTaskRecord, 'status' | 'executionKind' | 'conversationId' | 'groupChatMessageId'>, hasWorkflowStep = false): CogSeedRendererActionSet {
  const { status } = task;
  if (task.executionKind === 'group-chat') {
    return {
      retry: status === 'failed' && !!task.conversationId && !!task.groupChatMessageId,
      skip: false,
      resume: false,
      abort: status === 'created' || status === 'queued' || status === 'running',
    };
  }
  return {
    retry: status === 'failed',
    skip: hasWorkflowStep && !TERMINAL_TASK_STATUSES.has(status),
    resume: status === 'recoverable',
    abort: !TERMINAL_TASK_STATUSES.has(status),
  };
}

export function cogSeedRendererBoardColumn(status: CogSeedTaskStatus): CogSeedRendererBoardColumn {
  if (status === 'created' || status === 'queued') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'waiting_user' || status === 'recoverable' || status === 'failed') return 'attention';
  if (status === 'completed') return 'completed';
  return 'archived';
}

function taskSummary(task: CogSeedTaskRecord, hasWorkflowStep = false): CogSeedRendererTaskSummary {
  const title = rendererTaskTitle(task);
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
    ...(rendererSafeIdentifier(task.errorCode) ? { errorCode: rendererSafeIdentifier(task.errorCode) } : {}),
    ...(task.executionKind ? { executionKind: task.executionKind } : {}),
    ...(rendererSafeIdentifier(task.agentId) ? { agentId: rendererSafeIdentifier(task.agentId) } : {}),
    ...(task.skillVersionPinStatus ? { skillVersionPinStatus: task.skillVersionPinStatus } : {}),
    actions: taskActions(task, hasWorkflowStep),
  };
}

function sessionSummary(session: CogSeedSessionRecord, tasks: CogSeedTaskRecord[]): CogSeedRendererSessionSummary {
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const title = rendererSessionTitle(tasks);
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
  if (!['retry', 'skip', 'resume', 'abort'].includes(action)) throw new Error('invalid CogSeed task action');
  const taskId = raw.taskId === undefined ? undefined : assertCogSeedTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
  const requestId = raw.requestId === undefined ? undefined : assertCogSeedRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
  const reason = boundedString(raw.reason, 'reason', 500, false);
  return { action, ...(taskId ? { taskId } : {}), ...(requestId ? { requestId } : {}), ...(reason ? { reason } : {}) };
}

export function createCogSeedIpcService(deps: CogSeedIpcServiceDeps = {}) {
  const readTask = deps.readTask ?? readCogSeedTask;
  const retryTask = deps.retryTask ?? retryCogSeedTask;
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
  const abortGroupChat = deps.abortGroupChat ?? (async (userId, conversationId) => (await import('../group_chat')).abort(userId, conversationId));
  const retryGroupChat = deps.retryGroupChat ?? (async (input) => (await import('../group_chat')).retryFailedTurn(input));

  const visibleDashboardTasks = async (userId: string, tasks: CogSeedTaskRecord[]): Promise<CogSeedTaskRecord[]> => {
    const conversationIds = Array.from(new Set(tasks
      .filter((task) => task.executionKind === 'group-chat' && task.conversationId)
      .map((task) => task.conversationId!)));
    if (!conversationIds.length) return tasks;
    const availability = await Promise.all(conversationIds.map(async (conversationId) => [
      conversationId,
      await isConversationAvailable(userId, conversationId),
    ] as const));
    const available = new Set(availability.filter(([, exists]) => exists).map(([conversationId]) => conversationId));
    return tasks.filter((task) => task.executionKind !== 'group-chat' || !task.conversationId || available.has(task.conversationId));
  };

  return {
    async start(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const controller = await resolveCogSeedRuntimeController(deps);
      return taskSummary(await controller.startCogSeedTask(userId, normalizeStartInput(payload)));
    },

    async read(userId: string, payload: unknown): Promise<CogSeedRendererTaskSummary> {
      assertCogSeedUserId(userId);
      const taskId = normalizeTaskId(payload);
      const task = await readTask(userId, taskId);
      if (!task) throw new Error('CogSeed task not found');
      return taskSummary(task);
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
      const context = boundedArray(raw.context, 'context', MAX_CONTEXT_ITEMS);
      const attachments = boundedArray(raw.attachments, 'attachments', MAX_ATTACHMENT_ITEMS);
      const workingDir = boundedString(raw.workingDir, 'workingDir', 2_000, false);
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

    async boardProjection(userId: string): Promise<CogSeedRendererBoardProjection> {
      assertCogSeedUserId(userId);
      const [sessions, allTasks] = await Promise.all([listSessions(userId), listTasks(userId)]);
      const tasks = await visibleDashboardTasks(userId, allTasks);
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
        const sessionTitle = rendererSessionTitle(tasksBySession.get(task.sessionId) ?? [task]);
        return {
          ...taskSummary(task),
          column: cogSeedRendererBoardColumn(task.status),
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
        const title = rendererTaskTitle(parent);
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


    async sessionListProjection(userId: string): Promise<CogSeedRendererSessionSummary[]> {
      assertCogSeedUserId(userId);
      const [sessions, allTasks] = await Promise.all([listSessions(userId), listTasks(userId)]);
      const tasks = await visibleDashboardTasks(userId, allTasks);
      return sessions
        .map((session) => ({ session, tasks: tasks.filter((task) => task.sessionId === session.sessionId) }))
        .filter((entry) => entry.tasks.length > 0)
        .map((entry) => sessionSummary(entry.session, entry.tasks))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async sessionProjection(userId: string, payload: unknown): Promise<{ session: CogSeedRendererSessionSummary | null; collaboration: CogSeedRendererCollaborationSnapshot | null }> {
      assertCogSeedUserId(userId);
      const { sessionId, taskId } = normalizeProjectionInput(payload);
      const requestedTask = taskId ? await readTask(userId, taskId) : null;
      const resolvedSessionId = sessionId || requestedTask?.sessionId;
      const session = resolvedSessionId ? await readSession(userId, assertCogSeedSessionId(resolvedSessionId)) : null;
      if (!session) return { session: null, collaboration: null };
      if (session.conversationId && !await isConversationAvailable(userId, session.conversationId)) {
        return { session: null, collaboration: null };
      }
      const tasks = await visibleDashboardTasks(userId, await listTasks(userId));
      const directTasks = tasks.filter((task) => task.sessionId === session.sessionId);
      const collaboration = directTasks.length
        ? await this.collaborationSnapshot(userId, taskId ? { taskId } : { sessionId: session.sessionId })
        : null;
      return { session: sessionSummary(session, directTasks), collaboration };
    },

    async collaborationSnapshot(userId: string, payload: unknown): Promise<CogSeedRendererCollaborationSnapshot> {
      assertCogSeedUserId(userId);
      const input = normalizeProjectionInput(payload);
      const allTasks = await visibleDashboardTasks(userId, await listTasks(userId));
      let selected = input.taskId ? await readTask(userId, input.taskId) : null;
      if (selected?.executionKind === 'group-chat' && selected.conversationId
        && !await isConversationAvailable(userId, selected.conversationId)) {
        throw new Error('Group Chat conversation is unavailable');
      }
      if (!selected && input.sessionId) {
        selected = [...allTasks].filter((task) => task.sessionId === input.sessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      }
      if (!selected) throw new Error('CogSeed collaboration task not found');
      const session = await readSession(userId, selected.sessionId);
      if (!session) throw new Error('CogSeed session not found');

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
      const tasks = related.map((task) => taskSummary(task, workflowStepIds.has(task.taskId)));
      const directSessionTasks = allTasks.filter((task) => task.sessionId === session.sessionId);
      const sessionView = sessionSummary(session, directSessionTasks);
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
      if (!actorById.has('commander')) {
        actorById.set('commander', {
          actorId: 'commander',
          role: 'commander',
          displayName: 'Commander',
          sessionId: selected.sessionId,
          taskId: selected.taskId,
          status: selected.status,
        });
      }
      for (const task of related.filter((item) => item.taskId !== selected.taskId && item.executionKind !== 'group-chat')) {
        const actorId = task.agentId || `member:${task.taskId}`;
        if (actorById.has(actorId)) continue;
        const actorSession = sessionRecords.find((record) => record.sessionId === task.sessionId);
        actorById.set(actorId, {
          actorId: rendererSafeIdentifier(actorId) || task.taskId,
          role: actorRole(actorSession?.actorRole || (task.parentTaskId ? 'member' : 'child')),
          sessionId: task.sessionId,
          taskId: task.taskId,
          status: task.status,
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
        task: taskSummary(selected, hasSelectedWorkflowStep),
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
      else if (!input.requestId) throw new Error('requestId required');
      else if (input.action === 'retry') await controller.retryCogSeedTask(userId, input.taskId, input.requestId);
      else if (input.action === 'resume') await controller.resumeCogSeedTask(userId, input.taskId, { requestId: input.requestId, continuation: input.reason || 'Resume task.' });
      return this.collaborationSnapshot(userId, { taskId: input.taskId });
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
      const recovery = await recoverCogSeedTasks(userId);
      return { ...restarted, recovery };
    },

    async recover(userId: string) {
      assertCogSeedUserId(userId);
      return recoverCogSeedTasks(userId);
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
  };
}

export const cogseedIpcService = createCogSeedIpcService();
