import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import {
  appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord,
  removeRecallJsonlStream, removeRecallJsonlRecords, updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { normalizeAbilityAssetOntologyRefs } from './ontology-refs';
import type { RecallAbilityAssetRecord, RecallAbilityAssetLifecycleStatus } from './candidate-service';
import { ensureAbilityTags, normalizeAbilityTagList } from './ability-tag-service';
import { readAbilityAssetRelationContract } from './asset-relations';
import { readAbilityAssetSemantics } from './asset-semantics';
import { normalizeAbilityAssetScopePolicy, resolveScopeForAsset, normalizeAssetScopeValue, isRecallScopeTerm, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { normalizeCausalRule } from './world-model-types';
import { resolveExecutionEvidenceRefs } from './evidence-resolution';
import { assertCompliantAbilityAssetTitle, recallTitleIssue } from './title-policy';
import { createLogger } from '../../logger';

const log = createLogger('recall.assets');

/** `'ai'` = 模型经资产管家工具发起的写操作（specs/008 US-402）。
 *  与 `'system'` 分开：system 是自动线（抽取/沉淀/迁移），它带自动评审交接；
 *  ai 是用户在场的一次对话指令或 AI 自主提议，二者在台账上要能分辨。 */
export type AbilityAssetActor = 'user' | 'system' | 'ai';
export type AbilityAssetRecommendedAction = 'pause' | 'rework';

/** 失败归因分类（specs/008 plan · AI Product Addendum）。
 *  只写在失败/被拦截的台账记录上；成功的记录不带这个字段。 */
export type AbilityAssetFailureCategory =
  | 'product' | 'model' | 'prompt' | 'data' | 'tool'
  | 'permission' | 'workflow' | 'schema' | 'governance' | 'evidence' | 'unknown';

export interface AbilityAssetVersionRecord extends RecallJsonRecord {
  assetId: string;
  version: string;
  at: string;
  reason?: string;
  actor?: AbilityAssetActor;
  snapshot: Pick<
    RecallAbilityAssetRecord,
    | 'title' | 'statement' | 'type' | 'scope' | 'scopePolicy' | 'evidenceRefs'
    | 'status' | 'maturity' | 'version' | 'learningSignal' | 'learningProvenance'
    | 'ontologyRefs' | 'relations' | 'derivedFrom'
    | 'applicableWhen' | 'forbiddenWhen' | 'sensitivity' | 'sourceSessionIds'
  >;
}

export interface AbilityAssetAuditRecord extends RecallJsonRecord {
  assetId: string;
  action: 'created' | 'updated' | 'paused' | 'resumed' | 'revoked'
    | 'archived' | 'deleted' | 'purged' | 'restored' | 'rolled_back'
    | 'version_selected' | 'version_deleted' | 'merged_from' | 'merged_into'
    | 'maturity_downgraded' | 'pause_recommended' | 'rework_recommended'
    | 'recommendation_cleared'
    | 'cross_scope_confirmed' | 'cross_scope_withdrawn'
    | 'maturity_advanced'
    // 修正归档错误，**不是**靠证据挣来的升档。审计里要分得开，否则日后
    // 回看会以为这条资产做过 transfer proof。
    | 'maturity_corrected'
    // 资产管家安全网（specs/008 US-404）：
    //   - danger_snapshot：危险操作**执行前**留的快照锚点（内容在版本流里，
    //     这里记"当时在用哪一版"，回滚就滚到它）；
    //   - danger_confirmed / danger_denied：单次确认的结果（含超时/取消=deny）；
    //   - attempt_blocked：被门禁拦下的写尝试——**失败也要留痕**，否则"零静默
    //     放行"只在成功路径上成立，拦下的那些事无从审计。
    | 'danger_snapshot' | 'danger_confirmed' | 'danger_denied' | 'attempt_blocked'
    // 审批提议（specs/008 US-406）：AI 提出、用户三态处置、以及用户编辑卡片内容。
    // 提议本身不改资产，但它必须与"谁在什么时候做了什么决定"绑在同一条履历上。
    | 'approval_proposed' | 'approval_confirmed' | 'approval_rejected' | 'approval_deferred' | 'approval_edited';
  at: string;
  actor?: AbilityAssetActor;
  note?: string;
  /** 变更前后的**摘要**（不是全文）。由 `summarizeAuditChange` 产出：正文类字段
   *  只留字数（specs/008 FR-012）。逐字对比看
   *  版本流快照，台账不承担第二份正文副本的职责。 */
  before?: string;
  after?: string;
  /** 本次写操作的依据（specs/008 FR-004 的「依据」项）。与 `note` 同源：
   *  `note` 是既有消费方（渲染层生命周期记录 / timeline summary）在读的字段，
   *  保留不动；`reason` 是台账四项里可单独查询的那一项。 */
  reason?: string;
  /** 失败/被拦截的归因。成功的记录不带——「被拦截不得计为成功」靠这个字段
   *  与 `ok:false` 回执共同表达（specs/008 T032）。 */
  failureCategory?: AbilityAssetFailureCategory;
  /** 这一步之前的在用版本（回滚锚点）。渲染层「回滚到改动前」直接拿它调
   *  rollback，不必从 `before` 摘要里反解。 */
  rollbackAnchor?: string;
}

export interface UpdateAbilityAssetInput {
  // 转正字段已随出身收敛退役（2026-09-20）：「模型记的=已确定」，不再有
  // 出身升格动作；调用方传入的 lifecycleStatus 一律忽略（字段已删）。
  title?: string;
  statement?: string;
  scope?: string;
  /** `undefined` keeps the current policy; an empty object explicitly clears
   *  every policy dimension. Empty arrays inside a non-empty policy remain
   *  explicit deny-all decisions for that dimension. */
  scopePolicy?: RecallAbilityAssetScopePolicy;
  type?: RecallAbilityAssetRecord['type'];
  evidenceRefs?: RecallAbilityAssetRecord['evidenceRefs'];
  ontologyRefs?: RecallAbilityAssetRecord['ontologyRefs'];
  relations?: RecallAbilityAssetRecord['relations'];
  derivedFrom?: RecallAbilityAssetRecord['derivedFrom'];
  applicableWhen?: RecallAbilityAssetRecord['applicableWhen'];
  forbiddenWhen?: RecallAbilityAssetRecord['forbiddenWhen'];
  /** 主题标签（specs/012 T004）：整组替换语义。规范化/去重/≤12 条由
   *  ability-tag-service 的规范化唯一处收口，超限**抛错不截断**；缺失的库条目
   *  自动补建。元数据：**不 bump 内容版本**（对齐 family.ts:232 的 familyName
   *  直写先例）。**缺失 = 不改标签**（省略≠清空；清空请显式传 `[]`）。 */
  tags?: string[];
  reason: string;
  actor: AbilityAssetActor;
  /** 乐观并发：调用方读到的版本号。给了就要求与当前版本一致，不一致直接拒绝
   *  （**不静默覆盖**）。比对放在 `updateRecallJsonRecord` 的锁内做——放到调用方
   *  先读后写就会留下 TOCTOU 窗口，"比对通过"与"真的没被改过"变成两件事。
   *  资产管家工具在"用户可能正在手动编辑同一条"的场景下必须传它。 */
  expectedVersion?: string;
  acknowledgeRecommendation?: boolean;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
  id?: never;
  ownerId?: never;
}

export interface AbilityAssetUserActionInput {
  actor: AbilityAssetActor;
  reason: string;
  /** Optional optimistic concurrency guard for status changes. */
  expectedVersion?: string;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
}

export interface RecommendAbilityAssetActionInput {
  action: AbilityAssetRecommendedAction;
  reason: string;
  actor: AbilityAssetActor;
}

export interface CreateAbilityAssetInput extends RecallAbilityAssetRecord {}

function assetsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'ability-assets', 'placeholder'));
}

/** 治理状态白名单。旧记录只会含前三种，新增的三种向后兼容地放行。 */
const ABILITY_ASSET_STATUSES = new Set<RecallAbilityAssetRecord['status']>([
  'active', 'paused', 'archived', 'deleted', 'purged', 'revoked',
]);

const ABILITY_ASSET_MATURITIES = new Set<RecallAbilityAssetRecord['maturity']>([
  'seed', 'bud', 'transfer_validated', 'effectiveness_validated',
]);

/**
 * 删除保留期长度（天）。
 *
 * 口径（2026-09-24 定稿，不再是占位值）：删除后 30 天内可恢复；保留期内可在
 * 「已删除」列表对单条「立即彻底删除」；**到期系统自动彻底删除**（内容与记录
 * 一并清除、不可恢复）。到期清理见 `asset-retention-service.ts`。
 * 记录里存的是 `deletedAt` 这个事实而不是算好的到期时间，所以改动此常量不需要
 * 迁移任何已有数据。
 */
export const ABILITY_ASSET_DELETION_RETENTION_DAYS = 30;

/**
 * 一条已删除的资产是否仍在保留期内（即是否还能恢复）。
 *
 * 缺 `deletedAt` 的已删除记录一律视为「不在保留期内」：宁可让用户走申诉，也好过
 * 依据一个不存在的时间戳声称还能恢复。
 */
