import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import {
  appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord,
  removeRecallJsonlStream, updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { normalizeAbilityAssetOntologyRefs } from './ontology-refs';
import type { RecallAbilityAssetRecord, RecallAbilityAssetLifecycleStatus } from './candidate-service';
import { readAbilityAssetRelationContract } from './asset-relations';
import { readAbilityAssetSemantics } from './asset-semantics';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { normalizeCausalRule } from './world-model-types';
import { createLogger } from '../../logger';

const log = createLogger('recall.assets');

export type AbilityAssetActor = 'user' | 'system';
export type AbilityAssetRecommendedAction = 'pause' | 'rework';

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
    | 'applicableWhen' | 'forbiddenWhen' | 'sensitivity'
  >;
}

export interface AbilityAssetAuditRecord extends RecallJsonRecord {
  assetId: string;
  action: 'created' | 'updated' | 'paused' | 'resumed' | 'revoked'
    | 'archived' | 'deleted' | 'purged' | 'restored' | 'rolled_back'
    | 'maturity_downgraded' | 'pause_recommended' | 'rework_recommended'
    | 'recommendation_cleared'
    | 'cross_scope_confirmed' | 'cross_scope_withdrawn'
    | 'maturity_advanced'
    // 修正归档错误，**不是**靠证据挣来的升档。审计里要分得开，否则日后
    // 回看会以为这条资产做过 transfer proof。
    | 'maturity_corrected';
  at: string;
  actor?: AbilityAssetActor;
  note?: string;
}

export interface UpdateAbilityAssetInput {
  title?: string;
  statement?: string;
  scope?: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  type?: RecallAbilityAssetRecord['type'];
  evidenceRefs?: RecallAbilityAssetRecord['evidenceRefs'];
  ontologyRefs?: RecallAbilityAssetRecord['ontologyRefs'];
  relations?: RecallAbilityAssetRecord['relations'];
  derivedFrom?: RecallAbilityAssetRecord['derivedFrom'];
  applicableWhen?: RecallAbilityAssetRecord['applicableWhen'];
  forbiddenWhen?: RecallAbilityAssetRecord['forbiddenWhen'];
  sensitivity?: RecallAbilityAssetRecord['sensitivity'];
  reason: string;
  actor: AbilityAssetActor;
  acknowledgeRecommendation?: boolean;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
  id?: never;
  ownerId?: never;
}

