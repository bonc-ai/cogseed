import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import type { AbilityAssetFailureCategory } from '../recall/asset-service';
import {
  normalizeCognitionSourceRefsForWrite,
  redactSourceExcerpt,
  type CognitionSourceRef,
} from '../recall/source-service';
import { listKstarJsonRecords, readKstarJsonRecord, replaceKstarJsonRecord } from './episode-store';
import type { KstarJsonRecord } from './types';

const log = createLogger('kstar.improvement-outcome');

/** 结论记录集合：`<uid>/cloud/kstar/improvement-outcomes/<id>.json`
 *  （路径由 `paths.ts::kstarRecordPath` 拼装，读写走 `episode-store.ts`）。 */
export const KSTAR_IMPROVEMENT_OUTCOME_COLLECTION = 'improvement-outcomes';
/** reason 上限，与 `asset-usage-receipt.ts::compactReason`、
 *  `source-service.ts::MAX_EXCERPT_LENGTH` 同为 240 —— 只留人话摘要，不留正文。 */
export const KSTAR_IMPROVEMENT_OUTCOME_REASON_MAX = 240;

export const KSTAR_IMPROVEMENT_CONCLUSIONS = [
  'no_update',
  'insufficient_evidence',
  'analysis_failed',
  'submit_failed',
] as const;
/** 四类非候选结论：**互不冒充**——`no_update` 永远不由失败退化而来（data-model §2）。 */
export type KstarImprovementConclusion = (typeof KSTAR_IMPROVEMENT_CONCLUSIONS)[number];

/** 失败归因取值沿用 plan Addendum 的枚举（与 `AbilityAssetFailureCategory` 同一组，
 *  specs/008 的资产写入归因也用它）——不新开第二套分类。 */
export const KSTAR_IMPROVEMENT_FAILURE_CATEGORIES = [
  'product', 'model', 'prompt', 'data', 'tool',
  'permission', 'workflow', 'schema', 'governance', 'evidence', 'unknown',
] as const satisfies readonly AbilityAssetFailureCategory[];
export type KstarImprovementFailureCategory = (typeof KSTAR_IMPROVEMENT_FAILURE_CATEGORIES)[number];
/** 编译期穷尽性守卫：上游 `AbilityAssetFailureCategory` 新增取值而本列表未同步时，
 *  下面这行的类型不成立（`never` 之外还有成员），`npm run typecheck` 直接红。 */
type FailureCategoryCoverage = [Exclude<
  AbilityAssetFailureCategory,
  KstarImprovementFailureCategory
>] extends [never] ? true : never;
const FAILURE_CATEGORY_COVERAGE: FailureCategoryCoverage = true;

const CONCLUSIONS = new Set<string>(KSTAR_IMPROVEMENT_CONCLUSIONS);
/** 这两类结论是**失败**，必须带归因（data-model §2：`analysis_failed` / `submit_failed` 必填）。 */
const FAILURE_CONCLUSIONS = new Set<KstarImprovementConclusion>(['analysis_failed', 'submit_failed']);
const FAILURE_CATEGORIES = new Set<string>(
  FAILURE_CATEGORY_COVERAGE ? KSTAR_IMPROVEMENT_FAILURE_CATEGORIES : [],
);

/** 本次分析「看到的实际采用」摘要：只有标识与版本，没有资产正文。 */
export interface KstarAdoptedAssetRef {
  assetId: string;
  assetVersion: string;
  usageReceiptId: string;
}

/**
 * 改进分析结论记录（`specs/015` data-model §2）。
 *
 * 用途：US-701 AC3 的四类反馈的落档载体——「分析过但没出候选」必须如实记下来，
 * 而不是静默无声。结论是**终态快照**，不是流程状态。
 */
