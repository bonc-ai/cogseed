import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { fileEditLock } from '../../util/locks';
import { assertCogSeedCoordinationId, assertCogSeedTaskId, assertCogSeedUserId, cogseedCoordinationFile } from './paths';
import { createCogSeedTask, readCogSeedTask, readCogSeedTaskByRequestId } from './task-store';
import type { CogSeedCoordinationRecord, CogSeedTaskRecord } from './types';
import { CHILD_RESULT_CONTRACT, parseChildResult, type CogSeedChildStructuredResult } from './child-result';
import type { StartCogSeedTaskInput } from './runtime-controller';
import type { NativeRuntimeTurnRecord } from '../cogseed_runtime/kernel/session-store';
import { createCollaborationEngine } from '../collaboration_control/engine';
import { createCogSeedCollaborationStore } from './collaboration-store-adapter';
import { createCogSeedCollaborationDispatcher } from './collaboration-dispatcher';

const log = createLogger('cogseed-backend:coordinator');
const MAX_CHILDREN = 4;
const MAX_DEPTH = 1;
/** A join is a host-side wait, not a model round: cheap polling of task JSON. */
const JOIN_POLL_INTERVAL_MS = 250;
const DEFAULT_JOIN_TIMEOUT_MS = 120_000;
const MAX_JOIN_TIMEOUT_MS = 600_000;
const JOIN_RESULT_SUMMARY_CHARS = 4_000;
const JOIN_MAX_FILES = 20;
/** A child that needs a human, was cancelled, failed or ended recoverable is
 *  settled for the parent too: waiting longer only burns the outer deadline. */
const SETTLED_STATUSES: ReadonlySet<CogSeedTaskRecord['status']> = new Set([
  'completed', 'failed', 'cancelled', 'recoverable', 'waiting_user',
]);

export interface CogSeedCoordinatorDeps {
  startTask?: (userId: string, input: StartCogSeedTaskInput) => Promise<CogSeedTaskRecord>;
  cancelTask?: (userId: string, taskId: string) => Promise<CogSeedTaskRecord>;
}

export interface CogSeedDelegateInput {
  requestId: string;
  task: string;
  role?: string;
  context?: unknown[];
}

export interface CogSeedJoinInput {
  taskIds?: string[];
  timeoutMs?: number;
}

export interface CogSeedJoinedTask {
  taskId: string;
  status: CogSeedTaskRecord['status'];
  updatedAt: string;
  errorCode?: string;
  /** Bounded final assistant text. Full artifacts stay in the child workspace. */
  result?: string;
  /** Files the child wrote, so the parent can cite them without re-scanning. */
  files?: string[];
  /** Validated `cogseed-result` block, when the child followed the contract. */
  structured?: CogSeedChildStructuredResult;
  /** Why the block was rejected; absent when there was no block. */
  structuredError?: 'invalid_json' | 'invalid_shape' | 'too_large' | 'missing';
  /** Root task id of the delegation tree, for cross-process correlation. */
  traceId?: string;
  /** True when the join deadline expired before this child settled. */
  timedOut?: boolean;
}

export interface CogSeedJoinResult {
  coordinationId: string;
  settled: boolean;
  timedOut: boolean;
  tasks: CogSeedJoinedTask[];
}

export interface CogSeedChildSummary {
  taskId: string;
  status: CogSeedTaskRecord['status'];
  sessionId: string;
  runtimeSessionId: string;
  traceId?: string;
  updatedAt: string;
  errorCode?: string;
  /** Bounded latest assistant text; the full artifact stays in the child workspace. */
  result?: string;
  files?: string[];
}

export interface CogSeedCoordinator {
  delegate(userId: string, parentRequestId: string, input: CogSeedDelegateInput): Promise<CogSeedTaskRecord>;
  tasks(userId: string, parentRequestId: string, taskIds: string[]): Promise<{ coordinationId: string; children: CogSeedChildSummary[] }>;
  /** Wait (bounded) for delegated children, then return their outcomes. */
  join(userId: string, parentRequestId: string, input?: CogSeedJoinInput, opts?: { signal?: AbortSignal | null }): Promise<CogSeedJoinResult>;
  cancel(userId: string, parentRequestId: string, taskId: string): Promise<CogSeedTaskRecord>;
  cancelChildrenForParent(userId: string, parentTaskId: string): Promise<void>;
}

