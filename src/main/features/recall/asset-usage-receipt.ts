import { createHash } from 'node:crypto';

import { nowIso, safeId } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { readInjectionReceipt } from './injection-receipt';
import { recallJsonlPath } from './paths';
import {
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
} from './source-service';
import { appendRecallJsonlRecord, listRecallJsonlRecords } from './store';
import type { RecallJsonRecord } from './types';

export type AssetUsageStatus =
  | 'applied'
  | 'considered_not_applicable'
  | 'available_no_opportunity'
  | 'contradicted'
  | 'usage_unknown';

export type AssetUsageEvidenceKind = 'tool_call' | 'agent_action' | 'artifact' | 'final_output' | 'none';
export type AssetUsageBoundary = 'real' | 'degraded' | 'test-double';

export interface AssetUsageReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  projectionId: string;
  assetId: string;
  assetVersion: string;
  injectionReceiptId: string;
  status: AssetUsageStatus;
  evidenceRefs: CognitionSourceRef[];
  evidenceKind: AssetUsageEvidenceKind;
  boundary: AssetUsageBoundary;
  reason?: string;
  createdAt: string;
}

export interface RecordAssetUsageReceiptInput {
  taskRunId: string;
  projectionId: string;
  assetId: string;
  assetVersion: string;
  injectionReceiptId: string;
  status: AssetUsageStatus;
  evidenceRefs?: unknown[];
  evidenceKind: AssetUsageEvidenceKind;
  boundary: AssetUsageBoundary;
  reason?: string;
}

const USAGE_STATUSES = new Set<AssetUsageStatus>([
  'applied',
  'considered_not_applicable',
  'available_no_opportunity',
  'contradicted',
  'usage_unknown',
]);
const EVIDENCE_KINDS = new Set<AssetUsageEvidenceKind>([
  'tool_call',
  'agent_action',
  'artifact',
  'final_output',
  'none',
]);
const BOUNDARIES = new Set<AssetUsageBoundary>(['real', 'degraded', 'test-double']);
const EVIDENCE_REQUIRED = new Set<AssetUsageStatus>(['applied', 'considered_not_applicable', 'contradicted']);

function compactReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted ? compacted.slice(0, 240) : undefined;
}

function assertSafeInput(userId: string, input: RecordAssetUsageReceiptInput): void {
  if (
    !safeId(userId)
    || !safeId(input.taskRunId)
    || !safeId(input.projectionId)
    || !safeId(input.assetId)
    || !safeId(input.injectionReceiptId)
    || typeof input.assetVersion !== 'string'
    || !input.assetVersion.trim()
    || input.assetVersion.length > 80
    || !USAGE_STATUSES.has(input.status)
    || !EVIDENCE_KINDS.has(input.evidenceKind)
    || !BOUNDARIES.has(input.boundary)
  ) throw new Error('invalid asset usage receipt reference');
}

function normalizeEvidence(input: RecordAssetUsageReceiptInput): CognitionSourceRef[] {
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []);
  if (EVIDENCE_REQUIRED.has(input.status) && (!evidenceRefs.length || input.evidenceKind === 'none')) {
    throw new Error('asset usage evidence is required');
  }
  if (input.evidenceKind === 'none' && evidenceRefs.length) {
    throw new Error('asset usage evidence kind does not match evidence');
  }
  return evidenceRefs;
}

