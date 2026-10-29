import type { JevClient, JevEvaluationResult } from '../jev/types';
import {
  parseOntologyAssetQuery,
  type OntologyAssetQueryDirection,
  type OntologyAssetQueryRequest,
} from './ontology-asset-query';
import type { OntologyEntity, OntologyGraphSnapshot } from '../ontology_graph';
import type { RecallTaskContract } from './task-contract';
import type { AbilityAssetRelationKind } from './asset-relations';

export type OntologyQueryIntentRoute = 'ontology' | 'semantic' | 'hybrid' | 'clarify';
export type OntologyQueryIntentRelationScope = 'direct' | 'indirect' | 'both';
export type OntologyQueryIntentTargetSource = 'graph' | 'asset_text' | 'unresolved';

export interface OntologyQueryIntentInput extends OntologyAssetQueryRequest {
  purpose?: string;
  projectId?: string;
  workspaceId?: string;
  relationScope?: OntologyQueryIntentRelationScope;
  /** Finite plans generated from the already-governed ability-asset graph.
   * Jev may choose among these plans, but cannot invent a route or relation. */
  candidatePlans?: readonly OntologyQueryIntentPlan[];
}

export interface OntologyQueryIntentPlan {
  route: 'semantic' | 'hybrid';
  relationKind?: AbilityAssetRelationKind;
  direction: OntologyAssetQueryDirection;
  relationScope: OntologyQueryIntentRelationScope;
  maxHops: number;
}

export interface OntologyQueryIntentCandidate {
  id: string;
  route: OntologyQueryIntentRoute;
  targetText: string;
  targetEntityId?: string;
  targetSource: OntologyQueryIntentTargetSource;
  relationKind?: AbilityAssetRelationKind;
  relationText?: string;
  direction: OntologyAssetQueryDirection;
  relationScope: OntologyQueryIntentRelationScope;
  maxHops: number;
  constraints: string[];
  confidence: number;
  source: 'deterministic';
}

export interface OntologyQueryIntentResult {
  status: 'selected' | 'clarify' | 'fallback';
  selected?: OntologyQueryIntentCandidate;
  candidates: OntologyQueryIntentCandidate[];
  reason?: string;
  jev?: JevEvaluationResult;
}

export interface OntologyQueryIntentOptions {
  userId?: string;
  graph?: OntologyGraphSnapshot;
  taskContract?: RecallTaskContract;
  jev?: JevClient;
  requestId?: string;
  signal?: AbortSignal;
}

const MAX_CANDIDATES = 8;
const MAX_CONSTRAINTS = 12;

function compact(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max)
    : '';
}

function normalizeLookup(value: string): string {
  return compact(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function relationScopeFor(input: OntologyQueryIntentInput): OntologyQueryIntentRelationScope {
  if (input.relationScope) return input.relationScope;
  const query = compact(input.query);
  const direct = /直接/iu.test(query);
  const indirect = /间接|多跳/iu.test(query);
  if (direct && indirect) return 'both';
  if (indirect) return 'indirect';
  return 'direct';
}

function maxHopsFor(input: OntologyQueryIntentInput, scope: OntologyQueryIntentRelationScope): number {
  const requested = Number(input.maxHops);
  const base = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1;
  if (scope === 'indirect') return Math.min(4, Math.max(2, base));
  if (scope === 'both') return Math.min(4, Math.max(2, base));
  return Math.min(4, Math.max(1, base));
}

function inferRelationText(query: string): string | undefined {
  const match = compact(query).match(/的\s*([^，。！？?!；;\s]{1,40}?)(?:是|有|有哪些|是谁|是什么)/u);
  return match?.[1]?.trim() || undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => compact(value, 160)).filter(Boolean))].slice(0, MAX_CONSTRAINTS);
}

function defaultConstraints(input: OntologyQueryIntentInput, contract?: RecallTaskContract): string[] {
  const constraints = contract?.constraints || [];
  const explicit = compact(input.purpose, 500);
  return unique([...constraints, explicit]);
}

interface EntityMatch {
  entity: OntologyEntity;
  score: number;
}

function entityMatchScore(entity: OntologyEntity, query: string, target: string): number {
  const queryKey = normalizeLookup(query);
  const targetKey = normalizeLookup(target);
  const nameKey = normalizeLookup(entity.name);
  if (!nameKey) return 0;
  const exactTarget = targetKey === nameKey;
  const exactQuery = queryKey === nameKey;
  const targetContains = Boolean(targetKey && (targetKey.includes(nameKey) || nameKey.includes(targetKey)));
  const queryContains = Boolean(queryKey && queryKey.includes(nameKey));
  if (exactTarget || exactQuery) return 100;
  if (targetContains) return 80;
  if (queryContains) return 70;

  const descriptionKey = normalizeLookup(entity.description);
  if (targetKey && descriptionKey.includes(targetKey)) return 35;
  if (queryKey && descriptionKey.includes(nameKey)) return 30;
  for (const value of Object.values(entity.properties)) {
    const valueKey = normalizeLookup(value);
    if (targetKey && valueKey.includes(targetKey)) return 25;
    if (queryKey && valueKey.includes(nameKey)) return 20;
  }
  return 0;
}