export function isWithinDeletionRetention(
  asset: Pick<RecallAbilityAssetRecord, 'status' | 'deletedAt'>,
  now: Date = new Date(),
): boolean {
  if (asset.status !== 'deleted' || !asset.deletedAt) return false;
  const deletedAt = Date.parse(asset.deletedAt);
  if (Number.isNaN(deletedAt)) return false;
  return now.getTime() - deletedAt < ABILITY_ASSET_DELETION_RETENTION_DAYS * 86_400_000;
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !ABILITY_ASSET_STATUSES.has(value.status as RecallAbilityAssetRecord['status']) ||
    (value.maturity !== undefined
      && !ABILITY_ASSET_MATURITIES.has(value.maturity as RecallAbilityAssetRecord['maturity']))
    || (value.deletedAt !== undefined
      && (typeof value.deletedAt !== 'string' || Number.isNaN(Date.parse(value.deletedAt))))
  ) throw new Error('malformed recall ability asset');
  // 墓碑按定义没有内容：彻底清除已经删掉标题、正文和证据，只留下不可识别的最小
  // 审计项。仍然要求这些键存在（上面已校验类型），但不再要求非空——否则一条被
  // 合法清除的资产会被当成损坏记录读不出来，历史回执里的 asset:<id> 就指向虚空。
  if (value.status === 'purged') {
    return { ...value, evidenceRefs: [] } as unknown as RecallAbilityAssetRecord;
  }
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  // 手动新建资产（「记一条」晋升）没有对话证据，空证据合法——与 purged 的
  // 空证据同款豁免口径，靠落盘的 origin='manual' 识别（2026-09-28 拍板项）。
  if (!evidenceRefs.length && (value as { origin?: unknown }).origin !== 'manual') {
    throw new Error('malformed recall ability asset evidence');
  }
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(value, value.id);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  const causalRule = value.causalRule === undefined ? undefined : normalizeCausalRule(value.causalRule);
  const validationCount = value.validationCount === undefined ? undefined : Number(value.validationCount);
  const consecutiveFailures = value.consecutiveFailures === undefined ? undefined : Number(value.consecutiveFailures);
  const lastValidatedAt = value.lastValidatedAt === undefined ? undefined : String(value.lastValidatedAt);
  if ((validationCount !== undefined && (!Number.isInteger(validationCount) || validationCount < 0))
    || (consecutiveFailures !== undefined && (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0))
    || (value.lastValidatedAt !== undefined && (typeof value.lastValidatedAt !== 'string' || Number.isNaN(Date.parse(lastValidatedAt!))))) {
    throw new Error('malformed recall ability asset validation evidence');
  }
  const recommendedAction = value.recommendedAction;
  if (recommendedAction !== undefined && recommendedAction !== 'pause' && recommendedAction !== 'rework') throw new Error('malformed recall ability asset recommendation');
  if (recommendedAction !== undefined && (typeof value.recommendationReason !== 'string' || !value.recommendationReason.trim() || typeof value.recommendationAt !== 'string')) throw new Error('malformed recall ability asset recommendation');
  const sourceCandidateIds = Array.isArray(value.sourceCandidateIds)
    ? [...new Set(value.sourceCandidateIds.filter((id): id is string => typeof id === 'string' && safeId(id)))]
    : [value.candidateId as string];
  const appliedReviewDecisionIds = Array.isArray(value.appliedReviewDecisionIds)
    ? [...new Set(value.appliedReviewDecisionIds.filter((id): id is string => typeof id === 'string' && /^rd_[A-Za-z0-9_-]{8,64}$/.test(id)))]
    : [];
  const appliedValidationIds = Array.isArray(value.appliedValidationIds)
    ? [...new Set(value.appliedValidationIds.filter((id): id is string => typeof id === 'string' && safeId(id)))]
    : [];
  const lifecycleStatus: RecallAbilityAssetLifecycleStatus =
    value.lifecycleStatus === 'automatically_extracted_unverified'
      || value.lifecycleStatus === 'system_precipitated_unverified'
      ? value.lifecycleStatus
      : 'user_confirmed_unverified';
  const activeVersion = value.activeVersion === undefined ? undefined : String(value.activeVersion);
  if (activeVersion !== undefined && (!/^\d+$/.test(activeVersion) || Number(activeVersion) < 1)) {
    throw new Error('malformed recall ability asset active version');
  }
  const mergedIntoAssetId = value.mergedIntoAssetId === undefined ? undefined : String(value.mergedIntoAssetId);
  if (mergedIntoAssetId !== undefined && !safeId(mergedIntoAssetId)) {
    throw new Error('malformed recall ability asset merge target');
  }
  return {
    ...value,
    reviewDecisionId: typeof value.reviewDecisionId === 'string' ? value.reviewDecisionId : 'legacy-untracked',
    // Preserve the written confirmation semantics instead of force-rewriting
    // to user_confirmed_unverified (P0-2): both automatic lines
    // (automatically_extracted_unverified / system_precipitated_unverified)
    // must survive reads — the asset stays honest about NOT being
    // user-confirmed.
    lifecycleStatus,
    ...(activeVersion !== undefined ? { activeVersion } : {}),
    ...(mergedIntoAssetId !== undefined ? { mergedIntoAssetId } : {}),
    sourceCandidateIds,
    appliedReviewDecisionIds,
    appliedValidationIds,
    evidenceRefs,
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...relationContract,
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(causalRule ? { causalRule } : {}),
    ...(validationCount !== undefined ? { validationCount } : {}),
    ...(lastValidatedAt !== undefined ? { lastValidatedAt } : {}),
    ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
  } as RecallAbilityAssetRecord;
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid ability asset ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid ability asset ${field}`);
  return text;
}

function requireAssetAction(input: unknown): AbilityAssetUserActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ability asset action requires an actor');
  const record = input as Record<string, unknown>;
  if (record.actor !== 'user' && record.actor !== 'system' && record.actor !== 'ai') {
    // 措辞里的 "user actor" 是既有契约（调用方与测试按它匹配），改动需同步。
    throw new Error('ability asset action requires a user actor, system actor or ai actor');
  }
  return { actor: record.actor, reason: bounded(record.reason, 'reason', 1_000) };
}

function nextVersion(version: string): string {
  const current = Number(version);
  if (!Number.isSafeInteger(current) || current < 1) throw new Error('invalid ability asset version');
  return String(current + 1);
}

function snapshot(asset: RecallAbilityAssetRecord): AbilityAssetVersionRecord['snapshot'] {
  return {
    title: asset.title,
    statement: asset.statement,
    type: asset.type,
    scope: asset.scope,
    ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
    evidenceRefs: asset.evidenceRefs,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.learningProvenance ? { learningProvenance: asset.learningProvenance } : {}),
    ...(asset.ontologyRefs ? { ontologyRefs: asset.ontologyRefs } : {}),
    ...(asset.relations ? { relations: asset.relations } : {}),
    ...(asset.derivedFrom ? { derivedFrom: asset.derivedFrom } : {}),
    ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    ...(asset.sourceSessionIds?.length ? { sourceSessionIds: asset.sourceSessionIds } : {}),
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  };
}

function asVersion(value: RecallJsonRecord): AbilityAssetVersionRecord {
  const rawSnapshot = value.snapshot;
  if (typeof value.assetId !== 'string' || typeof value.version !== 'string' || typeof value.at !== 'string' || !rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('malformed recall ability asset version');
  const versionSnapshot = rawSnapshot as Record<string, unknown>;
  if (!Array.isArray(versionSnapshot.evidenceRefs)) throw new Error('malformed recall ability asset version evidence');
  const scopePolicy = normalizeAbilityAssetScopePolicy(versionSnapshot.scopePolicy);
  const relationContract = readAbilityAssetRelationContract(versionSnapshot, value.assetId);
  return {
    ...value,
    snapshot: {
      ...versionSnapshot,
      ...(scopePolicy ? { scopePolicy } : {}),
      ...relationContract,
      evidenceRefs: normalizeCognitionSourceRefs(versionSnapshot.evidenceRefs),
    },
  } as AbilityAssetVersionRecord;
}

async function appendVersion(userId: string, asset: RecallAbilityAssetRecord, metadata: { reason?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-versions', asset.id, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${asset.id}-v${asset.version}`,
    assetId: asset.id,
    version: asset.version,
    at,
    ...(metadata.reason ? { reason: metadata.reason } : {}),
    ...(metadata.actor ? { actor: metadata.actor } : {}),
    snapshot: snapshot(asset),
  } satisfies AbilityAssetVersionRecord);
}

/** 台账摘要的隐私边界（specs/008 FR-012 + data-model「before/after 只存摘要」）。
 *
 *  正文类字段**只留字数**：台账是给用户逐条读的账，不是第二份正文副本。
 *  要逐字对比，版本流里有完整快照（版本对比视图读的就是它）。
 */
const AUDIT_BODY_FIELDS: ReadonlySet<string> = new Set(['statement', 'applicableWhen', 'forbiddenWhen']);
const AUDIT_SUMMARY_MAX_CHARS = 240;
const AUDIT_BODY_PREFIX_CHARS = 60;
const AUDIT_VALUE_MAX_CHARS = 80;

/** 参与台账前后值比对的字段：只取用户/模型能改的那几维，治理派生量
 *  （validationCount、recommendedAction 等）由各自的 audit action 表达。 */
const AUDIT_DIFF_FIELDS = [
  'title', 'statement', 'type', 'scope', 'status', 'maturity', 'version',
  'applicableWhen', 'forbiddenWhen', 'evidenceRefs', 'deletedAt',
] as const;

function clipAuditText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 单个字段值 → 台账摘要文本。 */
export function summarizeAuditValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (AUDIT_BODY_FIELDS.has(field)) {
    const text = Array.isArray(value) ? value.map((entry) => String(entry)).join('；') : String(value);
    const size = Array.isArray(value) ? `${value.length} 条` : `${text.length} 字`;
    const flat = text.replace(/\s+/g, ' ').trim();
    const prefix = flat.slice(0, AUDIT_BODY_PREFIX_CHARS);
    // 短正文整段就是"前缀"——这时不给前缀等于台账什么都没说（用户看不出改了
    // 什么），而它本来也没超出前缀预算，没有多泄露任何东西。
    return prefix.length < flat.length ? `${size}·「${prefix}…」` : `${size}·「${prefix}」`;
  }
  if (Array.isArray(value)) return `${value.length} 项`;
  return clipAuditText(String(value), AUDIT_VALUE_MAX_CHARS);
}

export interface AuditFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** 变更集 → 台账的 `before`/`after` 两个摘要串。空变更集返回 undefined，
 *  调用方据此不写这两个字段（无变化的记录不该带空摘要）。 */
export function summarizeAuditChange(
  changes: readonly AuditFieldChange[],
): { before: string; after: string } | undefined {
  if (!changes.length) return undefined;
  const render = (pick: (change: AuditFieldChange) => unknown): string => {
    const joined = changes
      .map((change) => `${change.field}=${summarizeAuditValue(change.field, pick(change))}`)
      .join('；');
    return joined.length > AUDIT_SUMMARY_MAX_CHARS
      ? `${joined.slice(0, AUDIT_SUMMARY_MAX_CHARS)}…`
      : joined;
  };
  return { before: render((change) => change.before), after: render((change) => change.after) };
}

/** 比对两条资产记录，取出真正变了的那几维（供写路径生成台账前后值）。 */
export function diffAbilityAssetsForAudit(
  before: Partial<RecallAbilityAssetRecord>,
  after: Partial<RecallAbilityAssetRecord>,
): AuditFieldChange[] {
  const changes: AuditFieldChange[] = [];
  for (const field of AUDIT_DIFF_FIELDS) {
    const left = before[field];
    const right = after[field];
    if (JSON.stringify(left ?? null) === JSON.stringify(right ?? null)) continue;
    changes.push({ field, before: left, after: right });
  }
  return changes;
}

/**
 * 写路径的失败归因（specs/008 T032 · plan 的 AI Product Addendum 分类表）。
 *
 * 只影响"回执与台账怎么写归因"，**不改判定**：所有失败一律不得计为成功。
 * 认的是各写函数抛出的稳定英文消息（它们是不变量的一部分，不是展示文案），
 * 认不出的落 `unknown`——宁可归因不准，也不要假装知道原因。
 */
export function classifyAbilityAssetWriteFailure(error: unknown): AbilityAssetFailureCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('version conflict')) return 'workflow';
  if (message.includes('forbidden to persist')) return 'permission';
  if (
    message.includes('cannot be changed')
    || message.includes('has been purged')
    || message.includes('not restorable')
    || message.includes('retention window')
    || message.includes('review handoff')
  ) return 'governance';
  if (message.includes('not found')) return 'data';
  if (message.includes('evidence is required')) return 'evidence';
  if (message.includes('identity is immutable') || message.includes('invalid ') || message.includes('malformed ')) return 'schema';
  return 'unknown';
}

export interface AbilityAssetAuditMetadata {
  note?: string;
  reason?: string;
  actor?: AbilityAssetActor;
  before?: string;
  after?: string;
  failureCategory?: AbilityAssetFailureCategory;
  /** 这一步改动**之前**在用哪一版：回滚锚点。写路径自己填，渲染层的
   *  「回滚到改动前」直接拿它调 rollback——从 `before` 摘要里反解版本号是
   *  解析展示文本，迟早随文案改动而错。 */
  rollbackAnchor?: string;
}

async function appendAudit(userId: string, assetId: string, action: AbilityAssetAuditRecord['action'], metadata: AbilityAssetAuditMetadata = {}): Promise<void> {
  const at = new Date().toISOString();
  const reason = metadata.reason === undefined ? undefined : clipAuditText(metadata.reason, 1_000);
  // note 是既有消费方（渲染层生命周期记录 / timeline summary）在读的字段：
  // 没有单独给 note 时按 reason 落，保证「依据」在旧界面上照样看得见。
  const note = metadata.note === undefined ? reason : clipAuditText(metadata.note, 1_000);
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at,
    ...(metadata.actor ? { actor: metadata.actor } : {}),
    ...(note ? { note } : {}),
    ...(reason ? { reason } : {}),
    ...(metadata.before ? { before: metadata.before } : {}),
    ...(metadata.after ? { after: metadata.after } : {}),
    ...(metadata.failureCategory ? { failureCategory: metadata.failureCategory } : {}),
    ...(metadata.rollbackAnchor ? { rollbackAnchor: metadata.rollbackAnchor } : {}),
  } satisfies AbilityAssetAuditRecord);
}

/** 台账写入的公开口（specs/008 US-404）。
 *
 *  写路径自己记账的那几条（updated/deleted/…）不走这里；这个口给**工具层**用：
 *  危险操作的执行前快照与确认结果、以及被门禁拦下的写尝试——它们不产生版本
 *  变更，但必须留痕，否则"危险操作 100% 有执行前快照""零静默放行"两条承诺
 *  在失败路径上无从取证。
 *
 *  **不校验业务状态**（记录的是"发生过什么"，不是"资产现在是什么"）：调用方
 *  自己保证语义，就像 appendAudit 的既有调用点一样。 */
export async function recordAbilityAssetAudit(
  userId: string,
  assetId: string,
  action: AbilityAssetAuditRecord['action'],
  metadata: AbilityAssetAuditMetadata = {},
): Promise<void> {
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  await appendAudit(userId, assetId, action, metadata);
}

/**
 * 回滚/选用旧版时必须**显式清掉**的可选内容字段。
 *
 * `...content` 展开只能带上快照里**存在**的键：快照里缺席的可选字段会静默保留
 * 当前值——"改回去"于是只改了一半（回滚到没有 scopePolicy / 条件 / 定级的那一版，
 * 这些字段会原样留下）。这与 `updateAbilityAsset` 的条件清空是同一族缺陷，
 * 那处已修，这里（rollback 与 select 两条兄弟路径）一并清。
 *
 * 治理状态与成熟度**不在其列**：按设计不随内容回滚（暂停过的不该因回滚变回在用）。
 */
const VERSION_REVERT_CLEARABLE_FIELDS = [
  'scopePolicy', 'applicableWhen', 'forbiddenWhen',
  'ontologyRefs', 'relations', 'derivedFrom', 'learningSignal',
  'learningProvenance', 'sourceSessionIds',
] as const;