function receiptId(input: Pick<RecordAssetUsageReceiptInput, 'taskRunId' | 'projectionId' | 'assetId' | 'assetVersion'>): string {
  const key = JSON.stringify([input.taskRunId, input.projectionId, input.assetId, input.assetVersion]);
  return `aur-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function asAssetUsageReceipt(userId: string, value: RecallJsonRecord): AssetUsageReceipt {
  const input = value as unknown as RecordAssetUsageReceiptInput;
  assertSafeInput(userId, input);
  if (
    value.schemaVersion !== 1
    || value.ownerId !== userId
    // Historical schema-v1 receipts used a different deterministic key
    // derivation. The id is an opaque event key, not an authorization input;
    // keep old records readable while still requiring the current safe format.
    || typeof value.id !== 'string'
    || !/^aur-[a-f0-9]{24}$/.test(value.id)
    || !Array.isArray(value.evidenceRefs)
    || typeof value.createdAt !== 'string'
    || (value.reason !== undefined && typeof value.reason !== 'string')
  ) throw new Error('malformed asset usage receipt');
  const evidenceRefs = normalizeEvidence(input);
  if (evidenceRefs.length !== value.evidenceRefs.length) throw new Error('malformed asset usage receipt');
  // Normalize historical key derivations in memory. This lets a later
  // contradicted receipt replace the same logical usage event and prevents
  // old and current ids from being counted as two separate events.
  return { ...value, id: receiptId(input), evidenceRefs } as AssetUsageReceipt;
}

export async function recordAssetUsageReceipt(
  userId: string,
  input: RecordAssetUsageReceiptInput,
): Promise<AssetUsageReceipt> {
  assertSafeInput(userId, input);
  const evidenceRefs = normalizeEvidence(input);
  const injection = await readInjectionReceipt(userId, input.injectionReceiptId);
  if (!injection) throw new Error('injection receipt not found');
  if (
    injection.taskRunId !== input.taskRunId
    || injection.projectionId !== input.projectionId
    || injection.assetId !== input.assetId
    || injection.assetVersion !== input.assetVersion
  ) throw new Error('injection receipt does not match asset usage');
  if (injection.status !== 'injected' && injection.status !== 'dispatched') {
    throw new Error('injection receipt did not inject asset');
  }
  if (injection.boundary !== input.boundary) throw new Error('injection receipt boundary mismatch');

  const id = receiptId(input);
  const reasonText = compactReason(input.reason);
  const record: AssetUsageReceipt = {
    schemaVersion: 1,
    ownerId: userId,
    id,
    taskRunId: input.taskRunId,
    projectionId: input.projectionId,
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    injectionReceiptId: input.injectionReceiptId,
    status: input.status,
    evidenceRefs,
    evidenceKind: input.evidenceKind,
    boundary: input.boundary,
    ...(reasonText ? { reason: reasonText } : {}),
    createdAt: nowIso(),
  };

  const streamPath = recallJsonlPath(userId, 'asset-usage-receipts', 'events');
  return fileEditLock(streamPath).runExclusive(async () => {
    const existing = (await listAssetUsageReceipts(userId)).find((item) => item.id === id);
    if (existing) {
      // 负反馈覆盖（2026-09-14）：KSTAR 收账先写过 applied/usage_unknown 的
      // 同键收据，用户随后点踩的 contradicted 会被幂等去重静默吞掉——
      // 「点踩进治理」在 KSTAR 路径失效。contradicted 是用户明确否定，
      // 语义高于先前的自动记账，允许 append 覆盖（读取侧同 id 取末条）。
      if (input.status === 'contradicted' && existing.status !== 'contradicted') {
        await appendRecallJsonlRecord(userId, 'asset-usage-receipts', 'events', record);
        return record;
      }
      return existing;
    }
    await appendRecallJsonlRecord(userId, 'asset-usage-receipts', 'events', record);
    return record;
  });
}

export async function listAssetUsageReceipts(userId: string, taskRunId?: string): Promise<AssetUsageReceipt[]> {
  if (!safeId(userId) || (taskRunId !== undefined && !safeId(taskRunId))) {
    throw new Error('invalid asset usage receipt reference');
  }
  const records = (await listRecallJsonlRecords(userId, 'asset-usage-receipts', 'events', 0))
    .map((record) => asAssetUsageReceipt(userId, record));
  // 同 id 多条（负反馈覆盖 append 的产物）取末条：JSONL 顺序即写入顺序，
  // 消费方（run-evidence / task-closure / trace）只见最终状态，不双计。
  const latest = new Map<string, AssetUsageReceipt>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()].filter((record) => taskRunId === undefined || record.taskRunId === taskRunId);
}

/** 「实际采用」证据查询（specs/015 T003）。**只读、零写入。**
 *
 *  采用口径（唯一权威，来自 specs/011，不得重议）：只有 usage 回执同时满足
 *  `status === 'applied'` **且** `boundary === 'real'` 才算「实际采用」；
 *  `injected`/`dispatched`（注入回执）只是「被带入」，**不构成采用**；
 *  `considered_not_applicable`/`available_no_opportunity`/`contradicted`/
 *  `usage_unknown` 同样不构成采用依据——以上一律不出现在结果里。
 *
 *  读法复用 `listAssetUsageReceipts`（同 id 取末条：负反馈覆盖 append 的产物
 *  只留最终状态，不双计），不另写第二套判定；`taskRunIds` 为空数组返回空列表
 *  （**不是**全量）。结果顺序遵循流内首次出现顺序，不做额外排序。 */
export interface AppliedUsageReceipt {
  id: string;
  assetId: string;
  assetVersion: string;
  taskRunId: string;
  evidenceRefs: CognitionSourceRef[];
}

export async function listAppliedUsageReceipts(
  userId: string,
  query: { taskRunIds: string[]; assetId?: string },
): Promise<AppliedUsageReceipt[]> {
  if (
    !safeId(userId)
    || !query || typeof query !== 'object'
    || !Array.isArray(query.taskRunIds)
    || query.taskRunIds.some((taskRunId) => !safeId(taskRunId))
    || (query.assetId !== undefined && !safeId(query.assetId))
  ) throw new Error('invalid asset usage receipt query');
  const taskRunIds = new Set(query.taskRunIds);
  if (!taskRunIds.size) return [];
  return (await listAssetUsageReceipts(userId))
    .filter((receipt) => receipt.status === 'applied' && receipt.boundary === 'real')
    .filter((receipt) => taskRunIds.has(receipt.taskRunId))
    .filter((receipt) => query.assetId === undefined || receipt.assetId === query.assetId)
    .map((receipt) => ({
      id: receipt.id,
      assetId: receipt.assetId,
      assetVersion: receipt.assetVersion,
      taskRunId: receipt.taskRunId,
      evidenceRefs: [...receipt.evidenceRefs],
    }));
}

/** 采用回执的**视图投影**（2026-09-25 验收修复 US-602 AC5/AC6）：资产详情要显示
 *  「实际采用」的逐条记录——同次任务、具体版本、执行事件类型、产物位置。回执本身
 *  只按 taskRunId 过滤，这里按 assetId 取（与 `listAbilityAssetVersionsWithUsage`
 *  同一读法：全量读后过滤，量级相同）。**只透传 ref 的 kind/id/title**，不含
 *  excerpt、不含绝对路径、不含资产正文——可读名由渲染层唯一解析器负责。 */
export interface AssetUsageReceiptView {
  id: string;
  assetVersion: string;
  taskRunId: string;
  status: AssetUsageStatus;
  evidenceKind: AssetUsageEvidenceKind;
  evidence: Array<{ kind: string; id: string; title?: string }>;
  boundary: AssetUsageBoundary;
  createdAt: string;
}

export async function listAssetUsageReceiptViews(
  userId: string,
  assetId: string,
  limit = 50,
): Promise<AssetUsageReceiptView[]> {
  if (!safeId(userId) || !safeId(assetId)) throw new Error('invalid asset usage receipt query');
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  return (await listAssetUsageReceipts(userId))
    .filter((receipt) => String(receipt.assetId || '') === assetId)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, bounded)
    .map((receipt) => ({
      id: receipt.id,
      assetVersion: String(receipt.assetVersion || ''),
      taskRunId: String(receipt.taskRunId || ''),
      status: receipt.status,
      evidenceKind: receipt.evidenceKind,
      evidence: (receipt.evidenceRefs || []).slice(0, 5).map((ref) => ({
        kind: String(ref.kind || ''),
        id: String(ref.id || ''),
        ...(ref.title ? { title: String(ref.title) } : {}),
      })),
      boundary: receipt.boundary,
      createdAt: String(receipt.createdAt || ''),
    }));
}
