import { listAbilityAssets } from './asset-service';
import type { AbilityAssetRelationKind } from './asset-relations';
import { getRecallCandidateCapabilities, type RecallCandidateDisplayState } from './candidate-capabilities';
import {
  listRecallCandidates,
  recallCandidateConflictingTypes,
  type RecallAbilityAssetRecord,
  type RecallCandidateRecord,
  type RecallCandidateRisk,
} from './candidate-service';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import { RECALL_SCHEMA_VERSION, type RecallJsonRecord } from './types';

export const COGNITION_TREE_CONTRACT = 'ability_asset_relations';
/**
 * v2（G-8）：树上除正式资产外还长「芽」——尚未晋升、但用户现在就能确认成
 * 正式资产的候选。v1 记录只有 asset 节点，读到时按下面的 `readCognitionTree`
 * 原样重投一次即可，不需要迁移器：树本来就是投影，唯一事实源仍是资产与候选
 * 记录本身，重建不会丢用户数据。
 */
export const COGNITION_TREE_CONTRACT_VERSION = 2;

export type CognitionTreeAssetNodeId = `asset:${string}`;
export type CognitionTreeCandidateNodeId = `candidate:${string}`;
export type CognitionTreeNodeId = CognitionTreeAssetNodeId | CognitionTreeCandidateNodeId;

/**
 * The cognition tree is an asset relationship projection, not a second copy of
 * the evidence/candidate/usage lifecycle. Provenance stays on the asset record
 * (`evidenceRefs`, `derivedFrom`, `sourceSessionIds`) for its future consumers.
 */
export interface CognitionTreeAssetNode {
  id: CognitionTreeAssetNodeId;
  type: 'asset';
  assetType: RecallAbilityAssetRecord['type'];
  label: string;
  status: RecallAbilityAssetRecord['status'];
  maturity: RecallAbilityAssetRecord['maturity'];
  version: string;
}

/**
 * 「芽」：还不是资产的候选。它**没有** status / maturity / version——那三个字段
 * 属于正式资产的生命周期，给候选补一份就是在图上编造一个后端不认的状态。
 * 芽携带的是候选自己的产品态（displayState / risk），消费方据此渲染「待确认」，
 * 不得把芽当资产渲染，也不得从芽进入资产编辑页。
 */
export interface CognitionTreeCandidateNode {
  id: CognitionTreeCandidateNodeId;
  type: 'candidate';
  /**
   * 挂到哪一根主枝。**只取候选自己的 `suggestedType`**：抽取管线已经定过类，
   * 树是投影层，再按 title / judgment / 关键词猜一次分类就是第二套分类事实源。
   */
  assetType: RecallAbilityAssetRecord['type'];
  label: string;
  displayState: RecallCandidateDisplayState;
  risk: RecallCandidateRisk;
}

export type CognitionTreeNode = CognitionTreeAssetNode | CognitionTreeCandidateNode;

/** 关系只存在于正式资产之间。芽不长边——候选还没有被确认的关系可言。 */
export interface CognitionTreeEdge {
  from: CognitionTreeAssetNodeId;
  to: CognitionTreeAssetNodeId;
  type: 'asset_relation';
  kind: AbilityAssetRelationKind;
  note?: string;
}

export interface CognitionTreeRecord extends RecallJsonRecord {
  id: 'graph';
  contract: typeof COGNITION_TREE_CONTRACT;
  contractVersion: typeof COGNITION_TREE_CONTRACT_VERSION;
  nodes: CognitionTreeNode[];
  edges: CognitionTreeEdge[];
  updatedAt: string;
}

const ASSET_TYPES = new Set<RecallAbilityAssetRecord['type']>([
  'personal', 'rule', 'template', 'skill_method',
]);
const ASSET_STATUSES = new Set<RecallAbilityAssetRecord['status']>([
  'active', 'paused', 'archived', 'deleted', 'purged', 'revoked',
]);
const ASSET_MATURITIES = new Set<RecallAbilityAssetRecord['maturity']>([
  'seed', 'bud', 'transfer_validated', 'effectiveness_validated',
]);
const RELATION_KINDS = new Set<AbilityAssetRelationKind>([
  'refines', 'depends_on', 'replaces', 'conflicts_with', 'related_to',
]);
const CANDIDATE_DISPLAY_STATES = new Set<RecallCandidateDisplayState>([
  'needs_review', 'weak_evidence', 'deferred', 'confirmed', 'rejected',
  'ignored', 'expired', 'failed', 'superseded', 'unknown',
]);
const CANDIDATE_RISKS = new Set<RecallCandidateRisk>(['low', 'medium', 'high']);

