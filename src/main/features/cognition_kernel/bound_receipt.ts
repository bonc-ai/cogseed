/**
 * cognition_kernel/bound_receipt — 任务槽位绑定回执。
 *
 * 六级证据刻度（retrieved→eligible→bound→projected→consumed→effective）中
 * bound 档的落盘载体：一次真实体检后，把"这次任务绑到了哪些槽位（指针+版本）、
 * 还缺哪些（原因）"记成一条 JSONL。覆盖三轴：
 *   personal ＝ 个人字段（PoValue/资产指针）；ontology ＝ 本体记录
 *   （moduleId/recordId@version）；asset ＝ 方法资产（assetId@version）。
 *
 * 记录约束：
 *   - 只存指针与版本，绝不存字段值或正文（value/statement 不进回执）；
 *   - 无真实回合（turnId/taskRunId）不记录；
 *   - 写时严格校验、读时宽松跳过坏档（axis=personal 历史记录继续可读）；
 *   - 回执失败只 warn，不阻断工具结果（接线处保证）。
 *
 * 历史 filled 回执继续可读；对话缺口回答不再生产回填事件。
 */

import { genId12, safeId } from '../../storage';
import { appendRecallJsonlRecord, listRecallJsonlRecords } from '../recall/store';
import type { RecallJsonRecord } from '../recall/types';
import type { MissingReason, PersonalFieldSource } from './types';
import type { TaskFieldCheck } from './gap';

const COLLECTION = 'cognition-bound-receipts';
const FILE_KEY = 'events';
const MAX_SLOTS = 64;
const ID_PATTERN = /^cbound-[A-Za-z0-9_-]{8,40}$/;
const MISSING_REASONS: readonly MissingReason[] = ['no_value', 'restricted', 'not_authorized', 'stale'];
const AXES = ['personal', 'ontology', 'asset'] as const;

export type BoundSlotAxis = (typeof AXES)[number];

export interface BoundSlotRef {
  slot: string;
  axis: BoundSlotAxis;
  source: PersonalFieldSource | 'ontology_record' | 'recall_asset';
  /** 值的权威指针（PoValue.id / 资产 id / 本体记录 id）——只存指针，不存值文本。 */
  sourceId: string;
  /** ontology 轴：记录所属本体模块。 */
  moduleId?: string;
  version?: string;
  revision?: string;
}

export interface MissingSlotRef {
  slot: string;
  axis: BoundSlotAxis;
  reason: MissingReason;
  required: boolean;
}

export interface CognitionBoundReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  /** 兼容以对话回合 ID 充当运行标识的记录；有真实 taskRunId 时优先记它。 */
  taskRunId: string;
  /** 对话回合 ID（旧记录缺此字段，读侧不强制）。 */
  turnId?: string;
  packId: string;
  status: 'checked' | 'filled';
  policyVersion: string;
  bound: BoundSlotRef[];
  missing: MissingSlotRef[];
  boundCount: number;
  totalCount: number;
  createdAt: string;
}

function validSlot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 60;
}

function toPersonalBoundRef(field: { fieldName: string; source: PersonalFieldSource; sourceId: string; version?: string; revision?: string }): BoundSlotRef {
  if (!validSlot(field.fieldName) || !validSlot(field.source) || !validSlot(field.sourceId)) {
    throw new Error('invalid bound slot reference');
  }
  return {
    slot: field.fieldName,
    axis: 'personal',
    source: field.source,
    sourceId: field.sourceId,
    ...(field.version ? { version: field.version } : {}),
    ...(field.revision ? { revision: field.revision } : {}),
  };
}

function toOntologyBoundRef(ref: { slot: string; moduleId: string; recordId: string; version: number }): BoundSlotRef {
  if (!validSlot(ref.slot) || !validSlot(ref.moduleId) || !validSlot(ref.recordId)) {
    throw new Error('invalid bound slot reference');
  }
  const version = String(ref.version);
  if (!validSlot(version)) throw new Error('invalid bound slot reference');
  return { slot: ref.slot, axis: 'ontology', source: 'ontology_record', sourceId: ref.recordId, moduleId: ref.moduleId, version };
}

function toAssetBoundRef(ref: { slot: string; assetId: string; version: string }): BoundSlotRef {
  if (!validSlot(ref.slot) || !validSlot(ref.assetId)) throw new Error('invalid bound slot reference');
  return { slot: ref.slot, axis: 'asset', source: 'recall_asset', sourceId: ref.assetId, version: ref.version };
}

function toMissingRef(field: { fieldName: string; reason: MissingReason; required: boolean }): MissingSlotRef {
  if (!validSlot(field.fieldName) || !MISSING_REASONS.includes(field.reason)) {
    throw new Error('invalid missing slot reference');
  }
  return { slot: field.fieldName, axis: 'personal', reason: field.reason, required: field.required === true };
}

function missingReasonAllowed(axis: BoundSlotAxis, reason: MissingReason): boolean {
  return axis === 'personal' ? MISSING_REASONS.includes(reason)
    : reason === 'no_value' || reason === 'not_authorized';
}