/** 把旧版快照里缺席的可选内容字段从目标记录上摘掉（见上）。 */
function clearFieldsAbsentFromSnapshot(
  target: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const field of VERSION_REVERT_CLEARABLE_FIELDS) {
    if (!(field in snapshot)) delete target[field];
  }
}

/** 当前在用版（回滚锚点取它）：select 切过旧版时 activeVersion 才是内容来源。 */
function activeVersionOf(asset: RecallAbilityAssetRecord): string {
  return String(asset.activeVersion || asset.version || '1');
}

/** 对外暴露同一个规则：工具层与渲染层都要回答"这条现在的在用版是几"，
 *  各自写一遍迟早会分叉（select 之后 activeVersion 才是内容来源）。 */
export function abilityAssetActiveVersion(
  asset: Pick<RecallAbilityAssetRecord, 'activeVersion' | 'version'>,
): string {
  return activeVersionOf(asset as RecallAbilityAssetRecord);
}

export async function initializeAbilityAsset(userId: string, asset: RecallAbilityAssetRecord, metadata: { reason?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const current = await listAbilityAssetVersions(userId, asset.id);
  if (!current.length) await appendVersion(userId, asset, metadata);
  const audit = await listAbilityAssetAudit(userId, asset.id);
  if (!audit.length) await appendAudit(userId, asset.id, 'created', metadata.reason || metadata.actor ? { note: metadata.reason, actor: metadata.actor } : {});
}

/** Formal-asset persistence boundary used by the candidate confirmation gate. */
export async function createAbilityAsset(
  userId: string,
  input: CreateAbilityAssetInput,
  metadata: { reason: string; actor: AbilityAssetActor },
): Promise<RecallAbilityAssetRecord> {
  if (metadata.actor !== 'user' && metadata.actor !== 'system') throw new Error('invalid ability asset creation actor');
  // 刀一（2026-09-19）：scope 写入点归一——词条放行、场景描述句兜底 general。
  if (input.scope !== undefined) input = { ...input, scope: resolveScopeForAsset(input.scope) };
  // 标题一等化闸门（设计 3.2 / 深探 F4）：create 收口补与 update 对称的 bounded
  // 归一（空白折叠、trim、≤120），随后过 3.1 判定。闸门放在收口处，任何调用方
  // （晋升、跨会话记忆、AI 管家、审批卡确认、未来新增）都无法绕过。
  input = { ...input, title: bounded(input.title, 'title', 120) };
  assertCompliantAbilityAssetTitle(input.title, input.statement);
  bounded(metadata.reason, 'reason', 1_000);
  assertNotForbiddenToPersist([
    input.title,
    input.statement,
    input.scope,
    JSON.stringify(input.evidenceRefs),
    input.learningSignal ? JSON.stringify(input.learningSignal) : undefined,
  ]);
  // 显式生命周期校验：asAsset 会把缺失值静默 coerce 成
  // user_confirmed_unverified——那会让下面 expectedLifecycle 门形同虚设
  // （user actor 传缺失值也能"伪造用户确认"通过）。
  if (input.lifecycleStatus !== 'user_confirmed_unverified'
    && input.lifecycleStatus !== 'automatically_extracted_unverified'
    && input.lifecycleStatus !== 'system_precipitated_unverified') {
    throw new Error('invalid ability asset lifecycle status');
  }
  const validated = asAsset(input);
  if (validated.ownerId !== userId) throw new Error('ability asset owner mismatch');
  if (!safeId(validated.candidateId) || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(validated.reviewDecisionId)) {
    throw new Error('invalid ability asset handoff identity');
  }
  // 出身收敛（2026-09-20）：lifecycle 不再有 actor 分支门（此前 system actor
  // 只许自动线两值）——模型记下来的=已确定，唯一新写入值 user_confirmed_
  // unverified；maturity 门保留（system 创建仍走 seed 档）。
  const expectedMaturity = metadata.actor === 'system' ? 'seed' : 'bud';
  if (validated.maturity !== expectedMaturity || validated.version !== '1') {
    throw new Error('invalid initial ability asset lifecycle');
  }
  // 执行类证据写入前解析（2026-09-18 乙档）：查无复盘记录的证据如实标
  // degraded——写入照常，但不让"造出来的 id"冒充 KSTAR 血统（渲染层据此
  // 显示「来源记录不可用」并排除出归边）。
  validated.evidenceRefs = (await resolveExecutionEvidenceRefs(userId, validated.evidenceRefs)) || [];
  const stored = asAsset(await updateRecallJsonRecord(
    userId,
    'ability-assets',
    validated.id,
    (current) => current || validated,
  ));
  if (stored.candidateId !== validated.candidateId || stored.reviewDecisionId !== validated.reviewDecisionId) {
    throw new Error('ability asset idempotency identity mismatch');
  }
  await initializeAbilityAsset(userId, stored, metadata);
  return stored;
}

// createSystemAbilityAsset（2026-09-20 出身收敛后保留）：产品代码零调用，
// 但 run-evidence 等 12 处测试用它建 KStar 历史版本快照（断言版本冻结与证
// 据链，与出身值无关）。校验从「只许自动线两值」放宽为三值合法——读旧兼容；
// 新写入单值由 promote 单值化保证。

/** System-authored formal asset boundary (KStar direct experience line).
 *  Content-addressed and idempotent: the same asset id is never duplicated. */
export async function createSystemAbilityAsset(
  userId: string,
  input: RecallAbilityAssetRecord,
  reason: string,
): Promise<RecallAbilityAssetRecord> {
  if (!safeId(userId) || !safeId(input.id) || !safeId(input.candidateId || '')) throw new Error('invalid system ability asset identity');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1_000) throw new Error('invalid system ability asset reason');
  const validated = asAsset(input);
  if (validated.ownerId !== userId) throw new Error('ability asset owner mismatch');
  validated.evidenceRefs = (await resolveExecutionEvidenceRefs(userId, validated.evidenceRefs)) || [];
  const stored = asAsset(await updateRecallJsonRecord(
    userId,
    'ability-assets',
    validated.id,
    (current) => current || validated,
  ));
  if (stored.candidateId !== validated.candidateId || stored.reviewDecisionId !== validated.reviewDecisionId) {
    throw new Error('ability asset idempotency identity mismatch');
  }
  await initializeAbilityAsset(userId, stored, { reason: reason.trim(), actor: 'system' });
  return stored;
}

export async function readAbilityAsset(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) throw new Error('recall ability asset not found');
  return asAsset(raw);
}

/** Keep the optional role-template view aligned with the canonical asset. The
 * prompt reader also rechecks live eligibility, so a transient cleanup failure
 * cannot make a paused or restricted asset visible to a task. */
