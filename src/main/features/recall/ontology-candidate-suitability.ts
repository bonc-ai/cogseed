import { randomUUID } from 'node:crypto';

import {
  JEV_MAX_CANDIDATES,
  type JevCandidate,
  type JevClient,
  type JevEvaluationResult,
} from '../jev/types';
import type { UnifiedRecallCandidate } from './ontology-semantic-orchestrator';

const CANDIDATE_SUITABILITY_QUESTION_ID = 'ontology-candidate-suitability-v1';
const DEFAULT_MINIMUM_SCORE = 0.5;

export interface CandidateSuitabilityInput {
  query: string;
  candidates: readonly UnifiedRecallCandidate[];
  requestId?: string;
}

export interface CandidateSuitabilityOptions {
  jev?: JevClient;
  signal?: AbortSignal;
  minimumScore?: number;
  rolloutKey?: string;
}

export interface SuitableRecallCandidate extends UnifiedRecallCandidate {
  suitabilityScore?: number;
}

export interface CandidateSuitabilityResult {
  status: 'selected' | 'none' | 'clarify' | 'fallback';
  candidates: SuitableRecallCandidate[];
  reason?: string;
  jev?: JevEvaluationResult;
}

function compact(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boundedScore(value: unknown, fallback: number): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(1, score));
}

function candidateSummary(candidate: UnifiedRecallCandidate): string {
  const fields = [
    `title=${candidate.asset.title}`,
    `type=${candidate.asset.type}`,
    `scope=${candidate.asset.scope}`,
    `maturity=${candidate.asset.maturity}`,
    `version=${candidate.asset.activeVersion || candidate.asset.version}`,
    'governance=directory_admitted',
    `source=${candidate.source}`,
    `matchScore=${candidate.matchScore}`,
  ];
  if (candidate.semanticScore !== undefined) fields.push(`semanticScore=${candidate.semanticScore}`);
  if (candidate.ontologyScore !== undefined) fields.push(`ontologyScore=${candidate.ontologyScore}`);
  if (candidate.relationKind) fields.push(`relation=${candidate.relationKind}`);
  if (candidate.direction) fields.push(`direction=${candidate.direction}`);
  if (candidate.distance !== undefined) fields.push(`distance=${candidate.distance}`);
  if (candidate.entryAssetId) fields.push(`entryAssetId=${candidate.entryAssetId}`);
  if (candidate.maxHops !== undefined) fields.push(`maxHops=${candidate.maxHops}`);
  return compact(fields.join('; '), 2_000);
}

function candidateEvidence(candidate: UnifiedRecallCandidate): string[] | undefined {
  const evidence = (candidate.evidencePath || []).slice(0, 16).map((edge) => compact(
    `${edge.fromTitle} [${edge.fromAssetId}] -${edge.kind}-> ${edge.toTitle} [${edge.toAssetId}]`,
    1_000,
  )).filter(Boolean);
  return evidence.length ? evidence : undefined;
}

function jevCandidate(candidate: UnifiedRecallCandidate): JevCandidate {
  const evidence = candidateEvidence(candidate);
  return {
    id: candidate.assetId,
    summary: candidateSummary(candidate),
    source: candidate.source === 'semantic_ontology' ? 'hybrid' : candidate.source,
    ...(evidence ? { evidence } : {}),
  };
}

function fallback(
  candidates: readonly UnifiedRecallCandidate[],
  evaluation: JevEvaluationResult,
): CandidateSuitabilityResult {
  return {
    status: 'fallback',
    candidates: [...candidates],
    reason: `Jev 不可用，已保留确定性候选排序：${evaluation.status === 'fallback' ? evaluation.reason : 'unknown'}`,
    jev: evaluation,
  };
}

/**
 * Let Jev judge only the finite candidates already admitted and assembled by
 * CogSeed. Jev can select, score or reject those IDs, but cannot add assets,
 * restore filtered candidates, read asset content, or create ontology facts.
 */
export async function assessOntologyCandidateSuitability(
  input: CandidateSuitabilityInput,
  options: CandidateSuitabilityOptions = {},
): Promise<CandidateSuitabilityResult> {
  const query = compact(input.query, 4_000);
  const uniqueCandidates: UnifiedRecallCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate?.assetId || seen.has(candidate.assetId)) continue;
    seen.add(candidate.assetId);
    uniqueCandidates.push(candidate);
  }
  if (!uniqueCandidates.length) return { status: 'none', candidates: [], reason: '没有可判断的已准入候选' };
  if (!query) return { status: 'fallback', candidates: uniqueCandidates, reason: '查询为空，保留确定性候选排序' };

  // The product path is local-only. The orchestrator has already applied
  // governance and deterministic ranking, so no external service is needed.
  // Tests or future adapters may still inject a finite-candidate judge.
  if (!options.jev) {
    return {
      status: 'selected',
      candidates: uniqueCandidates,
      reason: '已使用本地确定性适用性排序',
    };
  }

  const evaluatedCandidates = uniqueCandidates.slice(0, JEV_MAX_CANDIDATES);
  const candidateById = new Map(evaluatedCandidates.map((candidate) => [candidate.assetId, candidate]));
  const requestId = compact(input.requestId || `candidate-${randomUUID()}`, 160);
  const jev = options.jev;
  const evaluation = await jev.evaluate({
    requestId,
    gate: 'candidate_suitability',
    question: {
      id: CANDIDATE_SUITABILITY_QUESTION_ID,
      kind: 'score',
      text: '选择真正适用于当前任务的能力资产候选并按适用性排序；没有合适候选时返回 none。',
    },
    query,
    candidates: evaluatedCandidates.map(jevCandidate),
  }, { ...(options.signal ? { signal: options.signal } : {}) });
  if (evaluation.status !== 'ok') return fallback(uniqueCandidates, evaluation);

  const decision = evaluation.response.decision;
  if (decision.type === 'none') {
    return {
      status: 'none',
      candidates: [],
      reason: decision.reason || 'Jev 判定没有适用候选',
      jev: evaluation,
    };
  }
  if (decision.type === 'clarify') {
    return { status: 'clarify', candidates: [], reason: decision.question, jev: evaluation };
  }
  if (decision.type === 'select') {
    const selected = decision.candidateIds
      .map((id) => candidateById.get(id))
      .filter((candidate): candidate is UnifiedRecallCandidate => Boolean(candidate));
    return selected.length
      ? { status: 'selected', candidates: selected, jev: evaluation }
      : { status: 'none', candidates: [], reason: 'Jev 未选择任何有效的已准入候选', jev: evaluation };
  }

  const minimumScore = boundedScore(options.minimumScore, DEFAULT_MINIMUM_SCORE);
  const inputOrder = new Map(evaluatedCandidates.map((candidate, index) => [candidate.assetId, index]));
  const scored = decision.scores
    .map((entry) => ({ candidate: candidateById.get(entry.candidateId), score: entry.score }))
    .filter((entry): entry is { candidate: UnifiedRecallCandidate; score: number } => (
      Boolean(entry.candidate) && entry.score >= minimumScore
    ))
    .sort((left, right) => right.score - left.score
      || (inputOrder.get(left.candidate.assetId) || 0) - (inputOrder.get(right.candidate.assetId) || 0));
  return scored.length
    ? {
      status: 'selected',
      candidates: scored.map(({ candidate, score }) => ({ ...candidate, suitabilityScore: score })),
      jev: evaluation,
    }
    : {
      status: 'none',
      candidates: [],
      reason: `Jev 候选评分均低于适用阈值 ${minimumScore}`,
      jev: evaluation,
    };
}
