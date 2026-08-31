import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { kstarEpisodePath, kstarRecordPath } from './paths';
import {
  KSTAR_SCHEMA_VERSION,
  type KstarEpisodeRecord,
  type KstarJsonRecord,
} from './types';

const log = createLogger('kstar.episode-store');

function assertPlainObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`malformed ${context}: expected object`);
  }
}

function validateBaseRecord(
  userId: string,
  recordId: string,
  value: unknown,
  context: string,
): KstarJsonRecord {
  assertPlainObject(value, context);
  if (!Number.isInteger(value.schemaVersion)) {
    throw new Error(`malformed ${context}: schemaVersion is required`);
  }
  if ((value.schemaVersion as number) > KSTAR_SCHEMA_VERSION) {
    throw new Error(`future schema ${context}: ${value.schemaVersion}`);
  }
  if (value.schemaVersion !== KSTAR_SCHEMA_VERSION) {
    throw new Error(`malformed ${context}: unsupported schemaVersion ${value.schemaVersion}`);
  }
  if (value.ownerId !== userId) throw new Error(`kstar owner mismatch: expected ${userId}`);
  if (value.id !== recordId) throw new Error(`kstar id mismatch: expected ${recordId}`);
  if (!safeId(value.id)) throw new Error('invalid kstar record id');
  return value as KstarJsonRecord;
}

function validateEpisode(userId: string, episodeId: string, value: unknown): KstarEpisodeRecord {
  const record = validateBaseRecord(userId, episodeId, value, 'kstar episode');
  assertPlainObject(record.k, 'kstar episode K');
  assertPlainObject(record.s, 'kstar episode S');
  assertPlainObject(record.t, 'kstar episode T');
  assertPlainObject(record.a, 'kstar episode A');
  assertPlainObject(record.r, 'kstar episode R');
  if (
    typeof record.sessionId !== 'string' || !record.sessionId ||
    typeof record.t.userGoal !== 'string' || !record.t.userGoal ||
    !Array.isArray(record.k.memoryRefs) ||
    !Array.isArray(record.k.contextRefs) ||
    !Array.isArray(record.k.abilityAssetRefs) ||
    !Array.isArray(record.t.constraints) ||
    !Array.isArray(record.a.toolCalls) ||
    !Array.isArray(record.a.agentActions) ||
    !Array.isArray(record.r.producedFiles) ||
    !Array.isArray(record.evidenceRefs) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !['completed', 'failed', 'cancelled', 'timed_out', 'waiting_input'].includes(String(record.r.status))
  ) {
    throw new Error('malformed kstar episode');
  }
  return record as KstarEpisodeRecord;
}

async function readJsonFile(filePath: string, context: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`malformed ${context}: invalid JSON`);
  }
}

export async function readKstarJsonRecord(
  userId: string,
  collection: string,
  recordId: string,
): Promise<KstarJsonRecord | null> {
  const raw = await readJsonFile(kstarRecordPath(userId, collection, recordId), `kstar ${collection} record`);
  return raw === null ? null : validateBaseRecord(userId, recordId, raw, `kstar ${collection} record`);
}

export async function writeKstarJsonRecord<T extends KstarJsonRecord>(
  userId: string,
  collection: string,
  record: T,
): Promise<T> {
  const validated = validateBaseRecord(userId, record.id, record, `kstar ${collection} record`) as T;
  const recordPath = kstarRecordPath(userId, collection, record.id);
  return fileEditLock(recordPath).runExclusive(async () => {
    const existing = await readJsonFile(recordPath, `kstar ${collection} record`);
    if (existing !== null) {
      const owned = validateBaseRecord(userId, record.id, existing, `kstar ${collection} record`) as T;
      if (JSON.stringify(owned) !== JSON.stringify(validated)) {
        throw new Error(`kstar ${collection} record conflict`);
      }
      return owned;
    }
    await writeJson(recordPath, validated);
    return validated;
  });
}

export async function replaceKstarJsonRecord<T extends KstarJsonRecord>(
  userId: string,
  collection: string,
  record: T,
): Promise<T> {
  const validated = validateBaseRecord(userId, record.id, record, `kstar ${collection} record`) as T;
  const recordPath = kstarRecordPath(userId, collection, record.id);
  return fileEditLock(recordPath).runExclusive(async () => {
    await writeJson(recordPath, validated);
    return validated;
  });
}

export async function listKstarJsonRecords(
  userId: string,
  collection: string,
): Promise<KstarJsonRecord[]> {
  const dir = path.dirname(kstarRecordPath(userId, collection, 'placeholder'));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: KstarJsonRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!safeId(id)) continue;
    try {
      const record = await readKstarJsonRecord(userId, collection, id);
      if (record) records.push(record);
    } catch (error) {
      log.warn('skipping degraded kstar record', {
        collection,
        recordId: id,
        error: (error as Error).message,
      });
    }
  }
  return records;
}

export async function readKstarEpisode(userId: string, episodeId: string): Promise<KstarEpisodeRecord | null> {
  const raw = await readJsonFile(kstarEpisodePath(userId, episodeId), 'kstar episode');
  return raw === null ? null : validateEpisode(userId, episodeId, raw);
}

export async function writeKstarEpisode(
  userId: string,
  episode: KstarEpisodeRecord,
): Promise<KstarEpisodeRecord> {
  validateEpisode(userId, episode.id, episode);
  await writeKstarJsonRecord(userId, 'episodes', episode);
  return episode;
}

export async function listKstarEpisodes(userId: string): Promise<KstarEpisodeRecord[]> {
  const records = await listKstarJsonRecords(userId, 'episodes');
  const episodes: KstarEpisodeRecord[] = [];
  for (const record of records) {
    try {
      episodes.push(validateEpisode(userId, record.id, record));
    } catch (error) {
      log.warn('skipping degraded kstar episode', {
        episodeId: record.id,
        error: (error as Error).message,
      });
    }
  }
  return episodes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
