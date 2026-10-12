/**
 * experience-migration.ts — 存量 KSTAR 经验类资产迁入经验目录（specs/016 T015，
 * 契约 E7/E8，data-model §4/§7；US-801 AC2 / FR-002 / SC-002）。
 *
 * 判据（research D5，唯一硬标记）：`asset.learningProvenance` 存在且
 * `status ∈ {active, paused, archived}`；capture 线（自动抽取，无 provenance）与
 * `preference_scan` 线（只带 learningSignal 徽章）天然落选，各落一个稳定跳过码。
 *
 * run 的顺序**不可颠倒**（照抄 `deleteAbilityAssetVersion` 的「先保引用、后删数据
 * + 任一失败整体中止」）：
 *   ① 冻结：把该资产在每个**已确认投影**里被钉住的那一版内容副本写进
 *      `projection.assetVersionSnapshots`（含本 feature 新增的可选 `evidenceRefs`，
 *      否则迁移后证据引用不可追）；全量枚举用 `listAllConfirmedProjections`
 *      （`listContextProjections` 会 clamp 条数，存量超过就漏冻结）；
 *   ② 写经验条目（`createExperience`，确定性 id `exp-mig-<assetId>` 保证重跑幂等）；
 *   ③ **经验确认写成功之后**才迁出资产库：物理删主记录 JSON + 清版本流
 *      （E7 口径「移出 ability-assets 记录面 + 清版本流」；不用 `purgeAbilityAsset`
 *      ——它的级联段会把冻结副本从投影里摘掉，直接违背 SC-002 不断链）；
 *   ④ 台账记 `assetId ↔ experienceId`（`experience-migrations` 集合，`exm-` 前缀）。
 * 任一步失败 → 该条记 `failed` 并**保持资产原状**（无半迁：经验没写成前不动
 * 资产记录；冻结副本是投影侧的幂等加法，写失败即中止、写成功也无害）。
 *
 * 与资产域的关系：本文件**只读调用** asset-service 的列举/读取原语；迁出用的
 * 物理删除是「同形操作」（store 没有删 JSON 记录的原语，这里按同一把文件锁
 * 删主记录，版本流用既有 `removeRecallJsonlStream`），不改 asset-service 本身。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, removeRecallJsonlStream, updateRecallJsonRecord } from './store';
import { RECALL_SCHEMA_VERSION, type RecallJsonRecord } from './types';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { AbilityAssetVersionRecord } from './asset-service';
import { readAbilityAsset, readAbilityAssetVersionSnapshot } from './asset-service';
import { listAllConfirmedProjections } from './context-projection';
import {
  createExperience,
  type ExperienceRecord,
  type ExperienceTaskType,
  type ExperienceType,
  type ExperienceVerification,
} from './experience-service';
import type { KstarLearningProvenance } from '../kstar/types';
import { scopeForTask, experienceTypeOf } from '../kstar/extraction-service';
import { readKstarEpisode } from '../kstar/episode-store';
import { readKstarReview } from '../kstar/review-service';
import { userFacingSummary } from '../kstar/task-level-precipitation';

/** 迁移台账集合（data-model §7：`<uid>/cloud/recall/records/experience-migrations/`）。 */
export const EXPERIENCE_MIGRATION_COLLECTION = 'experience-migrations';
/** run 单批上限（契约 E7：显式传 assetIds，≤200，禁止隐式一键全迁）。 */
export const EXPERIENCE_MIGRATION_MAX_ASSETS = 200;

/** 跳过理由码（稳定，界面按码翻人话；不回滚改文案导致历史台账不可读）。 */
export type ExperienceMigrationSkipReason =
  | 'no_kstar_provenance'   // 无 KSTAR 沉淀硬标记（默认跳过码）
  | 'capture_line'          // 会话整理自动抽取线（lifecycleStatus 可辨）
  | 'preference_scan_line'  // 偏好扫描线（learningSignal.source 徽章）
  | 'terminal_status'       // deleted/purged/revoked：删除是用户意图，不迁
  | 'asset_not_found'       // run 时记录已不存在且台账查无去向
  | 'already_migrated';     // 幂等：台账里已有该资产的经验去向

export type ExperienceMigrationRunStatus = 'running' | 'partial' | 'done' | 'failed';

export interface ExperienceMigrationDetail {
  assetId: string;
  experienceId?: string;
  reason: ExperienceMigrationSkipReason | 'ok' | 'freeze_failed' | 'experience_write_failed' | 'asset_removal_failed';
  /** 失败时的错误摘要（诊断用，非稳定码——渲染层文案一律按 reason 翻）。 */
  error?: string;
}

