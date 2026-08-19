import * as fs from 'node:fs/promises';

import { appendJsonlAtomic, genId12, nowIso } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { assertCogSeedTaskId, assertCogSeedUserId, cogseedTaskEventsFile } from './paths';
import { COGSEED_AGENT_BACKEND_SCHEMA_VERSION, type CogSeedTaskEvent, type CogSeedTaskEventType } from './types';

const MAX_EVENT_PAYLOAD_CHARS = 16_384;

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

function validateEvent(userId: string, taskId: string, value: unknown): CogSeedTaskEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed event');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION || row.taskId !== taskId) throw new Error('malformed CogSeed event');
  if (typeof row.eventId !== 'string' || !row.eventId.startsWith('cogseed-event-')) throw new Error('malformed CogSeed event');
  if (typeof row.sessionId !== 'string' || !row.sessionId.startsWith('cogseed-session-')) throw new Error('malformed CogSeed event');
  if (typeof row.sequence !== 'number' || !Number.isInteger(row.sequence) || row.sequence < 1) throw new Error('malformed CogSeed event');
  if (typeof row.type !== 'string' || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed event');
  validatePayload(row.payload as Record<string, unknown>);
  return row as unknown as CogSeedTaskEvent;
}

async function readAllEvents(userId: string, taskId: string): Promise<CogSeedTaskEvent[]> {
  const file = cogseedTaskEventsFile(userId, taskId);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const lines = text.split('\n');
  const events: CogSeedTaskEvent[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!raw && index === lines.length - 1) continue;
    if (!raw.trim()) throw new Error(`malformed CogSeed event at line ${index + 1}`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error(`malformed CogSeed event at line ${index + 1}`); }
    events.push(validateEvent(userId, taskId, parsed));
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
  return fileEditLock(file).runExclusive(async () => {
    const prior = await readAllEvents(userId, taskId);
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
  return (await readAllEvents(userId, taskId)).filter((event) => event.sequence > after).slice(0, max);
}
