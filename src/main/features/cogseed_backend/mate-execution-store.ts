import * as fs from 'node:fs/promises';

import { appendJsonlAtomic, genId12, nowIso, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { assertMateTaskId, assertMateUserId, mateExecutionEventsFile, mateExecutionRecordFile } from './paths';

export const MATE_EXECUTION_SCHEMA_VERSION = 1 as const;
export type MateExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MateExecutionRecord {
  schemaVersion: typeof MATE_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  taskId: string;
  sessionId: string;
  runtimeSessionId: string;
  ownerId: string;
  kind: 'mate-agent';
  status: MateExecutionStatus;
  boundary: 'real';
  permissionMode: 'cogseed-runtime';
  eventCount?: number;
  toolStartedCount?: number;
  toolFinishedCount?: number;
  modelDeltaCount?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MateExecutionEvent {
  schemaVersion: typeof MATE_EXECUTION_SCHEMA_VERSION;
  eventId: string;
  executionId: string;
  sequence: number;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertExecutionId(executionId: string): string {
  if (!/^mate-exec-[A-Za-z0-9_-]+$/.test(executionId)) throw new Error('invalid CogSeed execution id');
  return executionId;
}

function validateRecord(userId: string, executionId: string, value: unknown): MateExecutionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed execution record');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_EXECUTION_SCHEMA_VERSION || row.ownerId !== userId || row.executionId !== executionId) throw new Error('malformed CogSeed execution record');
  if (row.kind !== 'mate-agent' || row.boundary !== 'real' || row.permissionMode !== 'cogseed-runtime') throw new Error('malformed CogSeed execution record');
  if (typeof row.taskId !== 'string' || typeof row.sessionId !== 'string' || typeof row.runtimeSessionId !== 'string') throw new Error('malformed CogSeed execution record');
  assertMateTaskId(row.taskId);
  if (!String(row.sessionId).startsWith('mate-session-') || !String(row.runtimeSessionId).startsWith('mruntime-')) throw new Error('malformed CogSeed execution record');
  if (typeof row.status !== 'string' || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(row.status)) throw new Error('malformed CogSeed execution record');
  if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('malformed CogSeed execution record');
  return row as unknown as MateExecutionRecord;
}

function validateEvent(userId: string, executionId: string, value: unknown): MateExecutionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed execution event');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_EXECUTION_SCHEMA_VERSION || row.executionId !== executionId) throw new Error('malformed CogSeed execution event');
  if (typeof row.eventId !== 'string' || !row.eventId.startsWith('mate-exec-event-')) throw new Error('malformed CogSeed execution event');
  if (typeof row.sequence !== 'number' || !Number.isInteger(row.sequence) || row.sequence < 1 || typeof row.type !== 'string' || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed execution event');
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw new Error('malformed CogSeed execution event');
  void userId;
  return row as unknown as MateExecutionEvent;
}

export async function read(userId: string, executionId: string): Promise<MateExecutionRecord> {
  assertMateUserId(userId);
  const id = assertExecutionId(executionId);
  try {
    return validateRecord(userId, id, JSON.parse(await fs.readFile(mateExecutionRecordFile(userId, id), 'utf8')));
  } catch (error) {
    if (isEnoent(error)) throw new Error('CogSeed execution record not found');
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed execution record');
    throw error;
  }
}

export async function create(userId: string, input: Omit<MateExecutionRecord, 'schemaVersion' | 'createdAt' | 'updatedAt' | 'completedAt'>): Promise<MateExecutionRecord> {
  assertMateUserId(userId);
  const id = assertExecutionId(input.executionId);
  try { return await read(userId, id); } catch (error) { if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error; }
  const createdAt = nowIso();
  const record: MateExecutionRecord = { ...input, schemaVersion: MATE_EXECUTION_SCHEMA_VERSION, ownerId: userId, createdAt, updatedAt: createdAt };
  await writeJson(mateExecutionRecordFile(userId, id), record);
  return record;
}

async function readEventsUnlocked(userId: string, executionId: string): Promise<MateExecutionEvent[]> {
  const file = mateExecutionEventsFile(userId, executionId);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (isEnoent(error)) return []; throw error; }
  const rows: MateExecutionEvent[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line && index === text.split('\n').length - 1) continue;
    try { rows.push(validateEvent(userId, executionId, JSON.parse(line))); } catch { throw new Error('malformed CogSeed execution event at line ' + (index + 1)); }
  }
  rows.forEach((event, index) => { if (event.sequence !== index + 1) throw new Error('malformed CogSeed execution event sequence'); });
  return rows;
}

export async function appendEvent(userId: string, executionId: string, type: string, payload: Record<string, unknown>): Promise<MateExecutionEvent> {
  assertMateUserId(userId);
  const id = assertExecutionId(executionId);
  await read(userId, id);
  const file = mateExecutionEventsFile(userId, id);
  return fileEditLock(file).runExclusive(async () => {
    const prior = await readEventsUnlocked(userId, id);
    const event: MateExecutionEvent = { schemaVersion: MATE_EXECUTION_SCHEMA_VERSION, eventId: 'mate-exec-event-' + genId12(), executionId: id, sequence: prior.length + 1, type, createdAt: nowIso(), payload: JSON.parse(JSON.stringify(payload)) };
    await appendJsonlAtomic(file, event);
    return event;
  });
}

export async function readEvents(userId: string, executionId: string): Promise<MateExecutionEvent[]> {
  assertMateUserId(userId);
  return readEventsUnlocked(userId, assertExecutionId(executionId));
}

export async function complete(userId: string, executionId: string, status: Exclude<MateExecutionStatus, 'queued' | 'running'>, facts: Pick<MateExecutionRecord, 'eventCount' | 'toolStartedCount' | 'toolFinishedCount' | 'modelDeltaCount'> = {}): Promise<MateExecutionRecord> {
  assertMateUserId(userId);
  const id = assertExecutionId(executionId);
  const file = mateExecutionRecordFile(userId, id);
  return fileEditLock(file).runExclusive(async () => {
    const current = await read(userId, id);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return current;
    const updated: MateExecutionRecord = { ...current, ...facts, status, updatedAt: nowIso(), completedAt: nowIso() };
    await writeJson(file, updated);
    return updated;
  });
}
