import type { AbilityAssetRelationKind } from './asset-relations';
import type { RecallAbilityAssetRecord } from './candidate-service';

export type OntologyAssetQueryDirection = 'incoming' | 'outgoing' | 'both';

export interface OntologyAssetQueryRequest {
  query: string;
  target?: string;
  relationKind?: AbilityAssetRelationKind;
  /** Optional bounded relation allow-list used by automatic expansion. */
  relationKinds?: readonly AbilityAssetRelationKind[];
  direction?: OntologyAssetQueryDirection;
  maxHops?: number;
  limit?: number;
}

export interface OntologyAssetQueryIntent {
  target: string;
  relationKind?: AbilityAssetRelationKind;
  direction: OntologyAssetQueryDirection;
  maxHops: number;
}

export interface OntologyAssetQueryEvidenceEdge {
  fromAssetId: string;
  fromTitle: string;
  kind: AbilityAssetRelationKind;
  toAssetId: string;
  toTitle: string;
}

export interface OntologyAssetQueryMatch {
  asset: Pick<RecallAbilityAssetRecord, 'id' | 'title' | 'type' | 'scope' | 'maturity' | 'version' | 'activeVersion'>;
  distance: number;
  evidencePath: OntologyAssetQueryEvidenceEdge[];
}

export type OntologyAssetQueryResult =
  | {
    status: 'ok';
    intent: OntologyAssetQueryIntent;
    target: Pick<RecallAbilityAssetRecord, 'id' | 'title' | 'type' | 'scope' | 'maturity' | 'version' | 'activeVersion'>;
    matches: OntologyAssetQueryMatch[];
    truncated: boolean;
  }
  | {
    status: 'target_not_found';
    intent: OntologyAssetQueryIntent;
    candidates: [];
  }
  | {
    status: 'target_ambiguous';
    intent: OntologyAssetQueryIntent;
    candidates: Array<Pick<RecallAbilityAssetRecord, 'id' | 'title' | 'type' | 'scope'>>;
  };

const RELATION_KINDS = new Set<AbilityAssetRelationKind>([
  'refines',
  'depends_on',
  'replaces',
  'conflicts_with',
  'related_to',
  'same_family',
]);

