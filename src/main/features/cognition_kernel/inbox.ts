/**
 * cognition_kernel/inbox — 合并收件箱。
 *
 * 现在用户有两个收件箱（资产的「待我处理」+ 本体页里的候选横幅），同一件事两处
 * 可见、状态还可能不一样。本模块把两个池合成**一个队列**：用户只有一个收件箱，
 * 每条仍带 home 标记，落地时走各自的治理通道（本模块只读，不做治理动作）。
 *
 * 归属判定复用 routing.ts 的口径：本体候选 kind='rule' → 规则，其余 → 关于我；
 * 资产候选按 suggestedType 映射。界面因此可以用同一套标签显示两类候选。
 */

import type { InboxHome, InboxItemKind } from './types';

export interface InboxItem {
  /** 归一 id：两个池各自带前缀，合并后不会碰撞。 */
  id: string;
  home: InboxHome;
  title: string;
  detail?: string;
  kind: InboxItemKind;
  /** 原始类型标记（本体候选 kind / 资产候选 suggestedType），排查用。 */
  rawKind: string;
  source: string;
  createdAt: string;
  confidence?: string;
  suggestedAction?: string;
  risk?: string;
  /**
   * 回流候选的源资产已不存在（被删除/清除）。
   * 源资产清除后，`asset-backflow-<id>` 候选可能仍留在池中。
   * 此标记让界面说明来源已失效，不把这类建议呈现为仍有有效依据。
   */
  staleSource?: true;
}

export interface MergedInbox {
  items: InboxItem[];
  counts: { total: number; ontology: number; recall: number };
}

/** 一次最多交给界面多少条（全量仍在两个池里，收件箱只做"先看这些"）。 */
export const INBOX_LIMIT = 200;

const ONTOLOGY_KIND_TO_FORM: Record<string, InboxItemKind> = {
  rule: 'rule',
  preference: 'personal_fact',
  instance: 'personal_fact',
  attribute: 'personal_fact',
  relation: 'personal_fact',
  fact: 'personal_fact',
};

const ASSET_TYPE_TO_FORM: Record<string, InboxItemKind> = {
  cognition: 'cognition',
  personal: 'personal_fact',
  rule: 'rule',
  template: 'template',
  skill_method: 'method',
  fact: 'task_local',
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/** 终态候选不进收件箱（已在别处落地/被拒/过期）。 */
const TERMINAL_RECALL_STATUSES = new Set(['confirmed', 'rejected', 'ignored', 'expired', 'failed', 'superseded']);

/**
 * 这条资产候选是否还在等人处理。
 * 优先用服务侧算好的 capabilities.needsUserAction（尊重休眠/冷却），拿不到时
 * 退回状态判定——宁可多给一条，也不静默吞掉用户该看到的东西。
 */
function awaitsUserAction(candidate: Record<string, unknown>): boolean {
  const capabilities = candidate.capabilities as { needsUserAction?: unknown } | undefined;
  if (capabilities && typeof capabilities.needsUserAction === 'boolean') return capabilities.needsUserAction;
  const status = text(candidate.status);
  if (!status) return true;
  return !TERMINAL_RECALL_STATUSES.has(status);
}

/** 纯函数：把两个池的记录归一成一个队列（按时间倒序）。 */
/** 回流候选的幂等键前缀：candidate_id = asset-backflow-<assetId>。 */
const BACKFLOW_PREFIX = 'asset-backflow-';

/** 仍算"存在"的资产状态（deleted/purged/revoked 视为来源已消失）。 */
const EXISTING_ASSET_STATUSES = new Set(['active', 'paused', 'archived']);

export function buildMergedInbox(input: {
  ontologyCandidates: readonly unknown[];
  recallCandidates: readonly unknown[];
  /** 仍在库里的资产 id；给了才会标记 staleSource（没给＝不判断，不误标）。 */
  existingAssetIds?: ReadonlySet<string>;
}): MergedInbox {
  const items: InboxItem[] = [];

  for (const raw of input.ontologyCandidates ?? []) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = text(c.candidate_id) || text(c.id);
    if (!id) continue;
    const rawKind = text(c.kind) || 'unknown';
    const backflowAssetId = id.startsWith(BACKFLOW_PREFIX) ? id.slice(BACKFLOW_PREFIX.length) : '';
    const staleSource = Boolean(backflowAssetId && input.existingAssetIds && !input.existingAssetIds.has(backflowAssetId));
    items.push({
      id: 'onto:' + id,
      home: 'ontology',
      ...(staleSource ? { staleSource: true as const } : {}),
      title: text(c.summary) || text(c.memory_text) || '（无摘要）',
      ...(text(c.diff_summary) ? { detail: text(c.diff_summary) } : {}),
      kind: ONTOLOGY_KIND_TO_FORM[rawKind] ?? 'personal_fact',
      rawKind,
      source: text(c.write_actor) ? 'ontology:' + text(c.write_actor) : 'ontology',
      createdAt: text(c.recorded_time),
      ...(text(c.confidence) ? { confidence: text(c.confidence) } : {}),
    });
  }

  for (const raw of input.recallCandidates ?? []) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = text(c.id);
    if (!id) continue;
    if (!awaitsUserAction(c)) continue;
    const rawKind = text(c.suggestedType) || 'unknown';
    items.push({
      id: 'recall:' + id,
      home: 'recall',
      title: text(c.summary) || text(c.judgment) || '（无摘要）',
      ...(text(c.value) ? { detail: text(c.value) } : {}),
      kind: ASSET_TYPE_TO_FORM[rawKind] ?? 'unknown',
      rawKind,
      source: text(c.origin) || 'capture',
      createdAt: text(c.createdAt),
      ...(text(c.risk) ? { risk: text(c.risk) } : {}),
      ...(text(c.suggestedAction) ? { suggestedAction: text(c.suggestedAction) } : {}),
    });
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ontology = items.filter((i) => i.home === 'ontology').length;
  return {
    items: items.slice(0, INBOX_LIMIT),
    counts: { total: items.length, ontology, recall: items.length - ontology },
  };
}

/** 装配层：读两个候选池（只读）。 */
export async function readMergedInbox(uid: string): Promise<MergedInbox> {
  if (!uid) return { items: [], counts: { total: 0, ontology: 0, recall: 0 } };
  const [{ listCandidates }, { listRecallCandidates }, { listAbilityAssets }] = await Promise.all([
    import('../personal_ontology_candidates'),
    import('../recall/candidate-service'),
    import('../recall/asset-service'),
  ]);
  const ontologyRaw = (await listCandidates(uid)) as unknown;
  const ontologyCandidates = Array.isArray(ontologyRaw)
    ? ontologyRaw
    : ((ontologyRaw as { candidates?: unknown[] } | null)?.candidates ?? []);
  const recallCandidates = await listRecallCandidates(uid);

  // 回流候选的源资产是否还在：用于标记"来源已删除"的死候选。
  let existingAssetIds: Set<string> | undefined;
  try {
    const assets = await listAbilityAssets(uid);
    existingAssetIds = new Set(
      assets.filter((asset) => EXISTING_ASSET_STATUSES.has(String(asset.status ?? ''))).map((asset) => asset.id),
    );
  } catch {
    existingAssetIds = undefined; // 读不到就不判断，宁可不标也不误标
  }

  return buildMergedInbox({ ontologyCandidates, recallCandidates, ...(existingAssetIds ? { existingAssetIds } : {}) });
}
