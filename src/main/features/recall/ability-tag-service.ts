/**
 * 标签库服务（specs/012 US-201，data-model.md §2/§6.1）。
 *
 * 定位：标签 = **主题分类**（人工 + AI 辅助），与族名（同源血缘，系统自动）、
 * 作用域（消费准入）三轴各司其职。标签**不参与推荐分**（只影响筛选）。
 *
 * 载体：`records/ability-tags/<tagId>.json`（经 paths.ts 的 recallJsonRecordPath，
 * 段名过 assertSafeSegment）。资产按 **name** 引用标签（不是 id）——id 是稳定锚
 * （`tg-<12位>`，重命名不变），名字是唯一引用键。
 *
 * 三条硬纪律（specs/012 tasks 反漂移 II1/II4）：
 *   1. **资产 tags 的写入只有 `updateAbilityAsset` 一处**——本服务的
 *      rename/merge/delete/set/batch 联动全部经它循环，不直写资产记录
 *      （标签是元数据，那条路径不 bump 内容版本）。
 *   2. **标签规范化只有本文件一处**（trim + ≤20 字 + 大小写不敏感去重）；
 *      `updateAbilityAsset` 的 tags 校验调 `normalizeAbilityTagList`，不另写。
 *   3. **派生量不落盘**：usageCount/assetCount/lastUsedAt 读时按资产引用数算，
 *      落盘就是第二份真相（research D9）。
 *
 * 状态机（data-model §6.1）：active →（重命名）active（name 变、formerNames
 * 追加、id 不变）；→（合并的**源**）merged（name 保留、进目标 aliases）；→
 * （删除）archived。不硬删——merged/archived 条目是"这个旧标去哪了"的依据。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { genId12, safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { AbilityAssetActor } from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';

/** 标签条目三态（data-model §6.1）。merged/archived 不出现在打标候选与筛选条。 */
export type AbilityTagState = 'active' | 'merged' | 'archived';

/** 创建来源（data-model §2）。`ai` 只可能来自**经审批通过**的 AI 打标。 */
export type AbilityTagCreatedFrom = 'user' | 'ai' | 'cleanup' | 'meeting' | 'candidate';