async function reconcilePersonalProfileProjection(
  userId: string,
  asset: RecallAbilityAssetRecord,
): Promise<void> {
  try {
    const profileSync = await import('./personal-profile-sync');
    const canProject = asset.type === 'personal'
      && asset.status === 'active'
      && !(asset.ontologyRefs?.length);
    if (canProject) {
      await profileSync.schedulePersonalProfileSync(userId, { assetId: asset.id });
      return;
    }
    const result = await profileSync.removePersonalProfileProjectionForAsset(userId, asset.id);
    if (!result.ok) {
      log.warn('personal profile projection cleanup needs review', {
        userId,
        assetId: asset.id,
        error: result.error,
      });
    }
  } catch (error) {
    log.warn('personal profile projection reconciliation failed', {
      userId,
      assetId: asset.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listAbilityAssets(userId: string): Promise<RecallAbilityAssetRecord[]> {
  let names: string[];
  try { names = await fs.readdir(assetsDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => name.slice(0, -5));
  // 逐条降级，而不是让一条坏资产把全部资产列表读失败（照抄同目录
  // listRecallCandidates / listExperiences 的既有口径）：记录形状的不变量
  // 分布在两层——store 的 validateRecallRecord 和这里的 asAsset——任一层
  // 一抛，主列表/空间 tab/收件箱聚合/巡检/启动迁移全挂，好资产也列不出。
  //
  // 只降级**记录形状**的错。真正的 IO 故障（EACCES / EISDIR……）带 errno code，
  // 照旧上抛：那种情况下静默少几条，等于把磁盘问题伪装成「资产变少了」。
  const reads = await Promise.all(ids.map(async (id) => {
    try {
      return { id, record: await readRecallJsonRecord(userId, 'ability-assets', id) };
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      return { id, error: error as Error };
    }
  }));
  const assets: RecallAbilityAssetRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable recall ability asset', { assetId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      assets.push(asAsset(read.record));
    } catch (error) {
      log.warn('skipped a malformed recall ability asset', { assetId: read.id, error: (error as Error).message });
    }
  }
  return assets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 某空间沉淀的资产（按 spaceId 过滤；资产随 recall 全局存储，不随空间删）。
 *  空间能读到全局资产（引用/检索走 listAbilityAssets），但空间资产 tab 只显示本空间的。
 *  **已撤销（revoked）的资产不显示**（用户撤销后从空间资产列表消失；全局认知资产页仍可见）。 */
export async function listAbilityAssetsForSpace(userId: string, spaceId: string): Promise<RecallAbilityAssetRecord[]> {
  if (!safeId(spaceId)) return [];
  const all = await listAbilityAssets(userId);
  return all.filter((asset) => asset.spaceId === spaceId && asset.status !== 'revoked');
}

/** tags-only 更新判定（specs/012 T004）：除 tags/reason/actor/expectedVersion 外
 *  没有别的字段 = 纯标签元数据更新，走不 bump 版本的路径；任何内容字段在场
 *  都走既有内容路径（版本照常 bump，标签随同写入但不进版本快照）。 */
const TAGS_ONLY_METADATA_KEYS = new Set(['tags', 'reason', 'actor', 'expectedVersion']);

function isTagsOnlyUpdate(input: UpdateAbilityAssetInput): boolean {
  return Object.keys(input).every((key) => TAGS_ONLY_METADATA_KEYS.has(key));
}

function sameTagList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** 台账里的标签变更注记：只存标签名（元数据，非正文），形如「标签：a、b → c」。 */
function formatTagNames(names: readonly string[]): string {
  return names.length ? names.join('、') : '（无）';
}

export async function updateAbilityAsset(userId: string, assetId: string, input: UpdateAbilityAssetInput): Promise<RecallAbilityAssetRecord> {
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  // 刀一（2026-09-19）：scope 写入点归一——词条放行、场景描述句兜底 general。
  if (input.scope !== undefined) input = { ...input, scope: resolveScopeForAsset(input.scope) };
  const action = requireAssetAction(input);
  // 标签规范化唯一处在 ability-tag-service（specs/012 反漂移 II4），这里不另写。
  // 缺失的库条目**先补建**再写资产（createdFrom 按调用来源：模型打标 = ai），
  // 保证"资产引用的每个名字都有 active 条目"不被写路径自己打破。
  const tagsInput = input.tags === undefined ? undefined : normalizeAbilityTagList(input.tags);
  if (tagsInput !== undefined) {
    await ensureAbilityTags(userId, tagsInput, action.actor === 'ai' ? 'ai' : 'user');
  }
  const evidenceRefs = input.evidenceRefs === undefined
    ? undefined
    : await resolveExecutionEvidenceRefs(userId, normalizeCognitionSourceRefs(input.evidenceRefs));
  if (evidenceRefs && !evidenceRefs.length) throw new Error('ability asset evidence is required');
  const ontologyRefs = input.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(input.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(input as unknown as Record<string, unknown>, assetId);
  const semantics = readAbilityAssetSemantics(input as unknown as Record<string, unknown>);
  const scopePolicy = input.scopePolicy === undefined ? undefined : normalizeAbilityAssetScopePolicy(input.scopePolicy);
  const reviewDecisionId = input.reviewDecisionId;
  const sourceCandidateId = input.sourceCandidateId;
  if ((reviewDecisionId === undefined) !== (sourceCandidateId === undefined)) throw new Error('incomplete ability asset review handoff');
  if (reviewDecisionId !== undefined && !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) throw new Error('invalid ability asset review decision');
  if (sourceCandidateId !== undefined && !safeId(sourceCandidateId)) throw new Error('invalid ability asset source candidate');
  if (action.actor === 'system' && reviewDecisionId === undefined) {
    throw new Error('system asset action requires an automatic review handoff');
  }
  assertNotForbiddenToPersist([
    input.title,
    input.statement,
    input.scope,
    // 条件同样是用户手写、会被冻进能力包并注入提示的自由文本，
    // 不过闸就等于给凭证留了一条只换字段名的旁路。
    ...(semantics.applicableWhen || []),
    ...(semantics.forbiddenWhen || []),
    // 标签同上：会进筛选提示的自由文本（specs/012）。
    ...(tagsInput || []),
  ]);
  let clearedRecommendation = false;
  let changed = false;
  let tagsChanged = false;
  let beforeAsset: RecallAbilityAssetRecord | undefined;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 统一终态守卫（2026-09-17 对齐）：此前只挡 purged/revoked，已删除资产
    // 仍可被 update 改内容并 bump 版本——与 select/rollback/merge 同口径。
    assertMutableAbilityAsset(current);
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new Error(
        `ability asset version conflict: expected v${input.expectedVersion}, current v${current.version}`,
      );
    }
    // 标签元数据路径（specs/012 T004）：tags-only 更新**不 bump 内容版本**——
    // 标签是元数据不是内容（对齐 family.ts:232 的 familyName 直写先例）；
    // 版本快照不含 tags（见 snapshot()），version-diff 因此永远不出现标签项。
    // 规范化后无变化 = 不写不记账（幂等：同名打标不产生第二条台账）。
    // 清空的盘上形态是键缺席（与 applicableWhen 的显式清空同款），缺失与 []
    // 都表示「未分类」。
    if (isTagsOnlyUpdate(input)) {
      if (tagsInput === undefined || sameTagList(current.tags || [], tagsInput)) return current;
      changed = false;
      tagsChanged = true;
      beforeAsset = current;
      const tagOnly: RecallAbilityAssetRecord = {
        ...current,
        ...(tagsInput.length ? { tags: tagsInput } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (!tagsInput.length) delete tagOnly.tags;
      return tagOnly;
    }
    changed = true;
    beforeAsset = current;
    clearedRecommendation = Boolean(current.recommendedAction && input.acknowledgeRecommendation);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: bounded(input.statement, 'statement', 4_000) } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(input.scopePolicy !== undefined && scopePolicy ? { scopePolicy } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      ...(ontologyRefs !== undefined ? { ontologyRefs } : {}),
      ...relationContract,
      ...semantics,
      version: nextVersion(current.version),
      activeVersion: nextVersion(current.version),
      ...(reviewDecisionId ? {
        appliedReviewDecisionIds: [...new Set([...(current.appliedReviewDecisionIds || []), reviewDecisionId])],
        sourceCandidateIds: [...new Set([...(current.sourceCandidateIds || [current.candidateId]), sourceCandidateId!])],
        reviewDecisionId,
      } : {}),
      // 标签随内容路径整组替换（快照不含 tags：元数据不进版本链）。
      ...(tagsInput?.length ? { tags: tagsInput } : {}),
      updatedAt: new Date().toISOString(),
    };
    // An explicitly supplied empty policy means “remove all restrictions”.
    // `normalizeAbilityAssetScopePolicy({})` returns undefined to represent an
    // absent policy in stored records, so use the input-presence check to tell
    // that deliberate clear apart from an omitted update field.
    if (input.scopePolicy !== undefined && !scopePolicy) delete next.scopePolicy;
    if (tagsInput !== undefined && !tagsInput.length) delete next.tags;
    if (tagsInput !== undefined && !sameTagList(current.tags || [], tagsInput)) tagsChanged = true;
    if (clearedRecommendation) {
      delete next.recommendedAction;
      delete next.recommendationReason;
      delete next.recommendationAt;
    }
    // 边界条件清空语义：readAbilityAssetSemantics 把空数组折叠为键缺席，
    // `...semantics` 展开后「删光所有条件」的更新会静默变回旧值。传了键却
    // 没折出值的维度 = 显式清空（盘上形态：键缺席），把现值从记录上拿掉。
    if (input.applicableWhen !== undefined && !semantics.applicableWhen) delete next.applicableWhen;
    if (input.forbiddenWhen !== undefined && !semantics.forbiddenWhen) delete next.forbiddenWhen;
    // 标题一等化闸门（设计 3.2 / 深探 F1）：title 在场即过 3.1 判定，比对用的
    // 正文是写入后的最终值（本次未改正文 = 在用正文）。闸门拦的是**写入**：
    // 存量遗留的不合规标题只要本次不写 title 就不受影响，不会被这里卡死。
    if (input.title !== undefined) assertCompliantAbilityAssetTitle(next.title, next.statement);
    return next;
  });
  const asset = asAsset(updated);
  if (changed || tagsChanged) {
    // 标签是元数据：tags-only 改动不进版本流（不 appendVersion）、不 bump
    // version/activeVersion，只进台账；内容路径照旧进版本流。
    if (changed) {
      await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
    }
    const summary = summarizeAuditChange(
      diffAbilityAssetsForAudit(beforeAsset ?? asset, asset),
    );
    // 台账 reason 必含「标签：旧 → 新」（specs/012 data-model §3 台账纪律）——
    // 只存标签名（元数据，非正文）。
    const tagNote = tagsChanged && beforeAsset
      ? `标签：${formatTagNames(beforeAsset.tags || [])} → ${formatTagNames(asset.tags || [])}`
      : undefined;
    await appendAudit(userId, asset.id, 'updated', {
      reason: tagNote ? `${action.reason}｜${tagNote}` : action.reason,
      actor: action.actor,
      ...(summary ? { before: summary.before, after: summary.after } : {}),
      ...(beforeAsset ? { rollbackAnchor: activeVersionOf(beforeAsset) } : {}),
    });
    if (changed && clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
  }
  if (changed) await reconcilePersonalProfileProjection(userId, asset);
  if (changed && beforeAsset && asset.title !== beforeAsset.title) {
    // 标题一等化硬前提（设计 3.3 / 深探 F6）：改 title 走内容路径必然 bump
    // version，而 committed 投影读取强校验「冻结版本 == 资产当前版本」，不匹配
    // 即整组拒绝注入且无回退。一切改标题写入必须伴随投影版本刷新——与 scope
    // 迁移（2026-09-14）同口径，动态 import 避开 asset-service ↔
    // context-projection 静态循环依赖。资产写已落盘：刷新失败只记 error 不回滚
    // （回滚救不回已 bump 的版本号），留给下次写入或迁移修复。
    try {
      const { refreshCommittedProjectionAssetVersion } = await import('./context-projection');
      const refreshed = await refreshCommittedProjectionAssetVersion(userId, asset.id, String(asset.version));
      if (refreshed > 0) {
        log.info(`title change refreshed committed projections assetId=${asset.id} count=${refreshed}`);
      }
    } catch (error) {
      log.error('committed projection refresh failed after title change', {
        userId,
        assetId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return asset;
}

/** 证据并入资产（内容变化即 bump 版本 + 快照 + 审计）。
 *  调用方：候选语义去重融合路径（candidate-service 无权限直接访问
 *  appendVersion/appendAudit 内部函数）。 */
export async function mergeAbilityAssetEvidence(
  userId: string,
  assetId: string,
  newRefs: Array<Pick<CognitionSourceRef, 'kind' | 'id'> | CognitionSourceRef>,

  metadata: { reason: string; actor: AbilityAssetActor; sourceSessionIds?: string[] },
): Promise<RecallAbilityAssetRecord> {
  const current = await readAbilityAsset(userId, assetId);
  if (!current) throw new Error('recall ability asset not found');
  // 2026-09-28 红队补齐：与 updateAbilityAsset 同口径（assertMutable 挡
  // purged/revoked/deleted）。此前只挡 purged/revoked——已删除资产仍会被
  // 语义去重融合路径 bump 版本、追加快照，违反「保留期内不可变」。
  assertMutableAbilityAsset(current);
  // 只解析这批**新**证据（2026-09-18 乙档）：库里既有的引用原样放行——
  // 旧记录指向已被清理的复盘是既成事实，不该由一次融合触发版本重写；
  // 它们的诚实态由渲染层的"请求过但没有"兜底。
  const incoming = (await resolveExecutionEvidenceRefs(userId, normalizeCognitionSourceRefs(newRefs))) || [];
  const sourceSessionIds = [...new Set([
    ...(current.sourceSessionIds || []),
    ...(metadata.sourceSessionIds || []).filter((id) => safeId(id)),
  ])].slice(0, 50);
  const updated = asAsset(await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const cur = asAsset(raw);
    assertMutableAbilityAsset(cur);
    // 融合在锁内基于最新 cur 重算（2026-09-28）：锁外预计算的 merged 会把
    // 并发 updateAbilityAsset 刚写入的引用集整体覆写（丢更新窗口）。
    const merged = mergeRefsDedup(cur.evidenceRefs || [], incoming);
    const mergedSessions = [...new Set([
      ...(cur.sourceSessionIds || []),
      ...(metadata.sourceSessionIds || []).filter((id) => safeId(id)),
    ])].slice(0, 50);
    const changed = merged.length !== (cur.evidenceRefs || []).length
      || merged.some((ref, i) => JSON.stringify(ref) !== JSON.stringify((cur.evidenceRefs || [])[i]))
      || mergedSessions.length !== (cur.sourceSessionIds || []).length;
    if (!changed) return cur;
    return {
      ...cur,
      evidenceRefs: merged,
      ...(mergedSessions.length ? { sourceSessionIds: mergedSessions } : {}),
      version: nextVersion(cur.version),
      activeVersion: nextVersion(cur.version),
      updatedAt: new Date().toISOString(),
    };
  }));
  await appendVersion(userId, updated, metadata);
  await appendAudit(userId, assetId, 'updated', metadata);
  return updated;
}

function mergeRefsDedup(
  left: RecallAbilityAssetRecord['evidenceRefs'],
  right: CognitionSourceRef[],

): RecallAbilityAssetRecord['evidenceRefs'] {
  const seen = new Set<string>();
  // 入参可能携带宽松引用（仅 kind/id）；按现有语义去重并原样写回。
  const out: Array<RecallAbilityAssetRecord['evidenceRefs'][number] | { kind: string; id: string }> = [];
  for (const ref of [...left, ...right]) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out as RecallAbilityAssetRecord['evidenceRefs'];
}

const STATUS_AUDIT_ACTION: Record<RecallAbilityAssetRecord['status'], AbilityAssetAuditRecord['action']> = {
  active: 'resumed',
  paused: 'paused',
  archived: 'archived',
  deleted: 'deleted',
  purged: 'purged',
  revoked: 'revoked',
};

function assertNotPurged(current: RecallAbilityAssetRecord): void {
  if (current.status === 'purged') throw new Error('ability asset has been purged');
}

/** 版本组写路径的统一终态守卫（2026-09-16 检修）：purged/revoked/deleted 都
 *  不可再变更内容或版本——与 updateAbilityAsset 的 revoked 口径一致，此前
 *  select/rollback/merge 只查 purged，绕过了"撤回不可变更"与删除保留期。 */
function assertMutableAbilityAsset(current: RecallAbilityAssetRecord): void {
  assertNotPurged(current);
  if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
  if (current.status === 'deleted') throw new Error('deleted ability asset cannot be changed');
}

async function setStatus(
  userId: string,
  assetId: string,
  status: RecallAbilityAssetRecord['status'],
  input: AbilityAssetUserActionInput,
  mutate?: (current: RecallAbilityAssetRecord) => Partial<RecallAbilityAssetRecord>,
  guard?: (current: RecallAbilityAssetRecord) => void,
  auditAction: AbilityAssetAuditRecord['action'] = STATUS_AUDIT_ACTION[status],
): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  const reviewDecisionId = input.reviewDecisionId;
  const sourceCandidateId = input.sourceCandidateId;
  if ((reviewDecisionId === undefined) !== (sourceCandidateId === undefined)) throw new Error('incomplete ability asset review handoff');
  if (reviewDecisionId !== undefined && !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) throw new Error('invalid ability asset review decision');
  if (sourceCandidateId !== undefined && !safeId(sourceCandidateId)) throw new Error('invalid ability asset source candidate');
  // 评审交接要求只覆盖内容/治理变更。保留期到期清理是**策略触发**，没有可指的
  // 评审决定——凭空造一个 rd_ 只会污染 appliedReviewDecisionIds，让日后回看以为
  // 这条经过了一次人工评审。终态清除因此豁免（specs/008 T005 到期自动彻底删除）。
  if (action.actor === 'system' && status !== 'purged' && reviewDecisionId === undefined) {
    throw new Error('system asset action requires an automatic review handoff');
  }
  let clearedRecommendation = false;
  let changed = false;
  let beforeAsset: RecallAbilityAssetRecord | undefined;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertNotPurged(current);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new Error(
        `ability asset version conflict: expected v${input.expectedVersion}, current v${current.version}`,
      );
    }
    if (current.status === 'revoked' && status !== 'revoked' && status !== 'purged') {
      throw new Error('revoked ability asset cannot be changed');
    }
    // deleted 与 revoked 同为终态守卫口径（2026-09-28 红队补齐）：保留期内的
    // 删除只许重复 delete（幂等）、到期/手动 purge，或经 restore（auditAction
    // 'restored'，自带保留期 guard）回 active。此前 pause/resume/archive/revoke
    // 四条 setStatus 路径不挡 deleted——resume 可让已删除资产绕过保留期复活。
    if (current.status === 'deleted' && status !== 'deleted' && status !== 'purged' && auditAction !== 'restored') {
      throw new Error('deleted ability asset cannot be changed');
    }
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    guard?.(current);
    changed = current.status !== status || Boolean(reviewDecisionId);
    beforeAsset = current;
    clearedRecommendation = Boolean(current.recommendedAction && status !== 'active');
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(mutate ? mutate(current) : {}),
      status,
      ...(reviewDecisionId ? {
        appliedReviewDecisionIds: [...new Set([...(current.appliedReviewDecisionIds || []), reviewDecisionId])],
        sourceCandidateIds: [...new Set([...(current.sourceCandidateIds || [current.candidateId]), sourceCandidateId!])],
        reviewDecisionId,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (clearedRecommendation) {
      delete next.recommendedAction;
      delete next.recommendationReason;
      delete next.recommendationAt;
    }
    return next;
  });
  const asset = asAsset(updated);
  if (changed) {
    const summary = summarizeAuditChange(
      diffAbilityAssetsForAudit(beforeAsset ?? asset, asset),
    );
    await appendAudit(userId, asset.id, auditAction, {
      reason: action.reason,
      actor: action.actor,
      ...(summary ? { before: summary.before, after: summary.after } : {}),
      // 状态改动**不**留回滚锚点：它不 bump 版本，"回滚到改动前那一版"等于回滚到
      // 当前版（服务层会正当拒绝）。状态的回退走 restore，不是内容回滚——把锚点
      // 写上去只会让界面给出一个点了必然报错的按钮。
    });
    if (clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
    await reconcilePersonalProfileProjection(userId, asset);
  }
  return asset;
}

export function pauseAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'paused', input);
}

export function revokeAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'revoked', input);
}

export function resumeAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', input);
}