export interface KstarImprovementOutcomeRecord extends KstarJsonRecord {
  schemaVersion: 1;
  ownerId: string;
  /** 派生 id：`kio-<episodeId>`（同 episode 重复写 = 覆盖同一条，幂等）。 */
  id: string;
  episodeId: string;
  /** 回指复盘（`cloud/kstar/reviews/<reviewId>.json`）。 */
  reviewId: string;
  requirementId?: string;
  taskId?: string;
  conversationId?: string;
  conclusion: KstarImprovementConclusion;
  /** 人话短句，≤240 字（空白压缩 + 密钥样式脱敏后的摘要）。 */
  reason: string;
  /** 采用证据/来源引用；`insufficient_evidence` 时说明缺哪一项。只存元数据，不存正文。 */
  evidenceRefs: CognitionSourceRef[];
  adoptedAssetRefs?: KstarAdoptedAssetRef[];
  /** `analysis_failed` / `submit_failed` 必填。 */
  failureCategory?: KstarImprovementFailureCategory;
  /** §2 收敛语义的预留位（后续补到证据并产出候选时可标记被哪条候选取代）；
   *  本期写入函数不产出该字段，列表侧按「有无候选关联」过滤。 */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordKstarImprovementOutcomeInput {
  episodeId: string;
  reviewId: string;
  conclusion: KstarImprovementConclusion;
  reason: string;
  requirementId?: string;
  taskId?: string;
  conversationId?: string;
  evidenceRefs?: unknown[];
  adoptedAssetRefs?: Array<Partial<KstarAdoptedAssetRef>>;
  failureCategory?: AbilityAssetFailureCategory;
}

/** 派生记录 id（`safeId` 校验先于拼装，避免把路径片段带进文件名）。 */
export function kstarImprovementOutcomeId(episodeId: string): string {
  if (!safeId(episodeId)) throw new Error('invalid kstar improvement outcome episode id');
  return `kio-${episodeId}`;
}

function boundedReason(value: unknown): string {
  // 与 `asset-usage-receipt.ts::compactReason` 同口径（空白压缩 + 240 上限）：压缩后
  // 再复用内容源写入口径的 `redactSourceExcerpt`，token/api_key/password 等敏感值替换
  // 为 `[REDACTED]`；超长正文只留前 240 字，正文尾部永不落盘。
  return redactSourceExcerpt(value) || '';
}

function boundedVersion(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

/** 采用摘要规范化：只保留 `safeId` 过的标识 + 有界版本号，并按键去重。 */
function normalizeAdoptedAssetRefs(input: unknown): KstarAdoptedAssetRef[] {
  if (!Array.isArray(input)) return [];
  const out: KstarAdoptedAssetRef[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const assetId = typeof row.assetId === 'string' ? row.assetId : '';
    const assetVersion = boundedVersion(row.assetVersion);
    const usageReceiptId = typeof row.usageReceiptId === 'string' ? row.usageReceiptId : '';
    if (!safeId(assetId) || !assetVersion || !safeId(usageReceiptId)) continue;
    const key = `${assetId}:${assetVersion}:${usageReceiptId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ assetId, assetVersion, usageReceiptId });
  }
  return out;
}

function isStoredSourceRef(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.kind === 'string' && !!row.kind.trim() && typeof row.id === 'string' && safeId(row.id);
}

function isStoredAdoptedAssetRef(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.assetId === 'string' && safeId(row.assetId)
    && typeof row.assetVersion === 'string' && !!row.assetVersion
    && typeof row.usageReceiptId === 'string' && safeId(row.usageReceiptId);
}

function isOptionalSafeId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && safeId(value));
}

function assertOptionalSafeIds(row: Record<string, unknown>): void {
  if (
    !isOptionalSafeId(row.requirementId)
    || !isOptionalSafeId(row.taskId)
    || !isOptionalSafeId(row.conversationId)
    || !isOptionalSafeId(row.supersededBy)
  ) throw new Error('malformed kstar improvement outcome');
}

/** 读回校验：形状、结论与归因口径、以及「id = kio-<episodeId>」的派生关系。 */
function asImprovementOutcome(
  userId: string,
  value: KstarJsonRecord,
  expectedId?: string,
): KstarImprovementOutcomeRecord {
  const row = value as unknown as Record<string, unknown>;
  const conclusion = row.conclusion;
  if (
    value.ownerId !== userId
    || (expectedId !== undefined && value.id !== expectedId)
    || typeof row.episodeId !== 'string'
    || !safeId(row.episodeId)
    || row.id !== kstarImprovementOutcomeId(row.episodeId)
    || typeof row.reviewId !== 'string'
    || !safeId(row.reviewId)
    || !CONCLUSIONS.has(String(conclusion))
    || (FAILURE_CONCLUSIONS.has(conclusion as KstarImprovementConclusion)
      && !FAILURE_CATEGORIES.has(String(row.failureCategory)))
    || (row.failureCategory !== undefined && !FAILURE_CATEGORIES.has(String(row.failureCategory)))
    || typeof row.reason !== 'string'
    || !row.reason
    || row.reason.length > KSTAR_IMPROVEMENT_OUTCOME_REASON_MAX
    || !Array.isArray(row.evidenceRefs)
    || !row.evidenceRefs.every(isStoredSourceRef)
    || (row.adoptedAssetRefs !== undefined
      && (!Array.isArray(row.adoptedAssetRefs) || !row.adoptedAssetRefs.every(isStoredAdoptedAssetRef)))
    || typeof row.createdAt !== 'string'
    || !row.createdAt
    || typeof row.updatedAt !== 'string'
    || !row.updatedAt
  ) throw new Error('malformed kstar improvement outcome');
  assertOptionalSafeIds(row);
  return value as KstarImprovementOutcomeRecord;
}

/** 覆盖写时的时间戳推进：同 id 重复分析只更新 `updatedAt`，且**严格不倒退**
 *  （系统时钟回拨或同毫秒两次写入时也保证列表倒序可判定）。 */
function advancedUpdatedAt(previous: string | undefined, candidate: string): string {
  if (!previous) return candidate;
  if (candidate > previous) return candidate;
  const previousMs = Date.parse(previous);
  return Number.isFinite(previousMs) ? new Date(previousMs + 1).toISOString() : candidate;
}

/**
 * 写入（覆盖语义 / 幂等）：同一 `episodeId` 永远只有 `kio-<episodeId>` 这一条，
 * 重复分析把 `conclusion` / `reason` 更新为最新一次结果，`createdAt` 保留首次写入值。
 */
export async function recordKstarImprovementOutcome(
  userId: string,
  input: RecordKstarImprovementOutcomeInput,
): Promise<KstarImprovementOutcomeRecord> {
  if (
    !safeId(userId)
    || !safeId(input.episodeId)
    || !safeId(input.reviewId)
    || !CONCLUSIONS.has(String(input.conclusion))
    || !isOptionalSafeId(input.requirementId)
    || !isOptionalSafeId(input.taskId)
    || !isOptionalSafeId(input.conversationId)
    || (input.failureCategory !== undefined && !FAILURE_CATEGORIES.has(String(input.failureCategory)))
  ) throw new Error('invalid kstar improvement outcome reference');
  // 失败类结论缺归因 = 说不清失败在哪，**不许**退化成无归因的通用结论。
  if (FAILURE_CONCLUSIONS.has(input.conclusion) && input.failureCategory === undefined) {
    throw new Error(`invalid kstar improvement outcome: failureCategory is required for ${input.conclusion}`);
  }
  const reason = boundedReason(input.reason);
  if (!reason) throw new Error('invalid kstar improvement outcome reason');

  const id = kstarImprovementOutcomeId(input.episodeId);
  const existingRaw = await readKstarJsonRecord(userId, KSTAR_IMPROVEMENT_OUTCOME_COLLECTION, id);
  const existing = existingRaw ? asImprovementOutcome(userId, existingRaw, id) : null;
  const adoptedAssetRefs = normalizeAdoptedAssetRefs(input.adoptedAssetRefs);
  const now = new Date().toISOString();
  const record: KstarImprovementOutcomeRecord = {
    schemaVersion: 1,
    ownerId: userId,
    id,
    episodeId: input.episodeId,
    reviewId: input.reviewId,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    conclusion: input.conclusion,
    reason,
    evidenceRefs: normalizeCognitionSourceRefsForWrite(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []),
    ...(adoptedAssetRefs.length ? { adoptedAssetRefs } : {}),
    ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
    createdAt: existing?.createdAt || now,
    updatedAt: advancedUpdatedAt(existing?.updatedAt, now),
  };
  // 幂等靠派生 id：同 id 覆盖写（`writeKstarJsonRecord` 是首写即冲突检测的原语，
  // 覆盖语义必须用同一 store 的 `replaceKstarJsonRecord`，两者共用同一把文件锁）。
  return replaceKstarJsonRecord(userId, KSTAR_IMPROVEMENT_OUTCOME_COLLECTION, record);
}

/** 单条读取（按 episode 派生的 id 精确查；不存在返回 `null`）。 */
export async function readKstarImprovementOutcome(
  userId: string,
  episodeId: string,
): Promise<KstarImprovementOutcomeRecord | null> {
  if (!safeId(userId)) throw new Error('invalid kstar improvement outcome user id');
  const id = kstarImprovementOutcomeId(episodeId);
  const raw = await readKstarJsonRecord(userId, KSTAR_IMPROVEMENT_OUTCOME_COLLECTION, id);
  return raw ? asImprovementOutcome(userId, raw, id) : null;
}

/** 列表：按 `updatedAt` 倒序（同刻按 `createdAt`、`id` 兜底，保证顺序可判定），
 *  支持 `limit` 与可选 `conclusion` 过滤；降级记录跳过并留日志，不让一条坏记录拖垮整张列表。 */
export async function listKstarImprovementOutcomes(
  userId: string,
  options: { limit?: number; conclusion?: KstarImprovementConclusion } = {},
): Promise<KstarImprovementOutcomeRecord[]> {
  if (!safeId(userId)) throw new Error('invalid kstar improvement outcome user id');
  if (options.conclusion !== undefined && !CONCLUSIONS.has(String(options.conclusion))) {
    throw new Error('invalid kstar improvement outcome conclusion');
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('invalid kstar improvement outcome limit');
  }
  const records: KstarImprovementOutcomeRecord[] = [];
  for (const raw of await listKstarJsonRecords(userId, KSTAR_IMPROVEMENT_OUTCOME_COLLECTION)) {
    try {
      records.push(asImprovementOutcome(userId, raw));
    } catch (error) {
      log.warn('skipping degraded kstar improvement outcome', {
        recordId: raw?.id,
        error: (error as Error).message,
      });
    }
  }
  const filtered = options.conclusion === undefined
    ? records
    : records.filter((record) => record.conclusion === options.conclusion);
  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)
    || b.createdAt.localeCompare(a.createdAt)
    || b.id.localeCompare(a.id));
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}