function resolveEntities(
  graph: OntologyGraphSnapshot | undefined,
  query: string,
  target: string,
): EntityMatch[] {
  if (!graph) return [];
  const matches = graph.entities
    .filter((entity) => entity.status === 'active')
    .map((entity) => ({ entity, score: entityMatchScore(entity, query, target) }))
    .filter((match) => match.score > 0);
  if (!matches.length) return [];
  const best = Math.max(...matches.map((match) => match.score));
  return matches
    .filter((match) => match.score === best)
    .sort((left, right) => left.entity.id.localeCompare(right.entity.id));
}

function routeFor(input: OntologyQueryIntentInput, relationKind?: AbilityAssetRelationKind, entityMatches: EntityMatch[] = []): OntologyQueryIntentRoute {
  if (relationKind || input.target || entityMatches.length) return 'ontology';
  return 'semantic';
}

function candidateId(route: OntologyQueryIntentRoute, entityId?: string, planKey?: string): string {
  return `intent-${route}-${entityId || 'query'}${planKey ? `-${stableHash(planKey)}` : ''}`.slice(0, 160);
}

function candidateSummary(candidate: OntologyQueryIntentCandidate): string {
  return [
    `路由=${candidate.route}`,
    `目标=${candidate.targetText}`,
    candidate.targetEntityId ? `实体=${candidate.targetEntityId}` : '',
    candidate.relationKind ? `关系=${candidate.relationKind}` : '',
    candidate.relationText ? `关系词=${candidate.relationText}` : '',
    `方向=${candidate.direction}`,
    `范围=${candidate.relationScope}`,
    `最大跳数=${candidate.maxHops}`,
    candidate.constraints.length ? `约束=${candidate.constraints.join('；')}` : '',
  ].filter(Boolean).join('，');
}

function buildCandidates(
  input: OntologyQueryIntentInput,
  graph: OntologyGraphSnapshot | undefined,
  contract?: RecallTaskContract,
): OntologyQueryIntentCandidate[] {
  const query = compact(input.query);
  const parsed = parseOntologyAssetQuery(input);
  const scope = relationScopeFor(input);
  const maxHops = maxHopsFor(input, scope);
  const relationText = inferRelationText(query);
  const constraints = defaultConstraints(input, contract);
  const entityMatches = resolveEntities(graph, query, parsed.target);
  const route = routeFor(input, parsed.relationKind, entityMatches);
  const target = parsed.target || query;
  const planned = (input.candidatePlans || []).slice(0, MAX_CANDIDATES);
  if (planned.length) {
    const match = entityMatches.length === 1 ? entityMatches[0] : undefined;
    return planned.map((plan) => {
      const planKey = [plan.relationKind || 'none', plan.direction, plan.relationScope, plan.maxHops].join(':');
      return {
        id: candidateId(plan.route, match?.entity.id || target, planKey),
        route: plan.route,
        targetText: match?.entity.name || target,
        ...(match ? { targetEntityId: match.entity.id, targetSource: 'graph' as const } : {
          targetSource: input.target ? 'asset_text' as const : 'unresolved' as const,
        }),
        ...(plan.relationKind ? { relationKind: plan.relationKind } : {}),
        ...(relationText ? { relationText } : {}),
        direction: plan.direction,
        relationScope: plan.relationScope,
        maxHops: Math.min(4, Math.max(1, Math.floor(plan.maxHops))),
        constraints,
        confidence: plan.route === 'semantic' ? 0.6 : 0.72,
        source: 'deterministic' as const,
      };
    });
  }
  const candidates = (entityMatches.length ? entityMatches : [undefined]).map((match) => {
    const targetText = match?.entity.name || target;
    const exact = match?.score === 100;
    const confidence = Math.min(0.99, Math.max(
      route === 'semantic' ? 0.45 : 0.62,
      (parsed.relationKind ? 0.78 : 0.6) + (exact ? 0.16 : match ? 0.06 : 0),
    ));
    return {
      id: candidateId(route, match?.entity.id),
      route,
      targetText,
      ...(match ? { targetEntityId: match.entity.id, targetSource: 'graph' as const } : {
        targetSource: input.target ? 'asset_text' as const : 'unresolved' as const,
      }),
      ...(parsed.relationKind ? { relationKind: parsed.relationKind } : {}),
      ...(relationText ? { relationText } : {}),
      direction: parsed.direction,
      relationScope: scope,
      maxHops,
      constraints,
      confidence: Number(confidence.toFixed(3)),
      source: 'deterministic' as const,
    };
  });
  return candidates.slice(0, MAX_CANDIDATES);
}