/**
 * 记下用户确认「这条可以跨作用域使用」，或撤回这个确认。
 *
 * 规范 10.2 把跨作用域定为 confirm 档。既然规范要求「确认」，系统就得有地方
 * 记下确认发生过——否则那一档只会永远停在等待里：选择层算出 confirm、渲染侧
 * 不注入、回执记 needs_confirmation，然后没有任何人能让它继续走下去。
 *
 * 做成资产上的持久授权而不是每轮弹窗：它和 pause/revoke 是同一类东西——用户
 * 的一次决定，可审计、可撤回、在详情页看得见。每轮打断反而会让用户养成闭眼
 * 点确认的习惯，那时候这道闸就名存实亡了。
 *
 * 撤销后立刻回到 confirm 档：授权是可收回的，不是一次性放行。
 */
/**
 * correctMisfiledSeedMaturity 已随出身收敛退役（2026-09-20）：它是一次性
 * 历史归档修正（33a16ad 前 promote 出的 lifecycleStatus/maturity 矛盾资产
 * 升 seed→bud），早已跑完空转；出身单值化后「按 lifecycle 区分」的判据也
 * 不复存在。函数体与启动注册一并移除。
 */

/** 作用域中文标签（与 renderer _abilityAssetScopeLabel 一致；展示层另有映射，
 *  这里仅用于迁移时生成中文标题）。 */
export function userScopeLabel(scope: string): string {
  const map: Record<string, string> = {
    report: '报告类任务', code: '代码类任务', review: '审查类任务',
    product: '产品类任务', general: '通用',
  };
  return map[scope] || scope;
}

/** 一次性幂等迁移（2026-08-15 UI 优化）：旧 KStar 线资产带英文技术标题
 *  （'Reusable experience lesson (requirement-level)' 等），用户看不懂。
 *  只改写匹配的 title / statement 前缀，内容/证据/版本不动。可重复运行。 */
export async function migrateLegacyUserFacingTitles(userId: string): Promise<number> {
  let migrated = 0;
  const titleRules: Array<[RegExp, (scope: string) => string]> = [
    [/^Reusable experience lesson \(requirement-level\)$/, (s) => `可复用经验（${userScopeLabel(s)}）`],
    [/^KSTAR rule gap candidate \(requirement-level\)$/, (s) => `待修正的经验（${userScopeLabel(s)}）`],
    [/^Reusable workflow lesson$/, () => '可复用经验'],
    [/^Verified multi-tool workflow$/, () => '已验证的工作流程'],
  ];
  for (const asset of await listAbilityAssets(userId)) {
    // deleted 一并跳过（2026-09-28 红队补齐）：迁移是维护性内容改写，保留期内
    // 的删除同样不可变——此前只跳过 revoked/purged，deleted 资产会被改标题并
    // bump 版本，与 assertMutableAbilityAsset 的口径冲突。
    if (asset.status !== 'active' && asset.status !== 'paused' && asset.status !== 'archived') continue;
    const scope = String(asset.scope || '');
    let nextTitle: string | undefined;
    for (const [pattern, build] of titleRules) {
      if (pattern.test(String(asset.title || ''))) { nextTitle = build(scope); break; }
    }
    const gap = String(asset.statement || '').match(/^For similar tasks, address this [a-z_ ]+: ([\s\S]*)$/);
    const nextStatement = gap ? `遇到同类情况时，应注意修正：${gap[1].trim()}` : undefined;
    if (!nextTitle && !nextStatement) continue;
    try {
      // 版本递增 + 内容快照 + 审计，与 updateAbilityAsset 同一机制。
      // （不能直接调 updateAbilityAsset：system actor 要求自动评审交接
      //  reviewDecisionId，而迁移是维护性更新非评审产物。）旧实现直接
      //  改写 title/statement 不 bump 版本，导致冻结快照与实时内容分叉
      //  （确认投影永远注入旧英文标题）。
      await updateRecallJsonRecord(userId, 'ability-assets', asset.id, (raw) => {
        if (!raw) throw new Error('recall ability asset not found');
        const current = asAsset(raw);
        // 锁内终态复核（r2 补齐）：外层快照过滤只对快照时刻有效，遍历期间
        // 资产可能已被删除/撤回——闭包抛错发生在 writeJson 之前，整个
        // runExclusive reject 不落盘，外层 catch 记 warn 跳过该资产继续。
        assertMutableAbilityAsset(current);
        if (nextTitle) current.title = nextTitle;
        if (nextStatement) current.statement = nextStatement;
        current.version = nextVersion(current.version);
        current.updatedAt = new Date().toISOString();
        return current;
      });
      const migratedAsset = await readAbilityAsset(userId, asset.id);
      if (migratedAsset) {
        await appendVersion(userId, migratedAsset, {
          reason: 'legacy English title → user-facing Chinese (2026-08-15)',
          actor: 'system',
        });
        await appendAudit(userId, asset.id, 'updated', {
          note: 'legacy English title → user-facing Chinese (2026-08-15)',
          actor: 'system',
        });
      }
      migrated += 1;
    } catch (err) {
      log.warn(`ability asset title migration skipped id=${asset.id}: ${(err as Error).message}`);
    }
  }
  if (migrated) log.info(`ability asset legacy titles migrated count=${migrated}`);
  return migrated;
}

/** 一次性幂等迁移（A 轨道 · 2026-09-13 scope 枚举化）：存量自由文本 scope
 *  （"用户全局画像"、"该用户的身份与沟通定位…"）能安全归一词表的改写为
 *  词表值——否则它们在自动投影里永远匹配不上任务词（context-projection
 *  scopeAppliesToPurpose），用户确认过的资产在正式通道全部失配（实机：
 *  proj-a3ae7e6a3646 两条身份资产 omittedRefs=scope_mismatch）。
 *
 *  只改写 normalizeAssetScopeValue 能归一的；词表值原样跳过（幂等）。
 *  不设 confirmed-投影冻结豁免（首版设了，实机验证推翻）：自动投影
 *  （proj-auto-*）永不过期且每轮重建，豁免窗口永远不打开。版本递增对
 *  committed 投影并不"天然安全"——committed 校验器在读快照前就强校验
 *  版本号，因此迁移在 bump 后必须同步刷新仍存活 confirmed 投影的
 *  assetVersions（refreshCommittedProjectionAssetVersion，2026-09-14 补），
 *  否则 requirement 存续期内每回合注入整体失败且无回退。 */
export async function migrateLegacyFreeTextScopes(userId: string): Promise<number> {
  const { normalizeAssetScopeValue, isRecallScopeTerm } = await import('./scope-policy');
  let migrated = 0;
  for (const asset of await listAbilityAssets(userId)) {
    // 同上：迁移不触碰终态/保留期资产（2026-09-28 红队补齐，与标题迁移同口径）。
    if (asset.status !== 'active' && asset.status !== 'paused' && asset.status !== 'archived') continue;
    const scope = String(asset.scope || '');
    if (isRecallScopeTerm(scope)) continue;
    const normalized = normalizeAssetScopeValue(scope);
    if (!normalized || normalized === scope.toLowerCase()) continue;
    try {
      await updateRecallJsonRecord(userId, 'ability-assets', asset.id, (raw) => {
        if (!raw) throw new Error('recall ability asset not found');
        const current = asAsset(raw);
        // 同上（r2 补齐）：锁内终态复核，墓碑/撤回资产不进改写。
        assertMutableAbilityAsset(current);
        current.scope = normalized;
        current.version = nextVersion(current.version);
        current.updatedAt = new Date().toISOString();
        return current;
      });
      const migratedAsset = await readAbilityAsset(userId, asset.id);
      if (migratedAsset) {
        // committed 投影冻结了旧版本号：必须同步刷新（动态 import 避免
        // asset-service ↔ context-projection 静态循环依赖）。
        const { refreshCommittedProjectionAssetVersion } = await import('./context-projection');
        const refreshed = await refreshCommittedProjectionAssetVersion(userId, asset.id, String(migratedAsset.version));
        if (refreshed > 0) {
          log.info(`scope migration refreshed committed projections assetId=${asset.id} count=${refreshed}`);
        }
        await appendVersion(userId, migratedAsset, {
          reason: `legacy free-text scope "${scope}" → controlled term "${normalized}" (2026-09-13 scope enumeration)`,
          actor: 'system',
        });
        await appendAudit(userId, asset.id, 'updated', {
          note: `legacy free-text scope "${scope}" → controlled term "${normalized}"`,
          actor: 'system',
        });
      }
      migrated += 1;
    } catch (err) {
      log.warn(`ability asset scope migration skipped id=${asset.id}: ${(err as Error).message}`);
    }
  }
  if (migrated) log.info(`ability asset legacy scopes migrated count=${migrated}`);
  return migrated;
}

export async function setAbilityAssetCrossScopeConfirmation(
  userId: string,
  assetId: string,
  confirmed: boolean,
  input: AbilityAssetUserActionInput,
): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  let changed = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 2026-09-28 红队补齐：跨范围授权是对内容的授权，deleted 资产上预埋授权
    // 会让恢复后的资产带着一条用户没有重新确认过的许可。
    assertMutableAbilityAsset(current);
    if (Boolean(current.crossScopeConfirmedAt) === confirmed) return current;
    changed = true;
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(confirmed ? { crossScopeConfirmedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!confirmed) delete next.crossScopeConfirmedAt;
    return next;
  });
  const asset = asAsset(updated);
  if (changed) {
    await appendAudit(userId, asset.id, confirmed ? 'cross_scope_confirmed' : 'cross_scope_withdrawn', {
      note: action.reason,
      actor: action.actor,
    });
  }
  return asset;
}

export async function recommendAbilityAssetAction(userId: string, assetId: string, input: RecommendAbilityAssetActionInput): Promise<RecallAbilityAssetRecord> {
  if (input.action !== 'pause' && input.action !== 'rework') throw new Error('invalid ability asset recommendation');
  const reason = bounded(input.reason, 'recommendation reason', 1_000);
  const actor = input.actor === 'system' ? 'system' : input.actor === 'user' ? 'user' : undefined;
  if (!actor) throw new Error('invalid ability asset recommendation actor');
  let appended = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 2026-09-28 红队补齐：推荐卡只对可变更资产有意义（与内容写路径同口径）。
    assertMutableAbilityAsset(current);
    if (current.recommendedAction === input.action && current.recommendationReason === reason) return current;
    appended = true;
    return { ...current, recommendedAction: input.action, recommendationReason: reason, recommendationAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (appended) await appendAudit(userId, asset.id, input.action === 'pause' ? 'pause_recommended' : 'rework_recommended', { note: reason, actor });
  return asset;
}

/** 归档：从日常列表移出、不参与推荐，历史与 Evidence 保留，可恢复（规范 22.1）。 */
export function archiveAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'archived', input);
}

