/**
 * 正式资产的版本比对。
 *
 * 「版本与治理」此前只能列出版本号和时间，回答不了用户真正要问的那句话：
 * **这一版到底改了什么。** 没有这个答案，"回滚到此版本"就是一次盲赌。
 *
 * 数据是现成的：`AbilityAssetVersionRecord.snapshot` 每一版都存了完整内容
 * （title / statement / scope / applicableWhen / forbiddenWhen /
 * evidenceRefs …），所以这里不需要新增任何持久化，只做纯比对。
 *
 * 标签（tags）是元数据，**不进版本 diff**：标签改动不 bump 内容版本
 * （specs/012 data-model §3，对齐 familyName 先例），版本链只记内容；
 * 快照本身也不含 tags（见 asset-service 的 snapshot()）。
 *
 * 比对的粒度按「用户要为什么事负责」来分，不是按字段数量：
 *   - 作用边界变了，意味着这条资产从今往后会进入/退出一批任务；
 *   - 正文变了，意味着它主张的内容变了。
 * 这两类必须能各自被识别出来，因为待办里对应两种不同的决定。
 */

import type { AbilityAssetVersionRecord } from '../asset-service';

/** 一次变更影响的是哪一面。用户按这个分类决定要不要管。 */
export type AssetChangeKind =
  /** 资产类别变了：换类意味着进入哪条投影、参与哪类任务全变。 */
  | 'type'
  /** 适用/禁止范围变了：它会进入或退出一批任务。 */
  | 'boundary'
  /** 正文主张变了。 */
  | 'statement'
  /** 标题变了（只影响识别，不影响行为）。 */
  | 'title'
  /** 作用域变了。 */
  | 'scope'
  /** 证据集合变了。 */
  | 'evidence'
  /** 成熟度变了。 */
  | 'maturity'
  /** 治理状态变了。 */
  | 'status'
  /** 其余快照键变了（P-r1-22 兜底）：不显式归类，但保证任何真实变化
   *  都不再让版本被整体跳过（跳版=待办漏报+版本页缺行）。 */
  | 'other';

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

/** 影响面从大到小：先说"它会不会进入别的任务"，再说"它说了什么"。 */
const CHANGE_ORDER: AssetChangeKind[] = [
  'type',
  'boundary',
  'scope',
  'statement',
  'evidence',
  'maturity',
  'status',
  'title',
  'other',
];

/** 已显式比对的快照键（P-r1-22）：其余键走「其他变更」兜底。
 *  version 不在其中——它是版本号本身，每版必变，比它等于谎称每版都有变更。 */
const EXPLICIT_SNAPSHOT_KEYS = new Set([
  'title',
  'statement',
  'type',
  'scope',
  'scopePolicy',
  'applicableWhen',
  'forbiddenWhen',
  'evidenceRefs',
  'maturity',
  'status',
  'version',
]);

const EMPTY = '—';

/** 兜底键的可读摘要：对象/数组稳定序列化后截断，undefined/null 归为空。 */
function briefOf(value: unknown): string {
  if (value === undefined || value === null) return EMPTY;
  if (typeof value === 'string') return value || EMPTY;
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  return text || EMPTY;
}

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

  push(changes, 'type', 'type', textOf(previous.type), textOf(next.type));
  push(changes, 'title', 'title', textOf(previous.title), textOf(next.title));
  push(changes, 'statement', 'statement', textOf(previous.statement), textOf(next.statement));
  push(changes, 'scope', 'scope', textOf(previous.scope), textOf(next.scope));
  push(changes, 'scope', 'scopePolicy', briefOf(previous.scopePolicy), briefOf(next.scopePolicy));
  push(changes, 'boundary', 'applicableWhen', listOf(previous.applicableWhen), listOf(next.applicableWhen));
  push(changes, 'boundary', 'forbiddenWhen', listOf(previous.forbiddenWhen), listOf(next.forbiddenWhen));
  push(changes, 'evidence', 'evidenceRefs', evidenceOf(previous.evidenceRefs), evidenceOf(next.evidenceRefs));
  push(changes, 'maturity', 'maturity', textOf(previous.maturity), textOf(next.maturity));
  push(changes, 'status', 'status', textOf(previous.status), textOf(next.status));

  // P-r1-22 兜底：快照实存 17 键，显式比对只覆盖行为字段。此前仅改
  // scopePolicy/type 等字段的版本 diff 为空、被整体跳过——待办漏报、
  // 版本页跳版。其余键逐个稳定序列化比较，有变化就归「其他变更」，
  // 不再让任何真实变化静默。
  const seen = new Set<string>();
  for (const key of [...Object.keys(previous), ...Object.keys(next)]) {
    if (seen.has(key) || EXPLICIT_SNAPSHOT_KEYS.has(key)) continue;
    seen.add(key);
    push(changes, 'other', key, briefOf((previous as Record<string, unknown>)[key]), briefOf((next as Record<string, unknown>)[key]));
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
