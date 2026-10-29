import { t } from '../../i18n';
import { requireContentCategory, readContentCategory, type CognitionContentCategory } from './content-category';
import { verifyNightlyAssetCreation } from './formation-creation-gate';
import { attachHumanEditMetadata, attachStandingPreferenceAuthority, readStandingPreferenceAuthorityBaseline, withHumanStandingPreferenceDetailsSave } from './standing-preference-authority';
import { withCognitionTransition, persistCognitionSource } from '../cognition_bridge';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { safeId, writeJson, withJsonlLineLock } from '../../storage';
import { recallJsonlPath, recallJsonRecordPath } from './paths';
import { normalizeCognitionSourceRefs, cognitionSourceDependsOn, type CognitionSourceRef } from './source-service';
import {
  appendRecallJsonlRecord, listRecallJsonlRecords, createRecallCollectionReader, readRecallJsonRecord,
  removeRecallJsonlStream, removeRecallJsonlRecords, updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { assetVersionSnapshot, pendingAssetVersions, withAssetVersionMetadata } from './asset-version-journal';
import { normalizeAbilityAssetOntologyRefs } from './ontology-refs';
import type { RecallAbilityAssetRecord, RecallAbilityAssetLifecycleStatus } from './candidate-service';
import { ensureAbilityTags, normalizeAbilityTagList, sameAbilityTagSet } from './ability-tag-service';
import { readAbilityAssetRelationContract } from './asset-relations';
import { readAbilityAssetSemantics } from './asset-semantics';
import { normalizeAbilityAssetScopePolicy, resolveScopeForAsset, normalizeAssetScopeValue, isRecallScopeTerm, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { RECALL_TEXT_LIMITS, normalizeStatementText } from './content-contract';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { fileEditLock } from '../../util/locks';
import { normalizeCausalRule } from './world-model-types';
import { resolveExecutionEvidenceRefs } from './evidence-resolution';
import { assertCompliantAbilityAssetTitle, assertReviewedAbilityAssetTitle, isReviewedAbilityAssetTitle, recallTitleIssue } from './title-policy';
import { createLogger } from '../../logger';
import { organizationContentAssetIds, purgedOrganizationRecord } from './organization-content-lifecycle';

const log = createLogger('recall.assets');

/** Shared active-version comparison; the committing check must run under the asset record lock. */
export function matchesAbilityAssetActiveVersion(asset: Pick<RecallAbilityAssetRecord, 'activeVersion' | 'version'>, expected: string | undefined): boolean {
  // 在用版口径唯一：比较一律走 abilityAssetActiveVersion，不再各写
  // 一份 `activeVersion || version` 表达式——分叉的口径迟早判错方向。
  return typeof expected === 'string' && expected.length > 0 && abilityAssetActiveVersion(asset) === expected;
}

/** ai 表示模型工具发起的写操作；system 表示自动抽取、沉淀或迁移，使用自动评审交接。 */
export type AbilityAssetActor = 'user' | 'system' | 'ai';
export type AbilityAssetRecommendedAction = 'pause' | 'rework';

/** 失败归因分类。
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
  // 敏感性不进入版本快照；受限语义在主记录与读取投影层判定。
  snapshot: Pick<
    RecallAbilityAssetRecord,
    | 'title' | 'statement' | 'value' | 'type' | 'contentCategory' | 'scope' | 'scopePolicy' | 'evidenceRefs'
    | 'status' | 'maturity' | 'version' | 'learningSignal' | 'learningProvenance'
    | 'ontologyRefs' | 'relations' | 'derivedFrom'
    | 'applicableWhen' | 'forbiddenWhen' | 'sourceSessionIds'
    | 'standingPreferenceAuthority' | 'userEditDecision'
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
    // 资产管家安全网：
    //   - danger_snapshot：危险操作**执行前**留的快照锚点（内容在版本流里，
    //     这里记"当时在用哪一版"，回滚就滚到它）；
    //   - danger_confirmed / danger_denied：单次确认的结果（含超时/取消=deny）；
    //   - attempt_blocked：被门禁拦下的写尝试——**失败也要留痕**，否则"零静默
    //     放行"只在成功路径上成立，拦下的那些事无从审计。
    | 'danger_snapshot' | 'danger_confirmed' | 'danger_denied' | 'attempt_blocked'
    // 审批提议：AI 提出、用户三态处置、以及用户编辑卡片内容。
    // 提议本身不改资产，但它必须与"谁在什么时候做了什么决定"绑在同一条履历上。
    | 'approval_proposed' | 'approval_confirmed' | 'approval_rejected' | 'approval_deferred' | 'approval_edited';
  at: string;
  actor?: AbilityAssetActor;
  note?: string;
  /** 变更前后的**摘要**（不是全文）。由 `summarizeAuditChange` 产出：正文类字段
   *  只留字数。逐字对比看
   *  版本流快照，台账不承担第二份正文副本的职责。 */
  before?: string;
  after?: string;
  /** 本次写操作的依据。与 `note` 同源：
   *  `note` 是既有消费方（渲染层生命周期记录 / timeline summary）在读的字段，
   *  保留不动；`reason` 是台账四项里可单独查询的那一项。 */
  reason?: string;
  /** 失败/被拦截的归因。成功的记录不带——「被拦截不得计为成功」靠这个字段
   *  与 `ok:false` 回执共同表达。 */
  failureCategory?: AbilityAssetFailureCategory;
  /** 这一步之前的在用版本（回滚锚点）。渲染层「回滚到改动前」直接拿它调
   *  rollback，不必从 `before` 摘要里反解。 */
  rollbackAnchor?: string;
}

export interface UpdateAbilityAssetInput {
  // lifecycleStatus 不能通过内容更新修改；旧调用方传入该字段也不生效。
  contentCategory?: CognitionContentCategory;
  title?: string;
  statement?: string;
  /** Omission preserves the current value; empty text clears it. */
  value?: string;
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
  /** 主题标签整组替换；ability-tag-service 统一规范化、去重并限制为 ≤12 条，
   * 超限抛错，缺失的库条目自动补建。标签为元数据，不增加内容版本。
   * 省略表示不改；显式 [] 表示清空。 */
  tags?: string[];
  reason: string;
  actor: AbilityAssetActor;
  /** 乐观并发：调用方读到的版本号。给了就要求与当前版本一致，不一致直接拒绝
   *  （**不静默覆盖**）。比对放在 `updateRecallJsonRecord` 的锁内做——放到调用方
   *  先读后写就会留下 TOCTOU 窗口，"比对通过"与"真的没被改过"变成两件事。
   *  资产管家工具在"用户可能正在手动编辑同一条"的场景下必须传它。 */
  expectedVersion?: string;
  /** Optional active-version CAS for background writes; selecting a historical version does not bump version. */
  expectedActiveVersion?: string;
  /** 标签维度的 CAS：标签更新不 bump 内容版本，`expectedVersion` 看不见
   *  "期间有人改过标签"。给了就要求当前标签集合与它一致（大小写不敏感、
   *  忽略顺序），不一致在写锁内拒绝，不静默用整组替换盖掉期间的新标签。 */
  expectedTags?: string[];
  /** Background writes must not change a target paused after their preflight. */
  expectedStatus?: RecallAbilityAssetRecord['status'];
  acknowledgeRecommendation?: boolean;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
  id?: never;
  ownerId?: never;
}
export type SaveUserStandingPreferenceDetailsInput = Omit<UpdateAbilityAssetInput, 'actor' | 'reviewDecisionId' | 'sourceCandidateId'> & {
  statement: string; applicableWhen: string[]; forbiddenWhen: string[]; expectedVersion: string; expectedActiveVersion: string;
};
/** A complete, actual user editor save can renew an existing human standing
 * intent. Generic updates and model tools never enter this host-only boundary. */
export async function saveUserStandingPreferenceDetails(userId: string, assetId: string,
  input: SaveUserStandingPreferenceDetailsInput): Promise<RecallAbilityAssetRecord> {
  if (!input || typeof input.statement !== 'string' || !Array.isArray(input.applicableWhen) || !Array.isArray(input.forbiddenWhen)
    || !/^\d+$/.test(input.expectedVersion || '') || !/^\d+$/.test(input.expectedActiveVersion || ''))
    throw new Error('standing preference details save requires complete fields and both version baselines');
  // Strip caller-supplied authority/handoff/actor fields even at this internal
  // boundary; only the fixed explicit editor contract is forwarded.
  const { actor: _actor, reviewDecisionId: _decision, sourceCandidateId: _candidate, standingPreferenceAuthority: _proof,
    ...safeInput } = input as SaveUserStandingPreferenceDetailsInput & Record<string, unknown>;
  const current = await readAbilityAsset(userId, assetId);
  return withHumanStandingPreferenceDetailsSave(userId, current, () => updateAbilityAsset(userId, assetId, { ...safeInput, actor: 'user' }));
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
  /** Bind automated proof recommendations to the exact observed head. */
  expectedVersion?: string;
  action: AbilityAssetRecommendedAction;
  reason: string;
  actor: AbilityAssetActor;
}

export interface CreateAbilityAssetInput extends RecallAbilityAssetRecord {}

/** Version-independent metadata is excluded; the remaining canonical snapshot
 * binds verified outcomes to the actual body, conditions and source/access contract. */
function proofGuidanceIdentity(asset: RecallAbilityAssetRecord): unknown {
  const fields = { ...assetVersionSnapshot(asset) };
  for (const key of ['title', 'value', 'contentCategory', 'status', 'maturity', 'version', 'standingPreferenceAuthority',
    'relations', 'derivedFrom', 'learningSignal', 'learningProvenance', 'sourceSessionIds']) delete fields[key];
  fields.scope = resolveScopeForAsset(asset.scope);
  fields.scopePolicy = normalizeAbilityAssetScopePolicy(asset.scopePolicy);
  const terms = (values?: string[]) => [...new Set((values || []).map(value => value.trim().replace(/\s+/g, ' ')))].sort();
  fields.applicableWhen = terms(asset.applicableWhen); fields.forbiddenWhen = terms(asset.forbiddenWhen);
  fields.evidenceRefs = normalizeCognitionSourceRefs(asset.evidenceRefs).map(value => JSON.stringify(value)).sort();
  fields.ontologyRefs = (asset.ontologyRefs || []).map(value => JSON.stringify(value)).sort();
  return fields;
}
function resetChangedGuidanceOutcomes(current: RecallAbilityAssetRecord, next: RecallAbilityAssetRecord): RecallAbilityAssetRecord {
  if (isDeepStrictEqual(proofGuidanceIdentity(current), proofGuidanceIdentity(next))) return next;
  // A changed contract loses earlier validation and returns to bud, while a
  // legacy seed stays seed: editing alone cannot prove maturity. New assets
  // start at bud; reviewed standing intent is verified on its own axis.
  next.maturity = current.maturity === 'seed' ? 'seed' : 'bud';
  next.validationCount = 0; next.consecutiveFailures = 0;
  delete next.lastValidatedAt;
  delete next.recommendedAction; delete next.recommendationReason; delete next.recommendationAt;
  // Retain applied IDs and all version/proof ledgers: an old observation cannot
  // be replayed as a new independent outcome after content changes or rollback.
  return next;
}

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

/** 写入允许的资产类型，与 candidate-service 的 AbilityAssetType 保持一致。 */
const ABILITY_ASSET_TYPES = new Set<RecallAbilityAssetRecord['type']>([
  'cognition', 'personal', 'rule', 'template', 'skill_method', 'fact',
]);

/**
 * 删除保留期长度（天）：删除后 30 天内可恢复，也可立即彻底删除。
 * 到期由 asset-retention-service 自动删除内容和记录，之后不可恢复。
 * 记录保存 deletedAt 而非计算后的到期时间，调整常量无需迁移数据。
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

/** deletedAt 是否指向未来（时钟回拨/坏档迁移）：不可能的删除时刻
 *  不能作为「还能恢复」的依据——恢复侧按不在保留期内拒绝，等待真实时间
 *  追上或走人工处置。刻意不改 isWithinDeletionRetention 本身：清扫服务
 *  （asset-retention-service）以它为 false 判「已到期」，把未来时间戳折进
 *  去会让时间不明的记录被自动彻底清除——「时间不明 ≠ 已到期」。 */
function hasFutureDeletedAt(
  asset: Pick<RecallAbilityAssetRecord, 'deletedAt'>,
  now: Date = new Date(),
): boolean {
  if (typeof asset.deletedAt !== 'string' || !asset.deletedAt) return false;
  const deletedAt = Date.parse(asset.deletedAt);
  return Number.isFinite(deletedAt) && deletedAt > now.getTime();
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
    // 读侧同样不透传可识别内容：清理面与 purge mutate 一一对应（宁多勿漏），
    // 老墓碑（补清落盘前已产生的）读到即归一到同一口径。
    const tombstone = { ...value, evidenceRefs: [], scope: '' } as RecallAbilityAssetRecord & Record<string, unknown>;
    for (const key of ['causalRule', 'tags', 'learningProvenance', 'sensitivity', 'standingPreferenceAuthority', 'userEditDecision']) {
      delete tombstone[key];
    }
    return tombstone as unknown as RecallAbilityAssetRecord;
  }
  if (value.value !== undefined) normalizeFutureUse(value.value);
  if (value.contentCategory !== undefined) readContentCategory(value.contentCategory);
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  // 手动新建资产没有对话证据，origin='manual' 明确标识其空证据豁免。
  // Legacy saved content may have no recorded original source. Read it without
  // manufacturing evidence; new creation still requires its existing provenance gate.
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
    // to user_confirmed_unverified: both automatic lines
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

/** Body content is multiline text; single-line metadata normalization must not rewrite its structure. */
function boundedStatement(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid ability asset statement');
  const text = normalizeStatementText(value);
  if (!text || text.length > RECALL_TEXT_LIMITS.statement) throw new Error('invalid ability asset statement');
  return text;
}

/** Preserve prose layout. Empty input explicitly removes an optional future use. */
function normalizeFutureUse(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > RECALL_TEXT_LIMITS.value) throw new Error('invalid ability asset value');
  return value.trim() ? value : undefined;
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

/** 左时间是否严格晚于右时间。按解析后的时刻比，不按字符串字典序比——
 *  ISO 串在时区偏移/小数位精度差异下字典序会判错方向；任一侧缺失或
 *  不可解析时返回 false（无法证明更晚，消费方按「不采纳」处理）。 */
function isLaterInstant(left: string | undefined, right: string | undefined): boolean {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}

function snapshot(asset: RecallAbilityAssetRecord): AbilityAssetVersionRecord['snapshot'] {
  return assetVersionSnapshot(asset) as AbilityAssetVersionRecord['snapshot'];
}

/** A copied source snapshot now belongs to the merge target. Relations back to
 * that target become self references; content, evidence and access stay intact. */
function mergedSnapshotForTarget(value: Record<string, unknown>, targetId: string): Record<string, unknown> {
  return {
    ...value,
    ...(Array.isArray(value.relations) ? { relations: value.relations.filter(ref => !ref || typeof ref !== 'object' || ref.assetId !== targetId) } : {}),
    ...(Array.isArray(value.derivedFrom) ? { derivedFrom: value.derivedFrom.filter(id => id !== targetId) } : {}),
  };
}

function asVersion(value: RecallJsonRecord): AbilityAssetVersionRecord {
  const rawSnapshot = value.snapshot;
  if (typeof value.assetId !== 'string' || typeof value.version !== 'string' || typeof value.at !== 'string' || !rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('malformed recall ability asset version');
  // Older merges copied source relations verbatim. Normalize that legacy shape
  // on read without rewriting immutable stored snapshots or relaxing other rows.
  const versionSnapshot = /^merged (?:from|active version from) [A-Za-z0-9_-]+$/.test(String(value.reason || ''))
    ? mergedSnapshotForTarget(rawSnapshot as Record<string, unknown>, value.assetId)
    : rawSnapshot as Record<string, unknown>;
  if (versionSnapshot.contentCategory !== undefined) readContentCategory(versionSnapshot.contentCategory);
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

/** 按版本号直读既有版本行：追加前的同号存在性检查不再全流
 *  parse。候选行=含 `"version":"<v>"` 字面量的行，命中后仍走与
 *  listRecallJsonlRecords 相同的记录身份校验（owner/id/schema）+ asVersion
 *  域校验再按号精确比对（不可变快照冲突语义不变）；首条命中即止（与旧
 *  `.find` 的首匹配同口径）。非候选坏行跳过——与该流读侧 skipMalformedLines
 *  的逐行降级同口径。 */
async function findPersistedVersionLine(
  userId: string,
  assetId: string,
  version: string,
): Promise<AbilityAssetVersionRecord | undefined> {
  const streamPath = recallJsonlPath(userId, 'ability-asset-versions', assetId);
  let text: string;
  try {
    text = await fs.readFile(streamPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const needle = `"version":"${version}"`;
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (
      typeof record.schemaVersion !== 'number' || record.ownerId !== userId
      || typeof record.id !== 'string' || !safeId(record.id)
    ) throw new Error(`malformed recall JSONL ability-asset-versions/${assetId}: persisted version line`);
    const candidate = asVersion(raw as RecallJsonRecord);
    if (String(candidate.version) === String(version)) return candidate;
  }
  return undefined;
}

/** 版本追加持有主记录的 fileEditLock，并在锁内复核记录仍存在且未 purged。
 * 这使清除与迟到追加互斥，防止已清除正文的版本流被重建；流文件自身的互斥
 * 由 store.removeRecallJsonlStream 处理。
 * revoked/deleted 的内容仍在保留期内，允许兼容初始化补充快照；内容和版本变更
 * 则由写路径的 assertMutableAbilityAsset 在锁内拦截。 */
async function appendAbilityAssetVersionLine(
  userId: string,
  assetId: string,
  record: AbilityAssetVersionRecord,
): Promise<void> {
  const recordPath = recallJsonRecordPath(userId, 'ability-assets', assetId);
  await withCognitionTransition(userId, () => fileEditLock(recordPath).runExclusive(async () => {
    const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
    if (!raw) throw new Error('recall ability asset not found');
    assertNotPurged(asAsset(raw));
    // 版本流读侧逐行降级（见 store.ts 的 skipMalformedLines 规则）：撕裂行只作废
    // 它自己，好行照常参与不可变快照比对。同号存在性按号直读，
    // 不再为找一行同号记录全流 parse。
    const existing = await findPersistedVersionLine(userId, assetId, record.version);
    if (existing && !isDeepStrictEqual(existing.snapshot, record.snapshot)) throw new Error('immutable version snapshot conflict');
    try {
      if (!existing) await appendRecallJsonlRecord(userId, 'ability-asset-versions', assetId, record);
    } catch (error) {
      if (!pendingAssetVersions(raw).some(row => row.version === record.version && isDeepStrictEqual(row.snapshot, record.snapshot))) throw error;
      log.warn('asset version ledger pending recovery', { assetId, version: record.version });
      return;
    }
    const queued = pendingAssetVersions(raw);
    if (queued.some(row => row.version === record.version)) {
      const clean = { ...raw, pendingVersionSnapshots: queued.filter(row => row.version !== record.version) };
      if (!clean.pendingVersionSnapshots.length) delete (clean as RecallJsonRecord).pendingVersionSnapshots;
      await persistCognitionSource(userId, 'ability-assets', assetId, clean, () => writeJson(recordPath, clean));
    }
  }));
}

async function appendVersion(userId: string, asset: RecallAbilityAssetRecord, metadata: { reason?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const at = new Date().toISOString();
  await appendAbilityAssetVersionLine(userId, asset.id, {
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

/** 台账摘要的隐私边界。
 *
 *  文本类字段（正文/标题/用途/条件/自由文本 scope）**只留字数或条数**，任何
 *  情况下不落原文或前缀：台账是给用户逐条读的账，不是第二份正文副本——
 *  purge 之后它也是必须拿得出手的「不可识别最小项」。要逐字对比，版本流里
 *  有完整快照（版本对比视图读的就是它）；但版本流本身随 purge 一并清除。
 */
const AUDIT_BODY_FIELDS: ReadonlySet<string> = new Set(['statement', 'value', 'title', 'scope', 'applicableWhen', 'forbiddenWhen']);
const AUDIT_SUMMARY_MAX_CHARS = 240;
const AUDIT_VALUE_MAX_CHARS = 80;
/** Legacy audit summaries may still contain raw text. Field names survive;
 *  only an already-safe count (`N 字` / `N 条` / `N 项` / `—`) keeps its value —
 *  anything else is reduced to `—` so purge never keeps user text. */
const AUDIT_COUNT_SUMMARY_RE = /^(?:—|\d+\s*(?:字|条|项))$/;

/** 参与台账前后值比对的字段：只取用户/模型能改的那几维，治理派生量
 *  （validationCount、recommendedAction 等）由各自的 audit action 表达。 */
const AUDIT_DIFF_FIELDS = [
  'title', 'statement', 'type', 'contentCategory', 'scope', 'status', 'maturity', 'version',
  'value', 'applicableWhen', 'forbiddenWhen', 'evidenceRefs', 'deletedAt',
] as const;

function clipAuditText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 单个字段值 → 台账摘要文本。文本类字段只报字数/条数（审计只留
 *  字段名、字数、动作、时间）；枚举/数值类治理字段保留值本身。 */
export function summarizeAuditValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (AUDIT_BODY_FIELDS.has(field)) {
    return Array.isArray(value) ? `${value.length} 条` : `${String(value).length} 字`;
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
 * 写路径的失败归因。
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

/** 台账写入的公开口。
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
 * 当前值。rollback 与 select 必须删除目标快照中缺席的 scopePolicy / 条件 / 定级，
 * 才能完整恢复该版内容。
 *
 * 治理状态与成熟度**不在其列**：按设计不随内容回滚（暂停过的不该因回滚变回在用）。
 */
const VERSION_REVERT_CLEARABLE_FIELDS = [
  'value', 'contentCategory', 'scopePolicy', 'applicableWhen', 'forbiddenWhen',
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
  // 入参 asset 即记录快照，不重读主记录。
  const current = await listAbilityAssetVersions(userId, asset.id, asset);
  if (!current.length || pendingAssetVersions(asset).some(row => row.version === asset.version)) await appendVersion(userId, asset, metadata);
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
  // scope 写入点统一规范化：词条放行，场景描述句回落 general。
  if (input.scope !== undefined) input = { ...input, scope: resolveScopeForAsset(input.scope) };
  // 创建与更新共用标题边界：折叠空白、trim 并限制为 ≤120 字，再核对正文。
  // 在资产写入口校验，所有创建来源都必须经过此处。
  input = { ...input, title: bounded(input.title, 'title', 120) };
  if (input.value !== undefined) {
    const value = normalizeFutureUse(input.value);
    if (value === undefined) delete input.value; else input.value = value;
  }
  if (metadata.actor === 'user') assertReviewedAbilityAssetTitle(input.title);
  else assertCompliantAbilityAssetTitle(input.title, input.statement);
  bounded(metadata.reason, 'reason', 1_000);
  assertNotForbiddenToPersist([
    input.title,
    input.statement,
    input.value,
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
  if (!input.evidenceRefs.length && input.origin !== 'manual') throw new Error('new ability asset requires evidence');
  const validated = asAsset(input);
  if (validated.ownerId !== userId) throw new Error('ability asset owner mismatch');
  if (!safeId(validated.candidateId) || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(validated.reviewDecisionId)) {
    throw new Error('invalid ability asset handoff identity');
  }
  // 新资产从 bud/v1 开始；来源及未验证状态由 lifecycleStatus 表达，
  // 不以 actor 改变初始成熟度，避免自动来源资产因不可注入而无法积累验证。
  if (validated.maturity !== 'bud' || validated.version !== '1') {
    throw new Error('invalid initial ability asset lifecycle');
  }
  // 写入前解析执行类证据；查无来源记录时标记 degraded，不能冒充可核验来源。
  validated.evidenceRefs = (await resolveExecutionEvidenceRefs(userId, validated.evidenceRefs)) || [];
  const stored = asAsset(await withAssetVersionMetadata(metadata, () => updateRecallJsonRecord(
    userId,
    'ability-assets',
    validated.id,
    async (current) => {
      if (current) {
        if (current.ownerId !== userId || current.candidateId !== validated.candidateId
          || current.reviewDecisionId !== validated.reviewDecisionId) {
          throw new Error('ability asset idempotency identity mismatch');
        }
        return current;
      }
      if (validated.contentCategory !== undefined) requireContentCategory(validated.contentCategory);
      await verifyNightlyAssetCreation(userId, validated, metadata.actor);
      return validated;
    },
  )));
  if (stored.candidateId !== validated.candidateId || stored.reviewDecisionId !== validated.reviewDecisionId) {
    throw new Error('ability asset idempotency identity mismatch');
  }
  await initializeAbilityAsset(userId, stored, metadata);
  return stored;
}

export async function readAbilityAsset(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) throw new Error('recall ability asset not found');
  return asAsset(raw);
}

/** 画像投影的类型资格锚：personal 的认定只认评审落位时的
 *  类型——首版（v1）快照就是晋升评审定格的类型。事后把 type 改成 personal
 *  的编辑不构成投影授权，正文本会绕过画像评审直通第二份用户数据视图；
 *  资格要等覆盖该类型的评审确认（重新确认的 personal 资产）才会重建。
 *  版本流缺失或快照不记类型的存量档不追溯（读侧兼容口径）；读失败按
 *  无资格处理——投影宁可少投不可错投。 */
export async function hasReviewAnchoredPersonalType(userId: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  try {
    const first = (await listAbilityAssetVersions(userId, asset.id, asset)).find((row) => row.version === '1');
    if (!first) return true;
    const anchoredType = (first.snapshot as { type?: unknown } | null)?.type;
    if (anchoredType === undefined) return true;
    return String(anchoredType) === 'personal';
  } catch (error) {
    log.warn('personal profile type anchor unavailable', {
      userId,
      assetId: asset.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
      && !(asset.ontologyRefs?.length)
      && await hasReviewAnchoredPersonalType(userId, asset);
    if (canProject) {
      await profileSync.schedulePersonalProfileSync(userId, { assetId: asset.id });
      return;
    }
    const result = await profileSync.removePersonalProfileProjectionForAsset(userId, asset.id);
    if (!result.ok) {
      if (asset.status === 'purged') throw new Error(result.error || 'personal profile projection cleanup incomplete');
      log.warn('personal profile projection cleanup needs review', {
        userId,
        assetId: asset.id,
        error: result.error,
      });
    }
  } catch (error) {
    // 清除必须失败可重试：画像/模板副本还在时不能报成功。
    if (asset.status === 'purged') throw error;
    log.warn('personal profile projection reconciliation failed', {
      userId,
      assetId: asset.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listAbilityAssets(userId: string): Promise<RecallAbilityAssetRecord[]> {
  let names: string[];
  const reader = createRecallCollectionReader(userId, 'ability-assets');
  const unifiedIds = reader.ids;
  try { names = unifiedIds ? unifiedIds.map(id => `${id}.json`) : await fs.readdir(assetsDirectory(userId)); }
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
      return { id, record: await reader.read(id) };
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

/** Read a bounded set of assets by id with the same per-record degradation as
 *  listAbilityAssets: one collection snapshot for the whole set, malformed
 *  records skipped, real IO failures propagated. */
export async function readAbilityAssets(userId: string, assetIds: string[]): Promise<RecallAbilityAssetRecord[]> {
  const ids = [...new Set(assetIds.filter((id): id is string => typeof id === 'string' && safeId(id)))];
  if (!ids.length) return [];
  const reader = createRecallCollectionReader(userId, 'ability-assets');
  const reads = await Promise.all(ids.map(async (id) => {
    try {
      return { id, record: await reader.read(id) };
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
  return assets;
}

/** 某空间沉淀的资产（按 spaceId 过滤；资产随 recall 全局存储，不随空间删）。
 *  空间能读到全局资产（引用/检索走 listAbilityAssets），但空间资产 tab 只显示本空间的。
 *  **已撤销（revoked）的资产不显示**（用户撤销后从空间资产列表消失；全局认知资产页仍可见）。 */
export async function listAbilityAssetsForSpace(userId: string, spaceId: string): Promise<RecallAbilityAssetRecord[]> {
  if (!safeId(spaceId)) return [];
  const all = await listAbilityAssets(userId);
  return all.filter((asset) => asset.spaceId === spaceId && asset.status !== 'revoked');
}

/** tags-only 更新判定：除 tags/reason/actor/expectedVersion 外
 *  没有别的字段 = 纯标签元数据更新，走不 bump 版本的路径；任何内容字段在场
 *  都走既有内容路径（版本照常 bump，标签随同写入但不进版本快照）。 */
const TAGS_ONLY_METADATA_KEYS = new Set(['tags', 'reason', 'actor', 'expectedVersion', 'expectedActiveVersion', 'expectedTags', 'expectedStatus']);

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
  if (input.contentCategory !== undefined) requireContentCategory(input.contentCategory);
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  // 写入必须使用合法类型；读侧保留旧值，以便用户发现并修复历史记录。
  if (input.type !== undefined && !ABILITY_ASSET_TYPES.has(input.type)) {
    throw new Error(`invalid ability asset type: ${String(input.type)}`);
  }
  // scope 写入点统一规范化：词条放行，场景描述句回落 general。
  if (input.scope !== undefined) input = { ...input, scope: resolveScopeForAsset(input.scope) };
  const action = requireAssetAction(input);
  // 标签规范化统一在 ability-tag-service，这里不另写。
  // 缺失的库条目**先补建**再写资产（createdFrom 按调用来源：模型打标 = ai），
  // 保证"资产引用的每个名字都有 active 条目"不被写路径自己打破。
  const futureUse = input.value === undefined ? undefined : normalizeFutureUse(input.value);
  const tagsInput = input.tags === undefined ? undefined : normalizeAbilityTagList(input.tags);
  const expectedTagsInput = input.expectedTags === undefined ? undefined : normalizeAbilityTagList(input.expectedTags);
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
    input.value,
    input.scope,
    // 条件同样是用户手写、会被冻进能力包并注入提示的自由文本，
    // 不过闸就等于给凭证留了一条只换字段名的旁路。
    ...(semantics.applicableWhen || []),
    ...(semantics.forbiddenWhen || []),
    // 标签也是会进入筛选提示的自由文本。
    ...(tagsInput || []),
  ]);
  let clearedRecommendation = false;
  let changed = false;
  let tagsChanged = false;
  let beforeAsset: RecallAbilityAssetRecord | undefined;
  const updated = await withAssetVersionMetadata({ actor: action.actor, reason: action.reason }, () => updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    // 与版本选择、回滚和归并共用终态守卫，禁止修改 purged/revoked/deleted 资产。
    assertMutableAbilityAsset(current);
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new Error(
        `ability asset version conflict: expected v${input.expectedVersion}, current v${current.version}`,
      );
    }
    if (input.expectedActiveVersion !== undefined && !matchesAbilityAssetActiveVersion(current, input.expectedActiveVersion)) {
      throw new Error(`ability asset active version conflict: expected v${input.expectedActiveVersion}, current v${abilityAssetActiveVersion(current)}`);
    }
    if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
      throw new Error(`ability asset status conflict: expected ${input.expectedStatus}, current ${current.status}`);
    }
    // 标签不 bump 版本：expectedVersion 对标签维度的并发改动不可见，所以
    // 标签 CAS 必须在同一把写锁内按集合比对（顺序/大小写变化不算冲突）。
    if (expectedTagsInput !== undefined && !sameAbilityTagSet(current.tags || [], expectedTagsInput)) {
      throw new Error('ability asset tags conflict');
    }
    // 纯标签更新不增加内容版本，版本快照不含 tags。
    // 规范化后无变化时不写入、不记账；显式清空以键缺席落盘。
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
      attachHumanEditMetadata(userId, current, tagOnly);
      return tagOnly;
    }
    changed = true;
    beforeAsset = current;
    clearedRecommendation = Boolean(current.recommendedAction && input.acknowledgeRecommendation);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: boundedStatement(input.statement) } : {}),
      ...(futureUse !== undefined ? { value: futureUse } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(input.scopePolicy !== undefined && scopePolicy ? { scopePolicy } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.contentCategory !== undefined ? { contentCategory: input.contentCategory } : {}),
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
    if (input.value !== undefined && futureUse === undefined) delete next.value;
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
    // 写入 title 时用最终正文核对；未修改 title 的旧资产不因历史标题被拦。
    if (input.title !== undefined) {
      if (input.actor === 'user') assertReviewedAbilityAssetTitle(next.title);
      else assertCompliantAbilityAssetTitle(next.title, next.statement);
    }
    const standingBaseline = readStandingPreferenceAuthorityBaseline(userId, current.id);
    if (standingBaseline && (current.version !== standingBaseline.version || activeVersionOf(current) !== standingBaseline.activeVersion)) {
      throw new Error('standing preference authority baseline changed');
    }
    resetChangedGuidanceOutcomes(current, next);
    attachStandingPreferenceAuthority(userId, current, next);
    return next;
  }));
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
    // 台账 reason 必含「标签：旧 → 新」——
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
    // 标题内容更新会增加版本号，必须同步刷新 committed 投影的版本快照。
    // 动态 import 避免静态循环依赖。资产已提交，刷新失败只记录错误，不回滚版本。
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
  // 证据融合也遵守终态与删除保留期内不可变的约束。
  assertMutableAbilityAsset(current);
  // 只解析新证据；保留既有引用，由来源读取侧如实呈现旧来源不可用状态。
  const incoming = (await resolveExecutionEvidenceRefs(userId, normalizeCognitionSourceRefs(newRefs))) || [];
  const sourceSessionIds = [...new Set([
    ...(current.sourceSessionIds || []),
    ...(metadata.sourceSessionIds || []).filter((id) => safeId(id)),
  ])].slice(0, 50);
  const updated = asAsset(await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const cur = asAsset(raw);
    assertMutableAbilityAsset(cur);
    // 在锁内以最新 cur 重算融合结果，防止覆盖并发更新的引用。
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

/** 内容与版本写路径共用终态守卫：purged/revoked/deleted 均不可变更。 */
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
  // 内容和治理变更需要评审交接；保留期清除是策略触发，不生成虚构评审决定。
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
    if (current.organizationArchivedBy && ['active', 'paused'].includes(status)) throw new Error(t('cognition.organization.restore_group'));
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new Error(
        `ability asset version conflict: expected v${input.expectedVersion}, current v${current.version}`,
      );
    }
    if (current.status === 'revoked' && status !== 'revoked' && status !== 'purged') {
      throw new Error('revoked ability asset cannot be changed');
    }
    // 删除保留期内只允许幂等删除、彻底清除，或经带保留期校验的 restore 恢复。
    if (current.status === 'deleted' && status !== 'deleted' && status !== 'purged' && auditAction !== 'restored') {
      throw new Error('deleted ability asset cannot be changed');
    }
    // 守卫先于幂等早退：已应用评审决定的变更重放同样必须过前置校验，否则
    // 重放可绕过 requireDeleted/restore 保留期等条件，直接触发后续破坏性清理。
    guard?.(current);
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
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


/** 作用域中文标签（与 renderer _abilityAssetScopeLabel 一致；展示层另有映射，
 *  这里仅用于迁移时生成中文标题）。 */
export function userScopeLabel(scope: string): string {
  const map: Record<string, string> = {
    report: '报告类任务', code: '代码类任务', review: '审查类任务',
    product: '产品类任务', general: '通用',
  };
  return map[scope] || scope;
}

/** 幂等迁移旧英文技术标题：只改匹配的 title/statement 前缀，保留证据和版本关系。 */
export async function migrateLegacyUserFacingTitles(userId: string): Promise<number> {
  let migrated = 0;
  const titleRules: Array<[RegExp, (scope: string) => string]> = [
    [/^Reusable experience lesson \(requirement-level\)$/, (s) => `可复用经验（${userScopeLabel(s)}）`],
    [/^KSTAR rule gap candidate \(requirement-level\)$/, (s) => `待修正的经验（${userScopeLabel(s)}）`],
    [/^Reusable workflow lesson$/, () => '可复用经验'],
    [/^Verified multi-tool workflow$/, () => '已验证的工作流程'],
  ];
  for (const asset of await listAbilityAssets(userId)) {
    // 迁移不修改终态和删除保留期内的资产。
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
      // 迁移仍需递增版本、保存内容快照并记审计，以保持冻结投影与实时内容一致。
      // 不直接调用 updateAbilityAsset：它要求 system actor 提供自动评审交接
      // reviewDecisionId，而迁移属于维护性更新。
      await updateRecallJsonRecord(userId, 'ability-assets', asset.id, (raw) => {
        if (!raw) throw new Error('recall ability asset not found');
        const current = asAsset(raw);
        // 锁内终态复核：外层快照过滤只对快照时刻有效，遍历期间
        // 资产可能已被删除/撤回——闭包抛错发生在 writeJson 之前，整个
        // runExclusive reject 不落盘，外层 catch 记 warn 跳过该资产继续。
        assertMutableAbilityAsset(current);
        if (nextTitle) current.title = nextTitle;
        if (nextStatement) current.statement = nextStatement;
        current.version = nextVersion(current.version);
        // 迁移改写的是在用内容：activeVersion 同步指向新快照，
        // 否则 select 过旧版的资产按在用版注入的仍是迁移前旧文。
        current.activeVersion = current.version;
        current.updatedAt = new Date().toISOString();
        return current;
      });
      const migratedAsset = await readAbilityAsset(userId, asset.id);
      if (migratedAsset) {
        await appendVersion(userId, migratedAsset, {
          reason: 'legacy English title → user-facing Chinese',
          actor: 'system',
        });
        await appendAudit(userId, asset.id, 'updated', {
          note: 'legacy English title → user-facing Chinese',
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

/** 把可归一的旧自由文本 scope 迁为受控词表值；词表值原样跳过。
 * 内容版本递增后同步刷新 confirmed 投影的 assetVersions，保持版本校验一致。 */
export async function migrateLegacyFreeTextScopes(userId: string): Promise<number> {
  const { normalizeAssetScopeValue, isRecallScopeTerm } = await import('./scope-policy');
  let migrated = 0;
  for (const asset of await listAbilityAssets(userId)) {
    // 迁移不触碰终态或删除保留期内的资产。
    if (asset.status !== 'active' && asset.status !== 'paused' && asset.status !== 'archived') continue;
    const scope = String(asset.scope || '');
    if (isRecallScopeTerm(scope)) continue;
    const normalized = normalizeAssetScopeValue(scope);
    if (!normalized || normalized === scope.toLowerCase()) continue;
    try {
      await updateRecallJsonRecord(userId, 'ability-assets', asset.id, (raw) => {
        if (!raw) throw new Error('recall ability asset not found');
        const current = asAsset(raw);
        // 锁内终态复核，墓碑/撤回资产不进改写。
        assertMutableAbilityAsset(current);
        current.scope = normalized;
        current.version = nextVersion(current.version);
        // 同上：scope 是会进版本快照与注入的内容维度，在用版
        // 指针必须跟随迁移后的新快照，不能留在 select 过的旧版上。
        current.activeVersion = current.version;
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
          reason: `legacy free-text scope "${scope}" → controlled term "${normalized}"`,
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

/** 授予或撤回持久跨作用域许可；撤回后重新要求跨范围确认。 */
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
    // 跨范围授权同样受终态守卫约束，不能在已删除内容上预置恢复后的许可。
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
  if (input.expectedVersion !== undefined && !/^[0-9]{1,9}$/.test(input.expectedVersion)) throw new Error('invalid ability asset expected version');
  if (input.action !== 'pause' && input.action !== 'rework') throw new Error('invalid ability asset recommendation');
  const reason = bounded(input.reason, 'recommendation reason', 1_000);
  const actor = input.actor === 'system' ? 'system' : input.actor === 'user' ? 'user' : undefined;
  if (!actor) throw new Error('invalid ability asset recommendation actor');
  let appended = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (input.expectedVersion !== undefined && (current.version !== input.expectedVersion || activeVersionOf(current) !== input.expectedVersion)) return current;
    // 推荐卡仅适用于可变更资产，与内容写路径共用终态守卫。
    assertMutableAbilityAsset(current);
    if (current.recommendedAction === input.action && current.recommendationReason === reason) return current;
    appended = true;
    return { ...current, recommendedAction: input.action, recommendationReason: reason, recommendationAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (appended) await appendAudit(userId, asset.id, input.action === 'pause' ? 'pause_recommended' : 'rework_recommended', { note: reason, actor });
  return asset;
}

/** 归档：从日常列表移出、不参与推荐，历史与 Evidence 保留，可恢复。 */
export function archiveAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'archived', input);
}

/**
 * 删除：移出可用资产并进入保留期，保留期内可恢复。
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
 * 彻底清除：删除内容、版本和可识别副本，仅保留不可识别的审计最小项。
 *
 * 留墓碑而不是删记录：Receipt 里已经写着 `asset:<id>@v<version>`，记录整个消失
 * 会让历史回执指向虚空，回放时无从判断这条引用是被清除了还是从未存在。墓碑保留
 * id、candidateId、owner 与时间线，清空标题、正文、证据与全部语义字段。
 *
 * Reports persist contentAssetIds before the tombstone under the cognition
 * transition lock. Cleanup failures propagate; retry and boot resume by ID.
 * Legacy tombstones without these links support identity-based cleanup only:
 * erased text cannot establish ownership of an unrelated historical report row.
 * 版本快照一并清空——它们同样含正文，留着就不算「删除内容和版本」。
 */
export async function purgeAbilityAsset(
  userId: string,
  assetId: string,
  input: AbilityAssetUserActionInput,
  options: { requireDeleted?: boolean } = {},
): Promise<RecallAbilityAssetRecord> {
  return withCognitionTransition(userId, () => purgeAbilityAssetLocked(userId, assetId, input, options));
}

async function purgeAbilityAssetLocked(userId: string, assetId: string, input: AbilityAssetUserActionInput,
  options: { requireDeleted?: boolean }): Promise<RecallAbilityAssetRecord> {
  requireAssetAction(input);
  const beforePurge = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (beforePurge?.status === 'purged') return resumePurgedAssetCascade(userId, assetId);
  if (!beforePurge) throw new Error('recall ability asset not found');
  const purgedStatement = String(beforePurge.statement || '').trim();
  const purgedTitle = String(beforePurge.title || '').trim();
  const purgedOntologyRecordIds = ((beforePurge as RecallAbilityAssetRecord).ontologyRefs || [])
    .map(ref => ref.recordId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const { candidateTextHash } = await import('../personal_ontology_candidates');
  const purgedTextHash = purgedStatement ? candidateTextHash(purgedStatement) : undefined;
  // Persist ownership while text is available; a failed write leaves the asset
  // intact. Report writes share this transition lock through tombstoning.
  const { linkCleanupReportsToAsset } = await import('./cleanup-report-service');
  await linkCleanupReportsToAsset(userId, assetId, [purgedTitle, purgedStatement].filter(Boolean));
  const asset = await setStatus(userId, assetId, 'purged', input, () => ({
    title: '',
    statement: '',
    value: undefined,
    evidenceRefs: [],
    purgedAt: new Date().toISOString(),
    ...(purgedTextHash ? { purgedTextHash } : {}),
    ...(purgedOntologyRecordIds.length ? { purgedOntologyRecordIds } : {}),
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
    // 成熟度是对已清除内容的效果声明：与 sensitivity 同理，
    // 墓碑不该继续声称「这条已验证」。
    maturity: undefined,
    // 验证三件套是同一句声明的展开：validationCount>0 加
    // lastValidatedAt 就是「已验证 N 次、最近验证于 X」，consecutiveFailures
    // 同为验证效果记账——maturity 升 bud 的依据恰恰是 validationCount（见
    // recordAbilityAssetValidation），只清结论不清依据，墓碑仍在替已清除的
    // 内容背书，且 purged 终态拒写后永远清不掉。
    validationCount: undefined,
    consecutiveFailures: undefined,
    lastValidatedAt: undefined,
    // 因果规则是 R-Box 教训语义本体，cause/effect/mitigation 全是用户可读
    // 自然语言——与 statement 同级的可识别内容。
    causalRule: undefined,
    // 主题标签是用户手写的分类词（与 familyName 同理，元数据但可识别）。
    tags: undefined,
    // scope 可能被写成场景描述句（自由文本迁移前），按可识别内容清空；
    // 字段是 string 必填，清空口径为空串。
    scope: '',
    // 复盘归因明细带 plan 步骤与动作清单，是内容的事实副本。
    learningProvenance: undefined,
    // 敏感级是对已清除内容的分级声明：内容没了，分级成了对「无」的断言；
    // 与 maturity 清理同理（上面的注释原以它举例，这里一并落实）。
    sensitivity: undefined,
    // 延续授权与编辑决定内嵌 patch/内容哈希来源链（standingPreferenceAuthority
    // 的 editDecision、userEditDecision 的 patch），对已清除内容没有任何
    // 授权意义，且 patch 可携带正文片段。
    standingPreferenceAuthority: undefined,
    userEditDecision: undefined,
  } as Partial<RecallAbilityAssetRecord>),
  // 到期清扫传 requireDeleted：锁内复核仍是 deleted 才清——
  // 清扫列表是锁外读的快照，窗口期内被用户恢复的资产不许被照单清除。
  options.requireDeleted
    ? (current: RecallAbilityAssetRecord) => {
      if (current.status !== 'deleted') throw new Error('retention purge requires a deleted asset');
    }
    : undefined);
  // 幂等早退（已应用评审决定的重放）会让 setStatus 原样返回未清除的记录：
  // 破坏性清理只在墓碑真正落盘后进行——活资产的版本流被清而正文仍在主记录
  // 上，等于半次清除（版本没了、内容还在）。
  if (asset.status !== 'purged') {
    throw new Error('ability asset purge skipped: review decision already applied');
  }
  await sweepPurgedVersionStream(userId, assetId);
  await cascadePurgeAssetReferences(userId, assetId, purgedStatement);
  return asset;
}

/** purge 的版本流清理段：删整流 + 删后复读复核、再清一次（双向纵深）。
 * 复核失败不等同于干净：坏流同样不允许留在已清除资产名下。 */
async function sweepPurgedVersionStream(userId: string, assetId: string): Promise<void> {
  await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
  try {
    const residue = await listAbilityAssetVersions(userId, assetId);
    if (residue.length) {
      log.warn(`purge version stream residue reswept assetId=${assetId} lines=${residue.length}`);
      await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
    }
  } catch (error) {
    log.warn(`purge version stream unreadable, reswept assetId=${assetId}: ${error instanceof Error ? error.message : String(error)}`);
    await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
  }
}

/** 墓碑已落后的级联重入：级联失败须支持重试。
 * 终态复核持主记录锁进行；attempt 只记日志（含重放的清理段），不写新审计
 * 行——重试不是新的治理动作，墓碑本身就是那次清除的台账。 */
async function resumePurgedAssetCascade(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  let purgedTextHash: string | undefined;
  await fileEditLock(recallJsonRecordPath(userId, 'ability-assets', assetId)).runExclusive(async () => {
    const locked = await readRecallJsonRecord(userId, 'ability-assets', assetId);
    if (!locked) throw new Error('recall ability asset not found');
    if (asAsset(locked).status !== 'purged') {
      throw new Error('ability asset purge retry requires a purged tombstone');
    }
    purgedTextHash = asAsset(locked).purgedTextHash;
  });
  log.info(`purge cascade retry re-entered assetId=${assetId}`);
  await sweepPurgedVersionStream(userId, assetId);
  await cascadePurgeAssetReferences(userId, assetId, '', purgedTextHash);
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  return asAsset(raw!);
}

/**
 * 彻底清除的级联段。
 *
 * 正文副本散落在哪几处，就要清到哪几处——只清主记录和版本流不够：
 *   - `usage-records` / `asset-usage-receipts` / `injection-receipts` 的 events
 *     流里带着 assetId 与版本，是"这条资产被用过"的可识别痕迹；
 *   - 投影里的 `assetVersionSnapshots` 是「版本真删」时冻结的**内容副本**
 *     （见 deleteAbilityAssetVersion），正文就在里面；
 *   - 本体回流候选池的 `asset-backflow-<assetId>` 候选（仅清理历史副本）
 *     的 memory_text 就是 statement 全文——候选确认不查来源资产存活性，
 *     留着它等于留了一条「确认即复活」的通道。
 * 留下任何一处，「内容与记录一并清除、搜索不可见、不可恢复」都不成立。
 *
 * 幂等：流不存在或没有匹配行都不报错、不写新账——反复清除不会留下重复痕迹。
 */
async function cascadePurgeAssetReferences(
  userId: string,
  assetId: string,
  purgedStatement: string,
  purgedTextHash?: string,
): Promise<void> {
  await sweepPurgedOrganizationContent(userId, assetId);
  const dropAsset = (record: RecallJsonRecord) => String(record.assetId || '') !== assetId;
  // 坏行按「随清除移除」处理（dropMalformedLines 为显式 opt-in，版本删版
  // 等破坏性重写仍保持整流拒绝）：级联清理的目标是移除，一条不可解析的
  // 坏档不应阻止清除；级联失败须支持重试。
  for (const stream of ['usage-records', 'asset-usage-receipts', 'injection-receipts'] as const) {
    const result = await removeRecallJsonlRecords(userId, stream, 'events', dropAsset, { dropMalformedLines: true });
    if (result.droppedMalformed) {
      log.warn(`purge cascade dropped malformed receipt lines assetId=${assetId} stream=${stream} lines=${result.droppedMalformed}`);
    }
  }
  // 动态 import：asset-service ↔ context-projection 静态互引会成环。
  const { clearAssetFromAllProjections } = await import('./context-projection');
  const cleared = await clearAssetFromAllProjections(userId, assetId);
  if (cleared > 0) {
    log.info(`purge cascade cleared frozen asset copies from projections assetId=${assetId} projections=${cleared}`);
  }
  // 动态读取旧候选池，只为清理历史副本。rejectCandidate 按
  // candidate_id 精确移除这一条回流候选、不动池内其他候选；候选不存在时
  // 仅告警并返回 {ok:false}，不抛错不写新账——与上面各步同口径满足幂等。
  const { rejectCandidate, rejectCandidatesByText, rejectCandidatesByTextHash } = await import('../personal_ontology_candidates');
  // The writer is retired; historical IDs remain part of purge compatibility.
  const rejected = await rejectCandidate(userId, `asset-backflow-${assetId}`, 'asset purged');
  if (rejected.ok) {
    log.info(`purge cascade rejected ontology backflow candidate assetId=${assetId}`);
  }
  // 同正文的历史 pending 候选可能使用其他 id，按完整正文或清除时落下的
  // 不可逆摘要清理。正文为空时用摘要，重试不再依赖已经抹掉的原文。
  if (purgedStatement) {
    const rejectedByText = await rejectCandidatesByText(userId, purgedStatement, 'asset purged');
    if (rejectedByText.rejectedCount > 0) {
      log.info(`purge cascade rejected same-text candidates assetId=${assetId} count=${rejectedByText.rejectedCount}`);
    }
  } else if (purgedTextHash) {
    const rejectedByHash = await rejectCandidatesByTextHash(userId, purgedTextHash, 'asset purged');
    if (rejectedByHash.rejectedCount > 0) {
      log.info(`purge cascade rejected same-text candidates by hash assetId=${assetId} count=${rejectedByHash.rejectedCount}`);
    }
  }
  await sweepPurgedAssetRetainedCopies(userId, assetId);
}

/** 墓碑级残留副本的统一补偿入口：画像/模板、审查账本、旧审计、报告/巡检。
 *  purge 级联、用户重试与启动补偿共用，失败统一上抛给调用方重试。 */
async function sweepPurgedAssetRetainedCopies(userId: string, assetId: string): Promise<void> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) return;
  const asset = asAsset(raw);
  if (asset.status === 'purged') {
    // Unified-store history is written by the tombstone itself; scrub ontology
    // ownership and delete the per-object version stream after that commit.
    await sweepPurgedCognitionCopies(userId, assetId, asset.purgedOntologyRecordIds || []);
  }
  await reconcilePersonalProfileProjection(userId, asset);
  if (asset.status === 'purged') {
    const { purgePoAssetProjections } = await import('../po/store');
    const po = await purgePoAssetProjections(userId, assetId);
    if (po.liveValues || po.trashValues || po.historyFiles) {
      log.info(`purge cascade scrubbed PO copies assetId=${assetId} live=${po.liveValues} trash=${po.trashValues} historyFiles=${po.historyFiles} historyValues=${po.historyValues}`);
    }
  }
  const redactedDecisions = await sweepPurgedReviewDecisionContent(userId, assetId);
  if (redactedDecisions > 0) {
    log.info(`purge cascade redacted review decision content assetId=${assetId} records=${redactedDecisions}`);
  }
  const scrubbedAudit = await sweepPurgedAssetAudit(userId, assetId);
  if (scrubbedAudit > 0) {
    log.info(`purge cascade scrubbed legacy audit summaries assetId=${assetId} records=${scrubbedAudit}`);
  }
  await sweepPurgedAssetReportCopies(userId, assetId);
}

/** Scrub ontology history, its sideline archives and the unified-store version
 *  stream for one purged asset. The tombstone is already committed; any failure
 *  propagates so the retry/startup sweep can finish the remaining copies. */
async function sweepPurgedCognitionCopies(
  userId: string,
  assetId: string,
  ontologyRecordIds: readonly string[],
): Promise<void> {
  const [{ purgeCognitionObject }, { purgeOntologyAssetCopies, scrubOntologyArchives }] = await Promise.all([
    import('../cognition_kernel/store'),
    import('../cognition/ontology/purge'),
  ]);
  const ontology = await purgeOntologyAssetCopies(userId, assetId, ontologyRecordIds);
  await scrubOntologyArchives(userId, assetId, ontology.recordIds);
  await purgeCognitionObject(userId, assetId);
}

/** 审查账本里可能留有候选编辑全文；按资产记录的候选/决定身份抹掉用户文本。 */
async function sweepPurgedReviewDecisionContent(userId: string, assetId: string): Promise<number> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) return 0;
  const asset = asAsset(raw);
  const decisionIds = [asset.reviewDecisionId, ...(asset.appliedReviewDecisionIds || [])]
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  const targetRefs = [
    asset.candidateId ? `recall_candidate:${asset.candidateId}` : '',
    ...(asset.sourceCandidateIds || []).map(id => `recall_candidate:${id}`),
  ].filter((ref): ref is string => ref !== '');
  const { redactReviewDecisionContent } = await import('../cognition/review-decision');
  return redactReviewDecisionContent(userId, { decisionIds, targetRefs });
}

/** Re-summarize a legacy audit `before`/`after` string. Field names and
 *  counts/governance values survive; user text never does. A summary that
 *  cannot be parsed into fields is dropped entirely (absence is safer than
 *  guessing). */
function scrubLegacyAuditSummary(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const fields: string[] = [];
  for (const segment of value.split('；')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const field = segment.slice(0, eq).trim();
    const raw = segment.slice(eq + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) continue;
    if (AUDIT_BODY_FIELDS.has(field)) {
      const safe = !raw || raw === '—'
        ? '—'
        : (AUDIT_COUNT_SUMMARY_RE.test(raw) ? raw : `${raw.length} 字`);
      fields.push(`${field}=${safe}`);
      continue;
    }
    // Only an already-safe count survives; any other value could be user text
    // and is reduced to an empty marker.
    if (AUDIT_COUNT_SUMMARY_RE.test(raw)) fields.push(`${field}=${raw}`);
    else fields.push(`${field}=—`);
  }
  if (!fields.length) return undefined;
  const joined = fields.join('；');
  return joined.length > AUDIT_SUMMARY_MAX_CHARS
    ? `${joined.slice(0, AUDIT_SUMMARY_MAX_CHARS)}…`
    : joined;
}

/** 旧审计行可能带正文；清除后只保留字段名/字数与动作、时间、actor 等治理坐标，
 *  正文一律不保留。新写入的台账摘要（`statement=N 字`）同样要活下来——它是
 *  审计的最小可读凭据，不能整条 `before/after` 删掉。 */
async function sweepPurgedAssetAudit(userId: string, assetId: string): Promise<number> {
  const file = recallJsonlPath(userId, 'ability-asset-audit', assetId);
  return withJsonlLineLock(file, async () => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const rewritten: string[] = [];
    let scrubbed = 0;
    let changed = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // 坏行无法证明不含正文，随清除一起移除。
        changed = true;
        continue;
      }
      let local = false;
      for (const key of ['note', 'reason'] as const) {
        const value = record[key];
        // Keep exactly the system's retention proof; user text that merely
        // mentions 保留期 must still be removed from a purged asset.
        const systemRetentionProof = (key === 'note' || key === 'reason')
          && typeof value === 'string' && record.action === 'purged' && record.actor === 'system'
          && /^保留期（\d+ 天）届满，系统自动彻底删除$/.test(value);
        if (value !== undefined && !systemRetentionProof) {
          delete record[key];
          local = true;
        }
      }
      for (const key of ['before', 'after'] as const) {
        if (record[key] === undefined) continue;
        const sanitized = scrubLegacyAuditSummary(record[key]);
        if (sanitized === undefined) delete record[key];
        else record[key] = sanitized;
        local = true;
      }
      if (local) {
        scrubbed += 1;
        changed = true;
      }
      rewritten.push(JSON.stringify(record));
    }
    if (!changed) return 0;
    const tmp = `${file}.purge-${process.pid}.tmp`;
    await fs.writeFile(tmp, rewritten.length ? `${rewritten.join('\n')}\n` : '', 'utf8');
    await fs.rename(tmp, file);
    return scrubbed;
  });
}

async function sweepPurgedAssetReportCopies(userId: string, assetId: string): Promise<void> {
  // 报告/巡检台账不留正文——写入侧已改口径，存量残留（旧报告
  // 引用了被清除资产的标题/正文）在此清成不可识别形式。失败上抛，由级联
  // 的可重入通道（墓碑已落仍可重试）兜住，不吞错。
  const { sweepPurgedAssetFromCleanupReports } = await import('./cleanup-report-service');
  const sweptReports = await sweepPurgedAssetFromCleanupReports(
    userId, assetId,
  );
  if (sweptReports > 0) {
    log.info(`purge cascade redacted cleanup report entries assetId=${assetId} reports=${sweptReports}`);
  }
  const { sweepPurgedAssetFromInspectionRuns } = await import('./asset-inspection-service');
  const sweptRuns = await sweepPurgedAssetFromInspectionRuns(userId, assetId);
  if (sweptRuns > 0) {
    log.info(`purge cascade redacted inspection findings assetId=${assetId} runs=${sweptRuns}`);
  }
}

/** 启动期清扫已清除或已移出记录名下残留的版本流与投影冻结副本。
 * 版本流段：枚举版本流目录，只删除对应主记录为 purged 或已不存在的流。
 * 投影段：枚举 projections 引用的资产 id，对 purged/除名资产调
 * clearAssetFromAllProjections 清掉冻结内容副本——此前级联清理是投影冻结
 * 副本唯一清理点，purge 后的残留（级联中途失败/历史数据）没有任何通道。
 * 操作幂等、逐条容错；启动通过 recall:purge-version-stream-sweep 的
 * deferred/idleDisk 维护任务队列执行。 */
export interface PurgedAssetVersionStreamSweepReport {
  sweptStreams: string[];
  /** 主记录仍可读且为 purged 墓碑的条数（其余对应主记录已不存在）。 */
  purgedTombs: number;
  /** 投影段：被清掉引用的资产 id（purged 墓碑或记录已除名）。 */
  sweptProjectionAssets: string[];
  /** 投影段：实际改写过的投影条数。 */
  clearedProjections: number;
}

export async function sweepPurgedAbilityAssetVersionStreams(
  userId: string,
): Promise<PurgedAssetVersionStreamSweepReport> {
  // This pass does not depend on a version-stream directory: a crash may have
  // removed the stream before clearing organization checkpoints.
  const failures: unknown[] = [];
  try {
    await sweepPurgedOrganizationContent(userId);
  } catch (error) {
    // 一条坏组织档不能阻断后续版本流/投影清扫；失败在末尾聚合上报。
    failures.push(error);
  }
  const tombs = createRecallCollectionReader(userId, 'ability-assets');
  const tombIds = tombs.ids || await fs.readdir(path.dirname(recallJsonRecordPath(userId, 'ability-assets', 'snapshot')))
    .then(names => names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)))
    .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const id of tombIds) {
    if (!safeId(id)) continue;
    try {
      if ((await tombs.read(id))?.status === 'purged') await withCognitionTransition(userId, () => sweepPurgedAssetRetainedCopies(userId, id));
    } catch (error) { failures.push(error); }
  }
  const streamsDir = path.dirname(recallJsonlPath(userId, 'ability-asset-versions', 'placeholder'));
  let names: string[];
  try {
    names = await fs.readdir(streamsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const projection = await sweepPurgedAbilityProjectionReferences(userId);
      if (failures.length) throw new AggregateError(failures, 'purged asset cleanup remains incomplete');
      return { sweptStreams: [], purgedTombs: 0, sweptProjectionAssets: projection.sweptAssets, clearedProjections: projection.clearedProjections };
    }
    throw error;
  }
  const report: PurgedAssetVersionStreamSweepReport = { sweptStreams: [], purgedTombs: 0, sweptProjectionAssets: [], clearedProjections: 0 };
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const assetId = name.slice(0, -'.jsonl'.length);
    if (!safeId(assetId)) continue;
    try {
      const record = await readRecallJsonRecord(userId, 'ability-assets', assetId);
      // 记录仍在且非墓碑 = 活资产（active/paused/archived/deleted/revoked 都
      // 保留内容），流必须原样保留。只清「记录已除名」与「purged 墓碑」两种。
      if (record && record.status !== 'purged') continue;
      await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
      report.sweptStreams.push(assetId);
      if (record) report.purgedTombs += 1;
      log.warn(`startup sweep removed a residual ability asset version stream assetId=${assetId} record=${record ? 'purged tombstone' : 'missing (migrated out)'}`);
    } catch (error) {
      log.warn(`startup sweep failed on an ability asset version stream assetId=${assetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const projection = await sweepPurgedAbilityProjectionReferences(userId);
  report.sweptProjectionAssets = projection.sweptAssets;
  report.clearedProjections = projection.clearedProjections;
  if (failures.length) throw new AggregateError(failures, 'purged asset cleanup remains incomplete');
  return report;
}

/** Clear organization copies by asset identity, including historical jobs and
 * completed groups. The storage boundary prevents late writes after this pass. */
async function sweepPurgedOrganizationContent(userId: string, assetId?: string): Promise<void> {
  await withCognitionTransition(userId, async () => {
    const purged = new Map<string, boolean>();
    for (const collection of ['stock-organization', 'candidates', 'asset-approvals']) {
      const reader = createRecallCollectionReader(userId, collection);
      let ids = reader.ids;
      if (!ids) {
        try {
          ids = (await fs.readdir(path.dirname(recallJsonRecordPath(userId, collection, 'snapshot'))))
            .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      for (const id of ids) {
        const record = await reader.read(id);
        if (!record || record.contentPurgedAt) continue;
        const references = organizationContentAssetIds(record);
        if (assetId && !references.includes(assetId)) continue;
        let affected = false;
        for (const referenced of assetId ? [assetId] : references) {
          if (!purged.has(referenced)) purged.set(referenced, (await readRecallJsonRecord(userId, 'ability-assets', referenced))?.status === 'purged');
          if (purged.get(referenced)) { affected = true; break; }
        }
        if (affected) await updateRecallJsonRecord(userId, collection, id, current =>
          current?.contentPurgedAt ? current : purgedOrganizationRecord(collection, current!, new Date().toISOString()));
      }
    }
  });
}

/** 投影冻结副本清扫段：收集 projections 引用的资产 id，对 purged 墓碑或
 * 记录已除名者清掉全部引用（含 assetVersionSnapshots 内容副本）。幂等、
 * 逐资产容错；活资产（含 deleted 保留期）原样不动。 */
async function sweepPurgedAbilityProjectionReferences(
  userId: string,
): Promise<{ sweptAssets: string[]; clearedProjections: number }> {
  const projectionsDir = path.dirname(recallJsonRecordPath(userId, 'projections', 'placeholder'));
  let names: string[];
  try {
    names = await fs.readdir(projectionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sweptAssets: [], clearedProjections: 0 };
    throw error;
  }
  const referenced = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const recordId = name.slice(0, -5);
    if (!safeId(recordId)) continue;
    try {
      const raw = await readRecallJsonRecord(userId, 'projections', recordId);
      if (!raw) continue;
      const record = raw as Record<string, unknown>;
      for (const id of Array.isArray(record.assetIds) ? record.assetIds : []) {
        if (typeof id === 'string' && safeId(id)) referenced.add(id);
      }
      for (const key of ['assetVersions', 'assetVersionSnapshots'] as const) {
        const map = record[key];
        if (map && typeof map === 'object' && !Array.isArray(map)) {
          for (const id of Object.keys(map as Record<string, unknown>)) {
            if (safeId(id)) referenced.add(id);
          }
        }
      }
    } catch {
      // 单个投影读失败不阻断清扫；clearAssetFromAllProjections 对读不回的
      // 投影本就不改写。
    }
  }
  const { clearAssetFromAllProjections } = await import('./context-projection');
  const sweptAssets: string[] = [];
  let clearedProjections = 0;
  for (const assetId of referenced) {
    try {
      const record = await readRecallJsonRecord(userId, 'ability-assets', assetId);
      // 与版本流段同口径：活资产（含 deleted 保留期）不动，只清 purged 墓碑
      // 与记录已除名两种。
      if (record && record.status !== 'purged') continue;
      const cleared = await clearAssetFromAllProjections(userId, assetId);
      if (cleared > 0) {
        sweptAssets.push(assetId);
        clearedProjections += cleared;
        log.warn(`startup sweep cleared residual projection references assetId=${assetId} projections=${cleared}`);
      }
    } catch (error) {
      log.warn(`startup sweep failed on projection references assetId=${assetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sweptAssets, clearedProjections };
}

/**
 * 恢复：把归档或保留期内的删除放回 active。
 *
 * 保留期已过的删除不给恢复——过期后系统对外声称的就是「已经没了」，再让它复活
 * 等于那个承诺不作数。这条与 `purged` 的终态性是同一个理由。
 *
 * 恢复同时解除归并去向（mergedIntoAssetId）：恢复成 active 却仍挂着
 * 「已并入他处」的标记是混合态——归并预检会永久拒绝，条目卡死。归并历史
 * 仍留在台账（merged_into 行）与时间线里，解除的只是记录上的活体指向。
 */
export function restoreAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', input, () => ({ deletedAt: undefined, mergedIntoAssetId: undefined }), (current) => {
    if (current.status !== 'archived' && current.status !== 'deleted') {
      throw new Error('ability asset is not restorable');
    }
    if (current.status === 'deleted' && (hasFutureDeletedAt(current) || !isWithinDeletionRetention(current))) {
      throw new Error('ability asset retention window has expired');
    }
  }, 'restored');
}

/**
 * 回滚到某个历史版本。
 *
 * 回滚只影响后续默认引用，不改写历史。所以这里是用旧快照的内容
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
  // 报成「版本不存在」，让调用方以为是自己传错了版本号。读过的 head 直接
  // 作为记录快照传入：listAbilityAssetVersions 不再重读主记录。
  const head = await readAbilityAsset(userId, assetId);
  assertMutableAbilityAsset(head);
  const versions = await listAbilityAssetVersions(userId, assetId, head);
  const target = versions.find((record) => record.version === toVersion);
  if (!target) throw new Error('recall ability asset version not found');
  let beforeAsset: RecallAbilityAssetRecord | undefined;
  // 历史快照标题不合规时保留在用标题，其余字段照常回滚；锁内置位供台账注记。
  let titleRetained = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, async (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertMutableAbilityAsset(current);
    if (current.version === toVersion) throw new Error('ability asset is already at that version');
    // 目标版本可能在锁外读取后被并发删除，须在资产锁内重新确认存在。
    // 版本快照只追加不改写，因此存在性通过后可使用已读快照。锁内 current
    // 作记录快照传入，不再重读主记录。
    if (!(await listAbilityAssetVersions(userId, assetId, current)).some((record) => record.version === toVersion)) {
      throw new Error('recall ability asset version not found');
    }
    beforeAsset = current;
    // scope 单独摘出且不倒退：旧快照可能带
    // 词表化前的自由文本 scope，原样写回会再触发 legacy 迁移垫空版本。
    const { status: _snapshotStatus, maturity: _snapshotMaturity, version: _snapshotVersion, scope: rbScope, title: rbTitle, ...content } = target.snapshot;
    const scope = isRecallScopeTerm(String(rbScope || ''))
      ? String(rbScope)
      : (normalizeAssetScopeValue(String(rbScope || '')) || current.scope);
    // 判定用正文 = 目标快照自己的正文（回滚后的最终正文）；标题合规才随快照
    // 回滚，不合规则留在用标题（...current 先铺，content 已不含 title）。
    titleRetained = !isReviewedAbilityAssetTitle(String(rbTitle ?? ''));
    const reverted: Record<string, unknown> = {
      ...current,
      // 保留治理状态；实质内容回滚不能沿用当前版本的效果和成败计数。
      ...content,
      ...(titleRetained ? {} : { title: String(rbTitle ?? '') }),
      scope,
      version: nextVersion(current.version),
      activeVersion: nextVersion(current.version),
      updatedAt: new Date().toISOString(),
    };
    clearFieldsAbsentFromSnapshot(reverted, target.snapshot as unknown as Record<string, unknown>);
    return resetChangedGuidanceOutcomes(current, reverted as unknown as RecallAbilityAssetRecord);
  });
  const asset = asAsset(updated);
  await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
  // 回滚本身记账：前后值 + 依据齐全，回滚到哪一版写在 note/reason 里。
  const rollbackSummary = summarizeAuditChange(
    diffAbilityAssetsForAudit(beforeAsset ?? asset, asset),
  );
  await appendAudit(userId, asset.id, 'rolled_back', {
    reason: action.reason,
    actor: action.actor,
    ...(titleRetained ? { note: `${action.reason}｜目标版本标题不合规，保留在用标题` } : {}),
    ...(rollbackSummary ? { before: rollbackSummary.before, after: rollbackSummary.after } : {}),
    ...(beforeAsset ? { rollbackAnchor: activeVersionOf(beforeAsset) } : {}),
  });
  await reconcilePersonalProfileProjection(userId, asset);
  return asset;
}

/**
 * 选用某个历史版本为「在用版」。
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
  // 读过的 head 作记录快照传入，不重读主记录。
  const head = await readAbilityAsset(userId, assetId);
  assertMutableAbilityAsset(head);
  const versions = await listAbilityAssetVersions(userId, assetId, head);
  const target = versions.find((record) => record.version === toVersion);
  if (!target) throw new Error('recall ability asset version not found');
  // 与回滚相同：旧快照标题不合规时保留在用标题，其余内容照常切换。
  let titleRetained = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, async (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertMutableAbilityAsset(current);
    if (abilityAssetActiveVersion(current) === toVersion) throw new Error('ability asset already selected');
    // 在资产锁内重新确认目标版本存在，不能让 activeVersion 指向已删除快照。
    if (!(await listAbilityAssetVersions(userId, assetId)).some((record) => record.version === toVersion)) {
      throw new Error('recall ability asset version not found');
    }
    // 内容同步为所选快照，治理状态不变；效果成熟度绑定实际内容。
    // 保留受控 scope，避免恢复旧自由文本后再次触发格式迁移和无内容变化的版本。
    const { status: _snapshotStatus, maturity: _snapshotMaturity, version: _snapshotVersion, scope: snapshotScope, title: selectedTitle, ...content } = target.snapshot;
    const scope = isRecallScopeTerm(String(snapshotScope || ''))
      ? String(snapshotScope)
      : (normalizeAssetScopeValue(String(snapshotScope || '')) || current.scope);
    // 判定用正文 = 所选快照自己的正文（切换后的最终正文）。
    titleRetained = !isReviewedAbilityAssetTitle(String(selectedTitle ?? ''));
    const selected: Record<string, unknown> = {
      ...current,
      ...content,
      ...(titleRetained ? {} : { title: String(selectedTitle ?? '') }),
      scope,
      activeVersion: toVersion,
      updatedAt: new Date().toISOString(),
    };
    clearFieldsAbsentFromSnapshot(selected, target.snapshot as unknown as Record<string, unknown>);
    // Selecting content is not an authorization rollback. Historical references
    // keep their original snapshots; future use keeps the current access boundary.
    if (current.scopePolicy !== undefined) selected.scopePolicy = current.scopePolicy;
    else delete selected.scopePolicy;
    return resetChangedGuidanceOutcomes(current, selected as unknown as RecallAbilityAssetRecord);
  });
  const asset = asAsset(updated);
  await appendAudit(userId, asset.id, 'version_selected', {
    note: `${action.reason || 'select'} (v${toVersion})${titleRetained ? '｜目标版本标题不合规，保留在用标题' : ''}`,
    actor: action.actor,
  });
  await reconcilePersonalProfileProjection(userId, asset);
  return asset;
}

/** 物理删除单个历史版本，不可恢复；在用版本不可删除。
 * 删除前为全部引用该版本的已确认投影冻结内容副本，保持既有引用可用。
 * 任一冻结失败则中止删除；不重排剩余版本号，避免历史回执错指其他内容。 */
export async function deleteAbilityAssetVersion(
  userId: string,
  assetId: string,
  version: string,
  input: AbilityAssetUserActionInput,
): Promise<void> {
  const action = requireAssetAction(input);
  if (!/^[0-9]{1,9}$/.test(version)) throw new Error('invalid recall ability asset version');
  // 先判终态再查版本（与 select/rollback 同序）。
  assertMutableAbilityAsset(await readAbilityAsset(userId, assetId));
  // 在用复核、投影冻结与物理删除共用资产主记录锁，与并发选版互斥，
  // 防止选版后删除仍继续执行而留下悬空 activeVersion。
  await fileEditLock(recallJsonRecordPath(userId, 'ability-assets', assetId)).runExclusive(async () => {
    const current = await readAbilityAsset(userId, assetId);
    assertMutableAbilityAsset(current);
    // 锁内 current 作记录快照传入，不重读主记录。
    const target = (await listAbilityAssetVersions(userId, assetId, current)).find((record) => record.version === version);
    if (!target) throw new Error('recall ability asset version not found');
    if (abilityAssetActiveVersion(current) === version) {
      throw new Error('cannot delete the active version; select another version first');
    }
    // 为全部引用该版本的 confirmed 投影冻结副本，不使用有条数上限的列表接口。
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
  });
}

/**
 * 归并两条同义资产为同一版本组。
 *
 * source 的版本快照按时间序并入 target 版本流（续接编号）；source 更新时
 * target 在用内容切换为 source 在用内容。source 条目归档并记录去向
 * （mergedIntoAssetId），历史引用不回写——时间线/回执仍指向原条目可读。
 */
/** A version-group merge may not silently combine different use/authorization boundaries. */
function assertSameMergeBoundary(source: RecallAbilityAssetRecord, target: RecallAbilityAssetRecord): void {
  const policy = (asset: RecallAbilityAssetRecord) => Object.fromEntries(Object.entries(asset.scopePolicy || {})
    .map(([key, values]) => [key, [...values].sort()]));
  if (source.scope !== target.scope || !isDeepStrictEqual(policy(source), policy(target))) {
    throw new Error('ability asset merge requires the same scope and access policy');
  }
}

export async function mergeAbilityAssets(
  userId: string,
  sourceAssetId: string,
  targetAssetId: string,
  input: AbilityAssetUserActionInput,
): Promise<RecallAbilityAssetRecord> {
  // Reuse the reentrant cognition transition rail so source/target permissions
  // cannot change between the boundary check, version migration and commit.
  return withCognitionTransition(userId, () => mergeAbilityAssetsInTransition(userId, sourceAssetId, targetAssetId, input));
}

async function mergeAbilityAssetsInTransition(
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
  // target 侧同款门：已归并的条目再收归并会形成 m3→m1→m2 僵尸链——
  // 中间节点 archived 不参与注入，新内容沉进死节点、最终归宿永远收不到。
  if (target.mergedIntoAssetId) throw new Error('ability asset has already been merged');
  if (source.type !== target.type) throw new Error('ability asset merge requires the same type');
  assertSameMergeBoundary(source, target);
  // 已读的 source 作为记录快照传入，不重读主记录。
  const sourceVersions = (await listAbilityAssetVersions(userId, sourceAssetId, source))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const sourceActiveVersion = activeVersionOf(source);
  const sourceActiveIndex = sourceVersions.findIndex((v) => v.version === sourceActiveVersion);
  // source 版本快照按时间续接到 target 并重新编号，保留原时间。
  // 与前一快照 statement/title 相同的格式迁移版本不再占新号。
  const snapshotContentKey = (snap: AbilityAssetVersionRecord['snapshot']): string => `${snap.title}\n${snap.statement}`;
  let lastAppendedKey: string | null = null;
  let versionCursor = target.version;
  for (const entry of sourceVersions) {
    const key = snapshotContentKey(entry.snapshot);
    if (lastAppendedKey !== null && key === lastAppendedKey) continue;
    lastAppendedKey = key;
    versionCursor = nextVersion(versionCursor);
    // 版本流追加走统一收口：持 target 主记录锁+锁内复核——归并搬运
    // 多次 await，期间 target 被 purge 的话，后续追加不得重建它的版本流。
    await appendAbilityAssetVersionLine(userId, targetAssetId, {
      schemaVersion: 1,
      ownerId: userId,
      id: `${targetAssetId}-v${versionCursor}`,
      assetId: targetAssetId,
      version: versionCursor,
      at: entry.at,
      reason: `merged from ${sourceAssetId}`,
      actor: action.actor,
      snapshot: mergedSnapshotForTarget(entry.snapshot, targetAssetId),
    } as AbilityAssetVersionRecord);
  }
  // source 在用内容的快照（版本流缺失的遗留资产用 source 记录状态兜底）。
  const sourceActiveSnapshot = sourceActiveIndex >= 0
    ? sourceVersions[sourceActiveIndex].snapshot
    : snapshot(source);
  // 新旧按时间序判：乱串/缺省 updatedAt 的存量档无法证明 source
  // 更新——不铺在用内容（source 快照仍完整进版本流，可按号找回）。
  const sourceNewer = isLaterInstant(source.updatedAt, target.updatedAt);
  // source 曾 select 旧版（在用版不是末版）时，在用内容与末版快照不同——
  // 额外 append 一条在用内容快照，保证 activeVersion 指向的快照与在用内容
  // 恒一致（注入回放按 activeVersion 读快照，分叉=注入与所见不一致）。
  let activeCursor = versionCursor;
  if (sourceNewer && sourceActiveIndex >= 0 && sourceActiveIndex !== sourceVersions.length - 1) {
    activeCursor = nextVersion(versionCursor);
    // 同上：统一收口，锁内复核 target 终态后才落流。
    await appendAbilityAssetVersionLine(userId, targetAssetId, {
      schemaVersion: 1,
      ownerId: userId,
      id: `${targetAssetId}-v${activeCursor}`,
      assetId: targetAssetId,
      version: activeCursor,
      at: new Date().toISOString(),
      reason: `merged active version from ${sourceAssetId}`,
      actor: action.actor,
      snapshot: mergedSnapshotForTarget(sourceActiveSnapshot, targetAssetId),
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
    // 已归并门同样要在锁内复核：预检后窗口期里 target 被并入他处时，这里的
    // 写入会把新内容铺进一个已改道的中转节点（僵尸链的并发窗口）。
    if (current.mergedIntoAssetId) throw new Error('ability asset has already been merged');
    assertSameMergeBoundary(sourceLive, current);
    assertSameMergeBoundary(source, sourceLive);
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
      // （缺省跟随会指向并入的 source 快照，与在用内容分叉）——锁内 current
      // 的在用版，统一走 activeVersionOf 口径。关系上面已并入。
      return {
        ...current,
        relations: mergedRelations,
        ...(mergedDerivedFrom.length ? { derivedFrom: mergedDerivedFrom } : {}),
        version: activeCursor,
        activeVersion: activeVersionOf(current),
        updatedAt: new Date().toISOString(),
      };
    }
    // 保留受控 scope；source 在用标题不合规时保留 target 标题，其余内容照常并入。
    const { status: _s, maturity: _m, version: _v, relations: _r, derivedFrom: _d, scope: snapshotScope, scopePolicy: _sourceSnapshotPolicy, title: snapshotTitle, ...content } = sourceActiveSnapshot;
    const mergedScope = isRecallScopeTerm(String(snapshotScope || ''))
      ? String(snapshotScope)
      : (normalizeAssetScopeValue(String(snapshotScope || '')) || current.scope);
    const sourceTitleCompliant = recallTitleIssue(String(snapshotTitle ?? ''), String(sourceActiveSnapshot.statement ?? '')) === undefined;
    const merged: RecallAbilityAssetRecord = {
      ...current,
      ...content,
      value: sourceActiveSnapshot.value,
      ...(sourceTitleCompliant ? { title: String(snapshotTitle ?? '') } : {}),
      scope: mergedScope,
      relations: mergedRelations,
      ...(mergedDerivedFrom.length ? { derivedFrom: mergedDerivedFrom } : {}),
      evidenceRefs: [...current.evidenceRefs, ...source.evidenceRefs].slice(0, 200),
      version: activeCursor,
      activeVersion: activeCursor,
      updatedAt: new Date().toISOString(),
    };
    return resetChangedGuidanceOutcomes(current, merged);
  }));
  // activeCursor 的 source 快照已写入版本流；store 层还会为合并后主记录生成
  // 同版本号的 pending 快照。落盘后在同一资产记录锁内清掉该 pending 行，
  // 避免恢复时把不同内容重放到同一个不可变版本。
  await withCognitionTransition(userId, () => fileEditLock(recallJsonRecordPath(userId, 'ability-assets', targetAssetId)).runExclusive(async () => {
    const raw = await readRecallJsonRecord(userId, 'ability-assets', targetAssetId);
    if (!raw) return;
    const queued = pendingAssetVersions(raw);
    if (!queued.some((row) => String(row.version) === String(activeCursor))) return;
    const clean = { ...raw, pendingVersionSnapshots: queued.filter((row) => String(row.version) !== String(activeCursor)) };
    if (!clean.pendingVersionSnapshots.length) delete (clean as RecallJsonRecord).pendingVersionSnapshots;
    await persistCognitionSource(userId, 'ability-assets', targetAssetId, clean, () => writeJson(recallJsonRecordPath(userId, 'ability-assets', targetAssetId), clean));
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
  // 归并也要完整台账：target 记它自己的版本/关系变化，source 记归档与去向。
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

export async function listAbilityAssetVersions(userId: string, assetId: string, recordSnapshot?: RecallAbilityAssetRecord): Promise<AbilityAssetVersionRecord[]> {
  // A request that already read the canonical collection may reuse its own
  // snapshot. Never cache across requests or substitute another user's head.
  if (recordSnapshot && (recordSnapshot.id !== assetId || recordSnapshot.ownerId !== userId))
    throw new Error('ability asset version snapshot identity mismatch');
  // Capture pending snapshots first: recovery can append and clear them
  // between reads, so reading the ledger first could miss the same version twice.
  const raw = recordSnapshot ?? await readRecallJsonRecord(userId, 'ability-assets', assetId);
  // 版本流读侧逐行降级（见 store.ts 的 skipMalformedLines 规则）：坏行只作废它自己。
  const persisted = await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0, { skipMalformedLines: true });
  const versions = new Map(persisted.map(row => [String(row.version), row]));
  if (raw?.status !== 'purged') for (const row of pendingAssetVersions(raw)) if (!versions.has(String(row.version))) versions.set(String(row.version), row);
  return [...versions.values()].map(asVersion).sort((a, b) => Number(a.version) - Number(b.version));
}

/** 版本链及按版本聚合的使用效果：供版本对比视图——
 *  「实际采用」（applied）与「被否定」（contradicted）按版本号计数，
 *  数据来自 usage 回执（外键注入回执，只认有据使用）。 */
export async function listAbilityAssetVersionsWithUsage(
  userId: string,
  assetId: string,
): Promise<{
  versions: AbilityAssetVersionRecord[];
  usage: Array<{ version: string; applied: number; contradicted: number; total: number }>;
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
  return {
    versions,
    usage: [...counts.entries()].map(([version, c]) => ({ version, ...c })),
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
  // 台账读侧逐行降级（见 store.ts 的 skipMalformedLines 规则）：坏行只作废它自己，
  // 好行照常供时间线与幂等重放；撕裂字节保留在盘上（不做破坏性修复）。
  return (await listRecallJsonlRecords(userId, 'ability-asset-audit', assetId, 0, { skipMalformedLines: true })) as AbilityAssetAuditRecord[];
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
  // 未来 deletedAt 与缺失/损坏同属「时间不明」：不能恢复、也不会自动到期
  // （restorable 与 retentionDaysLeft 都不替这条记录编一个事实）。
  const futureDeletedAt = hasFutureDeletedAt(asset, now);
  const retentionUnknown = Number.isNaN(parsed) || futureDeletedAt;
  const expiresAt = retentionUnknown
    ? null
    : parsed + ABILITY_ASSET_DELETION_RETENTION_DAYS * 86_400_000;
  return {
    id: asset.id,
    title: asset.title,
    type: asset.type,
    scope: asset.scope,
    ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
    restorable: asset.status === 'deleted' && !futureDeletedAt && isWithinDeletionRetention(asset, now),
    retentionDaysLeft: expiresAt === null
      ? null
      : Math.max(0, Math.ceil((expiresAt - now.getTime()) / 86_400_000)),
    retentionUnknown,
    purgeable: asset.status === 'deleted',
  };
}

export async function setAbilityAssetMaturity(userId: string, assetId: string, maturity: RecallAbilityAssetRecord['maturity'], expectedVersion?: string): Promise<RecallAbilityAssetRecord> {
  if (expectedVersion !== undefined && !/^[0-9]{1,9}$/.test(expectedVersion)) throw new Error('invalid ability asset expected version');
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
    // The proof remains valid history, but only its exact head can mature.
    if (expectedVersion !== undefined && (current.version !== expectedVersion || activeVersionOf(current) !== expectedVersion)) return current;
    // 资产删除后仍可能收到迟到回执，终态及保留期内不再推进成熟度。
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
  expectedVersion?: string,
): Promise<RecallAbilityAssetRecord> {
  if (expectedVersion !== undefined && !/^[0-9]{1,9}$/.test(expectedVersion)) throw new Error('invalid ability asset expected version');
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  let maturityAdvanced: { from: RecallAbilityAssetRecord['maturity']; to: RecallAbilityAssetRecord['maturity'] } | undefined;
  let paused = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (expectedVersion !== undefined && (current.version !== expectedVersion || activeVersionOf(current) !== expectedVersion)) return current;
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
    // 证据撤销只暂停 active 资产，不改变 archived/deleted 等状态及保留期。
    if (
      current.status !== 'active'
      || !current.evidenceRefs.some(ref => cognitionSourceDependsOn(ref, source))
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
    // 终态或删除保留期内的资产不降低成熟度。
    if (
      current.status === 'purged'
      || current.status === 'revoked'
      || current.status === 'deleted'
      || current.maturity === 'seed'
      || current.maturity === 'bud'
      || !current.evidenceRefs.some(ref => cognitionSourceDependsOn(ref, source))
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

/** Recovery is idempotent; an immutable snapshot is never regenerated from current text. */
export async function recoverAbilityAssetVersionJournals(userId: string): Promise<void> {
  for (const asset of await listAbilityAssets(userId)) {
    if (asset.status === 'purged') continue;
    for (const row of pendingAssetVersions(asset)) {
      try { await appendAbilityAssetVersionLine(userId, asset.id, asVersion(row)); }
      catch { log.warn('asset version journal recovery failed', { assetId: asset.id }); }
    }
  }
}
