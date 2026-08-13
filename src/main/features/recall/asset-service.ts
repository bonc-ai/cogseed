import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { normalizeCognitionSourceRefs } from './source-service';
import {
  appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord,
  removeRecallJsonlStream, updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { normalizeAbilityAssetOntologyRefs, type AbilityAssetOntologyRef } from './ontology-refs';
import { readAbilityAssetSemantics } from './asset-semantics';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import type { RecallAbilityAssetRecord } from './candidate-service';

export interface AbilityAssetVersionRecord extends RecallJsonRecord {
  assetId: string;
  version: string;
  at: string;
  snapshot: Pick<
    RecallAbilityAssetRecord,
    | 'title' | 'statement' | 'type' | 'scope' | 'evidenceRefs' | 'status' | 'maturity'
    | 'version' | 'learningSignal' | 'ontologyRefs'
    | 'relations' | 'derivedFrom' | 'applicableWhen' | 'forbiddenWhen'
    | 'targetAgentIds' | 'sensitivity'
  >;
}

export interface AbilityAssetAuditRecord extends RecallJsonRecord {
  assetId: string;
  /**
   * 治理动作。`restored` 不区分是从暂停、归档还是删除回来的——审计要的是
   * 「谁在什么时候把它恢复了」，来源状态在上一条审计里，不必在这里重复编码。
   */
  action: 'created' | 'updated' | 'paused' | 'resumed' | 'revoked'
    | 'archived' | 'deleted' | 'purged' | 'restored' | 'rolled_back';
  at: string;
  note?: string;
}

export interface UpdateAbilityAssetInput {
  title?: string;
  statement?: string;
  scope?: string;
  type?: RecallAbilityAssetRecord['type'];
  evidenceRefs?: RecallAbilityAssetRecord['evidenceRefs'];
  ontologyRefs?: RecallAbilityAssetRecord['ontologyRefs'];
  relations?: RecallAbilityAssetRecord['relations'];
  derivedFrom?: RecallAbilityAssetRecord['derivedFrom'];
  applicableWhen?: RecallAbilityAssetRecord['applicableWhen'];
  forbiddenWhen?: RecallAbilityAssetRecord['forbiddenWhen'];
  targetAgentIds?: RecallAbilityAssetRecord['targetAgentIds'];
  sensitivity?: RecallAbilityAssetRecord['sensitivity'];
  id?: never;
  ownerId?: never;
}

function assetsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'ability-assets', 'placeholder'));
}

/** 治理状态白名单。旧记录只会含前三种，新增的三种向后兼容地放行。 */
const ABILITY_ASSET_STATUSES = new Set<RecallAbilityAssetRecord['status']>([
  'active', 'paused', 'archived', 'deleted', 'purged', 'revoked',
]);

const ABILITY_ASSET_MATURITIES = new Set<RecallAbilityAssetRecord['maturity']>([
  'seed', 'bud', 'transfer_validated', 'effectiveness_validated', 'stable',
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
  const semantics = readAbilityAssetSemantics(
    value as Record<string, unknown>,
    typeof value.id === 'string' ? value.id : undefined,
  );
  return {
    ...value,
    evidenceRefs,
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...semantics,
  } as RecallAbilityAssetRecord;
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid ability asset ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid ability asset ${field}`);
  return text;
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
    evidenceRefs: asset.evidenceRefs,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.ontologyRefs ? { ontologyRefs: asset.ontologyRefs } : {}),
    ...(asset.relations ? { relations: asset.relations } : {}),
    ...(asset.derivedFrom ? { derivedFrom: asset.derivedFrom } : {}),
    ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    ...(asset.targetAgentIds ? { targetAgentIds: asset.targetAgentIds } : {}),
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  };
}

function asVersion(value: RecallJsonRecord): AbilityAssetVersionRecord {
  const rawSnapshot = value.snapshot;
  if (
    typeof value.assetId !== 'string' || typeof value.version !== 'string' || typeof value.at !== 'string' ||
    !rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)
  ) throw new Error('malformed recall ability asset version');
  const versionSnapshot = rawSnapshot as Record<string, unknown>;
  if (!Array.isArray(versionSnapshot.evidenceRefs)) throw new Error('malformed recall ability asset version evidence');
  return {
    ...value,
    snapshot: {
      ...versionSnapshot,
      evidenceRefs: normalizeCognitionSourceRefs(versionSnapshot.evidenceRefs),
    },
  } as AbilityAssetVersionRecord;
}

async function appendVersion(userId: string, asset: RecallAbilityAssetRecord): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-versions', asset.id, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${asset.id}-v${asset.version}`,
    assetId: asset.id,
    version: asset.version,
    at,
    snapshot: snapshot(asset),
  } satisfies AbilityAssetVersionRecord);
}

async function appendAudit(userId: string, assetId: string, action: AbilityAssetAuditRecord['action'], note?: string): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at,
    ...(note ? { note } : {}),
  } satisfies AbilityAssetAuditRecord);
}