export interface AbilityTagRecord extends RecallJsonRecord {
  /** `tg-` + 12 位随机。稳定锚：创建后永不变（重命名不改 id）。 */
  id: string;
  /** 唯一权威显示名（资产按它引用）。≤20 字、trim 后非空；active 名全库唯一（大小写不敏感）。 */
  name: string;
  state: AbilityTagState;
  /** 同义词（人工维护 + 合并时写入源标签名）。只用于合并建议，不参与匹配优先级。 */
  aliases?: string[];
  /** 历史名（重命名时追加，只增不改）。 */
  formerNames?: string[];
  createdFrom: AbilityTagCreatedFrom;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层可见视图（ipc 契约 §1.1）。assetCount/lastUsedAt 读时派生、不落盘。 */
export interface AbilityTagView {
  id: string;
  name: string;
  state: AbilityTagState;
  createdFrom: AbilityTagCreatedFrom;
  aliases?: string[];
  formerNames?: string[];
  /** 引用该名字的资产数（不含 purged 墓碑）。 */
  assetCount: number;
  /** 被引用资产里最近的 updatedAt；无引用时省字段。 */
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 批量联动报告（rename/merge/delete/batch 共用；逐项可核对）。 */
export interface AbilityTagBatchReportItem {
  assetId: string;
  title: string;
  before: string[];
  after: string[];
  status: 'updated' | 'unchanged' | 'failed';
  /** 失败/跳过原因（人话短语，不含正文）。 */
  note?: string;
}

export interface AbilityTagBatchReport {
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  items: AbilityTagBatchReportItem[];
}

/** 批量打标的三选一语义（replace 与 add/remove 不得同时出现）。 */
export interface AbilityTagBatchOp {
  add?: string[];
  remove?: string[];
  replace?: string[];
}

export interface AbilityTagOrphanReport {
  ok: boolean;
  /** 资产引用了但没有 active 库条目的名字。 */
  orphans: Array<{ name: string; assetIds: string[] }>;
  /** active 名字撞车（大小写不敏感后同名）。 */
  duplicateActiveNames: string[];
}

export interface AbilityTagMergeSuggestion {
  sourceName: string;
  targetName: string;
  /** 'alias'（源别名命中目标名）| 'similar'（名字相似）。只建议不合并。 */
  reason: 'alias' | 'similar';
}

export const ABILITY_TAG_COLLECTION = 'ability-tags';
/** 标签名长度上限（与资产侧单条标签同规则；data-model §3）。 */
export const ABILITY_TAG_NAME_MAX_LENGTH = 20;
/** 单资产标签条数上限（超限拒绝不截断）。 */
export const ABILITY_ASSET_TAGS_MAX = 12;
/** 单次批量打标的资产条数上限（ipc 契约 §二：超限拒绝并提示分批）。 */
export const ABILITY_TAG_BATCH_MAX_ASSETS = 200;
/** 合并建议条数上限。 */
export const ABILITY_TAG_SUGGESTION_MAX = 20;

const TAG_ID_PATTERN = /^tg-[A-Za-z0-9]{12}$/;
const TAG_STATES = new Set<AbilityTagState>(['active', 'merged', 'archived']);
const TAG_CREATED_FROM = new Set<AbilityTagCreatedFrom>(['user', 'ai', 'cleanup', 'meeting', 'candidate']);

/** 大小写不敏感的引用键（指纹口径与 candidate-service.fingerprint 一致）。 */
function tagKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

// ── 规范化唯一处（反漂移 II4：trim / 长度 / 去重规则只有这一处） ──────────────

/**
 * 标签列表规范化（specs/012 data-model §3，**全仓唯一处**）：
 * - 必须是数组（**单一字符串拒绝**，不自动包成数组——静默容错会让模型养成错形状）；
 * - 每条 trim 后非空且 ≤20 字，违例**抛错拒绝**（不静默丢弃、不截断）；
 * - 按「去空格后大小写不敏感」去重，保留首次出现的原样；
 * - 去重后 ≤12 条，超限**抛错不截断**。
 */
export function normalizeAbilityTagList(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('invalid ability asset tags');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') throw new Error('invalid ability asset tags entry');
    const name = entry.trim();
    if (!name) throw new Error('invalid ability asset tags entry');
    if (name.length > ABILITY_TAG_NAME_MAX_LENGTH) {
      throw new Error(`invalid ability asset tag name: exceeds ${ABILITY_TAG_NAME_MAX_LENGTH} chars`);
    }
    const key = tagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > ABILITY_ASSET_TAGS_MAX) {
    throw new Error(`invalid ability asset tags: exceeds ${ABILITY_ASSET_TAGS_MAX} entries`);
  }
  return out;
}

/** 单个标签名规范化：复用列表规范化（同一处规则），只取一条。 */
export function normalizeAbilityTagName(input: unknown): string {
  const [name] = normalizeAbilityTagList([input]);
  return name;
}

function asTag(value: RecallJsonRecord): AbilityTagRecord {
  if (
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > ABILITY_TAG_NAME_MAX_LENGTH
    || !TAG_STATES.has(value.state as AbilityTagState)
    || !TAG_CREATED_FROM.has(value.createdFrom as AbilityTagCreatedFrom)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
  ) throw new Error('malformed ability tag record');
  return value as AbilityTagRecord;
}

function tagsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, ABILITY_TAG_COLLECTION, 'placeholder'));
}

async function listTagRecords(userId: string): Promise<AbilityTagRecord[]> {
  let names: string[];
  try { names = await fs.readdir(tagsDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(
    names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
      .map((name) => readRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, name.slice(0, -5))),
  );
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asTag);
}

async function readTagRecord(userId: string, tagId: string): Promise<AbilityTagRecord> {
  if (!TAG_ID_PATTERN.test(tagId)) throw new Error('invalid ability tag id');
  const raw = await readRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, tagId);
  if (!raw) throw new Error('ability tag not found');
  return asTag(raw);
}

