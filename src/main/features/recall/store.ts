import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { organizationContentAssetIds, purgedOrganizationRecord, contentPurgedError } from './organization-content-lifecycle';
import { assertReportContentWrite } from './report-content-lifecycle';
import { withPendingAssetVersion } from './asset-version-journal';
import { isManagedCognitionCollection, readUnifiedCognitionRecord, readUnifiedCognitionCollection, persistCognitionSource, withCognitionTransition } from '../cognition_bridge';

import { appendJsonlAtomic, removeJsonlRecords, removeJsonlStream, safeId, writeJson } from '../../storage';
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
  // Absence and corruption are different failures: callers retry or skip a
  // missing row, but a corrupt row needs repair.
  if (value === undefined || value === null) throw new Error(`missing ${context}: record is absent`);
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
  const unified = readUnifiedCognitionRecord(userId, collection, recordId);
  if (unified.authoritative) return unified.record ? validateRecallRecord(userId, recordId, unified.record) : undefined;
  return readExistingRecallRecord(userId, recordPath, recordId);
}

/** A list reads the unified file once, while retaining per-record validation and legacy IO errors. */
export function createRecallCollectionReader(userId: string, collection: string) {
  // Validate the scope before reading the main file, including empty collections.
  recallJsonRecordPath(userId, collection, 'snapshot');
  const snapshot = readUnifiedCognitionCollection(userId, collection);
  return {
    ids: snapshot.authoritative ? Object.keys(snapshot.records) : undefined,
    async read(recordId: string): Promise<RecallJsonRecord | undefined> {
      const file = recallJsonRecordPath(userId, collection, recordId);
      if (!snapshot.authoritative) return readExistingRecallRecord(userId, file, recordId);
      const record = Object.hasOwn(snapshot.records, recordId) ? snapshot.records[recordId] : undefined;
      return record ? validateRecallRecord(userId, recordId, record) : undefined;
    },
  };
}

/** Explicit cleanup of obsolete, untouched manual waits. Never removes a
 * conversation, a candidate, a processed capture or a managed cognition record. */
export async function discardUnstartedRecallCaptureWait(userId: string, recordId: string): Promise<boolean> {
  const recordPath = recallJsonRecordPath(userId, 'captures', recordId);
  const removed = await fileEditLock(recordPath).runExclusive(async () => {
    const current = await readRecallJsonRecord(userId, 'captures', recordId);
    if (!current) return false;
    if (current.status !== 'waiting_manual' || current.executionPolicy !== 'manual'
      || !Array.isArray(current.candidateIds) || current.candidateIds.length
      || current.startedAt || current.stage || current.writingCandidateId || current.promotedAssetId) {
      throw new Error('only an untouched manual capture wait can be discarded');
    }
    await fs.unlink(recordPath);
    return true;
  });
  if (removed) notifyCognitionWrite(userId, 'captures', 'remove', recordId);
  return removed;
}

export async function writeRecallJsonRecord(
  userId: string,
  collection: string,
  recordId: string,
  record: RecallJsonRecord,
): Promise<RecallJsonRecord> {
  const recordPath = recallJsonRecordPath(userId, collection, recordId);
  const work = () => fileEditLock(recordPath).runExclusive(async () => {
    const current = await readRecallJsonRecord(userId, collection, recordId);
    await assertOrganizationContentWrite(userId, collection, current, record);
    const result = validateRecallRecord(userId, recordId, collection === 'ability-assets' ? withPendingAssetVersion(current, record) : record);
    if (isManagedCognitionCollection(collection)) await persistCognitionSource(userId, collection, recordId, result, () => writeJson(recordPath, result));
    else await writeJson(recordPath, result);
    return result;
  });
  const validated = await (isManagedCognitionCollection(collection) || ['stock-organization', 'asset-approvals', 'cleanup-reports', 'inspection-runs'].includes(collection) ? withCognitionTransition(userId, work) : work());
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
  const work = () => fileEditLock(recordPath).runExclusive(async () => {
    const current = await readRecallJsonRecord(userId, collection, recordId);
    const next = await updater(current);
    await assertOrganizationContentWrite(userId, collection, current, next);
    const result = validateRecallRecord(userId, recordId, collection === 'ability-assets' ? withPendingAssetVersion(current, next) : next);
    if (isManagedCognitionCollection(collection)) await persistCognitionSource(userId, collection, recordId, result, () => writeJson(recordPath, result));
    else await writeJson(recordPath, result);
    return result;
  });
  const validated = await (isManagedCognitionCollection(collection) || ['stock-organization', 'asset-approvals', 'cleanup-reports', 'inspection-runs'].includes(collection) ? withCognitionTransition(userId, work) : work());
  notifyCognitionWrite(userId, collection, 'update', recordId);
  return validated;
}