function coordinationId(parentTaskId: string) { return `cogseed-coord-${parentTaskId.slice('cogseed-task-'.length)}`; }
function isMissing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms));
    timer.unref?.();
  });
}

interface CogSeedChildOutcome {
  result?: string;
  files?: string[];
  structured?: CogSeedChildStructuredResult;
  structuredError?: 'invalid_json' | 'invalid_shape' | 'too_large' | 'missing';
}

/**
 * The child's final assistant text and written paths already live in its
 * native session. Reading them here gives the parent one structured result
 * instead of forcing it to re-read the child's workspace or poll a status
 * field that carries no content.
 */
async function readChildOutcome(userId: string, task: CogSeedTaskRecord): Promise<CogSeedChildOutcome> {
  if (!task.runtimeSessionId) return {};
  try {
    const { readNativeRuntimeSession } = await import('../cogseed_runtime/kernel/session-store');
    const session = await readNativeRuntimeSession(userId, task.runtimeSessionId);
    const turns = session.records.filter((row): row is NativeRuntimeTurnRecord => row.type === 'turn');
    const assistant = [...turns].reverse().find((row) => row.role === 'assistant' && row.content.trim());
    const visited = [...new Set(turns.flatMap((row) => (
      row.tool?.name === 'write_file' && !row.tool.result.isError && typeof row.tool.input.path === 'string'
        ? [row.tool.input.path]
        : []
    )))];
    const parsed = assistant ? parseChildResult(assistant.content) : null;
    // Structured declarations are additive, but only absolute paths count:
    // the parent must be able to cite them without a second resolution step.
    const files = [...new Set([...(parsed?.structured?.files ?? []), ...visited])].slice(0, JOIN_MAX_FILES);
    const visible = parsed?.text ?? '';
    // A completed delegated child was given the contract; omitting it means the
    // parent cannot trust the prose as a machine-readable result. Flag it
    // instead of silently returning an untyped success.
    const structuredError = parsed?.error
      ?? (task.status === 'completed' && assistant && !parsed?.structured ? 'missing' : undefined);
    return {
      ...(visible
        ? {
            result: visible.length > JOIN_RESULT_SUMMARY_CHARS
              ? `${visible.slice(0, JOIN_RESULT_SUMMARY_CHARS)}\n[child result truncated: ${visible.length - JOIN_RESULT_SUMMARY_CHARS} more chars in the child session]`
              : visible,
          }
        : {}),
      ...(files.length ? { files } : {}),
      ...(parsed?.structured ? { structured: parsed.structured } : {}),
      ...(structuredError ? { structuredError } : {}),
    };
  } catch (error) {
    // A child that never ran, or whose session was already swept, has no
    // outcome to read. That is an expected absence, not a failure.
    if (isMissing(error)) return {};
    log.warn('CogSeed child outcome read failed', { taskId: task.taskId, error: logErrorRef(error) });
    return {};
  }
}

export async function readCogSeedCoordination(userId: string, id: string): Promise<CogSeedCoordinationRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(cogseedCoordinationFile(userId, id), 'utf8')) as CogSeedCoordinationRecord;
    if (value.ownerId !== userId || value.coordinationId !== id) throw new Error('malformed CogSeed coordination');
    assertCogSeedCoordinationId(value.coordinationId); assertCogSeedTaskId(value.parentTaskId);
    return value;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed coordination');
    throw error;
  }
}

