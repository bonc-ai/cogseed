/**
 * 正式资产的唯一读边界（canonical read boundary）。
 *
 * 规则：凡是「正式资产列表 / 资产详情 / runtime 注入 / timeline / maturity」
 * 需要读资产，都必须经过这里，不再各自调 `listAbilityAssets`。
 *
 * 这一层保证一件事，且只保证这一件事：**出去的每一条都是四类正式资产**。
 * 支撑对象（Personal Ontology 分组、Memory、Evidence、Receipt、
 * RelationshipAssertion、Workspace state、原始文件）进不来，所以调用方不需要
 * 再自己判断"这条是不是真资产"——过去渲染层靠 `source === 'recall_ability_asset'`
 * 辨真假，就是因为这层边界不存在。
 *
 * 过渡期设计：底层仍然读现有的 `RecallAbilityAssetRecord`，不做数据迁移。
 * 以后换存储只需要改这个文件。
 */

import { createLogger } from '../../../logger';
import { listAbilityAssets, listAbilityAssetsForSpace, readAbilityAsset } from '../asset-service';
import { listAbilityAssetTimeline, listRecallTimeline, type RecallAssetTimelineItem } from '../timeline-service';
import type { RecallAbilityAssetRecord } from '../candidate-service';
import {
  isFormalAssetType,
  type FormalAbilityAsset,
  type FormalAssetPayload,
  type ListFormalAssetsFilter,
} from './types';

const log = createLogger('recall.formal-assets');

function payloadFor(record: RecallAbilityAssetRecord): FormalAssetPayload {
  switch (record.type) {
    case 'skill_method':
      return { kind: 'skill_method' };
    case 'personal':
      return { kind: 'personal' };
    case 'template':
      return { kind: 'template' };
    default:
      return { kind: 'rule' };
  }
}

/** 底层记录 → 规范信封。只做形状转换，不做过滤判断（过滤在 list 里统一做）。 */
export function toFormalAsset(record: RecallAbilityAssetRecord): FormalAbilityAsset {
  return {
    assetId: record.id,
    assetType: record.type,
    owner: record.ownerId,
    version: record.version,
    lifecycleStatus: record.lifecycleStatus,
    maturity: record.maturity,
    status: record.status,
    title: record.title,
    statement: record.statement,
    scope: record.scope,
    ...(record.applicableWhen ? { applicableWhen: record.applicableWhen } : {}),
    ...(record.forbiddenWhen ? { forbiddenWhen: record.forbiddenWhen } : {}),
    ...(record.sensitivity ? { sensitivity: record.sensitivity } : {}),
    ...(record.spaceId ? { sourceWorkspaceRef: record.spaceId } : {}),
    evidenceRefs: record.evidenceRefs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    payload: payloadFor(record),
    record,
  };
}

/** canonical 边界：非四类的一律挡在外面并留痕，不静默丢弃。 */
function keepFormalOnly(records: RecallAbilityAssetRecord[]): RecallAbilityAssetRecord[] {
  const kept: RecallAbilityAssetRecord[] = [];
  const rejected: string[] = [];
  for (const record of records) {
    if (isFormalAssetType(record?.type)) kept.push(record);
    else rejected.push(String(record?.id || '(unknown)'));
  }
  if (rejected.length) {
    log.warn('non-formal records rejected at the formal asset boundary', {
      count: rejected.length,
      assetIds: rejected.slice(0, 10),
    });
  }
  return kept;
}

export async function listFormalAssets(
  userId: string,
  filter: ListFormalAssetsFilter = {},
): Promise<FormalAbilityAsset[]> {
  const raw = filter.spaceId
    ? await listAbilityAssetsForSpace(userId, filter.spaceId)
    : await listAbilityAssets(userId);
  let records = keepFormalOnly(raw);
  if (filter.assetType) records = records.filter((record) => record.type === filter.assetType);
  if (filter.activeOnly) records = records.filter((record) => record.status === 'active');
  return records.map(toFormalAsset);
}

/** 读单条。不是正式资产就当作不存在——调用方不该拿到支撑对象。 */
export async function getFormalAsset(
  userId: string,
  assetId: string,
): Promise<FormalAbilityAsset | undefined> {
  let record: RecallAbilityAssetRecord;
  try {
    record = await readAbilityAsset(userId, assetId);
  } catch {
    return undefined;
  }
  if (!isFormalAssetType(record?.type)) {
    log.warn('non-formal record requested through the formal asset boundary', { assetId });
    return undefined;
  }
  return toFormalAsset(record);
}

/** 事实链。传 assetId 取单条资产的链，不传取全局最近的。 */
export async function listFormalAssetTimeline(
  userId: string,
  assetId?: string,
  limit?: number,
): Promise<RecallAssetTimelineItem[]> {
  if (assetId) {
    const asset = await getFormalAsset(userId, assetId);
    if (!asset) return [];
    return listAbilityAssetTimeline(userId, assetId);
  }
  return listRecallTimeline(userId, limit);
}
