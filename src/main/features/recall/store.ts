import * as fs from 'node:fs/promises';

import { appendJsonlAtomic, removeJsonlRecords, safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { notifyCognitionWrite } from './store-events';
import {
  recallJsonRecordPath,
  recallJsonlPath,
  recallMigrationsPath,
} from './paths';
import {
  RECALL_SCHEMA_VERSION,
  type RecallJsonRecord,
  type RecallJsonRecordUpdater,
  type RecallMigrationMarker,
} from './types';

export { RECALL_SCHEMA_VERSION } from './types';

const STORE_MIGRATION_ID = 'recall-store-v1';
const MIGRATIONS_RECORD_ID = 'recall-migrations';

function assertSafeRecordId(value: string): void {
  if (!safeId(value)) throw new Error('invalid recall record id');
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('malformed recall record: expected object');
  }
}

function validateRecallRecord(
  userId: string,
  recordId: string,
  value: unknown,
  context = 'recall record',
): RecallJsonRecord {
  assertSafeRecordId(recordId);
  assertPlainObject(value);

  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) {
    throw new Error(`malformed ${context}: schemaVersion is required`);
  }
  if (value.schemaVersion > RECALL_SCHEMA_VERSION) {
    throw new Error(`future schema ${context}: ${value.schemaVersion}`);
  }
  if (value.schemaVersion < 1) {
    throw new Error(`malformed ${context}: unsupported schemaVersion ${value.schemaVersion}`);
  }
  if (typeof value.ownerId !== 'string') {
    throw new Error(`malformed ${context}: ownerId is required`);
  }
  if (value.ownerId !== userId) {
    throw new Error(`recall owner mismatch: expected ${userId}`);
  }
  if (typeof value.id !== 'string') {
    throw new Error(`malformed ${context}: id is required`);
  }
  if (value.id !== recordId) {
    throw new Error(`recall id mismatch: expected ${recordId}`);
  }
  if (!safeId(value.id)) {
    throw new Error('invalid recall record id');
  }

  return value as RecallJsonRecord;
}

async function readExistingRecallRecord(
  userId: string,
  recordPath: string,
  recordId: string,
  context = 'recall record',
): Promise<RecallJsonRecord | undefined> {
  let rawText: string;
  try {
    rawText = await fs.readFile(recordPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error(`malformed ${context}: invalid JSON`);
  }

  return validateRecallRecord(userId, recordId, raw, context);
}

export async function readRecallJsonRecord(
  userId: string,
  collection: string,
  recordId: string,
): Promise<RecallJsonRecord | undefined> {
  const recordPath = recallJsonRecordPath(userId, collection, recordId);
  return readExistingRecallRecord(userId, recordPath, recordId);
}

export async function writeRecallJsonRecord(
  userId: string,
  collection: string,
  recordId: string,
  record: RecallJsonRecord,
): Promise<RecallJsonRecord> {
  const recordPath = recallJsonRecordPath(userId, collection, recordId);
  const validated = await fileEditLock(recordPath).runExclusive(async () => {
    await readExistingRecallRecord(userId, recordPath, recordId);
    const result = validateRecallRecord(userId, recordId, record);
    await writeJson(recordPath, result);
    return result;
  });
  notifyCognitionWrite(userId, collection, 'write', recordId);
  return validated;
}

export async function updateRecallJsonRecord(
  userId: string,
  collection: string,
  recordId: string,
  updater: RecallJsonRecordUpdater,
): Promise<RecallJsonRecord> {
  const recordPath = recallJsonRecordPath(userId, collection, recordId);
  const validated = await fileEditLock(recordPath).runExclusive(async () => {
    const current = await readExistingRecallRecord(userId, recordPath, recordId);
    const next = await updater(current);
    const result = validateRecallRecord(userId, recordId, next);
    await writeJson(recordPath, result);
    return result;
  });
  notifyCognitionWrite(userId, collection, 'update', recordId);
  return validated;
}

export async function appendRecallJsonlRecord(
  userId: string,
  collection: string,
  stream: string,
  record: RecallJsonRecord,
): Promise<RecallJsonRecord> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  const recordId = typeof record?.id === 'string' ? record.id : '';
  const validated = validateRecallRecord(userId, recordId, record);
  await appendJsonlAtomic(streamPath, validated);
  notifyCognitionWrite(userId, collection, 'append', recordId || undefined);
  return validated;
}

/**
 * 删除整条 JSONL 流。
 *
 * 只为「彻底清除」而存在：规范 22.1 要求删掉内容与版本，而版本快照里同样有正文，
 * 留着就不算清除干净。除此之外没有理由调用它——普通删除走状态位，不动历史。
 *
 * 流不存在视为已达成目标，不报错：清除要可重入，半路失败后重试不该被绊住。
 */