/**
 * 删除：移出可用资产并进入保留期，保留期内可恢复（规范 22.1）。
 *
 * 只写 `deletedAt` 这个事实，保留期是否届满由 `isWithinDeletionRetention` 现算。
 * 重复删除会刷新计时，所以已是 deleted 的记录保留原时间戳——否则用户点两次
 * 删除就把保留期悄悄延长了。
 */
export function deleteAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'deleted', input, (current) => (
    current.status === 'deleted' && current.deletedAt
      ? {}
      : { deletedAt: new Date().toISOString() }
  ));
}

/**
 * 彻底清除：删除内容、版本和可识别副本，仅保留不可识别的审计最小项（规范 22.1）。
 *
 * 留墓碑而不是删记录：Receipt 里已经写着 `asset:<id>@v<version>`，记录整个消失
 * 会让历史回执指向虚空，回放时无从判断这条引用是被清除了还是从未存在。墓碑保留
 * id、candidateId、owner 与时间线，清空标题、正文、证据与全部语义字段。
 *
 * 版本快照一并清空——它们同样含正文，留着就不算「删除内容和版本」。
 */
export async function purgeAbilityAsset(
  userId: string,
  assetId: string,
  input: AbilityAssetUserActionInput,
  options: { requireDeleted?: boolean } = {},
): Promise<RecallAbilityAssetRecord> {
  const asset = await setStatus(userId, assetId, 'purged', input, () => ({
    title: '',
    statement: '',
    evidenceRefs: [],
    purgedAt: new Date().toISOString(),
    learningSignal: undefined,
    ontologyRefs: undefined,
    relations: undefined,
    derivedFrom: undefined,
    // 适用/禁用条件是用户手写的自然语言，与正文同属可识别内容。
    applicableWhen: undefined,
    forbiddenWhen: undefined,
    // 跨域授权是对一条已经不存在的内容的授权，留着没有意义，也不该让墓碑
    // 继续携带一个「可以跨作用域使用」的许可。
    crossScopeConfirmedAt: undefined,
    scopePolicy: undefined,
    recommendedAction: undefined,
    recommendationReason: undefined,
    recommendationAt: undefined,
    sourceSessionIds: undefined,
    // 族名是用户手写的分类名（元数据），与正文同属可识别内容：墓碑留着它
    // 等于把用户取的名字留在一条"已彻底清除"的记录上。
    familyName: undefined,
    // 成熟度是对已清除内容的效果声明（2026-09-28 补）：与 sensitivity 同理，
    // 墓碑不该继续声称「这条已验证」。
    maturity: undefined,
  } as Partial<RecallAbilityAssetRecord>),
  // 到期清扫传 requireDeleted（2026-09-28 补）：锁内复核仍是 deleted 才清——
  // 清扫列表是锁外读的快照，窗口期内被用户恢复的资产不许被照单清除。
  options.requireDeleted
    ? (current: RecallAbilityAssetRecord) => {
      if (current.status !== 'deleted') throw new Error('retention purge requires a deleted asset');
    }
    : undefined);
  // 版本快照同样含正文，留着就不算「删除内容和版本」。审计流保留：它只有
  // 动作名和时间戳，属于规范允许保留的不可识别最小项。
  await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
  await cascadePurgeAssetReferences(userId, assetId);
  return asset;
}

/**
 * 彻底清除的级联段（specs/008 T005）。
 *
 * 正文副本散落在哪几处，就要清到哪几处——只清主记录和版本流不够：
 *   - `usage-records` / `asset-usage-receipts` / `injection-receipts` 的 events
 *     流里带着 assetId 与版本，是"这条资产被用过"的可识别痕迹；
 *   - 投影里的 `assetVersionSnapshots` 是「版本真删」时冻结的**内容副本**
 *     （见 deleteAbilityAssetVersion），正文就在里面；
 *   - 本体回流候选池的 `asset-backflow-<assetId>` 候选（见 ontology-backflow）
 *     的 memory_text 就是 statement 全文——候选确认不查来源资产存活性，
 *     留着它等于留了一条「确认即复活」的通道。
 * 留下任何一处，「内容与记录一并清除、搜索不可见、不可恢复」都不成立。
 *
 * 幂等：流不存在或没有匹配行都不报错、不写新账——反复清除不会留下重复痕迹。
 */
async function cascadePurgeAssetReferences(userId: string, assetId: string): Promise<void> {
  const dropAsset = (record: RecallJsonRecord) => String(record.assetId || '') !== assetId;
  await removeRecallJsonlRecords(userId, 'usage-records', 'events', dropAsset);
  await removeRecallJsonlRecords(userId, 'asset-usage-receipts', 'events', dropAsset);
  await removeRecallJsonlRecords(userId, 'injection-receipts', 'events', dropAsset);
  // 动态 import：asset-service ↔ context-projection 静态互引会成环。
  const { clearAssetFromAllProjections } = await import('./context-projection');
  const cleared = await clearAssetFromAllProjections(userId, assetId);
  if (cleared > 0) {
    log.info(`purge cascade cleared frozen asset copies from projections assetId=${assetId} projections=${cleared}`);
  }
  // 动态 import 同上先例：候选池模块（personal_ontology_candidates /
  // ontology-backflow）静态互引同样会牵出成环依赖。rejectCandidate 按
  // candidate_id 精确移除这一条回流候选、不动池内其他候选；候选不存在时
  // 仅告警并返回 {ok:false}，不抛错不写新账——与上面各步同口径满足幂等。
  const { rejectCandidate } = await import('../personal_ontology_candidates');
  const { backflowCandidateIdFor } = await import('./ontology-backflow');
  const rejected = await rejectCandidate(userId, backflowCandidateIdFor(assetId), 'asset purged');
  if (rejected.ok) {
    log.info(`purge cascade rejected ontology backflow candidate assetId=${assetId}`);
  }
}

/**
 * 恢复：把归档或保留期内的删除放回 active。
 *
 * 保留期已过的删除不给恢复——过期后系统对外声称的就是「已经没了」，再让它复活
 * 等于那个承诺不作数。这条与 `purged` 的终态性是同一个理由。
 */
export function restoreAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', input, () => ({ deletedAt: undefined }), (current) => {
    if (current.status !== 'archived' && current.status !== 'deleted') {
      throw new Error('ability asset is not restorable');
    }
    if (current.status === 'deleted' && !isWithinDeletionRetention(current)) {
      throw new Error('ability asset retention window has expired');
    }
  }, 'restored');
}

/**
 * 回滚到某个历史版本。
 *
 * 按规范 10.4：回滚只影响后续默认引用，不改写历史。所以这里是用旧快照的内容
 * 生成一个**新版本**，而不是把版本号退回去——已经引用了旧版本的 TaskRun 和
 * Receipt 仍然指向它们当时的版本，回放不受影响。
 */
export async function rollbackAbilityAsset(
  userId: string,
  assetId: string,
  toVersion: string,
  input: AbilityAssetUserActionInput,
): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  // 先判终态再查版本：彻底清除会一并删掉版本流，反过来的顺序会把「已被清除」
  // 报成「版本不存在」，让调用方以为是自己传错了版本号。
  assertMutableAbilityAsset(await readAbilityAsset(userId, assetId));
  const versions = await listAbilityAssetVersions(userId, assetId);
  const target = versions.find((record) => record.version === toVersion);
  if (!target) throw new Error('recall ability asset version not found');
  let beforeAsset: RecallAbilityAssetRecord | undefined;
  // 标题闸门（设计 3.2 拍板项 #2 / 深探 F14）：历史快照冻结着大量不合规 title
  // （版本流只追加、物理不动），回滚不能成为「把烂标题带回在用版」的通道。
  // 目标快照标题不合规时保留在用标题，其余字段照常回滚；在锁内置位供台账注记。
  let titleRetained = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertMutableAbilityAsset(current);
    if (current.version === toVersion) throw new Error('ability asset is already at that version');
    beforeAsset = current;
    // scope 单独摘出且不倒退（2026-09-17 对齐 select 的守卫）：旧快照可能带
    // 词表化前的自由文本 scope，原样写回会再触发 legacy 迁移垫空版本。
    const { status: _snapshotStatus, maturity: _snapshotMaturity, version: _snapshotVersion, scope: rbScope, title: rbTitle, ...content } = target.snapshot;
    const scope = isRecallScopeTerm(String(rbScope || ''))
      ? String(rbScope)
      : (normalizeAssetScopeValue(String(rbScope || '')) || current.scope);
    // 判定用正文 = 目标快照自己的正文（回滚后的最终正文）；标题合规才随快照
    // 回滚，不合规则留在用标题（...current 先铺，content 已不含 title）。
    titleRetained = recallTitleIssue(String(rbTitle ?? ''), String(target.snapshot.statement ?? '')) !== undefined;
    const reverted: Record<string, unknown> = {
      ...current,
      // 只回滚内容，不回滚治理状态与成熟度：暂停过的资产不该因为回滚就自己
      // 变回 active，验证过的成熟度也不该被一次内容回滚抹掉。
      ...content,
      ...(titleRetained ? {} : { title: String(rbTitle ?? '') }),
      scope,
      version: nextVersion(current.version),
      activeVersion: nextVersion(current.version),
      updatedAt: new Date().toISOString(),
    };
    clearFieldsAbsentFromSnapshot(reverted, target.snapshot as unknown as Record<string, unknown>);
    return reverted as RecallAbilityAssetRecord;
  });
  const asset = asAsset(updated);
  await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
  // 回滚本身记账（FR-005）：前后值 + 依据齐全，回滚到哪一版写在 note/reason 里。
  const rollbackSummary = summarizeAuditChange(
    diffAbilityAssetsForAudit(beforeAsset ?? asset, asset),
  );
  await appendAudit(userId, asset.id, 'rolled_back', {
    reason: action.reason,
    actor: action.actor,
    ...(titleRetained ? { note: `${action.reason}｜目标版本标题不合规，保留在用标题（设计 3.2 拍板项 #2）` } : {}),
    ...(rollbackSummary ? { before: rollbackSummary.before, after: rollbackSummary.after } : {}),
    ...(beforeAsset ? { rollbackAnchor: activeVersionOf(beforeAsset) } : {}),
  });
  await reconcilePersonalProfileProjection(userId, asset);
  return asset;
}

/**
 * 选用某个历史版本为「在用版」（2026-09-16 版本组）。
 *
 * 与 rollback 的区别：rollback 生成新版本号（内容追加演进），select 只切
 * 「在用」指针——资产内容同步为所选版本快照，version 计数不变、不追加
 * 版本记录；后续内容更新会 bump 并让指针跟随最新。历史任务引用不受影响
 * （注入回放按投影冻结的版本号）。
 */
export async function selectAbilityAssetVersion(
  userId: string,
  assetId: string,
  toVersion: string,
  input: AbilityAssetUserActionInput,
): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  // 先判终态再查版本（与 rollback 同序）：purge 后的 select 报终态而不是版本错误。
  assertMutableAbilityAsset(await readAbilityAsset(userId, assetId));
  const versions = await listAbilityAssetVersions(userId, assetId);
  const target = versions.find((record) => record.version === toVersion);
  if (!target) throw new Error('recall ability asset version not found');
  // 标题闸门（设计 3.2 拍板项 #2 / 深探 F14，与 rollback 同口径）：选用标题
  // 不合规的旧快照时保留在用标题，其余内容照常切换。
  let titleRetained = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertMutableAbilityAsset(current);
    if ((current.activeVersion || current.version) === toVersion) throw new Error('ability asset already selected');
    // 内容同步为所选快照（治理状态与成熟度不动，与 rollback 同口径）。
    // scope 单独摘出且不倒退（2026-09-17 修）：旧快照可能带着词表化之前的
    // 自由文本 scope——原样写回会让 legacy scope 迁移在下次启动时再 bump
    // 一个内容不变的新版本（实机 aa-34b688 连产 v4/v5）。选用旧版只回内容，
    // scope 保持词表值。
    const { status: _snapshotStatus, maturity: _snapshotMaturity, version: _snapshotVersion, scope: snapshotScope, title: selectedTitle, ...content } = target.snapshot;
    const scope = isRecallScopeTerm(String(snapshotScope || ''))
      ? String(snapshotScope)
      : (normalizeAssetScopeValue(String(snapshotScope || '')) || current.scope);
    // 判定用正文 = 所选快照自己的正文（切换后的最终正文）。
    titleRetained = recallTitleIssue(String(selectedTitle ?? ''), String(target.snapshot.statement ?? '')) !== undefined;
    const selected: Record<string, unknown> = {
      ...current,
      ...content,
      ...(titleRetained ? {} : { title: String(selectedTitle ?? '') }),
      scope,
      activeVersion: toVersion,
      updatedAt: new Date().toISOString(),
    };
    clearFieldsAbsentFromSnapshot(selected, target.snapshot as unknown as Record<string, unknown>);
    return selected as RecallAbilityAssetRecord;
  });
  const asset = asAsset(updated);
  await appendAudit(userId, asset.id, 'version_selected', {
    note: `${action.reason || 'select'} (v${toVersion})${titleRetained ? '｜目标版本标题不合规，保留在用标题（设计 3.2 拍板项 #2）' : ''}`,
    actor: action.actor,
  });
  await reconcilePersonalProfileProjection(userId, asset);
  return asset;
}

