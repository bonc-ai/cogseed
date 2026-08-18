import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { fileEditLock } from '../../util/locks';
import { assertMateCoordinationId, assertMateTaskId, assertMateUserId, mateCoordinationFile } from './paths';
import { createMateTask, readMateTask, readMateTaskByRequestId } from './task-store';
import type { MateCoordinationRecord, MateTaskRecord } from './types';
import type { StartMateTaskInput } from './runtime-controller';
import { createCollaborationEngine } from '../collaboration_control/engine';
import { createMateCollaborationStore } from './collaboration-store-adapter';
import { createMateCollaborationDispatcher } from './collaboration-dispatcher';

const log = createLogger('mate-backend:coordinator');
const MAX_CHILDREN = 4;
const MAX_DEPTH = 1;

export interface MateCoordinatorDeps {
  startTask?: (userId: string, input: StartMateTaskInput) => Promise<MateTaskRecord>;
  cancelTask?: (userId: string, taskId: string) => Promise<MateTaskRecord>;
}

export interface MateDelegateInput {
  requestId: string;
  task: string;
  role?: string;
  context?: unknown[];
}

export interface MateCoordinator {
  delegate(userId: string, parentRequestId: string, input: MateDelegateInput): Promise<MateTaskRecord>;
  tasks(userId: string, parentRequestId: string, taskIds: string[]): Promise<{ coordinationId: string; children: Array<Pick<MateTaskRecord, 'taskId' | 'status' | 'sessionId' | 'runtimeSessionId' | 'updatedAt'>> }>;
  cancel(userId: string, parentRequestId: string, taskId: string): Promise<MateTaskRecord>;
  cancelChildrenForParent(userId: string, parentTaskId: string): Promise<void>;
}

function coordinationId(parentTaskId: string) { return `mate-coord-${parentTaskId.slice('mate-task-'.length)}`; }
function isMissing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }

export async function readMateCoordination(userId: string, id: string): Promise<MateCoordinationRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(mateCoordinationFile(userId, id), 'utf8')) as MateCoordinationRecord;
    if (value.ownerId !== userId || value.coordinationId !== id) throw new Error('malformed CogSeed coordination');
    assertMateCoordinationId(value.coordinationId); assertMateTaskId(value.parentTaskId);
    return value;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed coordination');
    throw error;
  }
}