function deterministicSelection(candidates: OntologyQueryIntentCandidate[]): OntologyQueryIntentResult {
  if (!candidates.length) return { status: 'clarify', candidates: [], reason: '无法生成结构化查询意图' };
  if (candidates.length === 1) return { status: 'selected', candidates, selected: candidates[0] };
  return {
    status: 'clarify',
    candidates,
    reason: '目标实体存在多个同等匹配，不能静默选择',
  };
}

function jevSource(candidate: OntologyQueryIntentCandidate): 'ontology' | 'semantic' | 'hybrid' {
  return candidate.route === 'semantic' ? 'semantic' : candidate.route === 'hybrid' ? 'hybrid' : 'ontology';
}

function applyJevDecision(
  candidates: OntologyQueryIntentCandidate[],
  evaluation: JevEvaluationResult,
): OntologyQueryIntentResult {
  if (evaluation.status !== 'ok') {
    const fallback = deterministicSelection(candidates);
    return {
      ...fallback,
      status: fallback.status === 'selected' ? 'fallback' : fallback.status,
      reason: fallback.reason || `Jev 不可用，已使用确定性回退：${evaluation.reason}`,
      jev: evaluation,
    };
  }

  const decision = evaluation.response.decision;
  if (decision.type === 'clarify') {
    return { status: 'clarify', candidates, reason: decision.question, jev: evaluation };
  }
  if (decision.type === 'none') {
    return { status: 'clarify', candidates, reason: decision.reason || 'Jev 判定当前意图没有安全候选', jev: evaluation };
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  if (decision.type === 'select') {
    const selected = decision.candidateIds.map((id) => candidateById.get(id)).filter(Boolean) as OntologyQueryIntentCandidate[];
    if (selected.length !== 1) {
      return { status: 'clarify', candidates, reason: 'Jev 选择了多个意图候选，需要进一步澄清', jev: evaluation };
    }
    return { status: 'selected', candidates, selected: selected[0], jev: evaluation };
  }

  const scored = decision.scores
    .map((entry) => ({ candidate: candidateById.get(entry.candidateId), score: entry.score }))
    .filter((entry): entry is { candidate: OntologyQueryIntentCandidate; score: number } => Boolean(entry.candidate))
    .sort((left, right) => right.score - left.score || candidates.indexOf(left.candidate) - candidates.indexOf(right.candidate));
  if (!scored.length) return { status: 'clarify', candidates, reason: 'Jev 未为任何候选提供有效评分', jev: evaluation };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { status: 'clarify', candidates, reason: 'Jev 对多个意图候选给出相同最高分', jev: evaluation };
  }
  return { status: 'selected', candidates, selected: scored[0].candidate, jev: evaluation };
}

export function buildOntologyQueryIntentCandidates(
  input: OntologyQueryIntentInput,
  graph?: OntologyGraphSnapshot,
  contract?: RecallTaskContract,
): OntologyQueryIntentCandidate[] {
  return buildCandidates(input, graph, contract);
}

export async function resolveOntologyQueryIntent(
  input: OntologyQueryIntentInput,
  options: OntologyQueryIntentOptions = {},
): Promise<OntologyQueryIntentResult> {
  const query = compact(input.query);
  if (!query) return { status: 'clarify', candidates: [], reason: '查询不能为空' };

  let graph = options.graph;
  let contract = options.taskContract;
  if (options.userId) {
    const graphPromise = graph
      ? Promise.resolve(graph)
      : import('../ontology_graph').then(({ readOntologyGraph }) => readOntologyGraph(options.userId!));
    const contractPromise = contract
      ? Promise.resolve({ contract })
      : import('./task-contract').then(({ loadRecallTaskContractContext }) => loadRecallTaskContractContext(options.userId!, {
        taskText: query,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      }));
    const [graphResult, contractResult] = await Promise.allSettled([
      graphPromise,
      contractPromise,
    ]);
    if (!graph && graphResult.status === 'fulfilled') graph = graphResult.value;
    if (!contract && contractResult.status === 'fulfilled') contract = contractResult.value.contract;
  }

  const candidates = buildCandidates(input, graph, contract);
  // Production Semantica uses the deterministic selection. An external
  // finite-candidate judge can still be injected explicitly by experiments.
  const jev = options.jev;
  if (!jev || !candidates.length) return deterministicSelection(candidates);

  const requestId = options.requestId || `intent-${stableHash(query)}`;
  const evaluation = await jev.evaluate({
    requestId,
    gate: 'intent',
    question: {
      id: 'ontology-query-intent-v1',
      kind: 'choice',
      text: '在已有候选中选择查询路由、目标实体和关系方向；不确定时要求澄清。',
    },
    query,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      summary: candidateSummary(candidate),
      source: jevSource(candidate),
      evidence: candidate.targetEntityId ? [`本地用户本体实体：${candidate.targetEntityId}`] : undefined,
    })),
  }, { signal: options.signal });
  return applyJevDecision(candidates, evaluation);
}