export function createCogSeedCoordinator(deps: CogSeedCoordinatorDeps = {}): CogSeedCoordinator {
  const startTask = deps.startTask ?? (async (userId, input) => {
    const task = await createCogSeedTask(userId, {
      requestId: input.requestId, task: input.task, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.coordinationId ? { coordinationId: input.coordinationId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.coordinationDepth !== undefined ? { coordinationDepth: input.coordinationDepth } : {}),
    });
    return task.task;
  });
  const cancelTask = deps.cancelTask ?? (async () => { throw new Error('CogSeed coordinator cancel controller unavailable'); });
  const controlStore = createCogSeedCollaborationStore();
  const controlDispatcher = createCogSeedCollaborationDispatcher({ startTask, cancelTask });
  const controlEngine = createCollaborationEngine({ store: controlStore, dispatcher: controlDispatcher, id: (prefix = 'id') => `${prefix}-${genId12()}` });

  async function parent(userId: string, requestId: string): Promise<CogSeedTaskRecord> {
    const task = await readCogSeedTaskByRequestId(userId, requestId);
    if (!task) throw new Error('CogSeed coordinator parent task not found');
    return task;
  }

  return {
    async delegate(userId, parentRequestId, input) {
      assertCogSeedUserId(userId); assertCogSeedTaskId((await parent(userId, parentRequestId)).taskId);
      const parentTask = await parent(userId, parentRequestId);
      const id = coordinationId(parentTask.taskId);
      if (parentTask.coordinationDepth && parentTask.coordinationDepth >= MAX_DEPTH) throw new Error('CogSeed coordinator depth budget exceeded');
      const requestId = input.requestId;
      const file = cogseedCoordinationFile(userId, id);
      return fileEditLock(file).runExclusive(async () => {
        const now = nowIso();
        let record = await readCogSeedCoordination(userId, id);
        if (!record) {
          record = { schemaVersion: 1, coordinationId: id, ownerId: userId, parentTaskId: parentTask.taskId, parentRuntimeSessionId: parentTask.runtimeSessionId, status: 'running', childTaskIds: [], maxChildren: MAX_CHILDREN, maxDepth: MAX_DEPTH, createdAt: now, updatedAt: now };
        }
        if (record.status !== 'running') throw new Error('CogSeed coordination is not running');
        const existing = await readCogSeedTaskByRequestId(userId, requestId);
        if (existing?.coordinationId === id && existing.parentTaskId === parentTask.taskId) return existing;
        if (record.childTaskIds.length >= record.maxChildren) throw new Error('CogSeed coordinator child budget exceeded');
        const brief = String(input.task || '').trim();
        if (!brief || brief.length > 20_000) throw new Error('CogSeed delegate task is invalid');
        const taskText = `${typeof input.role === 'string' && input.role.trim() ? `[Role: ${input.role.trim().slice(0, 120)}]\n` : ''}${brief}${CHILD_RESULT_CONTRACT}`;
        const scope = { ownerId: userId, domain: 'cogseed' as const, scopeId: id };
        if (!record.workflowRunId) {
          const controlRun = await controlEngine.createRun(scope, { objective: parentTask.task, kind: 'custom', createdBy: parentTask.taskId });
          record.workflowRunId = controlRun.id;
          await writeJson(file, record);
        }
        const step = await controlEngine.planStep(scope, record.workflowRunId, { title: taskText, actorId: typeof input.role === 'string' ? input.role.slice(0, 120) : null, type: 'dispatch', resumeToken: requestId, objective: taskText });
        const startedStep = await controlEngine.startStep(scope, record.workflowRunId, step.id);
        const child = startedStep.result_ref ? await readCogSeedTask(userId, startedStep.result_ref) : null;
        if (!child) throw new Error('CogSeed delegated task was not persisted');
        record.childTaskIds.push(child.taskId); record.updatedAt = nowIso();
        await writeJson(file, record);
        return child;
      });
    },
    async tasks(userId, parentRequestId, taskIds) {
      const parentTask = await parent(userId, parentRequestId); const id = coordinationId(parentTask.taskId); const record = await readCogSeedCoordination(userId, id);
      if (!record) return { coordinationId: id, children: [] };
      const wanted = taskIds.length ? new Set(taskIds) : new Set(record.childTaskIds);
      const children: CogSeedChildSummary[] = [];
      for (const childId of record.childTaskIds) {
        if (!wanted.has(childId)) continue;
        const child = await readCogSeedTask(userId, childId); if (!child) continue;
        const outcome = await readChildOutcome(userId, child);
        children.push({
          taskId: child.taskId, status: child.status, sessionId: child.sessionId,
          runtimeSessionId: child.runtimeSessionId, updatedAt: child.updatedAt,
          ...(child.traceId ? { traceId: child.traceId } : {}),
          ...(child.errorCode ? { errorCode: child.errorCode } : {}),
          ...outcome,
        });
      }
      return { coordinationId: id, children };
    },
    async join(userId, parentRequestId, input = {}, opts = {}) {
      const parentTask = await parent(userId, parentRequestId);
      const id = coordinationId(parentTask.taskId);
      const record = await readCogSeedCoordination(userId, id);
      if (!record) return { coordinationId: id, settled: true, timedOut: false, tasks: [] };
      const requested = Array.isArray(input.taskIds)
        ? input.taskIds.filter((taskId): taskId is string => typeof taskId === 'string')
        : [];
      const wanted = new Set(requested.length ? requested : record.childTaskIds);
      const targets = record.childTaskIds.filter((taskId) => wanted.has(taskId));
      const timeoutMs = Math.min(
        MAX_JOIN_TIMEOUT_MS,
        Math.max(1_000, typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_JOIN_TIMEOUT_MS),
      );
      const deadline = Date.now() + timeoutMs;
      let timedOut = false;
      for (;;) {
        if (opts.signal?.aborted) { timedOut = true; break; }
        const tasks = await Promise.all(targets.map((taskId) => readCogSeedTask(userId, taskId)));
        // A disappeared child is settled: there is nothing left to wait for.
        const pending = tasks.filter((task): task is CogSeedTaskRecord => !!task && !SETTLED_STATUSES.has(task.status));
        if (!pending.length) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { timedOut = true; break; }
        await delay(Math.min(JOIN_POLL_INTERVAL_MS, remaining));
      }
      const resolved: CogSeedJoinedTask[] = [];
      for (const taskId of targets) {
        const task = await readCogSeedTask(userId, taskId);
        if (!task) continue;
        const settled = SETTLED_STATUSES.has(task.status);
        // Preserve the child's last assistant text even on a non-completed
        // stop: a truncated or failed run still carries usable partial output
        // (same rule as the reference runtime's `stopReason` + partial output).
        const outcome = settled ? await readChildOutcome(userId, task) : {};
        resolved.push({
          taskId: task.taskId,
          status: task.status,
          updatedAt: task.updatedAt,
          ...(task.traceId ? { traceId: task.traceId } : {}),
          ...(task.errorCode ? { errorCode: task.errorCode } : {}),
          ...outcome,
          ...(settled ? {} : { timedOut: true }),
        });
      }
      return {
        coordinationId: id,
        settled: resolved.every((task) => !task.timedOut),
        timedOut: timedOut || resolved.some((task) => task.timedOut === true),
        tasks: resolved,
      };
    },
    async cancel(userId, parentRequestId, taskId) {
      const parentTask = await parent(userId, parentRequestId); const record = await readCogSeedCoordination(userId, coordinationId(parentTask.taskId));
      if (!record?.childTaskIds.includes(assertCogSeedTaskId(taskId))) throw new Error('CogSeed task is not linked to this coordination');
      return cancelTask(userId, taskId);
    },
    async cancelChildrenForParent(userId, parentTaskId) {
      const id = coordinationId(assertCogSeedTaskId(parentTaskId));
      const file = cogseedCoordinationFile(userId, id);
      await fileEditLock(file).runExclusive(async () => {
        const record = await readCogSeedCoordination(userId, id); if (!record || record.status === 'cancelled') return;
        for (const childId of record.childTaskIds) {
          const child = await readCogSeedTask(userId, childId);
          if (!child || ['completed', 'cancelled', 'failed'].includes(child.status)) continue;
          try { await cancelTask(userId, childId); }
          catch (error) { log.warn('CogSeed coordination child cancel failed', { error: logErrorRef(error) }); }
        }
        await writeJson(file, { ...record, status: 'cancelled', updatedAt: nowIso() });
      });
    },
  };
}

export const cogseedCoordinator = createCogSeedCoordinator({
  startTask: async (userId, input) => (await import('./runtime-controller')).cogseedRuntimeController.startCogSeedTask(userId, input),
  cancelTask: async (userId, taskId) => (await import('./runtime-controller')).cogseedRuntimeController.cancelCogSeedTask(userId, taskId),
});