const MAX_HOPS = 4;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function compact(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanTarget(value: string): string {
  return compact(value)
    .replace(/^[：:，,。；;\s]+|[？?！!。；;\s]+$/gu, '')
    .replace(/^[「“"'`]|[」”"'`]$/gu, '')
    .trim();
}

function normalizeLookup(value: string): string {
  return cleanTarget(value).toLocaleLowerCase().replace(/[\s：:，,。；;！？?!「」“”"'`_-]+/gu, '');
}

interface ParsedPattern {
  pattern: RegExp;
  relationKind?: AbilityAssetRelationKind;
  direction: OntologyAssetQueryDirection;
}

const QUERY_PATTERNS: readonly ParsedPattern[] = [
  { pattern: /^哪些(?:认知|能力)?资产(?:直接|间接)?依赖(?:于)?\s*(.+)$/u, relationKind: 'depends_on', direction: 'incoming' },
  { pattern: /^(.+?)被哪些(?:认知|能力)?资产(?:直接|间接)?依赖$/u, relationKind: 'depends_on', direction: 'incoming' },
  { pattern: /^(.+?)(?:依赖于|依赖)(?:哪些|什么)(?:认知|能力)?资产$/u, relationKind: 'depends_on', direction: 'outgoing' },
  { pattern: /^(.+?)的(?:直接|间接)?依赖(?:有哪些|是什么|是哪些)?$/u, relationKind: 'depends_on', direction: 'outgoing' },
  { pattern: /^哪些(?:认知|能力)?资产(?:可以)?替代\s*(.+)$/u, relationKind: 'replaces', direction: 'incoming' },
  { pattern: /^(.+?)替代(?:哪些|什么)(?:认知|能力)?资产$/u, relationKind: 'replaces', direction: 'outgoing' },
  { pattern: /^(?:哪些(?:认知|能力)?资产)?(?:与|和)\s*(.+?)\s*(?:存在)?冲突$/u, relationKind: 'conflicts_with', direction: 'both' },
  { pattern: /^与\s*(.+?)\s*冲突的(?:认知|能力)?资产(?:有哪些)?$/u, relationKind: 'conflicts_with', direction: 'both' },
  { pattern: /^哪些(?:认知|能力)?资产(?:细化|完善)\s*(.+)$/u, relationKind: 'refines', direction: 'incoming' },
  { pattern: /^(.+?)(?:细化|完善)(?:哪些|什么)(?:认知|能力)?资产$/u, relationKind: 'refines', direction: 'outgoing' },
  { pattern: /^与\s*(.+?)\s*相关的(?:认知|能力)?资产(?:有哪些)?$/u, relationKind: 'related_to', direction: 'both' },
  { pattern: /^(?:what|which)\s+(?:assets?\s+)?depends?\s+on\s+(.+)$/iu, relationKind: 'depends_on', direction: 'incoming' },
  { pattern: /^what\s+does\s+(.+?)\s+depend\s+on$/iu, relationKind: 'depends_on', direction: 'outgoing' },
];

export function parseOntologyAssetQuery(request: OntologyAssetQueryRequest): OntologyAssetQueryIntent {
  const query = compact(request.query).slice(0, 500);
  let target = cleanTarget(request.target || '');
  let inferredRelation: AbilityAssetRelationKind | undefined;
  let inferredDirection: OntologyAssetQueryDirection = 'both';

  if (!target) {
    for (const entry of QUERY_PATTERNS) {
      const match = query.match(entry.pattern);
      if (!match?.[1]) continue;
      target = cleanTarget(match[1]);
      inferredRelation = entry.relationKind;
      inferredDirection = entry.direction;
      break;
    }
  }

  if (!target) target = cleanTarget(query);
  const relationKind = request.relationKind && RELATION_KINDS.has(request.relationKind)
    ? request.relationKind
    : inferredRelation;
  const maxHops = Math.min(MAX_HOPS, Math.max(1, Math.floor(Number(request.maxHops) || 1)));
  return {
    target,
    ...(relationKind ? { relationKind } : {}),
    direction: request.direction || inferredDirection,
    maxHops,
  };
}

function publicAsset(asset: RecallAbilityAssetRecord) {
  return {
    id: asset.id,
    title: asset.title,
    type: asset.type,
    scope: asset.scope,
    maturity: asset.maturity,
    version: asset.version,
    activeVersion: asset.activeVersion,
  };
}

function resolveTarget(
  assets: readonly RecallAbilityAssetRecord[],
  targetText: string,
): { target?: RecallAbilityAssetRecord; ambiguous: RecallAbilityAssetRecord[] } {
  const raw = cleanTarget(targetText);
  const byId = assets.find((asset) => asset.id === raw);
  if (byId) return { target: byId, ambiguous: [] };

  const needle = normalizeLookup(raw);
  if (!needle) return { ambiguous: [] };
  const scored = assets.flatMap((asset) => {
    const title = normalizeLookup(asset.title);
    if (!title) return [];
    const score = title === needle ? 3 : title.startsWith(needle) || needle.startsWith(title) ? 2 : title.includes(needle) ? 1 : 0;
    return score ? [{ asset, score }] : [];
  });
  if (!scored.length) return { ambiguous: [] };
  const best = Math.max(...scored.map((item) => item.score));
  const candidates = scored.filter((item) => item.score === best).map((item) => item.asset);
  return candidates.length === 1 ? { target: candidates[0], ambiguous: [] } : { ambiguous: candidates };
}

interface TraversalState {
  assetId: string;
  path: OntologyAssetQueryEvidenceEdge[];
}

export function queryOntologyAssets(
  assets: readonly RecallAbilityAssetRecord[],
  request: OntologyAssetQueryRequest,
): OntologyAssetQueryResult {
  const intent = parseOntologyAssetQuery(request);
  const resolved = resolveTarget(assets, intent.target);
  if (!resolved.target) {
    if (resolved.ambiguous.length) {
      return {
        status: 'target_ambiguous',
        intent,
        candidates: resolved.ambiguous.map((asset) => ({
          id: asset.id,
          title: asset.title,
          type: asset.type,
          scope: asset.scope,
        })),
      };
    }
    return { status: 'target_not_found', intent, candidates: [] };
  }

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const allowedRelationKinds = new Set(
    (request.relationKinds || [...RELATION_KINDS]).filter((kind): kind is AbilityAssetRelationKind => RELATION_KINDS.has(kind)),
  );
  const rank = new Map(assets.map((asset, index) => [asset.id, index]));
  const outgoing = new Map<string, OntologyAssetQueryEvidenceEdge[]>();
  const incoming = new Map<string, OntologyAssetQueryEvidenceEdge[]>();
  for (const asset of assets) {
    for (const relation of asset.relations || []) {
      if (!allowedRelationKinds.has(relation.kind)) continue;
      if (intent.relationKind && relation.kind !== intent.relationKind) continue;
      const target = assetById.get(relation.assetId);
      if (!target || target.id === asset.id) continue;
      const edge: OntologyAssetQueryEvidenceEdge = {
        fromAssetId: asset.id,
        fromTitle: asset.title,
        kind: relation.kind,
        toAssetId: target.id,
        toTitle: target.title,
      };
      const forward = outgoing.get(asset.id) || [];
      forward.push(edge);
      outgoing.set(asset.id, forward);
      const reverse = incoming.get(target.id) || [];
      reverse.push(edge);
      incoming.set(target.id, reverse);
    }
  }

  const queue: TraversalState[] = [{ assetId: resolved.target.id, path: [] }];
  const visited = new Map<string, number>([[resolved.target.id, 0]]);
  const matches: OntologyAssetQueryMatch[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current.path.length >= intent.maxHops) continue;
    const neighbors: Array<{ nextId: string; edge: OntologyAssetQueryEvidenceEdge; reverse: boolean }> = [];
    if (intent.direction === 'outgoing' || intent.direction === 'both') {
      for (const edge of outgoing.get(current.assetId) || []) neighbors.push({ nextId: edge.toAssetId, edge, reverse: false });
    }
    if (intent.direction === 'incoming' || intent.direction === 'both') {
      for (const edge of incoming.get(current.assetId) || []) neighbors.push({ nextId: edge.fromAssetId, edge, reverse: true });
    }
    for (const neighbor of neighbors) {
      const distance = current.path.length + 1;
      if ((visited.get(neighbor.nextId) ?? Number.POSITIVE_INFINITY) <= distance) continue;
      const next = assetById.get(neighbor.nextId);
      if (!next) continue;
      const path = neighbor.reverse
        ? [neighbor.edge, ...current.path]
        : [...current.path, neighbor.edge];
      visited.set(next.id, distance);
      queue.push({ assetId: next.id, path });
      matches.push({ asset: publicAsset(next), distance, evidencePath: path });
    }
  }

  matches.sort((left, right) => left.distance - right.distance
    || (rank.get(left.asset.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.asset.id) ?? Number.MAX_SAFE_INTEGER)
    || left.asset.id.localeCompare(right.asset.id));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(request.limit) || DEFAULT_LIMIT)));
  return {
    status: 'ok',
    intent,
    target: publicAsset(resolved.target),
    matches: matches.slice(0, limit),
    truncated: matches.length > limit,
  };
}