/** Called inside the transition and record locks. Purge and every organization
 * checkpoint therefore agree on asset liveness before persisting text. */
async function assertOrganizationContentWrite(
  userId: string, collection: string, current: RecallJsonRecord | undefined, next: RecallJsonRecord,
): Promise<void> {
  if (collection === 'cleanup-reports' || collection === 'inspection-runs') {
    await assertReportContentWrite(collection, current, next, async id => (await readRecallJsonRecord(userId, 'ability-assets', id))?.status === 'purged');
    return;
  }
  if (!['candidates', 'stock-organization', 'asset-approvals'].includes(collection)) return;
  if (current?.contentPurgedAt) {
    if (!isDeepStrictEqual(current, next)) throw contentPurgedError();
    return;
  }
  const ids = new Set([...organizationContentAssetIds(next), ...(current ? organizationContentAssetIds(current) : [])]);
  let purged = false;
  for (const id of ids) {
    if ((await readRecallJsonRecord(userId, 'ability-assets', id))?.status === 'purged') { purged = true; break; }
  }
  if (next.contentPurgedAt !== undefined) {
    if (!current || !purged || typeof next.contentPurgedAt !== 'string' || !Number.isFinite(Date.parse(next.contentPurgedAt))
      || !isDeepStrictEqual(next, purgedOrganizationRecord(collection, current, next.contentPurgedAt))) throw contentPurgedError();
  } else if (purged) throw contentPurgedError();
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
  // 版本流追加前复核 purged 状态，拒绝清除后的迟到写入，防止正文复活。
  // 强互斥仍在 asset-service 的主记录锁内（先锁→复核终态→追加）；这里不取
  // 记录锁——合法调用方（appendAbilityAssetVersionLine）已持锁，重复加锁会
  // 死锁。本闸只做锁外快照复核，拦迟到的重放/后台补写。
  if (collection === 'ability-asset-versions') {
    const asset = await readRecallJsonRecord(userId, 'ability-assets', stream);
    if (asset?.status === 'purged') {
      throw new Error('ability asset has been purged; version append refused');
    }
  }
  // 防拼接：流尾撕裂半行（云同步冲突/崩溃截断）时先补换行隔离再追加，
  // 新记录不拼进坏行（坏行吞掉下一条合法记录）；撕裂字节原样保留，读侧
  // listRecallJsonlRecords 逐行降级跳过。注意是「拒绝拼接」而不是「拒绝写入」：
  // 资产内容更新在追加版本前已 bump 主记录版本号，写侧死拒会把「记录已 v3、
  // 流里无 v3」的半提交固化且产品内无出路。
  await appendJsonlAtomic(streamPath, validated, { repairTornTail: true });
  notifyCognitionWrite(userId, collection, 'append', recordId || undefined);
  return validated;
}

/**
 * 删除整条 JSONL 流。
 *
 * 用于「彻底清除」：版本快照含有正文，须与内容记录一同移除。
 * 普通删除修改状态位，保留历史。
 *
 * 流不存在视为已达成目标，不报错：清除要可重入，半路失败后重试不该被绊住。
 *
 * 物理互斥：删除走 removeJsonlStream——与 appendJsonlAtomic
 * 共享同一把行锁并失效行数缓存，排队中的在途 append 不会再于 rm 之后重建
 * 流文件（purged 资产的版本快照复活窗口）。记录层的互斥（追加侧锁内复核）
 * 在 asset-service 的版本追加收口处，两层合起来才是完整防线。
 */
export async function removeRecallJsonlStream(
  userId: string,
  collection: string,
  stream: string,
): Promise<void> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  const { existed } = await removeJsonlStream(streamPath);
  if (!existed) return;
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
  options?: { dropMalformedLines?: boolean },
): Promise<{ kept: number; removed: number; droppedMalformed?: number }> {
  const streamPath = recallJsonlPath(userId, collection, stream);
  if (!(await fileExists(streamPath))) return { kept: 0, removed: 0 };
  const result = await removeJsonlRecords(streamPath, keep, options);
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
  options?: { skipMalformedLines?: boolean },
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

  // 默认路径遇到坏行时拒绝整流读取——kstar 证据流
  // 的 fail-closed 契约不变（「证据不可读」与「证据缺失」必须可区分）。仅
  // ability-asset-versions / ability-asset-audit 两个非证据判定流（版本链/台账：
  // 展示与幂等重放语义）由调用方显式传 skipMalformedLines，坏行只作废它自己；
  // 破坏性重写（removeJsonlRecords）默认仍严格，purge 级联另走 dropMalformedLines
  // 显式 opt-in。
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
      if (options?.skipMalformedLines) continue;
      throw new Error(`${context} line ${index + 1}: blank line`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      if (options?.skipMalformedLines) continue;
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