export interface ExperienceMigrationPreviewItem {
  assetId: string;
  title: string;
  assetType: RecallAbilityAssetRecord['type'];
  status: RecallAbilityAssetRecord['status'];
  experienceTypeGuess: ExperienceType;
  frozenProjections: number;
}

export interface ExperienceMigrationPreview {
  scanned: number;
  migratable: number;
  skipped: number;
  items: ExperienceMigrationPreviewItem[];
  skippedReasons: Array<{ reason: ExperienceMigrationSkipReason; count: number }>;
}

export interface ExperienceMigrationRunResult {
  migrationId: string;
  status: ExperienceMigrationRunStatus;
  migrated: number;
  skipped: number;
  failed: number;
  details: ExperienceMigrationDetail[];
}

/** 台账记录（data-model §7 字段表；复用 recall 记录工具读写）。 */
export interface ExperienceMigrationRecord extends RecallJsonRecord {
  trigger: 'user';
  startedAt: string;
  finishedAt?: string;
  scanned: number;
  migrated: ExperienceMigrationDetail[];
  skipped: ExperienceMigrationDetail[];
  failed: ExperienceMigrationDetail[];
  status: ExperienceMigrationRunStatus;
}

export interface ExperienceMigrationStatusSummary {
  migrationId: string;
  status: ExperienceMigrationRunStatus;
  startedAt: string;
  finishedAt?: string;
  migrated: number;
  skipped: number;
  failed: number;
  details: ExperienceMigrationDetail[];
}

// ── 判据（唯一分叉点，preview/run 共用）────────────────────────────────────

/** 可迁移状态集：deleted/purged/revoked 不迁——删除是用户意图（research D5）。 */
const MIGRATABLE_STATUSES = new Set<RecallAbilityAssetRecord['status']>(['active', 'paused', 'archived']);

function migrationVerdict(asset: RecallAbilityAssetRecord): ExperienceMigrationSkipReason | null {
  if (asset.status === 'deleted' || asset.status === 'purged' || asset.status === 'revoked') {
    return 'terminal_status';
  }
  if (!asset.learningProvenance) {
    // capture 线与 preference_scan 线都无 provenance（D5 反例），但各自可辨：
    // 给出更具体的码，界面能如实说清「为什么这条不迁」。
    if (asset.learningSignal?.source === 'preference_scan') return 'preference_scan_line';
    if (asset.lifecycleStatus === 'automatically_extracted_unverified') return 'capture_line';
    return 'no_kstar_provenance';
  }
  if (!MIGRATABLE_STATUSES.has(asset.status)) {
    return 'terminal_status';
  }
  return null;
}

/** 资产反推经验类型（research D3 的逆向映射，与沉淀线 `experienceKindFor` 同源）：
 *  归因为 *_gap → gap；skill_method → workflow；其余 → lesson。 */
function kindForAsset(asset: RecallAbilityAssetRecord): 'lesson' | 'workflow' | 'gap' {
  const attribution = asset.learningProvenance?.attribution;
  if (
    attribution === 'knowledge_gap' || attribution === 'rule_gap'
    || attribution === 'template_gap' || attribution === 'skill_gap'
  ) return 'gap';
  return asset.type === 'skill_method' ? 'workflow' : 'lesson';
}

// ── preview（E7，只读）──────────────────────────────────────────────────────

export async function previewExperienceMigration(userId: string): Promise<ExperienceMigrationPreview> {
  if (!safeId(userId)) throw new Error('invalid experience migration user');
  const { listAbilityAssets } = await import('./asset-service');
  const assets = await listAbilityAssets(userId);
  // frozenProjections = 引用它的已确认投影数（E7；全量扫描，与删除冻结同一口径）。
  const projections = await listAllConfirmedProjections(userId);
  const items: ExperienceMigrationPreviewItem[] = [];
  const reasonCounts = new Map<ExperienceMigrationSkipReason, number>();
  for (const asset of assets) {
    const skipReason = migrationVerdict(asset);
    if (skipReason !== null) {
      reasonCounts.set(skipReason, (reasonCounts.get(skipReason) || 0) + 1);
      continue;
    }
    items.push({
      assetId: asset.id,
      title: asset.title,
      assetType: asset.type,
      status: asset.status,
      experienceTypeGuess: experienceTypeOf(kindForAsset(asset)),
      frozenProjections: projections.filter((projection) =>
        String(projection.assetVersions?.[asset.id] || '') !== '').length,
    });
  }
  return {
    scanned: assets.length,
    migratable: items.length,
    skipped: assets.length - items.length,
    items,
    // 排序保证两次调用输出一致（reason 码稳定可翻文案、可对比）。
    skippedReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
  };
}