/** 读侧校验：输入已是落盘的 BoundSlotRef 形状，按轴校验关键字段。 */
function parseBoundRef(value: unknown): BoundSlotRef {
  if (!value || typeof value !== 'object') throw new Error('invalid bound slot reference');
  const ref = value as Record<string, unknown>;
  if (!validSlot(ref.slot) || !validSlot(ref.source) || !validSlot(ref.sourceId)
    || !AXES.includes(ref.axis as BoundSlotAxis)) throw new Error('invalid bound slot reference');
  const axis = ref.axis as BoundSlotAxis;
  const expected = axis === 'personal' ? ['ontology_value', 'personal_asset'] : axis === 'ontology' ? ['ontology_record'] : ['recall_asset'];
  if (!expected.includes(String(ref.source))) throw new Error('invalid bound slot reference');
  if (axis === 'ontology' && (!validSlot(ref.moduleId) || !validSlot(ref.version))) throw new Error('invalid bound slot reference');
  if (ref.moduleId !== undefined && !validSlot(ref.moduleId)) throw new Error('invalid bound slot reference');
  if (ref.version !== undefined && !validSlot(ref.version)) throw new Error('invalid bound slot reference');
  if (ref.revision !== undefined && !validSlot(ref.revision)) throw new Error('invalid bound slot reference');
  return {
    slot: ref.slot,
    axis,
    source: ref.source as BoundSlotRef['source'],
    sourceId: ref.sourceId,
    ...(ref.moduleId ? { moduleId: ref.moduleId as string } : {}),
    ...(ref.version ? { version: ref.version as string } : {}),
    ...(ref.revision ? { revision: ref.revision as string } : {}),
  };
}

/** 读侧校验：输入已是落盘的 MissingSlotRef 形状。 */
function parseMissingRef(value: unknown): MissingSlotRef {
  if (!value || typeof value !== 'object') throw new Error('invalid missing slot reference');
  const ref = value as Record<string, unknown>;
  if (!validSlot(ref.slot) || !AXES.includes(ref.axis as BoundSlotAxis)
    || !MISSING_REASONS.includes(ref.reason as MissingReason)
    || !missingReasonAllowed(ref.axis as BoundSlotAxis, ref.reason as MissingReason)) {
    throw new Error('invalid missing slot reference');
  }
  return { slot: ref.slot, axis: ref.axis as BoundSlotAxis, reason: ref.reason as MissingReason, required: ref.required === true };
}

function slotsOf(check: TaskFieldCheck): { bound: BoundSlotRef[]; missing: MissingSlotRef[] } {
  const bound = check.resolution.bound.map(toPersonalBoundRef);
  const missing = check.resolution.missing.map(toMissingRef);
  for (const ref of check.ontology?.bound ?? []) bound.push(toOntologyBoundRef(ref));
  for (const ref of check.ontology?.missing ?? []) {
    if (!missingReasonAllowed('ontology', ref.reason)) throw new Error('invalid missing slot reference');
    if (!validSlot(ref.slot)) throw new Error('invalid missing slot reference');
    missing.push({ slot: ref.slot, axis: 'ontology', reason: ref.reason, required: ref.required === true });
  }
  for (const ref of check.assets?.bound ?? []) bound.push(toAssetBoundRef(ref));
  for (const ref of check.assets?.missing ?? []) {
    if (!missingReasonAllowed('asset', ref.reason)) throw new Error('invalid missing slot reference');
    if (!validSlot(ref.slot)) throw new Error('invalid missing slot reference');
    missing.push({ slot: ref.slot, axis: 'asset', reason: ref.reason, required: ref.required === true });
  }
  return { bound, missing };
}

/** 无真实回合不记账；包为空或槽位超限拒绝写（宁可不记也不记半截）。 */
export async function recordCognitionBoundReceipt(
  userId: string,
  turnId: string | undefined,
  packId: string,
  check: TaskFieldCheck,
  taskRunId?: string,
): Promise<CognitionBoundReceipt | undefined> {
  const runId = taskRunId ?? turnId;
  if (!runId) return undefined;
  if (!safeId(userId) || !safeId(runId) || !validSlot(packId)) throw new Error('invalid cognition bound receipt owner or pack');
  const { bound, missing } = slotsOf(check);
  if (bound.length + missing.length < 1) throw new Error('cognition bound receipt requires at least one slot');
  if (bound.length + missing.length > MAX_SLOTS) throw new Error('cognition bound receipt exceeds slot limit');
  const receipt: CognitionBoundReceipt = {
    schemaVersion: 1,
    ownerId: userId,
    id: `cbound-${genId12()}`,
    taskRunId: runId,
    ...(turnId && turnId !== runId ? { turnId } : {}),
    packId,
    status: 'checked',
    policyVersion: typeof check.resolution.policyVersion === 'string' ? check.resolution.policyVersion : '',
    bound,
    missing,
    boundCount: check.boundCount,
    totalCount: check.totalCount,
    createdAt: new Date().toISOString(),
  };
  await appendRecallJsonlRecord(userId, COLLECTION, FILE_KEY, receipt);
  return receipt;
}

/** 读回执（按运行标识过滤可选）；坏档跳过，不当作证据。 */
export async function listCognitionBoundReceipts(
  userId: string,
  taskRunId?: string,
): Promise<CognitionBoundReceipt[]> {
  if (!safeId(userId)) throw new Error('invalid cognition bound receipt owner');
  const values = await listRecallJsonlRecords(userId, COLLECTION, FILE_KEY, 0);
  const output: CognitionBoundReceipt[] = [];
  for (const value of values) {
    if (value.schemaVersion !== 1 || value.ownerId !== userId
      || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)
      || (value.status !== 'checked' && value.status !== 'filled')
      || typeof value.taskRunId !== 'string' || typeof value.packId !== 'string'
      || typeof value.createdAt !== 'string'
      || !Array.isArray(value.bound) || !Array.isArray(value.missing)
      || value.bound.length + value.missing.length < 1 || value.bound.length + value.missing.length > MAX_SLOTS) continue;
    if (taskRunId && value.taskRunId !== taskRunId) continue;
    try {
      output.push({
        ...value,
        bound: value.bound.map(parseBoundRef),
        missing: value.missing.map(parseMissingRef),
      } as CognitionBoundReceipt);
    } catch { /* 历史坏档不是证据 */ }
  }
  return output;
}
