import { listAbilityAssets } from './asset-service';
import type { AbilityAssetRelationKind } from './asset-relations';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import { RECALL_SCHEMA_VERSION, type RecallJsonRecord } from './types';

export const COGNITION_TREE_CONTRACT = 'ability_asset_relations';
export const COGNITION_TREE_CONTRACT_VERSION = 1;

export type CognitionTreeNodeId = `asset:${string}`;

/**
 * The cognition tree is an asset relationship projection, not a second copy of
 * the evidence/candidate/usage lifecycle. Provenance stays on the asset record
 * (`evidenceRefs`, `derivedFrom`, `sourceSessionIds`) for its future consumers.
 */
export interface CognitionTreeNode {
  id: CognitionTreeNodeId;
  type: 'asset';
  assetType: RecallAbilityAssetRecord['type'];
  label: string;
  status: RecallAbilityAssetRecord['status'];
  maturity: RecallAbilityAssetRecord['maturity'];
  version: string;
}

export interface CognitionTreeEdge {
  from: CognitionTreeNodeId;
  to: CognitionTreeNodeId;
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

function nodeId(assetId: string): CognitionTreeNodeId {
  return `asset:${assetId}`;
}

function isNodeId(value: unknown): value is CognitionTreeNodeId {
  return typeof value === 'string' && /^asset:[A-Za-z0-9_-]+$/.test(value);
}

function isCognitionTreeNode(value: unknown): value is CognitionTreeNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return isNodeId(node.id)
    && node.type === 'asset'
    && ASSET_TYPES.has(node.assetType as RecallAbilityAssetRecord['type'])
    && typeof node.label === 'string'
    && ASSET_STATUSES.has(node.status as RecallAbilityAssetRecord['status'])
    && ASSET_MATURITIES.has(node.maturity as RecallAbilityAssetRecord['maturity'])
    && typeof node.version === 'string';
}

function isCognitionTreeEdge(value: unknown): value is CognitionTreeEdge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return isNodeId(edge.from)
    && isNodeId(edge.to)
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

export async function rebuildCognitionTree(userId: string): Promise<CognitionTreeRecord> {
  const assets = (await listAbilityAssets(userId)).sort((left, right) => left.id.localeCompare(right.id));
  const nodes: CognitionTreeNode[] = assets.map((asset) => ({
    id: nodeId(asset.id),
    type: 'asset',
    assetType: asset.type,
    label: asset.title,
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  }));
  const edges: CognitionTreeEdge[] = assets.flatMap((asset) => (
    (asset.relations ?? []).map((relation) => ({
      from: nodeId(asset.id),
      to: nodeId(relation.assetId),
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
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
  await writeRecallJsonRecord(userId, 'tree', 'graph', tree);
  return tree;
}

export async function readCognitionTree(userId: string): Promise<CognitionTreeRecord | undefined> {
  const raw = await readRecallJsonRecord(userId, 'tree', 'graph');
  if (!raw) return undefined;
  // Records written before C7 contain source/candidate/usage lifecycle nodes.
  // Rebuild those records once into the narrower asset-relation contract.
  if (!isCurrentContract(raw)) return rebuildCognitionTree(userId);
  assertCurrentTree(raw);
  return raw;
}