// ── run（E7，写；顺序：冻结 → 写经验 → 迁出 → 台账）─────────────────────────

/** 版本流快照缺失时的 live 兜底（照 asset-service.snapshot() 的同形构造）：
 *  投影钉住的正是当前在用版时，live 内容就是那一版的原文。 */
function liveSnapshotOf(asset: RecallAbilityAssetRecord): AbilityAssetVersionRecord['snapshot'] {
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
    ...(asset.sourceSessionIds?.length ? { sourceSessionIds: asset.sourceSessionIds } : {}),
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  };
}

/**
 * ① 冻结：把该资产在每个已确认投影里钉住的版本内容副本写进
 * `assetVersionSnapshots`（含可选 `evidenceRefs`——T015 写、T016 读的加法式字段）。
 *
 * 形态照抄 `deleteAbilityAssetVersion`：逐投影 `updateRecallJsonRecord` 幂等合并
 * （同版本已冻则原样返回不写）；**任一投影写失败抛出**，调用方把该资产记
 * `failed` 并保持原状——冻结不完整就迁出，注入侧会静默降级到 live 缺席。
 */
async function freezeAssetIntoConfirmedProjections(
  userId: string,
  asset: RecallAbilityAssetRecord,
): Promise<number> {
  const referencing = (await listAllConfirmedProjections(userId)).filter((projection) =>
    String(projection.assetVersions?.[asset.id] || '') !== '');
  for (const projection of referencing) {
    const version = String(projection.assetVersions?.[asset.id]);
    let snapshot: AbilityAssetVersionRecord['snapshot'] | null = null;
    try {
      snapshot = await readAbilityAssetVersionSnapshot(userId, asset.id, version);
    } catch {
      snapshot = null; // 版本流读失败按缺失处理（下面走 live 同版兜底）
    }
    if (!snapshot && String(asset.activeVersion || asset.version) === version) {
      snapshot = liveSnapshotOf(asset);
    }
    if (!snapshot) {
      throw new Error(`frozen version snapshot missing for ${asset.id}@v${version}`);
    }
    // 证据引用一并冻结（data-model §4）：迁移后 live 记录没了，证据只能随副本走。
    const frozen = { ...snapshot, evidenceRefs: snapshot.evidenceRefs ?? asset.evidenceRefs };
    await updateRecallJsonRecord(userId, 'projections', projection.id, (raw) => {
      if (!raw) throw new Error('context projection not found');
      const existing = raw.assetVersionSnapshots;
      const cached = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing as Record<string, { version: string; snapshot: unknown }>
        : {};
      if (cached[asset.id] && String(cached[asset.id].version || '') === version) return raw;
      return { ...raw, assetVersionSnapshots: { ...cached, [asset.id]: { version, snapshot: frozen } } };
    });
  }
  return referencing.length;
}

/** ② 写经验：字段映射照沉淀线 `writeExperienceForProposal` 的口径（data-model §1）。
 *  id 用确定性 `exp-mig-<assetId>`（同资产重跑得到同 id，createExperience 幂等
 *  返回既有记录——「可重入」不产生第二条）。 */
