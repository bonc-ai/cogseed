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
  // Tolerant normalization: deepseek-v4-flash frequently flattens nested
  // arrays into a single string (live-observed: plan and expectedTools
  // arrived as one prose sentence). A single string is treated as a
  // one-item array; malformed arrays are still rejected.
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || items.length > maxItems) throw new Error(`invalid_candidate_${field}`);
  const out = items.map((item) => text(item, field, maxLength));
  if (!allowEmpty && !out.length) throw new Error(`invalid_candidate_${field}`);
  return out;
}

/**
 * Candidate scoring weights (P1-1): currently hand-picked starting values,
 * NOT calibrated against historical data. Calibration requires a
 * prediction-vs-actual regression loop (forecast score vs realized ΔR),
 * which is not built yet — until then these weights are honest about being
 * guesses. They are named constants so calibration can swap them in one
 * place.
 */
export const SCORE_WEIGHTS = Object.freeze({
  goalFit: 0.35,
  feasibility: 0.25,
  observability: 0.20,
  causalSupport: 0.20,
  /** Risk penalty is a discount term (subtracted), not a positive signal —
   *  semantically distinct from the four quality dimensions on purpose:
   *  a risky candidate must beat a safe one by a real margin. */
  riskPenalty: 0.25,
} as const);

export function recomputeCandidateScore(value: unknown): WorldModelCandidateScore {
  // Tolerant scoring: the model cannot self-score the four dimensions
  // (live: score was absent/guessed). Missing or malformed dimensions fall
  // back to the neutral 0.5 so a real forecast can commit; weights are
  // documented uncalibrated (P1-1) pending a prediction-vs-actual loop.
  const score = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
  const safe = (raw: unknown): number => {
    try { return dimension(raw, 'x'); } catch { return 0.5; }
  };
  const goalFit = safe(score.goalFit);
  const feasibility = safe(score.feasibility);
  const observability = safe(score.observability);
  const causalSupport = safe(score.causalSupport);
  const riskPenalty = safe(score.riskPenalty);
  const total = Number(clamp01(
    goalFit * SCORE_WEIGHTS.goalFit
    + feasibility * SCORE_WEIGHTS.feasibility
    + observability * SCORE_WEIGHTS.observability
    + causalSupport * SCORE_WEIGHTS.causalSupport
    - riskPenalty * SCORE_WEIGHTS.riskPenalty,
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
  // Tolerant normalization: the model may flatten predictedResult to a plain
  // string (live-observed). A string becomes { summary }.
  if (typeof raw === 'string') {
    return {
      summary: text(raw, 'result_summary', 4_000),
      acceptanceSignals: [],
      predictedFiles: [],
    };
  }
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
  // Tolerant id: the model may omit candidate ids (live-observed). Fall back
  // to a stable generated id so selectedCandidateId is never empty.
  let id = '';
  try { id = text(raw.id, 'id', 120); } catch { id = ''; }
  id = id || `candidate-${modelOrder + 1}`;
  const aHat = intervention(raw, context);
  // causalLinks / riskRuleRefs are world-model INTERNAL structures: the
  // model cannot know the host's rule ids or causal-link semantics (live:
  // it emitted a string array of projection ids). Tolerate absence/any
  // malformed shape → empty; the host scoring pass derives causal support
  // from the committed projection knowledge instead of the model's guesses.
  let links: WorldModelCausalLink[] = [];
  try { links = causalLinks(raw.causalLinks, aHat.plan.length, context); } catch { links = []; }
  // riskRuleRefs from the model are guesses (live: it emitted asset ids).
  // Drop non-string items and unknown refs instead of rejecting.
  let riskRuleRefs: string[] = [];
  try { riskRuleRefs = texts(raw.riskRuleRefs, 'risk_rule_refs', 20, 240, true); } catch { riskRuleRefs = []; }
  riskRuleRefs = riskRuleRefs.filter((ref) => context.allowedRuleRefs.has(ref));
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
