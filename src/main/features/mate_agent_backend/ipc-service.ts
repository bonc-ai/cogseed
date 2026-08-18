import { readMateTaskEvents } from './event-store';
import { retryMateTask } from './lifecycle';
import { recoverMateTasks } from './recovery';
import { mateRuntimeController, type MateRuntimeController, type ResumeMateTaskInput, type StartMateTaskInput } from './runtime-controller';
import { assertMateConnectorId, assertMateKbSourceId, assertMateRequestId, assertMateSessionId, assertMateTaskId, assertMateUserId } from './paths';
import { listMateConnectors } from './connector-store';
import { mateConnectorManager } from './connector-manager';
import { mateKbManager } from './mate-kb-store';
import { listMateSessions, listMateTasks, readMateSession, readMateTask } from './task-store';
import { readMateCoordination } from './coordinator';
import { mateCollaborationStore } from './collaboration-store-adapter';
import { resolveMateSessionIdentity } from './actor-session-facade';
import type { WorkflowRun } from '../collaboration_control/types';
import type { CollaborationScope } from '../collaboration_control/ports';
import type { MateSessionRecord, MateTaskEvent, MateTaskRecord, MateTaskStatus } from './types';

const MAX_TASK_CHARS = 64_000;
const MAX_PROFILE_ID_CHARS = 300;
const MAX_CONTEXT_ITEMS = 100;
const MAX_ATTACHMENT_ITEMS = 100;

interface MateIpcController extends Pick<MateRuntimeController, 'startMateTask' | 'cancelMateTask' | 'retryMateTask' | 'resumeMateTask' | 'runtimeStatus' | 'restartRuntime'> {}

export interface MateIpcServiceDeps {
  controller?: MateIpcController;
  readTask?: typeof readMateTask;
  retryTask?: typeof retryMateTask;
  readEvents?: typeof readMateTaskEvents;
  listSessions?: typeof listMateSessions;
  readSession?: typeof readMateSession;
  listTasks?: typeof listMateTasks;
  readCoordination?: typeof readMateCoordination;
  readWorkflowRun?: (scope: CollaborationScope, runId: string) => Promise<WorkflowRun | null>;
}

export interface MateTaskEventsInput {
  taskId: string;
  afterSequence?: number;
  limit?: number;
}

export interface MateTaskRetryInput {
  taskId: string;
  requestId: string;
}


export type MateRendererTaskAction = 'retry' | 'skip' | 'resume' | 'abort';

export interface MateRendererActionSet {
  retry: boolean;
  skip: boolean;
  resume: boolean;
  abort: boolean;
}

export interface MateRendererSessionSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  activeTaskCount: number;
  latestStatus: MateTaskStatus | 'idle';
  hasRecovery: boolean;
}

export interface MateRendererTaskSummary {
  taskId: string;
  sessionId: string;
  requestId: string;
  parentTaskId?: string;
  coordinationId?: string;
  status: MateTaskStatus;
  title: string;
  createdAt: string;
  updatedAt: string;
  actions: MateRendererActionSet;
}

export interface MateRendererActorSummary {
  actorId: string;
  role: 'commander' | 'member_agent' | 'child_agent';
  sessionId: string;
  taskId?: string;
  status: MateTaskStatus | 'idle';
}

export interface MateRendererTimelineEvent {
  eventId: string;
  taskId: string;
  sequence: number;
  type: MateTaskEvent['type'];
  createdAt: string;
  summary: string;
}

export interface MateRendererWorkflowSummary {
  coordinationId?: string;
  workflowRunId?: string;
  status?: WorkflowRun['status'];
  objective?: string;
  phase?: string;
  childTaskIds: string[];
  steps: Array<{
    stepId: string;
    title: string;
    actorId: string | null;
    status: string;
    dependsOn: string[];
    resultSummary?: string;
  }>;
}

export interface MateRendererCollaborationSnapshot {
  schemaVersion: 1;
  sessionId: string;
  updatedAt: string;
  session: MateRendererSessionSummary;
  task: MateRendererTaskSummary | null;
  actors: MateRendererActorSummary[];
  tasks: MateRendererTaskSummary[];
  workflow: MateRendererWorkflowSummary;
  recovery: {
    recoverable: boolean;
    taskIds: string[];
    lastEventAt?: string;
  };
  timeline: MateRendererTimelineEvent[];
  actions: MateRendererActionSet;
}