export async function removeRecallJsonlStream(
  userId: string,
  collection: string,
  stream: string,
): Promise<void> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  try {
    await fs.rm(streamPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  notifyCognitionWrite(userId, collection, 'remove');
}

/**
 * 从 JSONL 流中物理移除记录（真删，2026-09-17 版本删除）。与 append 共享
 * 同一把行锁，整文件临时写+原子改名回写；全部记录被移除时直接删掉流文件。
 * 与 removeRecallJsonlStream 的分工：那是删整条流（彻底清除资产），这是按
 * 记录粒度删（删除单个版本、清理链按 assetId 摘除引用）。
 *
 * 流不存在视为已达成目标（与 removeRecallJsonlStream 同口径）：清理链要可
 * 重入——一条从未产生过使用记录的新资产被彻底清除时，"这里本来就没有东西"
 * 不该让整次清除失败。返回保留/移除条数供调用方观测。
 */
export async function removeRecallJsonlRecords(
  userId: string,
  collection: string,
  stream: string,
  keep: (record: RecallJsonRecord) => boolean,
): Promise<{ kept: number; removed: number }> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  if (!(await fileExists(streamPath))) return { kept: 0, removed: 0 };
  const result = await removeJsonlRecords(streamPath, keep);
  if (result.removed > 0) notifyCognitionWrite(userId, collection, 'remove');
  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listRecallJsonlRecords(
  userId: string,
  collection: string,
  stream: string,
  limit = 200,
): Promise<RecallJsonRecord[]> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  let rawText: string;
  try {
    rawText = await fs.readFile(streamPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const context = `recall JSONL ${collection}/${stream}`;
  if (rawText === '') return [];

  const wanted = Math.floor(Number(limit));
  const useTailLimit = Number.isFinite(wanted) && wanted > 0;
  const records: RecallJsonRecord[] = [];
  let ringNext = 0;
  const lines = rawText.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line === '' && index === lines.length - 1 && rawText.endsWith('\n')) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      throw new Error(`${context} line ${index + 1}: blank line`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error(`${context} line ${index + 1}: invalid JSON`);
    }

    const recordId = typeof (raw as Record<string, unknown> | undefined)?.id === 'string'
      ? String((raw as Record<string, unknown>).id)
      : '';
    let validated: RecallJsonRecord;
    try {
      validated = validateRecallRecord(userId, recordId, raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${context} line ${index + 1}: ${message}`);
    }

    if (!useTailLimit) {
      records.push(validated);
    } else if (records.length < wanted) {
      records.push(validated);
    } else {
      records[ringNext] = validated;
      ringNext = (ringNext + 1) % wanted;
    }
  }

  if (!useTailLimit || records.length < wanted) return records;
  return records.slice(ringNext).concat(records.slice(0, ringNext));
}

function validateMigrationMarker(userId: string, value: unknown): RecallMigrationMarker {
  const record = validateRecallRecord(userId, MIGRATIONS_RECORD_ID, value, 'recall migration marker');
  if (!record.applied || typeof record.applied !== 'object' || Array.isArray(record.applied)) {
    throw new Error('malformed recall migration marker: applied is required');
  }
  for (const [migrationId, appliedAt] of Object.entries(record.applied)) {
    if (typeof appliedAt !== 'string') {
      throw new Error(`malformed recall migration marker: applied ${migrationId} must be a string`);
    }
  }
  return record as RecallMigrationMarker;
}

export async function migrateRecallStore(userId: string): Promise<RecallMigrationMarker> {
  const markerPath = recallMigrationsPath(userId);
  return fileEditLock(markerPath).runExclusive(async () => {
    const existing = await readExistingRecallRecord(
      userId,
      markerPath,
      MIGRATIONS_RECORD_ID,
      'recall migration marker',
    );
    if (existing) {
      const marker = validateMigrationMarker(userId, existing);
      if (marker.applied[STORE_MIGRATION_ID]) return marker;
      const updated: RecallMigrationMarker = {
        ...marker,
        applied: {
          ...marker.applied,
          [STORE_MIGRATION_ID]: new Date().toISOString(),
        },
      };
      await writeJson(markerPath, updated);
      return updated;
    }

    const marker: RecallMigrationMarker = {
      schemaVersion: RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: MIGRATIONS_RECORD_ID,
      applied: { [STORE_MIGRATION_ID]: new Date().toISOString() },
    };
    await writeJson(markerPath, marker);
    return marker;
  });
}