function assetNodeId(assetId: string): CognitionTreeAssetNodeId {
  return `asset:${assetId}`;
}

function candidateNodeId(candidateId: string): CognitionTreeCandidateNodeId {
  return `candidate:${candidateId}`;
}

function isAssetNodeId(value: unknown): value is CognitionTreeAssetNodeId {
  return typeof value === 'string' && /^asset:[A-Za-z0-9_-]+$/.test(value);
}

function isCandidateNodeId(value: unknown): value is CognitionTreeCandidateNodeId {
  return typeof value === 'string' && /^candidate:[A-Za-z0-9_-]+$/.test(value);
}

function isCognitionTreeAssetNode(node: Record<string, unknown>): node is CognitionTreeAssetNode & Record<string, unknown> {
  return isAssetNodeId(node.id)
    && ASSET_TYPES.has(node.assetType as RecallAbilityAssetRecord['type'])
    && typeof node.label === 'string'
    && ASSET_STATUSES.has(node.status as RecallAbilityAssetRecord['status'])
    && ASSET_MATURITIES.has(node.maturity as RecallAbilityAssetRecord['maturity'])
    && typeof node.version === 'string';
}

function isCognitionTreeCandidateNode(node: Record<string, unknown>): node is CognitionTreeCandidateNode & Record<string, unknown> {
  return isCandidateNodeId(node.id)
    && ASSET_TYPES.has(node.assetType as RecallAbilityAssetRecord['type'])
    && typeof node.label === 'string'
    && CANDIDATE_DISPLAY_STATES.has(node.displayState as RecallCandidateDisplayState)
    && CANDIDATE_RISKS.has(node.risk as RecallCandidateRisk);
}

function isCognitionTreeNode(value: unknown): value is CognitionTreeNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (node.type === 'asset') return isCognitionTreeAssetNode(node);
  if (node.type === 'candidate') return isCognitionTreeCandidateNode(node);
  return false;
}

function isCognitionTreeEdge(value: unknown): value is CognitionTreeEdge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return isAssetNodeId(edge.from)
    && isAssetNodeId(edge.to)
    && edge.type === 'asset_relation'
    && RELATION_KINDS.has(edge.kind as AbilityAssetRelationKind)
    && (edge.note === undefined || typeof edge.note === 'string');
}

function isCurrentContract(value: RecallJsonRecord): value is CognitionTreeRecord {
  return value.contract === COGNITION_TREE_CONTRACT
    && value.contractVersion === COGNITION_TREE_CONTRACT_VERSION;
}

function assertCurrentTree(value: RecallJsonRecord): asserts value is CognitionTreeRecord {
  if (
    value.id !== 'graph'
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isCognitionTreeNode)
    || !Array.isArray(value.edges)
    || !value.edges.every(isCognitionTreeEdge)
    || typeof value.updatedAt !== 'string'
  ) {
    throw new Error('malformed cognition tree asset relation contract');
  }
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  if (nodeIds.size !== value.nodes.length || value.edges.some((edge) => !nodeIds.has(edge.from))) {
    // A relation target may be unavailable in the local snapshot, but every
    // relation source must be one of the assets represented by this projection.
    throw new Error('malformed cognition tree asset relation contract');
  }
}

/**
 * 一条候选现在是不是「芽」。
 *
 * 判据只有一条唯一来源：`getRecallCandidateCapabilities().canPromote`。
 * 正式资产准入门槛（`validatePromotionByAssetType`）现在已经**并进**能力判据
 * 里（candidate-capabilities.ts::assessEligibility），所以这里不再自己调一次。
 * 树曾经是全仓唯一把两道闸都过一遍的地方，「待我处理」只过了前一道——同一条
 * 候选在树上不画芽、在待办里却可确认。判据统一之后这个分叉不复存在，两边
 * 消费的是同一个 canPromote。
 *
 * `conflictingTypes` 必须由调用方传：那是跨候选判断（同一句话被分成两类），
 * 单条算不出来。不传就等于树比晋升宽松，老问题原样回来。
 *
 * `failed` 例外说明：它的 `canPromote` 是 `true`（失败候选的主动作是重试，
 * 后端也确实放行晋升），但产品决定 failed 不作为芽展示——枝头的芽是「等你确认」
 * 的邀请，把一条沉淀失败的记录摆成邀请是在骗用户。它仍然在「沉淀失败的候选」
 * 分组里可见可重试，入口没有丢。
 *
 * `actor: 'user'` 对齐点击芽之后真实走的那条路（用户确认晋升）。用 'system'
 * 会把「缺边界的规则候选」判成不合格，而那条候选用户点进去确实能确认成功——
 * 树会比真实可做的事更保守，同样是撒谎。
 */
