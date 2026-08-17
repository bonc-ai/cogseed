/**
 * 正式资产的版本比对。
 *
 * 「版本与治理」此前只能列出版本号和时间，回答不了用户真正要问的那句话：
 * **这一版到底改了什么。** 没有这个答案，"回滚到此版本"就是一次盲赌。
 *
 * 数据是现成的：`AbilityAssetVersionRecord.snapshot` 每一版都存了完整内容
 * （title / statement / scope / applicableWhen / forbiddenWhen / sensitivity /
 * evidenceRefs …），所以这里不需要新增任何持久化，只做纯比对。
 *
 * 比对的粒度按「用户要为什么事负责」来分，不是按字段数量：
 *   - 作用边界变了，意味着这条资产从今往后会进入/退出一批任务；
 *   - 敏感级升了，意味着它能去的地方变了；
 *   - 正文变了，意味着它主张的内容变了。
 * 这三类必须能各自被识别出来，因为待办里对应三种不同的决定。
 */

import type { AbilityAssetVersionRecord } from '../asset-service';

/** 一次变更影响的是哪一面。用户按这个分类决定要不要管。 */
export type AssetChangeKind =
  /** 适用/禁止范围变了：它会进入或退出一批任务。 */
  | 'boundary'
  /** 正文主张变了。 */
  | 'statement'
  /** 标题变了（只影响识别，不影响行为）。 */
  | 'title'
  /** 作用域变了。 */
  | 'scope'
  /** 敏感级变了。升档单独用 sensitivity_escalated 表示。 */
  | 'sensitivity'
  /** 敏感级**升高**：能去的地方变多了，属于扩权。 */
  | 'sensitivity_escalated'
  /** 证据集合变了。 */
  | 'evidence'
  /** 成熟度变了。 */
  | 'maturity'
  /** 治理状态变了。 */
  | 'status';

export interface AssetFieldChange {
  kind: AssetChangeKind;
  field: string;
  /** 已格式化成可读文本；渲染层直接显示，不再解析结构。 */
  before: string;
  after: string;
}

export interface AssetVersionDiff {
  assetId: string;
  fromVersion: string;
  toVersion: string;
  at: string;
  reason?: string;
  actor?: AbilityAssetVersionRecord['actor'];
  changes: AssetFieldChange[];
  /** 本次变更涉及的分类，去重后按 CHANGE_ORDER 排序，便于一眼看出性质。 */
  kinds: AssetChangeKind[];
}

type Snapshot = AbilityAssetVersionRecord['snapshot'];

/** 敏感级从低到高。缺失不参与比较——未分级不是一个档位。 */
const SENSITIVITY_RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** 影响面从大到小：先说"它会不会进入别的任务"，再说"它说了什么"。 */
const CHANGE_ORDER: AssetChangeKind[] = [
  'sensitivity_escalated',
  'boundary',
  'scope',
  'sensitivity',
  'statement',
  'evidence',
  'maturity',
  'status',
  'title',
];

const EMPTY = '—';

function textOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return EMPTY;
  return String(value);
}

/** 条件列表按集合语义比较：顺序变化不算改动，否则会报一堆假变更。 */
function listOf(value: readonly string[] | undefined): string {
  const items = [...new Set((value || []).map((entry) => String(entry).trim()).filter(Boolean))].sort();
  return items.length ? items.join('、') : EMPTY;
}

function evidenceOf(refs: Snapshot['evidenceRefs'] | undefined): string {
  const ids = [...new Set((refs || []).map((ref) => `${ref.kind}:${ref.id}`))].sort();
  return ids.length ? String(ids.length) : EMPTY;
}

function push(
  changes: AssetFieldChange[],
  kind: AssetChangeKind,
  field: string,
  before: string,
  after: string,
): void {
  if (before === after) return;
  changes.push({ kind, field, before, after });
}

/**
 * 比对两个快照。`previous` 为 undefined 表示这是第一版——第一版不产生 diff，
 * 因为"从无到有"没有可对比的前一版，谎称它改了每一个字段只会制造噪音。
 */
export function diffAssetSnapshots(previous: Snapshot | undefined, next: Snapshot): AssetFieldChange[] {
  if (!previous) return [];
  const changes: AssetFieldChange[] = [];

  push(changes, 'title', 'title', textOf(previous.title), textOf(next.title));
  push(changes, 'statement', 'statement', textOf(previous.statement), textOf(next.statement));
  push(changes, 'scope', 'scope', textOf(previous.scope), textOf(next.scope));
  push(changes, 'boundary', 'applicableWhen', listOf(previous.applicableWhen), listOf(next.applicableWhen));
  push(changes, 'boundary', 'forbiddenWhen', listOf(previous.forbiddenWhen), listOf(next.forbiddenWhen));
  push(changes, 'evidence', 'evidenceRefs', evidenceOf(previous.evidenceRefs), evidenceOf(next.evidenceRefs));
  push(changes, 'maturity', 'maturity', textOf(previous.maturity), textOf(next.maturity));
  push(changes, 'status', 'status', textOf(previous.status), textOf(next.status));

  // 敏感级：只有确实升高才叫扩权。降级和"从未分级变成已分级"都不是。
  const before = textOf(previous.sensitivity);
  const after = textOf(next.sensitivity);
  if (before !== after) {
    const beforeRank = SENSITIVITY_RANK[before];
    const afterRank = SENSITIVITY_RANK[after];
    const escalated = beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank;
    changes.push({
      kind: escalated ? 'sensitivity_escalated' : 'sensitivity',
      field: 'sensitivity',
      before,
      after,
    });
  }

  return changes;
}

/**
 * 把版本序列变成相邻两版之间的 diff 列表，最新的在前。
 *
 * 入参按 `at` 升序或乱序都可以——这里自己排。版本号是 `nextVersion` 递增的
 * 字符串，不保证字典序可比，所以以时间为准。
 */
export function buildAssetVersionDiffs(
  assetId: string,
  versions: readonly AbilityAssetVersionRecord[],
): AssetVersionDiff[] {
  const ordered = [...versions].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const diffs: AssetVersionDiff[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const changes = diffAssetSnapshots(previous.snapshot, current.snapshot);
    if (!changes.length) continue;
    const kinds = CHANGE_ORDER.filter((kind) => changes.some((change) => change.kind === kind));
    diffs.push({
      assetId,
      fromVersion: previous.version,
      toVersion: current.version,
      at: current.at,
      ...(current.reason ? { reason: current.reason } : {}),
      ...(current.actor ? { actor: current.actor } : {}),
      changes,
      kinds,
    });
  }
  return diffs.reverse();
}

/** 最近一次真正改了内容的版本变更。没有历史或没有变化时返回 undefined。 */
export function latestAssetVersionDiff(
  assetId: string,
  versions: readonly AbilityAssetVersionRecord[],
): AssetVersionDiff | undefined {
  return buildAssetVersionDiffs(assetId, versions)[0];
}