/** 资产标签引用计数（读时派生）。purged 墓碑无内容不计（ipc 契约 §1.1）。 */
async function listAssetsForTagDerivation(userId: string): Promise<RecallAbilityAssetRecord[]> {
  const { listAbilityAssets } = await import('./asset-service');
  return (await listAbilityAssets(userId)).filter((asset) => asset.status !== 'purged');
}

/** 联动改写可触达的资产：purged/deleted/revoked 终态不可变更（updateAbilityAsset 会拒），
 *  标签联动与孤儿校验都按这个集合算——校验口径必须与可修复口径一致，否则
 *  "verifyNoOrphans 通过"会是谎（对着改不动的资产喊孤儿没有意义）。 */
function tagMutableAssets(assets: ReadonlyArray<RecallAbilityAssetRecord>): RecallAbilityAssetRecord[] {
  return assets.filter((asset) => asset.status !== 'purged' && asset.status !== 'deleted' && asset.status !== 'revoked');
}

interface TagUsageIndex {
  /** key(name) → 引用资产数 */
  counts: Map<string, number>;
  /** key(name) → 被引用资产里最近的 updatedAt */
  lastUsedAt: Map<string, string>;
}

function buildUsageIndex(assets: ReadonlyArray<RecallAbilityAssetRecord>): TagUsageIndex {
  const counts = new Map<string, number>();
  const lastUsedAt = new Map<string, string>();
  for (const asset of assets) {
    for (const name of asset.tags || []) {
      const key = tagKey(name);
      counts.set(key, (counts.get(key) || 0) + 1);
      const current = lastUsedAt.get(key);
      if (!current || String(asset.updatedAt) > current) lastUsedAt.set(key, String(asset.updatedAt));
    }
  }
  return { counts, lastUsedAt };
}