export async function initializeAbilityAsset(userId: string, asset: RecallAbilityAssetRecord): Promise<void> {
  const current = await listAbilityAssetVersions(userId, asset.id);
  if (!current.length) await appendVersion(userId, asset);
  const audit = await listAbilityAssetAudit(userId, asset.id);
  if (!audit.length) await appendAudit(userId, asset.id, 'created');
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
  const records = await Promise.all(names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, 'ability-assets', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asAsset)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateAbilityAsset(userId: string, assetId: string, input: UpdateAbilityAssetInput): Promise<RecallAbilityAssetRecord> {
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  const evidenceRefs = input.evidenceRefs === undefined
    ? undefined
    : normalizeCognitionSourceRefs(input.evidenceRefs);
  if (evidenceRefs && !evidenceRefs.length) throw new Error('ability asset evidence is required');
  const ontologyRefs = input.ontologyRefs === undefined
    ? undefined
    : normalizeAbilityAssetOntologyRefs(input.ontologyRefs);
  // 语义字段先于写事务校验，并把 assetId 传进去挡掉自指关系。
  const semantics = readAbilityAssetSemantics(input as Record<string, unknown>, assetId);
  // 纵深防御：候选入口已有 L3 闸，但资产可以被直接编辑，凭证能从这条路进来。
  assertNotForbiddenToPersist([input.title, input.statement, input.scope]);
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: bounded(input.statement, 'statement', 4_000) } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      ...(ontologyRefs !== undefined ? { ontologyRefs } : {}),
      ...semantics,
      version: nextVersion(current.version),
      updatedAt: new Date().toISOString(),
    };
    return next;
  });
  const asset = asAsset(updated);
  await appendVersion(userId, asset);
  await appendAudit(userId, asset.id, 'updated');
  return asset;
}

/** 状态 → 审计动作。原先是三分支三元表达式，补进治理状态后会把归档、删除
 *  统统记成 `revoked`，审计链就说不清到底发生了什么。 */
const STATUS_AUDIT_ACTION: Record<RecallAbilityAssetRecord['status'], AbilityAssetAuditRecord['action']> = {
  active: 'resumed',
  paused: 'paused',
  archived: 'archived',
  deleted: 'deleted',
  purged: 'purged',
  revoked: 'revoked',
};

/**
 * 彻底清除是终态：内容和版本已经删掉，没有任何东西可以恢复。任何试图让它离开
 * `purged` 的调用都是调用方的 bug，不能静默放过——放过会产出一条标题为空、
 * 证据为空却显示为 active 的资产。
 */
function assertNotPurged(current: RecallAbilityAssetRecord): void {
  if (current.status === 'purged') throw new Error('ability asset has been purged');
}

async function setStatus(
  userId: string,
  assetId: string,
  status: RecallAbilityAssetRecord['status'],
  note: string | undefined,
  mutate?: (current: RecallAbilityAssetRecord) => Partial<RecallAbilityAssetRecord>,
  guard?: (current: RecallAbilityAssetRecord) => void,
): Promise<RecallAbilityAssetRecord> {
  const normalizedNote = note === undefined ? undefined : bounded(note, 'audit note', 1_000);
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    assertNotPurged(current);
    guard?.(current);
    return {
      ...current,
      ...(mutate ? mutate(current) : {}),
      status,
      updatedAt: new Date().toISOString(),
    };
  });
  const asset = asAsset(updated);
  await appendAudit(userId, asset.id, STATUS_AUDIT_ACTION[status], normalizedNote);
  return asset;
}

export function pauseAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'paused', note);
}

export function revokeAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'revoked', note);
}

export function resumeAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', note);
}

/** 归档：从日常列表移出、不参与推荐，历史与 Evidence 保留，可恢复（规范 22.1）。 */
export function archiveAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'archived', note);
}

/**
 * 删除：移出可用资产并进入保留期，保留期内可恢复（规范 22.1）。
 *
 * 只写 `deletedAt` 这个事实，保留期是否届满由 `isWithinDeletionRetention` 现算。
 * 重复删除会刷新计时，所以已是 deleted 的记录保留原时间戳——否则用户点两次
 * 删除就把保留期悄悄延长了。
 */
export function deleteAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'deleted', note, (current) => (
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
export async function purgeAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  const asset = await setStatus(userId, assetId, 'purged', note, () => ({
    title: '',
    statement: '',
    evidenceRefs: [],
    purgedAt: new Date().toISOString(),
    learningSignal: undefined,
    ontologyRefs: undefined,
    relations: undefined,
    derivedFrom: undefined,
    applicableWhen: undefined,
    forbiddenWhen: undefined,
    targetAgentIds: undefined,
    sensitivity: undefined,
    confidence: undefined,
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
export function restoreAbilityAsset(userId: string, assetId: string, note?: string): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', note, () => ({ deletedAt: undefined }), (current) => {
    if (current.status === 'deleted' && !isWithinDeletionRetention(current)) {
      throw new Error('ability asset retention window has expired');
    }
  });
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
  note?: string,
): Promise<RecallAbilityAssetRecord> {
  const normalizedNote = note === undefined ? undefined : bounded(note, 'audit note', 1_000);
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
  await appendVersion(userId, asset);
  await appendAudit(userId, asset.id, 'rolled_back', normalizedNote ?? `rolled back to v${toVersion}`);
  return asset;
}

export async function listAbilityAssetVersions(userId: string, assetId: string): Promise<AbilityAssetVersionRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0)).map(asVersion);
}

export async function listAbilityAssetAudit(userId: string, assetId: string): Promise<AbilityAssetAuditRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-audit', assetId, 0)) as AbilityAssetAuditRecord[];
}

export async function setAbilityAssetMaturity(
  userId: string,
  assetId: string,
  maturity: RecallAbilityAssetRecord['maturity'],
): Promise<RecallAbilityAssetRecord> {
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    return { ...current, maturity, updatedAt: new Date().toISOString() };
  });
  return asAsset(updated);
}
