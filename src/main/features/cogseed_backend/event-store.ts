import * as fs from 'node:fs/promises';

import { appendJsonlAtomic, genId12, invalidateLineCount, nowIso } from '../../storage';
import { createLogger } from '../../logger';
import { fileEditLock } from '../../util/locks';
import { logErrorRef } from '../../util/log-redact';
import { assertCogSeedTaskId, assertCogSeedUserId, cogseedTaskEventsFile } from './paths';
import { COGSEED_AGENT_BACKEND_SCHEMA_VERSION, type CogSeedTaskEvent, type CogSeedTaskEventType } from './types';

const MAX_EVENT_PAYLOAD_CHARS = 16_384;
const COGSEED_TASK_EVENT_TYPES = new Set<string>([
  'task.created',
  'task.queued',
  'task.started',
  'task.waiting_user',
  'model.delta',
  'tool.started',
  'tool.finished',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.recoverable',
  'task.archived',
  'artifact',
]);
const log = createLogger('cogseed-backend:event-store');

export interface CogSeedDashboardChange {
  schemaVersion: 1;
  revision: number;
  changeKind: 'task';
  taskId: string;
  sessionId: string;
  occurredAt: string;
  /** A task event invalidates each derived operations-center projection. */
  domains: Array<'tasks' | 'sessions' | 'agents' | 'collaboration'>;
}

type CogSeedDashboardChangeListener = (change: CogSeedDashboardChange) => void;

const dashboardChangeListeners = new Map<string, Set<CogSeedDashboardChangeListener>>();
const dashboardRevisions = new Map<string, number>();

function publishDashboardChange(userId: string, event: CogSeedTaskEvent): void {
  const revision = (dashboardRevisions.get(userId) ?? 0) + 1;
  dashboardRevisions.set(userId, revision);
  const change: CogSeedDashboardChange = {
    schemaVersion: 1,
    revision,
    changeKind: 'task',
    taskId: event.taskId,
    sessionId: event.sessionId,
    occurredAt: event.createdAt,
    domains: ['tasks', 'sessions', 'agents', 'collaboration'],
  };
  for (const listener of dashboardChangeListeners.get(userId) ?? []) {
    try { listener(change); }
    catch (error) { log.warn('CogSeed dashboard change listener failed', { error: logErrorRef(error) }); }
  }
}

export function subscribeCogSeedDashboardChanges(
  userId: string,
  listener: CogSeedDashboardChangeListener,
): () => void {
  assertCogSeedUserId(userId);
  const listeners = dashboardChangeListeners.get(userId) ?? new Set<CogSeedDashboardChangeListener>();
  listeners.add(listener);
  dashboardChangeListeners.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) dashboardChangeListeners.delete(userId);
  };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function validatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid CogSeed event payload');
  let encoded: string;
  try { encoded = JSON.stringify(payload); }
  catch { throw new Error('invalid CogSeed event payload'); }
  if (encoded.length > MAX_EVENT_PAYLOAD_CHARS) throw new Error('CogSeed event payload exceeds limit');
  return JSON.parse(encoded) as Record<string, unknown>;
}

function validateEvent(taskId: string, value: unknown): CogSeedTaskEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed event');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION || row.taskId !== taskId) throw new Error('malformed CogSeed event');
  if (typeof row.eventId !== 'string' || !row.eventId.startsWith('cogseed-event-')) throw new Error('malformed CogSeed event');
  if (typeof row.sessionId !== 'string' || !row.sessionId.startsWith('cogseed-session-')) throw new Error('malformed CogSeed event');
  if (typeof row.sequence !== 'number' || !Number.isInteger(row.sequence) || row.sequence < 1) throw new Error('malformed CogSeed event');
  if (typeof row.type !== 'string' || !COGSEED_TASK_EVENT_TYPES.has(row.type)
    || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed event');
  validatePayload(row.payload as Record<string, unknown>);
  return row as unknown as CogSeedTaskEvent;
}

async function readAllEventsUnlocked(userId: string, taskId: string): Promise<CogSeedTaskEvent[]> {
  const file = cogseedTaskEventsFile(userId, taskId);
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    const tail = bytes.subarray(completeLength).toString('utf8');
    let completeTail = false;
    try {
      completeTail = Boolean(validateEvent(taskId, JSON.parse(tail)));
    } catch {
      // An append interrupted before its newline is the only corruption that
      // can be identified safely. Preserve every complete line and discard
      // only the unterminated tail; malformed terminated/middle rows still
      // fail closed below.
    }
    if (completeTail) {
      await fs.appendFile(file, '\n', 'utf8');
      bytes = Buffer.concat([bytes, Buffer.from('\n')]);
    } else {
      await fs.truncate(file, completeLength);
      bytes = bytes.subarray(0, completeLength);
    }
    invalidateLineCount(file);
    log.warn('Recovered an interrupted CogSeed event append', { task_id: taskId });
  }

  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const events: CogSeedTaskEvent[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!raw && index === lines.length - 1) continue;
    if (!raw.trim()) throw new Error(`malformed CogSeed event at line ${index + 1}`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error(`malformed CogSeed event at line ${index + 1}`); }
    events.push(validateEvent(taskId, parsed));
  }
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) throw new Error('malformed CogSeed event sequence');
  }
  return events;
}

export async function appendCogSeedTaskEvent(
  userId: string,
  taskId: string,
  sessionId: string,
  type: CogSeedTaskEventType,
  payload: Record<string, unknown>,
): Promise<CogSeedTaskEvent> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  if (!sessionId.startsWith('cogseed-session-')) throw new Error('invalid CogSeed session id');
  const file = cogseedTaskEventsFile(userId, taskId);
  const event = await fileEditLock(file).runExclusive(async () => {
    const prior = await readAllEventsUnlocked(userId, taskId);
    const event: CogSeedTaskEvent = {
      schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
      eventId: `cogseed-event-${genId12()}`,
      taskId,
      sessionId,
      sequence: prior.length + 1,
      type,
      createdAt: nowIso(),
      payload: validatePayload(payload),
    };
    await appendJsonlAtomic(file, event);
    return event;
  });
  publishDashboardChange(userId, event);
  return event;
}

export async function readCogSeedTaskEvents(
  userId: string,
  taskId: string,
  afterSequence = 0,
  limit = 200,
): Promise<CogSeedTaskEvent[]> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const after = Math.max(0, Math.floor(Number(afterSequence) || 0));
  const max = Math.max(1, Math.min(Math.floor(Number(limit) || 1), 500));
  const file = cogseedTaskEventsFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => (
    (await readAllEventsUnlocked(userId, taskId))
      .filter((event) => event.sequence > after)
      .slice(0, max)
  ));
}