/** 真删单个版本（2026-09-17，子安口径：删除就是删除，不留界面外的暗桩）。
 *  物理移除该版本的全部 JSONL 记录：之后版本列表、按号读快照都拿不到它，
 *  不可恢复。安全网两层：①「在用」版本不可删（删除即资产内容变空）；
 *  ②删除前把该版本快照冻结进每个引用它的已确认投影（assetVersionSnapshots），
 *  已确认注入继续按副本供给，效果与删除前一致——先保引用、后删数据，任一
 *  投影写副本失败则整体中止。版本号不回退：历史回执写着 asset@vN，重排
 *  补位会让旧回执错指到别的内容。 */
export async function deleteAbilityAssetVersion(
  userId: string,
  assetId: string,
  version: string,
  input: AbilityAssetUserActionInput,
): Promise<void> {
  const action = requireAssetAction(input);
  if (!/^[0-9]{1,9}$/.test(version)) throw new Error('invalid recall ability asset version');
  // 先判终态再查版本（与 select/rollback 同序）。
  const current = await readAbilityAsset(userId, assetId);
  assertMutableAbilityAsset(current);
  const target = (await listAbilityAssetVersions(userId, assetId)).find((record) => record.version === version);
  if (!target) throw new Error('recall ability asset version not found');
  if (String(current.activeVersion || current.version) === version) {
    throw new Error('cannot delete the active version; select another version first');
  }
  // ① 先给所有引用它的已确认投影冻结内容副本（先保引用，幂等）。
  // 全量枚举（2026-09-17 P0 修复）：listContextProjections 默认 clamp 到 20 条，
  // 投影存量超过后老投影漏冻结——删了版本副本就丢，注入静默降级。与
  // refreshCommittedProjectionAssetVersion 同款教训，改走全量目录扫描。
  const { listAllConfirmedProjections } = await import('./context-projection');
  const referencing = (await listAllConfirmedProjections(userId)).filter((projection) =>
    String(projection.assetVersions?.[assetId] || '') === version);
  for (const projection of referencing) {
    await updateRecallJsonRecord(userId, 'projections', projection.id, (raw) => {
      if (!raw) throw new Error('context projection not found');
      const existing = raw.assetVersionSnapshots;
      const cached = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing as Record<string, { version: string; snapshot: unknown }>
        : {};
      if (cached[assetId] && String(cached[assetId].version || '') === version) return raw;
      return { ...raw, assetVersionSnapshots: { ...cached, [assetId]: { version, snapshot: target.snapshot } } };
    });
  }
  // ② 再物理删除该版本的全部记录行。
  await removeRecallJsonlRecords(userId, 'ability-asset-versions', assetId,
    (record) => String(record.version || '') !== version);
  // ③ 审计只记动作（何时删了 v几），不记任何内容——与彻底清除同口径。
  await appendAudit(userId, assetId, 'version_deleted', { note: `${action.reason || 'delete'} (v${version})`, actor: action.actor });
}

/**
 * 归并两条同义资产为同一版本组（2026-09-16 存量治理）。
 *
 * source 的版本快照按时间序并入 target 版本流（续接编号）；source 更新时
 * target 在用内容切换为 source 在用内容。source 条目归档并记录去向
 * （mergedIntoAssetId），历史引用不回写——时间线/回执仍指向原条目可读。
 */
export async function mergeAbilityAssets(
  userId: string,
  sourceAssetId: string,
  targetAssetId: string,
  input: AbilityAssetUserActionInput,
): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  if (sourceAssetId === targetAssetId) throw new Error('cannot merge an ability asset into itself');
  const source = await readAbilityAsset(userId, sourceAssetId);
  if (!source) throw new Error('recall ability asset not found');
  assertMutableAbilityAsset(source);
  if (source.mergedIntoAssetId) throw new Error('ability asset has already been merged');
  const target = await readAbilityAsset(userId, targetAssetId);
  if (!target) throw new Error('recall ability asset not found');
  assertMutableAbilityAsset(target);
  if (source.type !== target.type) throw new Error('ability asset merge requires the same type');
  const sourceVersions = (await listAbilityAssetVersions(userId, sourceAssetId))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const sourceActiveVersion = String(source.activeVersion || source.version || '1');
  const sourceActiveIndex = sourceVersions.findIndex((v) => v.version === sourceActiveVersion);
  // source 全部版本快照续接进 target 流（重编号，at 保留原时间可考）。
  // 空版本去重（2026-09-16 修）：系统迁移会 bump 版本号但内容一字不变
  //（scope 枚举化等格式迁移）——与前一版 statement+title 相同的快照不占新号，
  // 否则归并后会出现成对的"一模一样"版本（用户实测抓出）。
  const snapshotContentKey = (snap: AbilityAssetVersionRecord['snapshot']): string => `${snap.title}\n${snap.statement}`;
  let lastAppendedKey: string | null = null;
  let versionCursor = target.version;
  for (const entry of sourceVersions) {
    const key = snapshotContentKey(entry.snapshot);
    if (lastAppendedKey !== null && key === lastAppendedKey) continue;
    lastAppendedKey = key;
    versionCursor = nextVersion(versionCursor);
    await appendRecallJsonlRecord(userId, 'ability-asset-versions', targetAssetId, {
      schemaVersion: 1,
      ownerId: userId,
      id: `${targetAssetId}-v${versionCursor}`,
      assetId: targetAssetId,
      version: versionCursor,
      at: entry.at,
      reason: `merged from ${sourceAssetId}`,
      actor: action.actor,
      snapshot: entry.snapshot,
    } as AbilityAssetVersionRecord);
  }
  // source 在用内容的快照（版本流缺失的遗留资产用 source 记录状态兜底）。
  const sourceActiveSnapshot = sourceActiveIndex >= 0
    ? sourceVersions[sourceActiveIndex].snapshot
    : snapshot(source);
  const sourceNewer = String(source.updatedAt || '') > String(target.updatedAt || '');
  // source 曾 select 旧版（在用版不是末版）时，在用内容与末版快照不同——
  // 额外 append 一条在用内容快照，保证 activeVersion 指向的快照与在用内容
  // 恒一致（注入回放按 activeVersion 读快照，分叉=注入与所见不一致）。
  let activeCursor = versionCursor;
  if (sourceNewer && sourceActiveIndex >= 0 && sourceActiveIndex !== sourceVersions.length - 1) {
    activeCursor = nextVersion(versionCursor);
    await appendRecallJsonlRecord(userId, 'ability-asset-versions', targetAssetId, {
      schemaVersion: 1,
      ownerId: userId,
      id: `${targetAssetId}-v${activeCursor}`,
      assetId: targetAssetId,
      version: activeCursor,
      at: new Date().toISOString(),
      reason: `merged active version from ${sourceAssetId}`,
      actor: action.actor,
      snapshot: sourceActiveSnapshot,
    } as AbilityAssetVersionRecord);
  }
  // 归并前的 live source 重读：函数开头读的 source 经过版本流搬运（多次
  // await）后可能已不是最新，且挂族是直写不 bump 版本——版本快照里的
  // relations 恒滞后于 live 记录，按快照搬会把自动挂上的族关系丢掉。
  const sourceLive = await readAbilityAsset(userId, sourceAssetId);
  let beforeTarget: RecallAbilityAssetRecord | undefined;
  const merged = asAsset(await updateRecallJsonRecord(userId, 'ability-assets', targetAssetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 锁内复核三终态（与 rollback/select/update 同款）：版本搬运多次 await，
    // 锁外预检后窗口期内被 delete/revoke 的 target 不许再被铺内容或 bump 版本。
    assertMutableAbilityAsset(current);
    beforeTarget = current;
    // 关系/溯源并入不挑 source 新旧：source 随即归档，不搬就净丢失（族成员
    // 凭空少）。过滤自指（same_family 互指时 source 带着指向 target 的关系，
    // 直接搬会撞 normalize 的自指闸），指向彼此的 same_family 随归并失效一并
    // 丢弃，其余去重保留。
    const seenRelation = new Set((current.relations || []).map((relation) => `${relation.kind}\0${relation.assetId}`));
    const mergedRelations = [...(current.relations || [])];
    for (const relation of sourceLive.relations || []) {
      if (relation.assetId === targetAssetId) continue;
      const key = `${relation.kind}\0${relation.assetId}`;
      if (seenRelation.has(key)) continue;
      seenRelation.add(key);
      mergedRelations.push(relation);
    }
    const mergedDerivedFrom = [...new Set([...(current.derivedFrom || []), ...(sourceLive.derivedFrom || [])])]
      .filter((id) => id !== targetAssetId)
      .slice(0, 32);
    if (!sourceNewer) {
      // source 较旧：在用内容不动，但版本计数器必须推进到 cursor——否则后续
      // 更新的 nextVersion 会与并入的快照撞号（JSONL 追加不去重，撞号后
      // rollback/select 按号查到错误内容）。activeVersion 显式钉在原在用版
      // （缺省跟随会指向并入的 source 快照，与在用内容分叉）。关系上面已并入。
      return {
        ...current,
        relations: mergedRelations,
        ...(mergedDerivedFrom.length ? { derivedFrom: mergedDerivedFrom } : {}),
        version: activeCursor,
        activeVersion: String(current.activeVersion || target.version),
        updatedAt: new Date().toISOString(),
      };
    }
    // scope 单独摘出且不倒退（与 rollback/select 同款守卫）：旧快照可能带
    // 词表化前的自由文本 scope，原样铺上会再触发 legacy 迁移垫空版本。
    // 标题闸门（设计 3.2 / 深探 F15）：source 在用标题不合规时不铺到 target
    // （保留 target 在用标题），其余内容照常并入——归并不走 updateAbilityAsset
    // 收口，这里就是它的判定点。
    const { status: _s, maturity: _m, version: _v, relations: _r, derivedFrom: _d, scope: snapshotScope, title: snapshotTitle, ...content } = sourceActiveSnapshot;
    const mergedScope = isRecallScopeTerm(String(snapshotScope || ''))
      ? String(snapshotScope)
      : (normalizeAssetScopeValue(String(snapshotScope || '')) || current.scope);
    const sourceTitleCompliant = recallTitleIssue(String(snapshotTitle ?? ''), String(sourceActiveSnapshot.statement ?? '')) === undefined;
    return {
      ...current,
      ...content,
      ...(sourceTitleCompliant ? { title: String(snapshotTitle ?? '') } : {}),
      scope: mergedScope,
      relations: mergedRelations,
      ...(mergedDerivedFrom.length ? { derivedFrom: mergedDerivedFrom } : {}),
      evidenceRefs: [...current.evidenceRefs, ...source.evidenceRefs].slice(0, 200),
      version: activeCursor,
      activeVersion: activeCursor,
      updatedAt: new Date().toISOString(),
    };
  }));
  // source 归档 + 去向 + 双向审计。
  let beforeSource: RecallAbilityAssetRecord | undefined;
  let afterSource: RecallAbilityAssetRecord | undefined;
  await updateRecallJsonRecord(userId, 'ability-assets', sourceAssetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 同上：锁内复核三终态——窗口期内被 delete/revoke 的 source 强改 archived
    // 是非法跃迁（deletedAt 脏残留），archived 又是 restore 的合法源会绕过保留期。
    assertMutableAbilityAsset(current);
    if (current.mergedIntoAssetId) throw new Error('ability asset has already been merged');
    beforeSource = current;
    afterSource = { ...current, status: 'archived' as const, mergedIntoAssetId: targetAssetId, updatedAt: new Date().toISOString() };
    return afterSource;
  });
  // 归并也要台账四项（FR-004）：target 记它自己的版本/关系变化，source 记归档与去向。
  const targetSummary = summarizeAuditChange(
    diffAbilityAssetsForAudit(beforeTarget ?? merged, merged),
  );
  const sourceSummary = summarizeAuditChange(
    diffAbilityAssetsForAudit(beforeSource ?? source, afterSource ?? source),
  );
  await appendAudit(userId, targetAssetId, 'merged_from', {
    reason: `${action.reason || 'merge'} (from ${sourceAssetId})`,
    actor: action.actor,
    ...(targetSummary ? { before: targetSummary.before, after: targetSummary.after } : {}),
    ...(beforeTarget ? { rollbackAnchor: activeVersionOf(beforeTarget) } : {}),
  });
  await appendAudit(userId, sourceAssetId, 'merged_into', {
    reason: `${action.reason || 'merge'} (into ${targetAssetId})`,
    actor: action.actor,
    ...(sourceSummary ? { before: sourceSummary.before, after: sourceSummary.after } : {}),
    ...(beforeSource ? { rollbackAnchor: activeVersionOf(beforeSource) } : {}),
  });
  return merged;
}