function toTagView(record: AbilityTagRecord, usage: TagUsageIndex): AbilityTagView {
  const key = tagKey(record.name);
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    createdFrom: record.createdFrom,
    ...(record.aliases?.length ? { aliases: record.aliases } : {}),
    ...(record.formerNames?.length ? { formerNames: record.formerNames } : {}),
    assetCount: record.state === 'active' ? usage.counts.get(key) || 0 : 0,
    ...(record.state === 'active' && usage.lastUsedAt.get(key) ? { lastUsedAt: usage.lastUsedAt.get(key) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 标签清单（纯读，零写入正文）。排序口径定死（「常用标签置顶」的唯一口径，
 * data-model §2）：assetCount DESC → lastUsedAt DESC → name 字典序（码点序，
 * 保证可复现）。缺省只给 active；includeRetired 附带 merged/archived 供管理页。
 */
export async function listTags(
  userId: string,
  options: { includeRetired?: boolean } = {},
): Promise<AbilityTagView[]> {
  const records = await listTagRecords(userId);
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  return records
    .filter((record) => options.includeRetired || record.state === 'active')
    .map((record) => toTagView(record, usage))
    .sort((left, right) => {
      if (left.assetCount !== right.assetCount) return right.assetCount - left.assetCount;
      const leftAt = left.lastUsedAt || '';
      const rightAt = right.lastUsedAt || '';
      if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });
}

async function findActiveTagByKey(records: ReadonlyArray<AbilityTagRecord>, name: string): Promise<AbilityTagRecord | undefined> {
  const key = tagKey(name);
  return records.find((record) => record.state === 'active' && tagKey(record.name) === key);
}

/** 打标时自动补建缺失的库条目（data-model §3：否则打一个标要先建库，不可用）。
 *  已有同名 active 条目则跳过；同名 retired（merged/archived）条目**不复用**——
 *  停用是历史事实，重新启用要新建（active 名字唯一性只约束 active 之间）。 */
export async function ensureAbilityTags(
  userId: string,
  names: ReadonlyArray<string>,
  createdFrom: AbilityTagCreatedFrom = 'user',
): Promise<AbilityTagView[]> {
  if (!names.length) return [];
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  const created: AbilityTagView[] = [];
  for (const name of normalizeAbilityTagList([...names])) {
    const existing = await findActiveTagByKey(await listTagRecords(userId), name);
    if (existing) continue;
    created.push(toTagView(await createTagRecord(userId, name, createdFrom), usage));
  }
  return created;
}

async function createTagRecord(
  userId: string,
  name: string,
  createdFrom: AbilityTagCreatedFrom,
): Promise<AbilityTagRecord> {
  const normalized = normalizeAbilityTagName(name);
  const now = new Date().toISOString();
  const id = `tg-${genId12()}`;
  return asTag(await updateRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, id, (current) => current || {
    schemaVersion: 1,
    ownerId: userId,
    id,
    name: normalized,
    state: 'active',
    createdFrom,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * 新建标签。同名（大小写不敏感）**active** 条目已存在 → 返回既有条目（created:
 * false，不报错、不建重复——data-model §2「同名 → 返回既有条目」）。
 */
export async function createTag(
  userId: string,
  name: string,
  createdFrom: AbilityTagCreatedFrom = 'user',
): Promise<{ tag: AbilityTagView; created: boolean }> {
  const normalized = normalizeAbilityTagName(name);
  const records = await listTagRecords(userId);
  const existing = await findActiveTagByKey(records, normalized);
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  if (existing) return { tag: toTagView(existing, usage), created: false };
  return { tag: toTagView(await createTagRecord(userId, normalized, createdFrom), usage), created: true };
}

/** 资产上的标签是否含某名字（大小写不敏感比对——两侧写入时都已规范化，这里
 *  只是防御外部手改盘导致的 casing 漂移）。 */
function assetHasTag(asset: RecallAbilityAssetRecord, name: string): boolean {
  const key = tagKey(name);
  return (asset.tags || []).some((entry) => tagKey(entry) === key);
}

/** 逐资产经 updateAbilityAsset 改写标签（唯一写路径，II1），产出逐项报告。
 *  不可变更终态（purged/deleted/revoked）的引用资产如实记 failed，不静默跳过。 */
async function rewriteAssetTags(
  userId: string,
  assets: ReadonlyArray<RecallAbilityAssetRecord>,
  compute: (asset: RecallAbilityAssetRecord) => string[],
  reason: string,
  actor: AbilityAssetActor = 'user',
): Promise<AbilityTagBatchReport> {
  const { updateAbilityAsset } = await import('./asset-service');
  const items: AbilityTagBatchReportItem[] = [];
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  for (const asset of assets) {
    const before = asset.tags || [];
    const after = compute(asset);
    const same = before.length === after.length && before.every((name, index) => tagKey(name) === tagKey(after[index]));
    if (same) {
      unchanged += 1;
      items.push({ assetId: asset.id, title: asset.title, before, after, status: 'unchanged' });
      continue;
    }
    if (asset.status === 'purged' || asset.status === 'deleted' || asset.status === 'revoked') {
      failed += 1;
      items.push({ assetId: asset.id, title: asset.title, before, after, status: 'failed', note: 'asset not mutable' });
      continue;
    }
    try {
      await updateAbilityAsset(userId, asset.id, { tags: after, reason, actor });
      updated += 1;
      items.push({ assetId: asset.id, title: asset.title, before, after, status: 'updated' });
    } catch (error) {
      failed += 1;
      items.push({
        assetId: asset.id,
        title: asset.title,
        before,
        after,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { total: assets.length, updated, unchanged, failed, items };
}

/**
 * 重命名（data-model §6.1）：库条目 name 变、旧名追加 formerNames、**id 不变**；
 * 批量改写所有引用旧名的资产（元数据，不 bump 版本）。目标名与其它 active
 * 条目同名 → 拒绝（那是合并的事）。先改库再改资产：库改名是单条原子写，
 * 最稳的一步先落；资产的逐条改写可从报告重跑。名字大小写不敏感后相同 = 同一
 * 个标签，改名无操作（不产生 formerNames 噪音）。
 */
export async function renameTag(
  userId: string,
  tagId: string,
  name: string,
  options: { actor?: AbilityAssetActor } = {},
): Promise<{ tag: AbilityTagView; report: AbilityTagBatchReport }> {
  const normalized = normalizeAbilityTagName(name);
  const record = await readTagRecord(userId, tagId);
  if (record.state !== 'active') throw new Error('ability tag is not active');
  let previousName = record.name;
  if (tagKey(normalized) !== tagKey(record.name)) {
    const clash = await findActiveTagByKey(await listTagRecords(userId), normalized);
    if (clash && clash.id !== record.id) {
      throw new Error('ability tag name already in use by another active tag (use merge instead)');
    }
    // formerNames 只增不改：追加旧名（大小写不敏感去重，防 A→B→A→B 循环刷屏）。
    const formerNames = [...new Map([
      ...(record.formerNames || []).map((entry) => [tagKey(entry), entry] as const),
      [tagKey(record.name), record.name] as const,
    ]).values()];
    await updateRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, record.id, (current) => ({
      ...(current || {}),
      name: normalized,
      formerNames,
      updatedAt: new Date().toISOString(),
    } as RecallJsonRecord));
  }
  const renamed = await readTagRecord(userId, record.id);
  const assets = await listAssetsForTagDerivation(userId);
  const referencing = assets.filter((asset) => assetHasTag(asset, previousName));
  const report = await rewriteAssetTags(
    userId,
    referencing,
    (asset) => (asset.tags || []).map((entry) => (
      (renamed.formerNames || []).some((former) => tagKey(former) === tagKey(entry)) ? renamed.name : entry
    )),
    `标签重命名：${previousName} → ${renamed.name}`,
    options.actor,
  );
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  return { tag: toTagView(await readTagRecord(userId, record.id), usage), report };
}

/** 合并（data-model §6.1）：源名下资产批量改写为目标名（去重）；源条目置
 *  merged、源名进目标 aliases（条目保留，供"这个旧标去哪了"追问）。
 *  顺序：先改资产再动库——改完后源名零引用，置 merged 才不违反
 *  "merged 的 name 不得再被引用"。 */
export async function mergeTag(
  userId: string,
  sourceTagId: string,
  targetTagId: string,
  options: { actor?: AbilityAssetActor } = {},
): Promise<{ tag: AbilityTagView; mergedFrom: AbilityTagView; report: AbilityTagBatchReport }> {
  if (sourceTagId === targetTagId) throw new Error('ability tag merge requires distinct tags');
  const source = await readTagRecord(userId, sourceTagId);
  const target = await readTagRecord(userId, targetTagId);
  if (source.state !== 'active' || target.state !== 'active') throw new Error('ability tag merge requires both tags active');
  const assets = await listAssetsForTagDerivation(userId);
  const referencing = assets.filter((asset) => assetHasTag(asset, source.name));
  const report = await rewriteAssetTags(
    userId,
    referencing,
    (asset) => {
      const kept = (asset.tags || []).filter((entry) => tagKey(entry) !== tagKey(source.name));
      return kept.some((entry) => tagKey(entry) === tagKey(target.name)) ? kept : [...kept, target.name];
    },
    `标签合并：${source.name} → ${target.name}`,
    options.actor,
  );
  const now = new Date().toISOString();
  const aliases = [...new Map([
    ...(target.aliases || []).map((entry) => [tagKey(entry), entry] as const),
    [tagKey(source.name), source.name] as const,
  ]).values()];
  await updateRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, target.id, (current) => ({
    ...(current || {}),
    aliases,
    updatedAt: now,
  } as RecallJsonRecord));
  await updateRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, source.id, (current) => ({
    ...(current || {}),
    state: 'merged',
    updatedAt: now,
  } as RecallJsonRecord));
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  return {
    tag: toTagView(await readTagRecord(userId, target.id), usage),
    mergedFrom: toTagView(await readTagRecord(userId, source.id), usage),
    report,
  };
}

/** 删除（data-model §6.1）：**仅摘除**资产上的该名字（批量）；条目置 archived
 *  （不硬删）。资产本体零改动——tags 是元数据，updateAbilityAsset 的 tags
 *  路径不 bump 版本、不动 statement/status/scope（spec US-201 AC4）。 */
export async function deleteTag(
  userId: string,
  tagId: string,
  options: { actor?: AbilityAssetActor } = {},
): Promise<{ tag: AbilityTagView; report: AbilityTagBatchReport }> {
  const record = await readTagRecord(userId, tagId);
  const assets = await listAssetsForTagDerivation(userId);
  const referencing = assets.filter((asset) => assetHasTag(asset, record.name));
  const report = record.state === 'archived' ? { total: 0, updated: 0, unchanged: 0, failed: 0, items: [] } : await rewriteAssetTags(
    userId,
    referencing,
    (asset) => (asset.tags || []).filter((entry) => tagKey(entry) !== tagKey(record.name)),
    `标签删除：摘除「${record.name}」`,
    options.actor,
  );
  if (record.state !== 'archived') {
    await updateRecallJsonRecord(userId, ABILITY_TAG_COLLECTION, record.id, (current) => ({
      ...(current || {}),
      state: 'archived',
      updatedAt: new Date().toISOString(),
    } as RecallJsonRecord));
  }
  const usage = buildUsageIndex(await listAssetsForTagDerivation(userId));
  return { tag: toTagView(await readTagRecord(userId, record.id), usage), report };
}

/** 单条打标 / 清空（整组替换语义；`[]` = 清空 → 回到「未分类」）。
 *  走唯一写路径 updateAbilityAsset（缺失的库条目在那边自动补建）。 */
export async function setAssetTags(
  userId: string,
  assetId: string,
  tags: string[],
  options: { actor?: AbilityAssetActor; reason?: string } = {},
): Promise<RecallAbilityAssetRecord> {
  const normalized = normalizeAbilityTagList(tags);
  const { updateAbilityAsset } = await import('./asset-service');
  return updateAbilityAsset(userId, assetId, {
    tags: normalized,
    reason: options.reason || '设置标签',
    actor: options.actor || 'user',
  });
}

/** 批量打标三选一（replace 或 add/remove，不得同时给）。逐资产算最终标签组
 *  后仍走 updateAbilityAsset；单资产超 12 条记 failed **不截断**。幂等：同名
 *  标签不会重复加，中断重跑已完成项自动落 unchanged。 */
export async function batchAssetTags(
  userId: string,
  assetIds: string[],
  op: AbilityTagBatchOp,
  options: { actor?: AbilityAssetActor; reason?: string } = {},
): Promise<AbilityTagBatchReport> {
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.some((id) => !safeId(id))) {
    throw new Error('invalid ability tag batch asset ids');
  }
  if (assetIds.length > ABILITY_TAG_BATCH_MAX_ASSETS) {
    throw new Error(`ability tag batch exceeds ${ABILITY_TAG_BATCH_MAX_ASSETS} assets`);
  }
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Error('invalid ability tag batch op');
  const replace = op.replace === undefined ? undefined : normalizeAbilityTagList(op.replace);
  const add = op.add === undefined ? undefined : normalizeAbilityTagList(op.add);
  const remove = op.remove === undefined ? undefined : normalizeAbilityTagList(op.remove);
  if (replace !== undefined && (add !== undefined || remove !== undefined)) {
    throw new Error('ability tag batch op: replace cannot combine with add/remove');
  }
  if (replace === undefined && add === undefined && remove === undefined) {
    throw new Error('ability tag batch op requires at least one action');
  }
  const { listAbilityAssets, updateAbilityAsset } = await import('./asset-service');
  const byId = new Map((await listAbilityAssets(userId)).map((asset) => [asset.id, asset]));
  const reasonBase = options.reason || (replace !== undefined ? '批量替换标签' : '批量打标');
  const items: AbilityTagBatchReportItem[] = [];
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  for (const assetId of assetIds) {
    const asset = byId.get(assetId);
    if (!asset) {
      failed += 1;
      items.push({ assetId, title: '', before: [], after: [], status: 'failed', note: 'asset not found' });
      continue;
    }
    const before = asset.tags || [];
    let after: string[];
    if (replace !== undefined) {
      after = [...replace];
    } else {
      const kept = before.filter((entry) => !(remove || []).some((name) => tagKey(name) === tagKey(entry)));
      after = [...kept, ...(add || []).filter((name) => !kept.some((entry) => tagKey(entry) === tagKey(name)))];
    }
    if (after.length > ABILITY_ASSET_TAGS_MAX) {
      failed += 1;
      items.push({ assetId, title: asset.title, before, after, status: 'failed', note: `exceeds ${ABILITY_ASSET_TAGS_MAX} tags` });
      continue;
    }
    const same = before.length === after.length && before.every((name, index) => tagKey(name) === tagKey(after[index]));
    if (same) {
      unchanged += 1;
      items.push({ assetId, title: asset.title, before, after, status: 'unchanged' });
      continue;
    }
    try {
      await updateAbilityAsset(userId, assetId, { tags: after, reason: reasonBase, actor: options.actor || 'user' });
      updated += 1;
      items.push({ assetId, title: asset.title, before, after, status: 'updated' });
    } catch (error) {
      failed += 1;
      items.push({
        assetId,
        title: asset.title,
        before,
        after,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { total: assetIds.length, updated, unchanged, failed, items };
}

function levenshteinRatio(left: string, right: string): number {
  if (left === right) return 1;
  const a = [...left];
  const b = [...right];
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** 同义合并建议（只读；**只建议不合并**，spec US-201）。纯字符串层面：
 *  aliases 命中 + 名字相似度，不调模型。按 相似度倒序 → 源名 → 目标名 稳定排序。 */
export async function suggestMerges(
  userId: string,
  options: { max?: number; minSimilarity?: number } = {},
): Promise<AbilityTagMergeSuggestion[]> {
  const max = options.max ?? ABILITY_TAG_SUGGESTION_MAX;
  const minSimilarity = options.minSimilarity ?? 0.6;
  const records = (await listTagRecords(userId)).filter((record) => record.state === 'active');
  const suggestions: Array<AbilityTagMergeSuggestion & { score: number }> = [];
  for (const source of records) {
    for (const target of records) {
      if (source.id === target.id) continue;
      const aliasHit = (source.aliases || []).some((alias) => tagKey(alias) === tagKey(target.name));
      const similarity = levenshteinRatio(tagKey(source.name), tagKey(target.name));
      if (aliasHit) {
        suggestions.push({ sourceName: source.name, targetName: target.name, reason: 'alias', score: 1 });
      } else if (similarity >= minSimilarity) {
        suggestions.push({ sourceName: source.name, targetName: target.name, reason: 'similar', score: similarity });
      }
    }
  }
  return suggestions
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.sourceName !== right.sourceName) return left.sourceName < right.sourceName ? -1 : 1;
      return left.targetName < right.targetName ? -1 : 1;
    })
    .slice(0, Math.max(0, Math.floor(max)))
    .map(({ sourceName, targetName, reason }) => ({ sourceName, targetName, reason }));
}

/**
 * 「无孤儿标签」一致性校验（只读，可被判据使用）。两个可校验形态
 * （data-model §6.1 不变量）：
 *   ① 资产引用的每个名字都有 active 库条目（按可变更资产集算，见 tagMutableAssets）；
 *   ② active 条目的 name 全库唯一（大小写不敏感）。
 */
export async function verifyNoOrphans(userId: string): Promise<AbilityTagOrphanReport> {
  const records = await listTagRecords(userId);
  const activeByKey = new Map<string, AbilityTagRecord[]>();
  for (const record of records) {
    if (record.state !== 'active') continue;
    const key = tagKey(record.name);
    const bucket = activeByKey.get(key) || [];
    bucket.push(record);
    activeByKey.set(key, bucket);
  }
  const duplicateActiveNames = [...activeByKey.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([, bucket]) => bucket.map((record) => record.name).join(' / '));
  const assets = tagMutableAssets(await listAssetsForTagDerivation(userId));
  const orphanByName = new Map<string, string[]>();
  for (const asset of assets) {
    for (const name of asset.tags || []) {
      if (activeByKey.has(tagKey(name))) continue;
      const ids = orphanByName.get(name) || [];
      ids.push(asset.id);
      orphanByName.set(name, ids);
    }
  }
  const orphans = [...orphanByName.entries()].map(([name, assetIds]) => ({ name, assetIds }));
  return { ok: orphans.length === 0 && duplicateActiveNames.length === 0, orphans, duplicateActiveNames };
}