function rejectHiddenBackendFields(payload: Record<string, unknown>): void {
  const forbidden = ['allowFallback', 'backendPreference', 'kernelMode', 'mode', 'runtimeKernel'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`Mate Agent does not accept Core/fallback field: ${key}`);
    }
  }
}

function asObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid Mate Agent request');
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
  return text ? assertMateSessionId(text) : undefined;
}

function optionalProfileId(value: unknown): string | undefined {
  return boundedString(value, 'profileId', MAX_PROFILE_ID_CHARS, false);
}

function normalizeStartInput(payload: unknown): StartMateTaskInput {
  const raw = asObject(payload);
  rejectHiddenBackendFields(raw);
  const requestId = assertMateRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
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
  if (typeof payload === 'string') return assertMateTaskId(payload.trim());
  const raw = asObject(payload);
  return assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
}

function normalizeRetryInput(payload: unknown): MateTaskRetryInput {
  const raw = asObject(payload);
  rejectHiddenBackendFields(raw);
  return {
    taskId: assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''),
    requestId: assertMateRequestId(boundedString(raw.requestId, 'requestId', 120) ?? ''),
  };
}

function normalizeEventsInput(payload: unknown): MateTaskEventsInput {
  const raw = typeof payload === 'string' ? { taskId: payload } : asObject(payload);
  return {
    taskId: assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''),
    afterSequence: Math.max(0, Math.floor(Number(raw.afterSequence) || 0)),
    limit: Math.max(1, Math.min(Math.floor(Number(raw.limit) || 200), 500)),
  };
}



const TERMINAL_TASK_STATUSES = new Set<MateTaskStatus>(['completed', 'failed', 'cancelled']);

function redactRendererText(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : '';
  return text
    .replace(/(?:\/Users|\/private|\/tmp|\/var|\/home)\/[^\s"'`]+/g, '[path]')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[path]')
    .replace(/\b(?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .slice(0, max);
}

function taskActions(status: MateTaskStatus, hasWorkflowStep = false): MateRendererActionSet {
  return {
    retry: status === 'failed' || status === 'cancelled',
    skip: hasWorkflowStep && !TERMINAL_TASK_STATUSES.has(status),
    resume: status === 'recoverable',
    abort: !TERMINAL_TASK_STATUSES.has(status),
  };
}

function taskSummary(task: MateTaskRecord, hasWorkflowStep = false): MateRendererTaskSummary {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    requestId: task.requestId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.coordinationId ? { coordinationId: task.coordinationId } : {}),
    status: task.status,
    title: redactRendererText(task.task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    actions: taskActions(task.status, hasWorkflowStep),
  };
}

function sessionSummary(session: MateSessionRecord, tasks: MateTaskRecord[]): MateRendererSessionSummary {
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    taskCount: tasks.length,
    activeTaskCount: tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status)).length,
    latestStatus: latest?.status ?? 'idle',
    hasRecovery: tasks.some((task) => task.status === 'recoverable'),
  };
}

function rendererSafeEventSummary(event: MateTaskEvent): string {
  switch (event.type) {
    case 'task.created': return 'Task created.';
    case 'task.queued': return 'Task queued.';
    case 'task.started': return 'Task started.';
    case 'task.completed': return 'Task completed.';
    case 'task.failed': return 'Task failed.';
    case 'task.cancelled': return 'Task cancelled.';
    case 'task.recoverable': return 'Task requires recovery.';
    default: return redactRendererText(event.type, 120) || 'Mate task event.';
  }
}

function timelineSummary(event: MateTaskEvent): MateRendererTimelineEvent {
  return {
    eventId: event.eventId,
    taskId: event.taskId,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    summary: rendererSafeEventSummary(event),
  };
}

function normalizeProjectionInput(payload: unknown): { sessionId?: string; taskId?: string } {
  const raw = typeof payload === 'string' ? { sessionId: payload } : asObject(payload);
  const sessionId = raw.sessionId === undefined
    ? undefined
    : resolveMateSessionIdentity(boundedString(raw.sessionId, 'sessionId', 120) ?? '').canonicalSessionId;
  const taskId = raw.taskId === undefined ? undefined : assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
  if (!sessionId && !taskId) throw new Error('sessionId or taskId required');
  return { ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) };
}