export async function listAbilityAssetVersions(userId: string, assetId: string): Promise<AbilityAssetVersionRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0)).map(asVersion);
}

/** 版本链 + 按版本的使用效果聚合（2026-09-16 M8）：供版本对比视图——
 *  「实际采用」（applied）与「被否定」（contradicted）按版本号计数，
 *  数据来自 usage 回执（外键注入回执，只认有据使用）。 */
export async function listAbilityAssetVersionsWithUsage(
  userId: string,
  assetId: string,
): Promise<{
  versions: AbilityAssetVersionRecord[];
  usage: Array<{ version: string; applied: number; contradicted: number; total: number }>;
  frozen: Array<{ version: string; count: number }>;
}> {
  const versions = await listAbilityAssetVersions(userId, assetId);
  const { listAssetUsageReceipts } = await import('./asset-usage-receipt');
  const counts = new Map<string, { applied: number; contradicted: number; total: number }>();
  try {
    for (const receipt of await listAssetUsageReceipts(userId)) {
      if (String(receipt.assetId || '') !== assetId) continue;
      const version = String(receipt.assetVersion || '');
      if (!version) continue;
      const entry = counts.get(version) || { applied: 0, contradicted: 0, total: 0 };
      entry.total += 1;
      if (receipt.status === 'applied') entry.applied += 1;
      if (receipt.status === 'contradicted') entry.contradicted += 1;
      counts.set(version, entry);
    }
  } catch {
    // 回执读取失败只丢效果列，不阻断版本链。
  }
  // 冻结引用按版本计数（specs/008 US-402 AC6 / T023「被引用过的历史版本」）：
  // 权威判据是已确认投影的 assetVersions 映射——与 deleteAbilityAssetVersion 的
  // 冻结段同一判据。**不能拿 KSTAR 采用回执（上面的 usage）顶替**：那记录的是
  // "这一版被判为实际采用/被否定"，与"这一版被某个任务引用过"是两件事，回执为空
  // 时提示永不出现（2026-09-25 合并态走查抓出：v1 被 8 条投影冻结，界面无标记）。
  const frozenCounts = new Map<string, number>();
  try {
    const { listAllConfirmedProjections } = await import('./context-projection');
    for (const projection of await listAllConfirmedProjections(userId)) {
      const version = String(projection.assetVersions?.[assetId] || '');
      if (!version) continue;
      frozenCounts.set(version, (frozenCounts.get(version) || 0) + 1);
    }
  } catch {
    // 投影读取失败只丢「已有更新的版本」标记，不阻断版本链。
  }
  return {
    versions,
    usage: [...counts.entries()].map(([version, c]) => ({ version, ...c })),
    frozen: [...frozenCounts.entries()].map(([version, count]) => ({ version, count })),
  };
}

/** Read the immutable content snapshot of a specific asset version, or null
 *  when no such version record exists. Used by prompt injection so confirmed
 *  Projections keep injecting exactly the knowledge the user approved. */
export async function readAbilityAssetVersionSnapshot(
  userId: string,
  assetId: string,
  version: string,
): Promise<AbilityAssetVersionRecord['snapshot'] | null> {
  if (!safeId(userId) || !safeId(assetId) || typeof version !== 'string' || !version.trim()) {
    throw new Error('invalid ability asset version reference');
  }
  const records = await listAbilityAssetVersions(userId, assetId);
  const match = records.find((record) => record.version === version);
  return match?.snapshot ?? null;
}

export async function listAbilityAssetAudit(userId: string, assetId: string): Promise<AbilityAssetAuditRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-audit', assetId, 0)) as AbilityAssetAuditRecord[];
}

/** 「已删除」列表的一行。
 *
 *  保留期剩余天数是用户"什么时候会真的没了"的唯一答案，所以**现算**而不存字段：
 *  存下来的倒计时会在磁盘上冻结，用户看到的永远是删除那天算出的数字。
 *  `retentionUnknown` 单列一态：deletedAt 缺失/损坏时既不能恢复、也不会自动到期，
 *  把这种情况混进"已过期"或"还能恢复"都是在替用户编一个不存在的事实。 */
export interface DeletedAbilityAssetView {
  id: string;
  title: string;
  type: RecallAbilityAssetRecord['type'];
  scope: string;
  deletedAt?: string;
  restorable: boolean;
  /** 保留期剩余天数（向上取整）；时间戳不可用时为 null。 */
  retentionDaysLeft: number | null;
  retentionUnknown: boolean;
  /** 「立即彻底删除」可用否。列表里恒为 true（列表本身就只收 deleted）。 */
  purgeable: boolean;
}

export function describeDeletedAbilityAsset(
  asset: Pick<RecallAbilityAssetRecord, 'id' | 'title' | 'type' | 'scope' | 'status' | 'deletedAt'>,
  now: Date = new Date(),
): DeletedAbilityAssetView {
  const parsed = typeof asset.deletedAt === 'string' ? Date.parse(asset.deletedAt) : Number.NaN;
  const retentionUnknown = Number.isNaN(parsed);
  const expiresAt = retentionUnknown
    ? null
    : parsed + ABILITY_ASSET_DELETION_RETENTION_DAYS * 86_400_000;
  return {
    id: asset.id,
    title: asset.title,
    type: asset.type,
    scope: asset.scope,
    ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
    restorable: asset.status === 'deleted' && isWithinDeletionRetention(asset, now),
    retentionDaysLeft: expiresAt === null
      ? null
      : Math.max(0, Math.ceil((expiresAt - now.getTime()) / 86_400_000)),
    retentionUnknown,
    purgeable: asset.status === 'deleted',
  };
}

export async function setAbilityAssetMaturity(userId: string, assetId: string, maturity: RecallAbilityAssetRecord['maturity']): Promise<RecallAbilityAssetRecord> {
  if (!ABILITY_ASSET_MATURITIES.has(maturity)) {
    throw new Error('invalid ability asset maturity');
  }
  const rank: Record<RecallAbilityAssetRecord['maturity'], number> = {
    seed: 0,
    bud: 1,
    transfer_validated: 2,
    effectiveness_validated: 3,
  };
  let previous: RecallAbilityAssetRecord['maturity'] | undefined;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 2026-09-28 红队补齐：终态/保留期资产不再推进成熟度（回执驱动的调用在
    // 资产被删后仍可能到达）。
    assertMutableAbilityAsset(current);
    if (rank[maturity] < rank[current.maturity]) {
      throw new Error('ability asset maturity cannot move backwards');
    }
    if (maturity === current.maturity) return current;
    previous = current.maturity;
    return { ...current, maturity, updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (previous) {
    await appendAudit(userId, asset.id, 'maturity_advanced', {
      note: `${previous}->${asset.maturity}`,
      actor: 'system',
    });
  }
  return asset;
}

/** Record independent cross-task evidence for an asset. Loading an asset
 * proves transfer; this record proves whether the transfer helped or hurt. */
export async function recordAbilityAssetValidation(
  userId: string,
  assetId: string,
  outcome: 'success' | 'failure',
  validationId?: string,
): Promise<RecallAbilityAssetRecord> {
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  let maturityAdvanced: { from: RecallAbilityAssetRecord['maturity']; to: RecallAbilityAssetRecord['maturity'] } | undefined;
  let paused = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (current.status === 'purged' || current.status === 'deleted' || current.status === 'revoked') return current;
    const appliedValidationIds = current.appliedValidationIds || [];
    if (validationId && appliedValidationIds.includes(validationId)) return current;
    const validationCount = (current.validationCount || 0) + (outcome === 'success' ? 1 : 0);
    const consecutiveFailures = outcome === 'success' ? 0 : (current.consecutiveFailures || 0) + 1;
    // Two independent positive outcomes establish repeatability for a seed.
    // Transfer validation remains receipt-backed and cannot be fabricated by
    // an outcome record alone.
    const nextMaturity = outcome === 'success' && current.maturity === 'seed' && validationCount >= 2
      ? 'bud'
      : current.maturity;
    if (nextMaturity !== current.maturity) maturityAdvanced = { from: current.maturity, to: nextMaturity };
    if (consecutiveFailures >= 3 && current.status === 'active') paused = true;
    return {
      ...current,
      validationCount,
      ...(outcome === 'success' ? { lastValidatedAt: new Date().toISOString() } : {}),
      consecutiveFailures,
      ...(nextMaturity !== current.maturity ? { maturity: nextMaturity } : {}),
      ...(paused ? { status: 'paused' as const } : {}),
      ...(validationId ? { appliedValidationIds: [...new Set([...appliedValidationIds, validationId])] } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  const asset = asAsset(updated);
  if (maturityAdvanced) {
    await appendAudit(userId, asset.id, 'maturity_advanced', {
      note: `${maturityAdvanced.from}->${maturityAdvanced.to}:validation_count=${asset.validationCount}`,
      actor: 'system',
    });
  }
  if (paused) {
    await appendAudit(userId, asset.id, 'paused', {
      note: `three_consecutive_validation_failures:${asset.consecutiveFailures}`,
      actor: 'system',
    });
  }
  return asset;
}

/**
 * Evidence 撤销后回收由它支撑的成熟度声明。
 *
 * 资产仍是用户确认过的正式资产，所以不删正文、不改治理状态；但来源链已经失效，
 * 不能继续声称它完成过 transfer / effectiveness 验证。`bud` 是既有使用矩阵中的
 * User Confirmed / Unverified 档，正好表达「资产仍在、效果待重新验证」。来源随后
 * 恢复也不会自动升回去，新的 proof 才能升阶。
 */
/**
 * 证据撤销后暂停由它支撑的正式资产（系统发起，幂等）。
 *
 * 资产仍是用户确认过的正式资产，不删除、不撤销；但来源链已失效，暂停后不再进入
 * 新 Projection、不再注入 Prompt，直到用户显式恢复（resume 仍要求 user actor）。
 */
export async function pauseAbilityAssetForRevokedEvidence(
  userId: string,
  assetId: string,
  source: Pick<CognitionSourceRef, 'kind' | 'id'>,
): Promise<{ asset: RecallAbilityAssetRecord; paused: boolean }> {
  if (typeof source.kind !== 'string' || !safeId(source.id)) throw new Error('invalid revoked evidence source');
  let paused = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 2026-09-28 红队收紧：只暂停 active 资产。此前跳过清单漏了 deleted 与
    // archived——删除保留期内的资产被证据撤销级联改道成 paused 后，「已删除」
    // 列表与保留期清扫都看不到它，随后 resume 一路绿灯复活且不可追踪。
    if (
      current.status !== 'active'
      || !current.evidenceRefs.some((ref) => ref.kind === source.kind && ref.id === source.id)
    ) return current;
    paused = true;
    return { ...current, status: 'paused', updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (paused) {
    await appendAudit(userId, asset.id, 'paused', {
      note: `evidence_revoked:${source.kind}:${source.id}`,
      actor: 'system',
    });
  }
  return { asset, paused };
}

export async function downgradeAbilityAssetMaturityForRevokedEvidence(
  userId: string,
  assetId: string,
  source: Pick<CognitionSourceRef, 'kind' | 'id'>,
): Promise<{ asset: RecallAbilityAssetRecord; downgraded: boolean }> {
  if (typeof source.kind !== 'string' || !safeId(source.id)) throw new Error('invalid revoked evidence source');
  let downgraded = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 2026-09-28 红队补齐：终态/保留期资产不降成熟度（与内容写路径同口径）。
    if (
      current.status === 'purged'
      || current.status === 'revoked'
      || current.status === 'deleted'
      || current.maturity === 'seed'
      || current.maturity === 'bud'
      || !current.evidenceRefs.some((ref) => ref.kind === source.kind && ref.id === source.id)
    ) return current;
    downgraded = true;
    return { ...current, maturity: 'bud', updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (downgraded) {
    await appendAudit(userId, asset.id, 'maturity_downgraded', {
      note: `evidence_revoked:${source.kind}:${source.id}`,
      actor: 'system',
    });
  }
  return { asset, downgraded };
}