export function createMateCoordinator(deps: MateCoordinatorDeps = {}): MateCoordinator {
  const startTask = deps.startTask ?? (async (userId, input) => {
    const task = await createMateTask(userId, {
      requestId: input.requestId, task: input.task, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.coordinationId ? { coordinationId: input.coordinationId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.coordinationDepth !== undefined ? { coordinationDepth: input.coordinationDepth } : {}),
    });
    return task.task;
  });
  const cancelTask = deps.cancelTask ?? (async () => { throw new Error('CogSeed coordinator cancel controller unavailable'); });
  const controlStore = createMateCollaborationStore();
  const controlDispatcher = createMateCollaborationDispatcher({ startTask, cancelTask });
  const controlEngine = createCollaborationEngine({ store: controlStore, dispatcher: controlDispatcher, id: (prefix = 'id') => `${prefix}-${genId12()}` });

  async function parent(userId: string, requestId: string): Promise<MateTaskRecord> {
    const task = await readMateTaskByRequestId(userId, requestId);
    if (!task) throw new Error('CogSeed coordinator parent task not found');
    return task;
  }

  return {
    async delegate(userId, parentRequestId, input) {
      assertMateUserId(userId); assertMateTaskId((await parent(userId, parentRequestId)).taskId);
      const parentTask = await parent(userId, parentRequestId);
      const id = coordinationId(parentTask.taskId);
      if (parentTask.coordinationDepth && parentTask.coordinationDepth >= MAX_DEPTH) throw new Error('CogSeed coordinator depth budget exceeded');
      const requestId = input.requestId;
      const file = mateCoordinationFile(userId, id);
      return fileEditLock(file).runExclusive(async () => {
        const now = nowIso();
        let record = await readMateCoordination(userId, id);
        if (!record) {
          record = { schemaVersion: 1, coordinationId: id, ownerId: userId, parentTaskId: parentTask.taskId, parentRuntimeSessionId: parentTask.runtimeSessionId, status: 'running', childTaskIds: [], maxChildren: MAX_CHILDREN, maxDepth: MAX_DEPTH, createdAt: now, updatedAt: now };
        }
        if (record.status !== 'running') throw new Error('CogSeed coordination is not running');
        const existing = await readMateTaskByRequestId(userId, requestId);
        if (existing?.coordinationId === id && existing.parentTaskId === parentTask.taskId) return existing;
        if (record.childTaskIds.length >= record.maxChildren) throw new Error('CogSeed coordinator child budget exceeded');
        const taskText = `${typeof input.role === 'string' && input.role.trim() ? `[Role: ${input.role.trim().slice(0, 120)}]\n` : ''}${String(input.task || '').trim()}`;
        if (!taskText.trim() || taskText.length > 20_000) throw new Error('CogSeed delegate task is invalid');
        const scope = { ownerId: userId, domain: 'mate' as const, scopeId: id };
        if (!record.workflowRunId) {
          const controlRun = await controlEngine.createRun(scope, { objective: parentTask.task, kind: 'custom', createdBy: parentTask.taskId });
          record.workflowRunId = controlRun.id;
          await writeJson(file, record);
        }
        const step = await controlEngine.planStep(scope, record.workflowRunId, { title: taskText, actorId: typeof input.role === 'string' ? input.role.slice(0, 120) : null, type: 'dispatch', resumeToken: requestId, objective: taskText });
        const startedStep = await controlEngine.startStep(scope, record.workflowRunId, step.id);
        const child = startedStep.result_ref ? await readMateTask(userId, startedStep.result_ref) : null;
        if (!child) throw new Error('CogSeed delegated task was not persisted');
        record.childTaskIds.push(child.taskId); record.updatedAt = nowIso();
        await writeJson(file, record);
        return child;
      });
    },
    async tasks(userId, parentRequestId, taskIds) {
      const parentTask = await parent(userId, parentRequestId); const id = coordinationId(parentTask.taskId); const record = await readMateCoordination(userId, id);
      if (!record) return { coordinationId: id, children: [] };
      const wanted = taskIds.length ? new Set(taskIds) : new Set(record.childTaskIds);
      const children: Array<Pick<MateTaskRecord, 'taskId' | 'status' | 'sessionId' | 'runtimeSessionId' | 'updatedAt'>> = [];
      for (const childId of record.childTaskIds) {
        if (!wanted.has(childId)) continue;
        const child = await readMateTask(userId, childId); if (!child) continue;
        children.push({ taskId: child.taskId, status: child.status, sessionId: child.sessionId, runtimeSessionId: child.runtimeSessionId, updatedAt: child.updatedAt });
      }
      return { coordinationId: id, children };
    },
    async cancel(userId, parentRequestId, taskId) {
      const parentTask = await parent(userId, parentRequestId); const record = await readMateCoordination(userId, coordinationId(parentTask.taskId));
      if (!record?.childTaskIds.includes(assertMateTaskId(taskId))) throw new Error('CogSeed task is not linked to this coordination');
      return cancelTask(userId, taskId);
    },
    async cancelChildrenForParent(userId, parentTaskId) {
      const id = coordinationId(assertMateTaskId(parentTaskId));
      const file = mateCoordinationFile(userId, id);
      await fileEditLock(file).runExclusive(async () => {
        const record = await readMateCoordination(userId, id); if (!record || record.status === 'cancelled') return;
        for (const childId of record.childTaskIds) {
          const child = await readMateTask(userId, childId);
          if (!child || ['completed', 'cancelled', 'failed'].includes(child.status)) continue;
          try { await cancelTask(userId, childId); }
          catch (error) { log.warn('CogSeed coordination child cancel failed', { error: logErrorRef(error) }); }
        }
        await writeJson(file, { ...record, status: 'cancelled', updatedAt: nowIso() });
      });
    },
  };
}

export const mateCoordinator = createMateCoordinator({
  startTask: async (userId, input) => (await import('./runtime-controller')).mateRuntimeController.startMateTask(userId, input),
  cancelTask: async (userId, taskId) => (await import('./runtime-controller')).mateRuntimeController.cancelMateTask(userId, taskId),
});
