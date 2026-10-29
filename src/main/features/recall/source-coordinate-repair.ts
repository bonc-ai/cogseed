/**
 * 旧格式消息引用的坐标补全。
 *
 * 历史流水线写下的 taxonomyVersion 2 消息引用只带内容标识（`msg-<hash>`），
 * 没有 locator，也没有内容版本；来源准入因此读不出它们，只能靠候选链上的
 * 形成证明兜底。候选链同样缺证明时，这些引用永远无法进入可读池。
 *
 * 本模块按记录**自己声明的会话**找回同一条消息并把坐标写回引用：
 *   - 只按内容标识匹配（`sha256(会话 id + 消息 id)` 前缀），不模糊搜索；
 *   - 只写 locator 与 sha256 内容版本，不改正文、不新增或删除任何引用；
 *   - 用户已移除/暂停来源的引用保持原样，等来源恢复后下一轮再补；
 *   - 幂等：数据本身即标记。修好的引用不再命中；空跑只读不写。
 *
 * 与 `asset-source-availability` 的既有口径一致：消息记录只追加、不就地
 * 改写正文（删除只落 tombstone），因此活着的消息文本就是形成时的原文。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';
import { getMessagesPage } from '../chats';
import { isCognitionSourceEnabled } from './source-control';
import { cognitionMessageSourceId } from './source-identity';
import { recallJsonRecordPath } from './paths';
import { createRecallCollectionReader, readRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { CognitionSourceRef } from './source-service';

const log = createLogger('recall.source-coordinates');

type RefArrayField = 'evidenceRefs' | 'sourceRefs';

/** 需要补坐标的集合与各自的引用字段；其余集合不含消息引用。 */
const COLLECTION_REF_FIELDS: ReadonlyArray<{ collection: string; fields: readonly RefArrayField[] }> = [
  { collection: 'ability-assets', fields: ['evidenceRefs'] },
  { collection: 'candidates', fields: ['evidenceRefs', 'sourceRefs'] },
  { collection: 'projections', fields: ['sourceRefs'] },
  { collection: 'views', fields: ['sourceRefs'] },
  { collection: 'asset-handoff-receipts', fields: ['sourceRefs'] },
];

export interface RecallSourceCoordinateRepairStats {
  /** 上一轮已全部补完并落标记，本轮只做标记判断、未扫描。 */
  skipped: boolean;
  scannedRecords: number;
  updatedRecords: number;
  /** 补齐或补全坐标的引用数（无版本→加 locator+版本；缺一件→补缺的那件）。 */
  repairedRefs: number;
  /** 消息已不在可用会话里的引用（删除/会话缺失），保持原样。 */
  unresolvedRefs: number;
  /** 来源被用户移除或暂停的引用，保持原样，来源恢复后重试。 */
  skippedRemovedRefs: number;
  failedRecords: number;
}

/** 补完落标记：残留未决/跳过/失败时为下次启动保留重试，不落标记。 */
const MARKER_COLLECTION = 'capture-settings';
const MARKER_ID = 'source-coordinate-repair-v1';

const isContentVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const textContentVersion = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const isConversationId = (value: string) => /^[0-9a-f]{12}$/.test(value);

function refArray(record: RecallJsonRecord, field: RefArrayField): unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

/** 记录自己声明的会话：sourceSessionIds 与引用里的会话引用（12 位会话 id）。 */
function declaredConversations(record: RecallJsonRecord, fields: readonly RefArrayField[]): string[] {
  const ids = new Set<string>();
  const declared = record.sourceSessionIds;
  if (Array.isArray(declared)) for (const id of declared) if (typeof id === 'string' && isConversationId(id)) ids.add(id);
  for (const field of fields) for (const raw of refArray(record, field)) {
    const ref = raw as CognitionSourceRef | undefined;
    if (ref && typeof ref === 'object' && ref.subtype === 'session' && typeof ref.id === 'string' && isConversationId(ref.id)) ids.add(ref.id);
  }
  return [...ids];
}

/** 一次运行内共享的消息索引：内容标识 → 活消息。只按需加载被引用的会话。 */
function createMessageIndexCache(userId: string) {
  const indexes = new Map<string, Promise<Map<string, { messageId: string; text: string }>>>();
  return (cid: string) => {
    if (!indexes.has(cid)) indexes.set(cid, (async () => {
      const index = new Map<string, { messageId: string; text: string }>();
      let cursor: number | null | undefined;
      do {
        const page = await getMessagesPage(userId, cid, 500, cursor);
        for (const row of page.history) if (typeof row.id === 'string')
          index.set(cognitionMessageSourceId(cid, row.id), { messageId: row.id, text: String(row.text ?? '') });
        cursor = page.nextCursor;
      } while (cursor !== null);
      return index;
    })());
    return indexes.get(cid)!;
  };
}

interface RefPatch { field: RefArrayField; index: number; value: CognitionSourceRef }

