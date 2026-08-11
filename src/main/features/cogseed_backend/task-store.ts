import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { appendMateTaskEvent } from './event-store';
import { fileEditLock } from '../../util/locks';
import {
  assertMateRequestId,
  assertMateCoordinationId,
  assertMateTaskId,
  assertMateUserId,
  mateRequestClaimFile,
  mateTaskFile,
  mateTasksDirectory,
} from './paths';
import { getOrCreateMateSession, readMateSession, listMateSessions } from './session-store';
import {
  MATE_AGENT_BACKEND_SCHEMA_VERSION,
  type MateRequestClaim,
  type MateSessionRecord,
  type MateTaskRecord,
} from './types';

export { getOrCreateMateSession, readMateSession, listMateSessions } from './session-store';

export interface CreateMateTaskInput {
  requestId: string;
  task: string;
  sessionId?: string;
  profileId?: string;
  retryOfTaskId?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
}

export interface CreateMateTaskResult {
  task: MateTaskRecord;
  created: boolean;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function validateTask(userId: string, value: unknown, expectedTaskId?: string): MateTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed task');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION) throw new Error('unsupported CogSeed task schema');
  if (row.ownerId !== userId) throw new Error('CogSeed task owner mismatch');
  if (typeof row.taskId !== 'string') throw new Error('malformed CogSeed task');
  assertMateTaskId(row.taskId);
  if (expectedTaskId && row.taskId !== expectedTaskId) throw new Error('CogSeed task id mismatch');
  if (typeof row.sessionId !== 'string' || typeof row.runtimeSessionId !== 'string' || typeof row.requestId !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  if (!row.runtimeSessionId.startsWith('mruntime-')) throw new Error('malformed CogSeed task');
  if (row.executionId !== undefined && (typeof row.executionId !== 'string' || !row.executionId.startsWith('mate-exec-'))) throw new Error('malformed CogSeed task');
  if (row.runtimeRunId !== undefined && (typeof row.runtimeRunId !== 'string' || !row.runtimeRunId.startsWith('run_'))) throw new Error('malformed CogSeed task');
  if (row.runtimeWorkerId !== undefined && (typeof row.runtimeWorkerId !== 'string' || !row.runtimeWorkerId.startsWith('mate-worker-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationId !== undefined && (typeof row.coordinationId !== 'string' || !row.coordinationId.startsWith('mate-coord-'))) throw new Error('malformed CogSeed task');
  if (row.parentTaskId !== undefined && (typeof row.parentTaskId !== 'string' || !row.parentTaskId.startsWith('mate-task-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationDepth !== undefined && (!Number.isInteger(row.coordinationDepth) || Number(row.coordinationDepth) < 1)) throw new Error('malformed CogSeed task');
  assertMateRequestId(row.requestId);
  if (row.lastResumeRequestId !== undefined) assertMateRequestId(String(row.lastResumeRequestId));
  if (typeof row.task !== 'string' || typeof row.status !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  return row as unknown as MateTaskRecord;
}

function validateClaim(userId: string, requestId: string, value: unknown): MateRequestClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed request claim');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION || row.ownerId !== userId || row.requestId !== requestId) {
    throw new Error('malformed CogSeed request claim');
  }
  if (typeof row.taskId !== 'string' || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed request claim');
  assertMateTaskId(row.taskId);
  return row as unknown as MateRequestClaim;
}

export async function readMateTask(userId: string, taskId: string): Promise<MateTaskRecord | null> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  try {
    const text = await fs.readFile(mateTaskFile(userId, taskId), 'utf8');
    return validateTask(userId, JSON.parse(text), taskId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed task');
    throw error;
  }
}

export async function updateMateTask(
  userId: string,
  taskId: string,
  mutate: (current: MateTaskRecord) => MateTaskRecord | Promise<MateTaskRecord>,
): Promise<MateTaskRecord> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  const file = mateTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readMateTask(userId, taskId);
    if (!current) throw new Error('CogSeed task not found');
    const next = await mutate(current);
    const validated = validateTask(userId, next, taskId);
    await writeJson(file, validated);
    return validated;
  });
}


export async function readMateTaskByRequestId(userId: string, requestId: string): Promise<MateTaskRecord | null> {
  assertMateUserId(userId);
  const claimFile = mateRequestClaimFile(userId, assertMateRequestId(requestId));
  try {
    const claim = validateClaim(userId, requestId, JSON.parse(await fs.readFile(claimFile, 'utf8')));
    return readMateTask(userId, claim.taskId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
    throw error;
  }
}

export async function listMateTasks(userId: string): Promise<MateTaskRecord[]> {
  assertMateUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(mateTasksDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const tasks: MateTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const taskId = entry.name.slice(0, -'.json'.length);
    tasks.push(await readMateTask(userId, taskId).then((task) => { if (!task) throw new Error('CogSeed task disappeared during recovery'); return task; }));
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createMateTask(userId: string, input: CreateMateTaskInput): Promise<CreateMateTaskResult> {
  assertMateUserId(userId);
  const requestId = assertMateRequestId(String(input.requestId || ''));
  const task = String(input.task || '').trim();
  if (!task) throw new Error('CogSeed task is required');
  const claimFile = mateRequestClaimFile(userId, requestId);

  return fileEditLock(claimFile).runExclusive(async () => {
    try {
      const claimText = await fs.readFile(claimFile, 'utf8');
      const claim = validateClaim(userId, requestId, JSON.parse(claimText));
      const existing = await readMateTask(userId, claim.taskId);
      if (!existing) throw new Error('CogSeed request claim references a missing task');
      return { task: existing, created: false };
    } catch (error) {
      if (!isEnoent(error)) {
        if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
        throw error;
      }
    }

    const session: MateSessionRecord = await getOrCreateMateSession(userId, input.sessionId);
    const createdAt = nowIso();
    const taskRecord: MateTaskRecord = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      taskId: `mate-task-${genId12()}`,
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      executionId: 'mate-exec-' + genId12(),
      requestId,
      ownerId: userId,
      status: 'created',
      task,
      ...(input.profileId ? { profileId: String(input.profileId) } : {}),
      ...(input.retryOfTaskId ? { retryOfTaskId: assertMateTaskId(String(input.retryOfTaskId)) } : {}),
      ...(input.coordinationId ? { coordinationId: assertMateCoordinationId(String(input.coordinationId)) } : {}),
      ...(input.parentTaskId ? { parentTaskId: assertMateTaskId(String(input.parentTaskId)) } : {}),
      ...(input.coordinationDepth !== undefined ? { coordinationDepth: (() => { const depth = Number(input.coordinationDepth); if (!Number.isInteger(depth) || depth < 1) throw new Error('invalid CogSeed coordination depth'); return depth; })() } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    const claim: MateRequestClaim = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      requestId,
      taskId: taskRecord.taskId,
      ownerId: userId,
      createdAt,
    };
    await writeJson(mateTaskFile(userId, taskRecord.taskId), taskRecord);
    await writeJson(claimFile, claim);
    await appendMateTaskEvent(userId, taskRecord.taskId, taskRecord.sessionId, 'task.created', { requestId });
    return { task: taskRecord, created: true };
  });
}