function isBudCandidate(
  candidate: RecallCandidateRecord,
  presentAssetIds: ReadonlySet<string>,
  conflictingTypes: ReadonlyMap<string, string[]>,
): boolean {
  // 已经晋升出的资产就在同一棵树上时，芽必须让位：同一条认知不能既是芽又是叶。
  if (candidate.promotedAssetId && presentAssetIds.has(candidate.promotedAssetId)) return false;
  if (candidate.status === 'failed') return false;
  return budCapabilities(candidate, conflictingTypes).canPromote;
}

/** 树上这条候选的能力投影。芽的判据与显示态都从这里取，不各算各的。 */
function budCapabilities(
  candidate: RecallCandidateRecord,
  conflictingTypes: ReadonlyMap<string, string[]>,
) {
  const conflicts = conflictingTypes.get(candidate.id);
  return getRecallCandidateCapabilities({
    ...candidate,
    ...(conflicts?.length ? { conflictingTypes: conflicts } : {}),
  });
}

function budLabel(candidate: RecallCandidateRecord): string {
  return (candidate.summary || candidate.judgment || '').trim() || candidate.id;
}

export async function rebuildCognitionTree(userId: string): Promise<CognitionTreeRecord> {
  const [allAssets, allCandidates] = await Promise.all([
    listAbilityAssets(userId),
    listRecallCandidates(userId),
  ]);
  const assets = [...allAssets].sort((left, right) => left.id.localeCompare(right.id));
  const assetIds = new Set(assets.map((asset) => asset.id));
  const assetNodes: CognitionTreeAssetNode[] = assets.map((asset) => ({
    id: assetNodeId(asset.id),
    type: 'asset',
    assetType: asset.type,
    label: asset.title,
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  }));
  // 跨候选的分类冲突：与晋升闸门、inbox 用同一个计算，算一次传下去。
  const conflictingTypes = recallCandidateConflictingTypes(allCandidates);
  const candidateNodes: CognitionTreeCandidateNode[] = [...allCandidates]
    .filter((candidate) => isBudCandidate(candidate, assetIds, conflictingTypes))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => ({
      id: candidateNodeId(candidate.id),
      type: 'candidate',
      assetType: candidate.suggestedType,
      label: budLabel(candidate),
      displayState: budCapabilities(candidate, conflictingTypes).displayState,
      risk: candidate.risk,
    }));
  const edges: CognitionTreeEdge[] = assets.flatMap((asset) => (
    (asset.relations ?? []).map((relation) => ({
      from: assetNodeId(asset.id),
      to: assetNodeId(relation.assetId),
      type: 'asset_relation' as const,
      kind: relation.kind,
      ...(relation.note ? { note: relation.note } : {}),
    }))
  ));

  const tree: CognitionTreeRecord = {
    schemaVersion: RECALL_SCHEMA_VERSION,
    ownerId: userId,
    id: 'graph',
    contract: COGNITION_TREE_CONTRACT,
    contractVersion: COGNITION_TREE_CONTRACT_VERSION,
    nodes: [...assetNodes, ...candidateNodes],
    edges,
    updatedAt: new Date().toISOString(),
  };
  await writeRecallJsonRecord(userId, 'tree', 'graph', tree);
  return tree;
}

export async function readCognitionTree(userId: string): Promise<CognitionTreeRecord | undefined> {
  const raw = await readRecallJsonRecord(userId, 'tree', 'graph');
  if (!raw) return undefined;
  // Records written before C7 contain source/candidate/usage lifecycle nodes;
  // records written before G-8 (contractVersion 1) carry no candidate buds.
  // Both are re-projected once from the assets/candidates that own the facts.
  if (!isCurrentContract(raw)) return rebuildCognitionTree(userId);
  assertCurrentTree(raw);
  return raw;
}