async function repairOneRecord(
  userId: string,
  collection: string,
  fields: readonly RefArrayField[],
  record: RecallJsonRecord,
  messageIndex: ReturnType<typeof createMessageIndexCache>,
  stats: RecallSourceCoordinateRepairStats,
): Promise<void> {
  const conversations = declaredConversations(record, fields);
  const patches: RefPatch[] = [];
  for (const field of fields) {
    const refs = refArray(record, field);
    for (const [index, raw] of refs.entries()) {
      const ref = raw as CognitionSourceRef | undefined;
      if (!ref || typeof ref !== 'object' || ref.taxonomyVersion !== 2 || ref.degraded
        || ref.kind !== 'conversation' || ref.subtype !== 'message') continue;
      const locator = ref.locator;
      const hasLocator = !!locator && typeof locator.conversationId === 'string' && locator.conversationId.length > 0
        && typeof locator.messageId === 'string' && locator.messageId.length > 0;
      const hasVersion = isContentVersion(ref.sourceVersion);
      if (hasLocator && hasVersion) continue;

      // 定位：有 locator 就按它取；没有就在记录声明的会话里按内容标识找。
      let found: { cid: string; messageId: string; text: string } | undefined;
      if (hasLocator) {
        const cid = locator!.conversationId as string;
        if (cognitionMessageSourceId(cid, locator!.messageId as string) === ref.id) {
          const hit = (await messageIndex(cid).catch(() => null))?.get(ref.id);
          if (hit) found = { cid, messageId: hit.messageId, text: hit.text };
        }
      } else {
        for (const cid of conversations) {
          const hit = (await messageIndex(cid).catch(() => null))?.get(ref.id);
          if (hit) { found = { cid, messageId: hit.messageId, text: hit.text }; break; }
        }
      }
      if (!found) { stats.unresolvedRefs += 1; continue; }

      if (!await isCognitionSourceEnabled(userId, { kind: 'conversation', id: ref.id,
        locator: { conversationId: found.cid, messageId: found.messageId } })) {
        stats.skippedRemovedRefs += 1;
        continue;
      }
      patches.push({ field, index, value: { ...ref,
        locator: { conversationId: found.cid, messageId: found.messageId },
        sourceVersion: hasVersion ? ref.sourceVersion : textContentVersion(found.text) } });
    }
  }
  if (!patches.length) return;

  const next: RecallJsonRecord = { ...record };
  const byField = new Map<RefArrayField, RefPatch[]>();
  for (const patch of patches) byField.set(patch.field, [...(byField.get(patch.field) || []), patch]);
  for (const [field, fieldPatches] of byField) {
    const refs = [...refArray(record, field)];
    for (const patch of fieldPatches) refs[patch.index] = patch.value;
    next[field] = refs;
  }
  await writeRecallJsonRecord(userId, collection, String(record.id), next);
  stats.updatedRecords += 1;
  stats.repairedRefs += patches.length;
}

async function listRecordIds(userId: string, collection: string, reader: ReturnType<typeof createRecallCollectionReader>): Promise<string[]> {
  if (reader.ids) return reader.ids.filter(safeId);
  const dir = path.dirname(recallJsonRecordPath(userId, collection, 'snapshot'));
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(safeId);
}

/** 对五个集合各跑一遍坐标补全；任何一条记录的失败都不阻断其余记录。 */
export async function repairRecallSourceCoordinates(userId: string): Promise<RecallSourceCoordinateRepairStats> {
  const stats: RecallSourceCoordinateRepairStats = { skipped: false, scannedRecords: 0, updatedRecords: 0,
    repairedRefs: 0, unresolvedRefs: 0, skippedRemovedRefs: 0, failedRecords: 0 };
  if (!safeId(userId)) return stats;
  const marker = await readRecallJsonRecord(userId, MARKER_COLLECTION, MARKER_ID).catch(() => undefined);
  if (marker) {
    stats.skipped = true;
    log.info('source coordinate repair skipped (already clean)', { userId: maskId(userId) });
    return stats;
  }
  const messageIndex = createMessageIndexCache(userId);
  for (const { collection, fields } of COLLECTION_REF_FIELDS) {
    const reader = createRecallCollectionReader(userId, collection);
    for (const id of await listRecordIds(userId, collection, reader)) {
      stats.scannedRecords += 1;
      try {
        const record = await reader.read(id);
        if (record) await repairOneRecord(userId, collection, fields, record, messageIndex, stats);
      } catch (error) {
        stats.failedRecords += 1;
        log.warn('source coordinate repair failed for record', { userId: maskId(userId), collection,
          recordId: maskId(id), error: logErrorRef(error as Error) });
      }
    }
  }
  if (!stats.unresolvedRefs && !stats.skippedRemovedRefs && !stats.failedRecords) {
    await writeRecallJsonRecord(userId, MARKER_COLLECTION, MARKER_ID, { schemaVersion: 1, ownerId: userId,
      id: MARKER_ID, repairedRefs: stats.repairedRefs, repairedAt: new Date().toISOString() } as RecallJsonRecord)
      .catch((error) => log.warn('source coordinate repair marker write failed', { userId: maskId(userId), error: logErrorRef(error as Error) }));
  }
  if (stats.repairedRefs || stats.unresolvedRefs || stats.skippedRemovedRefs || stats.failedRecords) {
    log.info('source coordinate repair finished', { userId: maskId(userId), scannedRecords: stats.scannedRecords,
      updatedRecords: stats.updatedRecords, repairedRefs: stats.repairedRefs, unresolvedRefs: stats.unresolvedRefs,
      skippedRemovedRefs: stats.skippedRemovedRefs, failedRecords: stats.failedRecords });
  }
  return stats;
}