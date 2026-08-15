import type {
  PredictedRisk,
  WorldModelCandidateForecast,
  WorldModelCandidateScore,
  WorldModelCausalLink,
  WorldModelIntervention,
  WorldModelPredictedResult,
} from './world-model-types';

const MAX_PLAN = 24;
const MAX_TOOLS = 24;
const MAX_ACTORS = 12;
const MAX_SIGNALS = 24;
const MAX_FILES = 50;
const MAX_LINKS = 32;
const MAX_ASSUMPTIONS = 24;

export interface WorldModelCandidateValidationContext {
  allowedTools?: Set<string>;
  allowedRuleRefs: Set<string>;
  predictedRisks: PredictedRisk[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function dimension(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid_candidate_score_${field}`);
  }
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid_candidate_${field}`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > max) throw new Error(`invalid_candidate_${field}`);
  return normalized;
}

function texts(value: unknown, field: string, maxItems: number, maxLength: number, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid_candidate_${field}`);
  const out = value.map((item) => text(item, field, maxLength));
  if (!allowEmpty && !out.length) throw new Error(`invalid_candidate_${field}`);
  return out;
}

export function recomputeCandidateScore(value: unknown): WorldModelCandidateScore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_candidate_score');
  const score = value as Record<string, unknown>;
  const goalFit = dimension(score.goalFit, 'goal_fit');
  const feasibility = dimension(score.feasibility, 'feasibility');
  const observability = dimension(score.observability, 'observability');
  const causalSupport = dimension(score.causalSupport, 'causal_support');
  const riskPenalty = dimension(score.riskPenalty, 'risk_penalty');
  const total = Number(clamp01(
    goalFit * 0.35
    + feasibility * 0.25
    + observability * 0.20
    + causalSupport * 0.20
    - riskPenalty * 0.25,
  ).toFixed(4));
  return { goalFit, feasibility, observability, causalSupport, riskPenalty, total };
}

function intervention(raw: Record<string, unknown>, context: WorldModelCandidateValidationContext): WorldModelIntervention {
  const expectedTools = texts(raw.expectedTools, 'expected_tools', MAX_TOOLS, 120, true);
  if (context.allowedTools) {
    for (const tool of expectedTools) {
      if (!context.allowedTools.has(tool)) throw new Error(`unavailable_tool:${tool}`);
    }
  }
  return {
    plan: texts(raw.plan, 'plan', MAX_PLAN, 1_000),
    expectedTools,
    expectedActors: texts(raw.expectedActors, 'expected_actors', MAX_ACTORS, 120),
  };
}

function predictedResult(raw: unknown): WorldModelPredictedResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_candidate_predicted_result');
  const result = raw as Record<string, unknown>;
  return {
    summary: text(result.summary, 'result_summary', 4_000),
    acceptanceSignals: texts(result.acceptanceSignals, 'acceptance_signals', MAX_SIGNALS, 1_000),
    predictedFiles: texts(result.predictedFiles, 'predicted_files', MAX_FILES, 1_000, true),
  };
}

function causalLinks(raw: unknown, planLength: number, context: WorldModelCandidateValidationContext): WorldModelCausalLink[] {
  if (!Array.isArray(raw) || raw.length > MAX_LINKS) throw new Error('invalid_candidate_causal_links');
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_candidate_causal_link');
    const link = item as Record<string, unknown>;
    if (!Number.isSafeInteger(link.interventionIndex) || Number(link.interventionIndex) < 0 || Number(link.interventionIndex) >= planLength) {
      throw new Error('invalid_candidate_intervention_index');
    }
    const ruleRefs = texts(link.ruleRefs, 'rule_refs', 20, 240, true);
    for (const ref of ruleRefs) {
      if (!context.allowedRuleRefs.has(ref)) throw new Error(`invalid_rule_ref:${ref}`);
    }
    return {
      interventionIndex: Number(link.interventionIndex),
      mechanism: text(link.mechanism, 'mechanism', 2_000),
      ruleRefs,
      assumptions: texts(link.assumptions, 'link_assumptions', 12, 1_000, true),
    };
  });
}

export function validateWorldModelCandidate(
  value: unknown,
  context: WorldModelCandidateValidationContext,
  modelOrder: number,
): WorldModelCandidateForecast {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_world_model_candidate');
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 'id', 120);
  const aHat = intervention(raw, context);
  const links = causalLinks(raw.causalLinks, aHat.plan.length, context);
  const riskRuleRefs = texts(raw.riskRuleRefs, 'risk_rule_refs', 20, 240, true);
  for (const ref of riskRuleRefs) {
    if (!context.allowedRuleRefs.has(ref)) throw new Error(`invalid_rule_ref:${ref}`);
  }
  const risksById = new Map(context.predictedRisks.map((risk) => [risk.ruleId, risk]));
  return {
    id,
    aHat,
    rHat: predictedResult(raw.predictedResult),
    causalLinks: links,
    assumptions: texts(raw.assumptions, 'assumptions', MAX_ASSUMPTIONS, 1_000, true),
    predictedRisks: riskRuleRefs.map((ref) => risksById.get(ref)).filter((risk): risk is PredictedRisk => Boolean(risk)),
    score: recomputeCandidateScore(raw.score),
    modelOrder,
  };
}

export function selectWorldModelCandidate(candidates: WorldModelCandidateForecast[]): WorldModelCandidateForecast {
  if (!candidates.length) throw new Error('world_model_no_valid_candidates');
  return [...candidates].sort((left, right) => (
    right.score.total - left.score.total
    || left.score.riskPenalty - right.score.riskPenalty
    || right.score.observability - left.score.observability
    || left.modelOrder - right.modelOrder
  ))[0];
}