export interface AbilityAssetUserActionInput {
  actor: AbilityAssetActor;
  reason: string;
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
 * 规范 22.1 只写了「进入保留期」「保留期内可恢复」，没有给出具体天数，所以这里
 * 是占位值，等产品确认后只改这一个常量。记录里存的是 `deletedAt` 这个事实而不是
 * 算好的到期时间，因此改动此常量不需要迁移任何已有数据。
 *
 * TODO(产品确认): 保留期天数，以及到期后是自动 purge 还是仅停止恢复入口。
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
  if (!evidenceRefs.length) throw new Error('malformed recall ability asset evidence');
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(value, value.id);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  const causalRule = value.causalRule === undefined ? undefined : normalizeCausalRule(value.causalRule);
  const validationCount = value.validationCount === undefined ? undefined : Number(value.validationCount);
  const consecutiveFailures = value.consecutiveFailures === undefined ? undefined : Number(value.consecutiveFailures);
  if ((validationCount !== undefined && (!Number.isInteger(validationCount) || validationCount < 0))
    || (consecutiveFailures !== undefined && (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0))
    || (value.lastValidatedAt !== undefined && (typeof value.lastValidatedAt !== 'string' || Number.isNaN(Date.parse(value.lastValidatedAt))))) {
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
  const lifecycleStatus: RecallAbilityAssetLifecycleStatus =
    value.lifecycleStatus === 'automatically_extracted_unverified'
      || value.lifecycleStatus === 'system_precipitated_unverified'
      ? value.lifecycleStatus
      : 'user_confirmed_unverified';
  return {
    ...value,
    reviewDecisionId: typeof value.reviewDecisionId === 'string' ? value.reviewDecisionId : 'legacy-untracked',
    // Preserve the written confirmation semantics instead of force-rewriting
    // to user_confirmed_unverified (P0-2): both automatic lines
    // (automatically_extracted_unverified / system_precipitated_unverified)
    // must survive reads — the asset stays honest about NOT being
    // user-confirmed.
    lifecycleStatus,
    sourceCandidateIds,
    appliedReviewDecisionIds,
    evidenceRefs,
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...relationContract,
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(causalRule ? { causalRule } : {}),
    ...(value.validationCount !== undefined ? { validationCount: value.validationCount } : {}),
    ...(value.lastValidatedAt !== undefined ? { lastValidatedAt: value.lastValidatedAt } : {}),
    ...(value.consecutiveFailures !== undefined ? { consecutiveFailures: value.consecutiveFailures } : {}),
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
  if (record.actor !== 'user' && record.actor !== 'system') {
    throw new Error('ability asset action requires a user actor or system actor');
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
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
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

async function appendAudit(userId: string, assetId: string, action: AbilityAssetAuditRecord['action'], metadata: { note?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at,
    ...(metadata.actor ? { actor: metadata.actor } : {}),
    ...(metadata.note ? { note: metadata.note } : {}),
  } satisfies AbilityAssetAuditRecord);
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
  const expectedLifecycle: RecallAbilityAssetLifecycleStatus = metadata.actor === 'system'
    ? (validated.lifecycleStatus === 'automatically_extracted_unverified' || validated.lifecycleStatus === 'system_precipitated_unverified'
        ? validated.lifecycleStatus
        : 'automatically_extracted_unverified')
    : 'user_confirmed_unverified';
  const expectedMaturity = metadata.actor === 'system' ? 'seed' : 'bud';
  if (validated.lifecycleStatus !== expectedLifecycle || validated.maturity !== expectedMaturity || validated.version !== '1') {
    throw new Error('invalid initial ability asset lifecycle');
  }
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

/** System-authored formal asset boundary (KStar direct experience line).
 *  Content-addressed and idempotent: the same asset id is never duplicated.
 *  Validation happens through asAsset before the record is persisted. */
export async function createSystemAbilityAsset(
  userId: string,
  input: RecallAbilityAssetRecord,
  reason: string,
): Promise<RecallAbilityAssetRecord> {
  if (!safeId(userId) || !safeId(input.id) || !safeId(input.candidateId || '')) throw new Error('invalid system ability asset identity');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1_000) throw new Error('invalid system ability asset reason');
  // 系统资产只能带自动生命周期（诚实标注：未经用户确认）；asAsset 的
  // 缺失值 coerce 在这里同样被显式校验挡下。
  if (input.lifecycleStatus !== 'automatically_extracted_unverified'
    && input.lifecycleStatus !== 'system_precipitated_unverified') {
    throw new Error('system asset requires an automatic lifecycle status');
  }
  const validated = asAsset(input);
  if (validated.ownerId !== userId) throw new Error('ability asset owner mismatch');
  const stored = asAsset(await updateRecallJsonRecord(
    userId,
    'ability-assets',
    validated.id,
    (current) => current || validated,
  ));
  await initializeAbilityAsset(userId, stored, { reason: reason.trim(), actor: 'system' });
  return stored;
}

export async function readAbilityAsset(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) throw new Error('recall ability asset not found');
  return asAsset(raw);
}

export async function listAbilityAssets(userId: string): Promise<RecallAbilityAssetRecord[]> {
  let names: string[];
  try { names = await fs.readdir(assetsDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5))).map((name) => readRecallJsonRecord(userId, 'ability-assets', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asAsset).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 某空间沉淀的资产（按 spaceId 过滤；资产随 recall 全局存储，不随空间删）。
 *  空间能读到全局资产（引用/检索走 listAbilityAssets），但空间资产 tab 只显示本空间的。
 *  **已撤销（revoked）的资产不显示**（用户撤销后从空间资产列表消失；全局认知资产页仍可见）。 */
export async function listAbilityAssetsForSpace(userId: string, spaceId: string): Promise<RecallAbilityAssetRecord[]> {
  if (!safeId(spaceId)) return [];
  const all = await listAbilityAssets(userId);
  return all.filter((asset) => asset.spaceId === spaceId && asset.status !== 'revoked');
}

export async function updateAbilityAsset(userId: string, assetId: string, input: UpdateAbilityAssetInput): Promise<RecallAbilityAssetRecord> {
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  const action = requireAssetAction(input);
  const evidenceRefs = input.evidenceRefs === undefined ? undefined : normalizeCognitionSourceRefs(input.evidenceRefs);
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
  ]);
  let clearedRecommendation = false;
  let changed = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertNotPurged(current);
    if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    changed = true;
    clearedRecommendation = Boolean(current.recommendedAction && input.acknowledgeRecommendation);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: bounded(input.statement, 'statement', 4_000) } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(scopePolicy !== undefined ? { scopePolicy } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      ...(ontologyRefs !== undefined ? { ontologyRefs } : {}),
      ...relationContract,
      ...semantics,
      version: nextVersion(current.version),
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
    await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
    await appendAudit(userId, asset.id, 'updated', { note: action.reason, actor: action.actor });
    if (clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
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

  metadata: { reason: string; actor: AbilityAssetActor },
): Promise<RecallAbilityAssetRecord> {
  const current = await readAbilityAsset(userId, assetId);
  if (!current) throw new Error('recall ability asset not found');
  const merged = mergeRefsDedup(current.evidenceRefs || [], normalizeCognitionSourceRefs(newRefs));
  const changed = merged.length !== (current.evidenceRefs || []).length
    || merged.some((ref, i) => JSON.stringify(ref) !== JSON.stringify((current.evidenceRefs || [])[i]));
  if (!changed) return current;
  const updated = asAsset(await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const cur = asAsset(raw);
    return {
      ...cur,
      evidenceRefs: merged,
      version: nextVersion(cur.version),
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
  if (action.actor === 'system' && reviewDecisionId === undefined) {
    throw new Error('system asset action requires an automatic review handoff');
  }
  let clearedRecommendation = false;
  let changed = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertNotPurged(current);
    if (current.status === 'revoked' && status !== 'revoked' && status !== 'purged') {
      throw new Error('revoked ability asset cannot be changed');
    }
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    guard?.(current);
    changed = current.status !== status || Boolean(reviewDecisionId);
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
    await appendAudit(userId, asset.id, auditAction, { note: action.reason, actor: action.actor });
    if (clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
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
 * 把 33a16ad 之前 promote 出来的资产从 seed 修正到 bud。
 *
 * 那次改动之前，promote 写下的两个字段是自相矛盾的：lifecycleStatus 说
 * 「user_confirmed_unverified」，maturity 却归在 seed（规范 10.2 里 seed 是
 * Candidate 档）。接上选择层之后这个矛盾变成实的——seed 一律 never，于是这些
 * 资产永远进不了任何 Agent，也永远升不了档（seed→bud 没有任何路径）。
 *
 * **只改归档错误，不放宽策略。** 判据是那对矛盾本身：lifecycleStatus 已确认
 * 且 maturity 仍是 seed。满足这两条的资产，它的 seed 是系统写错的，不是用户
 * 的决定——让用户逐条去修系统的错不合理。
 *
 * 其余一概不碰：没有 lifecycleStatus 的、已经是 bud 以上的、已撤销或已清除的。
 *
 * 审计动作用 maturity_corrected 而不是复用升档语义：这是修正，不是靠证据挣来
 * 的晋级，日后回看不能把两者混为一谈。
 *
 * 幂等：跑完一次之后就没有符合判据的记录了，重启再跑是空转。
 */
export async function correctMisfiledSeedMaturity(userId: string): Promise<number> {
  let corrected = 0;
  for (const asset of await listAbilityAssets(userId)) {
    if (asset.maturity !== 'seed') continue;
    if (asset.lifecycleStatus !== 'user_confirmed_unverified') continue;
    if (asset.status === 'revoked' || asset.status === 'purged') continue;
    try {
      await updateRecallJsonRecord(userId, 'ability-assets', asset.id, (raw) => {
        if (!raw) throw new Error('recall ability asset not found');
        const current = asAsset(raw);
        // 并发下可能已经被别处改过，再确认一次判据仍然成立。
        if (current.maturity !== 'seed' || current.lifecycleStatus !== 'user_confirmed_unverified') return current;
        return { ...current, maturity: 'bud', updatedAt: new Date().toISOString() };
      });
      await appendAudit(userId, asset.id, 'maturity_corrected', {
        actor: 'system',
        note: 'seed→bud: promote 时的归档错误，lifecycleStatus 已是 user_confirmed_unverified',
      });
      corrected += 1;
    } catch (err) {
      // 单条修不了不该拦住其余的——它下次启动还会被扫到。
      log.warn(`ability asset maturity correction skipped id=${asset.id}: ${(err as Error).message}`);
    }
  }
  if (corrected) log.info(`ability asset maturity corrected seed->bud count=${corrected}`);
  return corrected;
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
    if (asset.status === 'revoked' || asset.status === 'purged') continue;
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
    assertNotPurged(current);
    if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
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
    assertNotPurged(current);
    if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
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
export async function purgeAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  const asset = await setStatus(userId, assetId, 'purged', input, () => ({
    title: '',
    statement: '',
    evidenceRefs: [],
    purgedAt: new Date().toISOString(),
    learningSignal: undefined,
    ontologyRefs: undefined,
    relations: undefined,
    derivedFrom: undefined,
    // 适用/禁用条件是用户手写的自然语言，与正文同属可识别内容；
    // sensitivity 是对已清除内容的定级，留着也只会指向一条空记录。
    applicableWhen: undefined,
    forbiddenWhen: undefined,
    sensitivity: undefined,
    // 跨域授权是对一条已经不存在的内容的授权，留着没有意义，也不该让墓碑
    // 继续携带一个「可以跨作用域使用」的许可。
    crossScopeConfirmedAt: undefined,
    scopePolicy: undefined,
    recommendedAction: undefined,
    recommendationReason: undefined,
    recommendationAt: undefined,
    sourceSessionIds: undefined,
  } as Partial<RecallAbilityAssetRecord>));
  // 版本快照同样含正文，留着就不算「删除内容和版本」。审计流保留：它只有
  // 动作名和时间戳，属于规范允许保留的不可识别最小项。
  await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
  return asset;
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
  assertNotPurged(await readAbilityAsset(userId, assetId));
  const versions = await listAbilityAssetVersions(userId, assetId);
  const target = versions.find((record) => record.version === toVersion);
  if (!target) throw new Error('recall ability asset version not found');
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertNotPurged(current);
    if (current.version === toVersion) throw new Error('ability asset is already at that version');
    const { status: _snapshotStatus, maturity: _snapshotMaturity, version: _snapshotVersion, ...content } = target.snapshot;
    return {
      ...current,
      // 只回滚内容，不回滚治理状态与成熟度：暂停过的资产不该因为回滚就自己
      // 变回 active，验证过的成熟度也不该被一次内容回滚抹掉。
      ...content,
      version: nextVersion(current.version),
      updatedAt: new Date().toISOString(),
    };
  });
  const asset = asAsset(updated);
  await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
  await appendAudit(userId, asset.id, 'rolled_back', { note: action.reason, actor: action.actor });
  return asset;
}

export async function listAbilityAssetVersions(userId: string, assetId: string): Promise<AbilityAssetVersionRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0)).map(asVersion);
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
): Promise<RecallAbilityAssetRecord> {
  if (!safeId(assetId)) throw new Error('invalid ability asset id');
  let maturityAdvanced: { from: RecallAbilityAssetRecord['maturity']; to: RecallAbilityAssetRecord['maturity'] } | undefined;
  let paused = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (current.status === 'purged' || current.status === 'deleted') return current;
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
    if (
      current.status === 'purged'
      || current.status === 'revoked'
      || current.status === 'paused'
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
    if (
      current.status === 'purged'
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