function normalizeActionInput(payload: unknown): { action: MateRendererTaskAction; taskId?: string; requestId?: string; reason?: string } {
  const raw = asObject(payload);
  const action = boundedString(raw.action, 'action', 20) as MateRendererTaskAction;
  if (!['retry', 'skip', 'resume', 'abort'].includes(action)) throw new Error('invalid Mate task action');
  const taskId = raw.taskId === undefined ? undefined : assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? '');
  const requestId = raw.requestId === undefined ? undefined : assertMateRequestId(boundedString(raw.requestId, 'requestId', 120) ?? '');
  const reason = boundedString(raw.reason, 'reason', 500, false);
  return { action, ...(taskId ? { taskId } : {}), ...(requestId ? { requestId } : {}), ...(reason ? { reason } : {}) };
}

export function createMateIpcService(deps: MateIpcServiceDeps = {}) {
  const controller = deps.controller ?? mateRuntimeController;
  const readTask = deps.readTask ?? readMateTask;
  const retryTask = deps.retryTask ?? retryMateTask;
  const readEvents = deps.readEvents ?? readMateTaskEvents;
  const listSessions = deps.listSessions ?? listMateSessions;
  const readSession = deps.readSession ?? readMateSession;
  const listTasks = deps.listTasks ?? listMateTasks;
  const readCoordination = deps.readCoordination ?? readMateCoordination;
  const readWorkflowRun = deps.readWorkflowRun ?? ((scope, runId) => mateCollaborationStore.readRun(scope, runId));

  return {
    async start(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      assertMateUserId(userId);
      return taskSummary(await controller.startMateTask(userId, normalizeStartInput(payload)));
    },

    async read(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      assertMateUserId(userId);
      const taskId = normalizeTaskId(payload);
      const task = await readTask(userId, taskId);
      if (!task) throw new Error('Mate task not found');
      return taskSummary(task);
    },

    async cancel(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      assertMateUserId(userId);
      return taskSummary(await controller.cancelMateTask(userId, normalizeTaskId(payload)));
    },

    async abort(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      return this.cancel(userId, payload);
    },

    async retry(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      assertMateUserId(userId);
      const input = normalizeRetryInput(payload);
      const task = deps.retryTask ? await retryTask(userId, input.taskId, input.requestId) : await controller.retryMateTask(userId, input.taskId, input.requestId);
      return taskSummary(task);
    },

    async resume(userId: string, payload: unknown): Promise<MateRendererTaskSummary> {
      assertMateUserId(userId);
      const raw = asObject(payload);
      rejectHiddenBackendFields(raw);
      const context = boundedArray(raw.context, 'context', MAX_CONTEXT_ITEMS);
      const attachments = boundedArray(raw.attachments, 'attachments', MAX_ATTACHMENT_ITEMS);
      const workingDir = boundedString(raw.workingDir, 'workingDir', 2_000, false);
      const profileId = optionalProfileId(raw.profileId);
      const input: ResumeMateTaskInput = {
        requestId: assertMateRequestId(boundedString(raw.requestId, 'requestId', 120) ?? ''),
        continuation: boundedString(raw.continuation, 'continuation', MAX_TASK_CHARS) ?? '',
        ...(profileId ? { profileId } : {}),
        ...(context ? { context } : {}),
        ...(attachments ? { attachments } : {}),
        ...(workingDir ? { workingDir } : {}),
      };
      const task = await controller.resumeMateTask(userId, assertMateTaskId(boundedString(raw.taskId, 'taskId', 120) ?? ''), input);
      return taskSummary(task);
    },

    async kbIndex(userId: string, payload: unknown) {
      assertMateUserId(userId);
      const raw = asObject(payload);
      const sourceId = assertMateKbSourceId(boundedString(raw.sourceId, 'sourceId', 200) ?? '');
      const title = boundedString(raw.title, 'title', 500) ?? '';
      const content = boundedString(raw.content, 'content', 5_000_000) ?? '';
      return mateKbManager.indexText(userId, { sourceId, title, content });
    },

    async kbSearch(userId: string, payload: unknown) {
      assertMateUserId(userId);
      const raw = asObject(payload);
      const query = boundedString(raw.query, 'query', 2_000) ?? '';
      return mateKbManager.search(userId, query, { k: Math.max(1, Math.min(Math.floor(Number(raw.k) || 10), 50)) });
    },

    async kbRead(userId: string, payload: unknown) {
      assertMateUserId(userId);
      const raw = asObject(payload);
      return mateKbManager.readSource(userId, assertMateKbSourceId(boundedString(raw.sourceId, 'sourceId', 200) ?? ''));
    },

    async kbSources(userId: string) {
      assertMateUserId(userId);
      return mateKbManager.listSources(userId);
    },

    async connectors(userId: string) {
      assertMateUserId(userId);
      const records = await listMateConnectors(userId);
      return records.map(({ transport: _transport, ...publicRecord }) => publicRecord);
    },

    async connectorTools(userId: string, payload: unknown) {
      assertMateUserId(userId);
      const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const connectorId = typeof raw.connectorId === 'string' ? assertMateConnectorId(raw.connectorId) : undefined;
      return connectorId ? mateConnectorManager.listTools(userId, connectorId) : mateConnectorManager.listAllTools(userId);
    },

    async sessions(userId: string) {
      return this.sessionListProjection(userId);
    },

    async session(userId: string, payload: unknown) {
      return this.sessionProjection(userId, payload);
    },


    async sessionListProjection(userId: string): Promise<MateRendererSessionSummary[]> {
      assertMateUserId(userId);
      const [sessions, tasks] = await Promise.all([listSessions(userId), listTasks(userId)]);
      return sessions.map((session) => sessionSummary(session, tasks.filter((task) => task.sessionId === session.sessionId)));
    },

    async sessionProjection(userId: string, payload: unknown): Promise<{ session: MateRendererSessionSummary | null; collaboration: MateRendererCollaborationSnapshot | null }> {
      assertMateUserId(userId);
      const { sessionId } = normalizeProjectionInput(payload);
      const session = await readSession(userId, assertMateSessionId(sessionId ?? ''));
      if (!session) return { session: null, collaboration: null };
      const tasks = await listTasks(userId);
      const directTasks = tasks.filter((task) => task.sessionId === session.sessionId);
      const collaboration = directTasks.length
        ? await this.collaborationSnapshot(userId, { taskId: [...directTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].taskId })
        : null;
      return { session: sessionSummary(session, directTasks), collaboration };
    },

    async collaborationSnapshot(userId: string, payload: unknown): Promise<MateRendererCollaborationSnapshot> {
      assertMateUserId(userId);
      const input = normalizeProjectionInput(payload);
      const allTasks = await listTasks(userId);
      let selected = input.taskId ? await readTask(userId, input.taskId) : null;
      if (!selected && input.sessionId) {
        selected = [...allTasks].filter((task) => task.sessionId === input.sessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      }
      if (!selected) throw new Error('Mate collaboration task not found');
      const session = await readSession(userId, selected.sessionId);
      if (!session) throw new Error('Mate session not found');

      const related: MateTaskRecord[] = [];
      const visit = (task: MateTaskRecord) => {
        if (related.some((item) => item.taskId === task.taskId)) return;
        related.push(task);
        for (const child of allTasks.filter((candidate) => candidate.parentTaskId === task.taskId)) visit(child);
      };
      visit(selected);
      const coordination = selected.coordinationId ? await readCoordination(userId, selected.coordinationId) : null;
      const workflowRun = coordination?.workflowRunId
        ? await readWorkflowRun({ ownerId: userId, domain: 'mate', scopeId: coordination.coordinationId }, coordination.workflowRunId)
        : null;
      const workflowStepIds = new Set(workflowRun?.steps.map((step) => step.result_ref).filter(Boolean) ?? []);
      const tasks = related.map((task) => taskSummary(task, workflowStepIds.has(task.taskId)));
      const directSessionTasks = allTasks.filter((task) => task.sessionId === session.sessionId);
      const sessionView = sessionSummary(session, directSessionTasks);
      const eventLists = await Promise.all(related.map((task) => readEvents(userId, task.taskId, 0, 200)));
      const timeline = eventLists.flat().map(timelineSummary).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence).slice(-500);
      const actors: MateRendererActorSummary[] = [
        { actorId: 'commander', role: 'commander', sessionId: selected.sessionId, taskId: selected.taskId, status: selected.status },
        ...related.filter((task) => task.taskId !== selected.taskId).map((task) => ({
          actorId: `member:${task.taskId}`,
          role: task.parentTaskId ? 'member_agent' as const : 'child_agent' as const,
          sessionId: task.sessionId,
          taskId: task.taskId,
          status: task.status,
        })),
      ];
      const recoveryEvents = timeline.filter((event) => event.type === 'task.recoverable');
      const workflow: MateRendererWorkflowSummary = {
        ...(coordination?.coordinationId ? { coordinationId: coordination.coordinationId } : {}),
        ...(coordination?.workflowRunId ? { workflowRunId: coordination.workflowRunId } : {}),
        ...(workflowRun?.status ? { status: workflowRun.status } : {}),
        ...(workflowRun?.objective ? { objective: redactRendererText(workflowRun.objective) } : {}),
        ...(workflowRun?.phase ? { phase: redactRendererText(workflowRun.phase, 80) } : {}),
        childTaskIds: coordination?.childTaskIds ?? [],
        steps: (workflowRun?.steps ?? []).map((step) => ({
          stepId: step.id,
          title: redactRendererText(step.title),
          actorId: step.actor_id,
          status: step.status,
          dependsOn: step.depends_on,
          ...(step.result_summary ? { resultSummary: redactRendererText(step.result_summary) } : {}),
        })),
      };
      const primaryActions = taskActions(selected.status, workflow.steps.some((step) => step.resultSummary || step.stepId === selected.taskId));
      return {
        schemaVersion: 1,
        sessionId: session.sessionId,
        updatedAt: [selected.updatedAt, ...related.map((task) => task.updatedAt), session.updatedAt].sort().at(-1) ?? session.updatedAt,
        session: sessionView,
        task: taskSummary(selected, workflow.steps.some((step) => step.resultSummary || step.stepId === selected.taskId)),
        actors,
        tasks,
        workflow,
        recovery: {
          recoverable: related.some((task) => task.status === 'recoverable'),
          taskIds: related.filter((task) => task.status === 'recoverable').map((task) => task.taskId),
          ...(recoveryEvents.at(-1)?.createdAt ? { lastEventAt: recoveryEvents.at(-1)!.createdAt } : {}),
        },
        timeline,
        actions: primaryActions,
      };
    },

    async action(userId: string, payload: unknown): Promise<MateRendererCollaborationSnapshot> {
      assertMateUserId(userId);
      const input = normalizeActionInput(payload);
      if (!input.taskId) throw new Error('taskId required');
      if (input.action === 'skip') throw new Error('Mate workflow skip requires a workflow step scope');
      if (input.action === 'abort') await controller.cancelMateTask(userId, input.taskId);
      else if (!input.requestId) throw new Error('requestId required');
      else if (input.action === 'retry') await controller.retryMateTask(userId, input.taskId, input.requestId);
      else if (input.action === 'resume') await controller.resumeMateTask(userId, input.taskId, { requestId: input.requestId, continuation: input.reason || 'Resume task.' });
      return this.collaborationSnapshot(userId, { taskId: input.taskId });
    },

    async runtimeStatus(userId: string) {
      assertMateUserId(userId);
      return controller.runtimeStatus();
    },

    async restartRuntime(userId: string) {
      assertMateUserId(userId);
      const restarted = await controller.restartRuntime();
      const recovery = await recoverMateTasks(userId);
      return { ...restarted, recovery };
    },

    async recover(userId: string) {
      assertMateUserId(userId);
      return recoverMateTasks(userId);
    },

    async events(userId: string, payload: unknown): Promise<{ events: MateTaskEvent[]; afterSequence: number }> {
      assertMateUserId(userId);
      const input = normalizeEventsInput(payload);
      const events = await readEvents(userId, input.taskId, input.afterSequence, input.limit);
      return { events, afterSequence: input.afterSequence ?? 0 };
    },

    async *streamEvents(userId: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<{ type: 'event'; event: MateTaskEvent }, void, unknown> {
      assertMateUserId(userId);
      const input = normalizeEventsInput(payload);
      const events = await readEvents(userId, input.taskId, input.afterSequence, input.limit);
      for (const event of events) {
        if (signal?.aborted) return;
        yield { type: 'event', event };
      }
    },
  };
}

export const mateIpcService = createMateIpcService();