async function writeExperienceForAsset(
  userId: string,
  asset: RecallAbilityAssetRecord,
  provenance: KstarLearningProvenance,
): Promise<ExperienceRecord> {
  const kind = kindForAsset(asset);
  const body = String(asset.statement || '').replace(/\s+/g, ' ').trim().slice(0, 4_000);
  // 溯源 episode best-effort：读得到就用真实 userGoal/status；读不到用资产标题
  // 兜底（如实：这条经验学自哪个任务，标题就是当时的内容核心），不编造。
  let taskGoal = '';
  let taskStatus = 'unknown';
  try {
    const episode = await readKstarEpisode(userId, provenance.episodeId);
    taskGoal = String(episode?.t.userGoal || '');
    taskStatus = String(episode?.r.status || 'unknown') || 'unknown';
  } catch {
    // episode 读失败不阻断迁移（历史任务可能已清理）；taskStatus 保持 unknown。
  }
  if (!taskGoal) taskGoal = asset.title;
  // verification 与沉淀线同款：review 优先，learningSignal 兜底，state 如实 unknown。
  let verification: ExperienceVerification = {
    state: 'unknown',
    outcome: asset.learningSignal?.outcome ?? 'unclear',
    deltaR: asset.learningSignal?.deltaR ?? 'unknown',
    confidence: asset.learningSignal?.confidence ?? 0,
  };
  try {
    const review = await readKstarReview(userId, provenance.episodeId);
    if (review) {
      verification = {
        state: review.reviewState || 'unknown',
        outcome: review.outcome ?? verification.outcome,
        deltaR: review.deltaR ?? verification.deltaR,
        confidence: review.confidence ?? verification.confidence,
      };
    }
  } catch {
    // review 读失败不阻断迁移。
  }
  return createExperience(userId, {
    id: `exp-mig-${asset.id}`,
    source: {
      episodeId: provenance.episodeId,
      taskGoal,
      taskType: scopeForTask(taskGoal) as ExperienceTaskType,
      taskStatus,
    },
    experienceType: experienceTypeOf(kind),
    title: userFacingSummary(kind, asset.scope, body),
    body,
    ...(asset.learningSignal?.expectedResult ? { expected: asset.learningSignal.expectedResult } : {}),
    ...(asset.learningSignal?.actualResult ? { actual: asset.learningSignal.actualResult } : {}),
    // 范围条件原样搬运不截断：经验侧超限（>5 条/单条 >300 字）会被校验拒收
    // → 该条 failed、资产保持原状——宁失败不静默裁（与 experience-service 同理由）。
    ...(asset.applicableWhen?.length ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen?.length ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    scope: String(asset.scope || 'general').slice(0, 500),
    verification,
    evidenceRefs: asset.evidenceRefs,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    learningProvenance: provenance,
    status: asset.status as ExperienceRecord['status'],
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
    ...(asset.spaceId && safeId(asset.spaceId) ? { spaceId: asset.spaceId } : {}),
  });
}

/** ③ 迁出资产库：物理删主记录（同一把文件锁，与 update 原语互斥）+ 清版本流。
 *  不清审计流（只有动作名与时间戳，是历史可考的最小项）；**绝不**碰投影里的
 *  冻结副本（那是 SC-002 的载体）。ENOENT 容忍：迁出可重入。 */
async function removeAssetRecordAndVersions(userId: string, assetId: string): Promise<void> {
  const recordPath = recallJsonRecordPath(userId, 'ability-assets', assetId);
  await fileEditLock(recordPath).runExclusive(async () => {
    await fs.rm(recordPath, { force: true });
  });
  await removeRecallJsonlStream(userId, 'ability-asset-versions', assetId);
}

// ── 台账（E8）──────────────────────────────────────────────────────────────

function migrationsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, EXPERIENCE_MIGRATION_COLLECTION, 'placeholder'));
}

/** 台账集合全量列举（startedAt 降序；目录不存在 = 从未跑过）。 */
async function listMigrationRecords(userId: string): Promise<ExperienceMigrationRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(migrationsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => safeId(id) && id.startsWith('exm-'));
  const records = (await Promise.all(ids.map((id) => readRecallJsonRecord(userId, EXPERIENCE_MIGRATION_COLLECTION, id))))
    .filter((raw): raw is RecallJsonRecord => Boolean(raw));
  return records
    .map((raw) => raw as unknown as ExperienceMigrationRecord)
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)) || String(right.id).localeCompare(String(left.id)));
}

/** 最近一次迁移（E8）：从未跑过 → `{ok:true, migrationId:null}`（契约原文）。 */
export async function latestExperienceMigrationStatus(
  userId: string,
): Promise<{ ok: true; migrationId: null } | ({ ok: true } & ExperienceMigrationStatusSummary)> {
  if (!safeId(userId)) throw new Error('invalid experience migration user');
  const records = await listMigrationRecords(userId);
  const latest = records[0];
  if (!latest) return { ok: true, migrationId: null };
  const details = [...(latest.migrated || []), ...(latest.skipped || []), ...(latest.failed || [])];
  return {
    ok: true,
    migrationId: latest.id,
    status: latest.status,
    startedAt: latest.startedAt,
    ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}),
    migrated: (latest.migrated || []).length,
    skipped: (latest.skipped || []).length,
    failed: (latest.failed || []).length,
    details,
  };
}

// ── run 主流程 ──────────────────────────────────────────────────────────────

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export async function runExperienceMigration(
  userId: string,
  assetIds: string[],
): Promise<ExperienceMigrationRunResult> {
  if (!safeId(userId)) throw new Error('invalid experience migration user');
  // 显式批量边界（契约 E7）：必须传数组、非空、≤200、逐条合法——禁止隐式全迁。
  if (
    !Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > EXPERIENCE_MIGRATION_MAX_ASSETS
    || assetIds.some((id) => typeof id !== 'string' || !safeId(id))
  ) {
    throw new Error(`invalid experience migration asset ids (1-${EXPERIENCE_MIGRATION_MAX_ASSETS} explicit ids required)`);
  }

  const migrationId = `exm-${Date.now().toString(36)}-${randomSuffix()}`;
  const record: ExperienceMigrationRecord = {
    schemaVersion: RECALL_SCHEMA_VERSION,
    ownerId: userId,
    id: migrationId,
    trigger: 'user',
    startedAt: new Date().toISOString(),
    scanned: assetIds.length,
    migrated: [],
    skipped: [],
    failed: [],
    status: 'running',
  };
  // 先落 running 记录：中断后盘上留有「跑到一半」的事实，status 通道可查。
  await updateRecallJsonRecord(userId, EXPERIENCE_MIGRATION_COLLECTION, migrationId, (current) => current || record);

  // 幂等判据的数据源（data-model §7）：资产记录已不存在时，用历史台账的
  // assetId → experienceId 映射区分「已迁过」（already_migrated）与「本来没有」。
  const knownDestinations = new Map<string, string>();
  for (const historical of await listMigrationRecords(userId)) {
    for (const entry of historical.migrated || []) {
      if (entry.experienceId && !knownDestinations.has(entry.assetId)) knownDestinations.set(entry.assetId, entry.experienceId);
    }
  }

  const summarize = (): ExperienceMigrationRunResult => ({
    migrationId,
    status: record.status,
    migrated: record.migrated.length,
    skipped: record.skipped.length,
    failed: record.failed.length,
    details: [...record.migrated, ...record.skipped, ...record.failed],
  });

  for (const assetId of assetIds) {
    try {
      let asset: RecallAbilityAssetRecord;
      try {
        asset = await readAbilityAsset(userId, assetId);
      } catch {
        const destination = knownDestinations.get(assetId);
        record.skipped.push(destination
          ? { assetId, experienceId: destination, reason: 'already_migrated' }
          : { assetId, reason: 'asset_not_found' });
        continue;
      }
      const skipReason = migrationVerdict(asset);
      if (skipReason !== null) {
        record.skipped.push({ assetId, reason: skipReason });
        continue;
      }
      // ① 冻结引用副本（任一投影写失败 → 整体中止，资产不动）。
      try {
        await freezeAssetIntoConfirmedProjections(userId, asset);
      } catch (error) {
        record.failed.push({ assetId, reason: 'freeze_failed', error: (error as Error).message });
        continue;
      }
      // ② 写经验条目（未确认写成功之前不动资产记录——无半迁）。
      let experienceId: string;
      try {
        experienceId = (await writeExperienceForAsset(userId, asset, asset.learningProvenance!)).id;
      } catch (error) {
        record.failed.push({ assetId, reason: 'experience_write_failed', error: (error as Error).message });
        continue;
      }
      // ③ 迁出资产库（主记录 + 版本流）。
      try {
        await removeAssetRecordAndVersions(userId, assetId);
      } catch (error) {
        record.failed.push({ assetId, experienceId, reason: 'asset_removal_failed', error: (error as Error).message });
        continue;
      }
      // ④ 台账明细：assetId ↔ experienceId 双向映射可追（data-model §7）。
      record.migrated.push({ assetId, experienceId, reason: 'ok' });
    } catch (error) {
      // 防御兜底：逐条处理不应让整批中断（其余条目照常），单条失败如实记账。
      record.failed.push({ assetId, reason: 'experience_write_failed', error: (error as Error).message });
    }
  }

  record.finishedAt = new Date().toISOString();
  record.status = record.failed.length
    ? (record.migrated.length || record.skipped.length ? 'partial' : 'failed')
    : 'done';
  await updateRecallJsonRecord(userId, EXPERIENCE_MIGRATION_COLLECTION, migrationId, (current) => ({
    ...(current || record),
    finishedAt: record.finishedAt,
    migrated: record.migrated,
    skipped: record.skipped,
    failed: record.failed,
    status: record.status,
  }));
  return summarize();
}
