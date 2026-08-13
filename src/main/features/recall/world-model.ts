/**
 * World-model simulation `f(K, S, T) -> (A_hat, R_hat)`.
 *
 * Hybrid implementation:
 *   1. Deterministic layer: apply R-Box causal rules to the A-Box snapshot
 *      to predict known risks (Hermes F002 equivalent).
 *   2. Cognitive layer: when a model is configured, generate the open-ended
 *      (A_hat, R_hat) prediction with the matched risks injected as hard
 *      constraints, so the LLM simulation is grounded in the frozen lessons.
 */

import { buildRunner } from '../../model/core-agent/runner';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import { genId12 } from '../../storage';
import { hasConfiguredModel } from '../auth';
import { normalizeCausalRule } from './world-model-types';
import { selectWorldModelCandidate, validateWorldModelCandidate } from './world-model-scoring';

const MAX_SUMMARY = 4_000;
import type {
  CausalRule,
  PredictedRisk,
  WorldModelCandidateForecast,
  WorldModelForecast,
  WorldModelForecastRecord,
  WorldModelPredicateKey,
  WorldModelSimulationInput,
  WorldModelSnapshot,
} from './world-model-types';
import type { KstarEpisodeRecord } from '../kstar/types';

/** Deterministic A-Box predicates for the F002 risk pass. */
const PREDICATE_TESTS: Record<WorldModelPredicateKey, (s: WorldModelSnapshot) => boolean> = {
  workspace_unavailable: (s) => !s.environment.workspace.ok,
  model_not_configured: (s) => !s.environment.model.configured,
  bash_unavailable: (s) => !s.environment.tools.bash,
  skills_missing: (s) => s.skills.status === 'missing',
  too_few_skills: (s) => s.skills.status === 'ok' && s.skills.total < 10,
  too_few_rules: (s) => s.ontology.totalRules < 5,
  no_active_assets: (s) => s.ontology.activeAssets === 0,
};

function bareCausalRules(input: WorldModelSimulationInput['k']['rules']): CausalRule[] {
  return input.map((entry) => ('rule' in entry ? entry.rule : entry));
}

/**
 * F002 equivalent: apply R-Box rules to an A-Box snapshot and return the
 * predicted risks whose deterministic predicate currently fires.
 */
export function applyCausalRules(
  snapshot: WorldModelSnapshot,
  rules: CausalRule[],
): PredictedRisk[] {
  const out: PredictedRisk[] = [];
  for (const rule of rules) {
    if (!rule.predicateKey) continue;
    const test = PREDICATE_TESTS[rule.predicateKey];
    if (!test || !test(snapshot)) continue;
    out.push({
      ruleId: rule.cause, // temporary; real id comes from the asset store caller
      cause: rule.cause,
      effect: rule.effect,
      mitigation: rule.mitigation,
      severity: rule.severity,
      deltaR: rule.deltaR,
    });
  }
  return out;
}

function forecastSystemPrompt(): string {
  return [
    'You are a world model. Given knowledge K, situation S, and task T, simulate 2 to 4 candidate futures.',
    'Each candidate must pair one predicted intervention sequence with the world state caused by that sequence.',
    'Return exactly one JSON object and no markdown.',
    'Schema: {"candidates":[{"id":"path-a","plan":["step"],"expectedTools":["tool"],"expectedActors":["actor"],"predictedResult":{"summary":"...","acceptanceSignals":["..."],"predictedFiles":["..."]},"causalLinks":[{"interventionIndex":0,"mechanism":"...","ruleRefs":["rule-id"],"assumptions":["..."]}],"assumptions":["..."],"riskRuleRefs":["rule-id"],"score":{"goalFit":0,"feasibility":0,"observability":0,"causalSupport":0,"riskPenalty":0,"total":0}}]}',
    'All score dimensions are numbers from 0 to 1. The host recomputes total and does not trust your total.',
    'Use only rule refs and tools provided in the input. Do not execute tools or invent facts.',
    'Causal links are concise auditable mechanisms, not hidden reasoning or chain-of-thought.',
  ].join('\n');
}

function parseForecastCandidates(
  text: string,
  context: {
    allowedTools?: Set<string>;
    allowedRuleRefs: Set<string>;
    predictedRisks: PredictedRisk[];
  },
): WorldModelCandidateForecast[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('model output is not strict JSON');
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model output must be an object');
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 4) {
    throw new Error('world model must return two to four candidates');
  }
  return candidates.map((candidate, index) => validateWorldModelCandidate(candidate, context, index));
}

export interface SimulateWorldOptions {
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
}

function predictedRisksForKnowledge(
  snapshot: WorldModelSnapshot,
  rules: WorldModelSimulationInput['k']['rules'],
): PredictedRisk[] {
  const out: PredictedRisk[] = [];
  for (const entry of rules) {
    const rule = 'rule' in entry ? entry.rule : entry;
    const hits = applyCausalRules(snapshot, [rule]);
    for (const hit of hits) {
      out.push({ ...hit, ruleId: 'rule' in entry ? entry.id : hit.ruleId });
    }
  }
  return out;
}

/**
 * Hybrid world-model simulation `f(K, S, T) -> (A_hat, R_hat)`.
 *
 * Deterministic rule hits are computed first; when a model is available they
 * are injected into the LLM prompt as hard constraints, otherwise the forecast
 * falls back to a deterministic-only risk forecast with empty open predictions.
 */
export async function simulateWorld(
  userId: string,
  input: WorldModelSimulationInput,
  snapshot: WorldModelSnapshot,
  options: SimulateWorldOptions = {},
): Promise<WorldModelForecast> {
  if (!options.runModel && !hasConfiguredModel().configured) {
    throw Object.assign(new Error('world model simulation requires a configured model'), {
      code: 'model_not_configured',
    });
  }

  const predictedRisks = predictedRisksForKnowledge(snapshot, input.k.rules);
  const ruleRefs = new Set(input.k.rules
    .filter((entry): entry is Extract<typeof entry, { rule: CausalRule }> => 'rule' in entry)
    .map((entry) => entry.id));
  const allowedTools = input.s.execution?.availableTools?.length
    ? new Set(input.s.execution.availableTools)
    : undefined;
  const message = JSON.stringify({
    k: input.k,
    s: input.s,
    t: input.t,
    knownRiskConstraints: predictedRisks.map((risk) => ({
      ruleId: risk.ruleId,
      cause: risk.cause,
      effect: risk.effect,
      mitigation: risk.mitigation,
      severity: risk.severity,
    })),
  });

  let output: string;
  if (options.runModel) {
    output = await options.runModel({ systemPrompt: forecastSystemPrompt(), message });
  } else {
    const { runner } = await buildRunner({
      sessionId: `kstar-forecast-${snapshot.taskRunId}`,
      userId,
      systemPrompt: forecastSystemPrompt(),
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
    });
    const result = await runner.run({
      message,
      thinkingLevel: 'off',
      cacheRetention: 'none',
    });
    if (result.meta.aborted || result.meta.error) {
      throw Object.assign(new Error('world model unavailable'), { code: 'world_model_unavailable' });
    }
    output = result.text;
  }

  const candidates = parseForecastCandidates(output, {
    ...(allowedTools ? { allowedTools } : {}),
    allowedRuleRefs: ruleRefs,
    predictedRisks,
  });
  const selected = selectWorldModelCandidate(candidates);
  return {
    candidates,
    selectedCandidateId: selected.id,
    aHat: selected.aHat,
    rHat: selected.rHat,
    causalLinks: selected.causalLinks,
    assumptions: selected.assumptions,
    predictedRisks: selected.predictedRisks.length ? selected.predictedRisks : predictedRisks,
  };
}

/** Assemble an A-Box snapshot from the current world state. Kept explicit so
 *  the KSTAR task-boundary caller supplies only the facts it already has. */
export function collectWorldSnapshot(
  userId: string,
  input: {
    taskRunId: string;
    workspace: { ok: boolean; path?: string };
    model: { configured: boolean; profile?: string };
    tools: { fileSystem: boolean; bash: boolean };
    groupChatStatus: 'idle' | 'running' | 'aborted';
    requirementStatus?: string;
    projectionStatus?: string;
    skills: { total: number; categories: string[]; status: 'ok' | 'empty' | 'missing' | 'unknown' };
    ontology: { totalAssets: number; activeAssets: number; totalRules: number };
    now?: string;
  },
): WorldModelSnapshot {
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: `snap-${genId12()}`,
    taskRunId: input.taskRunId,
    environment: {
      workspace: input.workspace,
      model: input.model,
      tools: input.tools,
    },
    core: {
      groupChat: { status: input.groupChatStatus },
      ...(input.requirementStatus ? { kstar: { requirementStatus: input.requirementStatus } } : {}),
      ...(input.projectionStatus ? { recall: { projectionStatus: input.projectionStatus } } : {}),
    },
    skills: input.skills,
    ontology: input.ontology,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

/** Persist a world-model forecast record keyed by forecast id. */
export async function saveWorldModelForecast(
  userId: string,
  record: WorldModelForecastRecord,
): Promise<WorldModelForecastRecord> {
  await writeRecallJsonRecord(userId, 'world-model-forecasts', record.id, record);
  return record;
}

/** Read a world-model forecast record by id. */
export async function readWorldModelForecast(
  userId: string,
  forecastId: string,
): Promise<WorldModelForecastRecord | null> {
  const raw = await readRecallJsonRecord(userId, 'world-model-forecasts', forecastId);
  if (!raw) return null;
  const record = raw as WorldModelForecastRecord;
  const provenanceComplete = Boolean(
    record.projectionId
    && record.projectionConfirmedAt
    && record.assetVersions
    && record.ruleRefs
    && record.snapshotId
  );
  return { ...record, provenanceComplete };
}

/** Build a forecast record from simulation inputs + output. */
export function buildWorldModelForecastRecord(
  userId: string,
  input: {
    taskRunId: string;
    requirementId: string;
    forecast: WorldModelForecast;
    simulationInput: WorldModelSimulationInput;
    projectionId?: string;
    projectionConfirmedAt?: string;
    assetVersions?: Record<string, string>;
    ruleRefs?: string[];
    snapshotId?: string;
  },
): WorldModelForecastRecord {
  const provenanceComplete = Boolean(
    input.projectionId
    && input.projectionConfirmedAt
    && input.assetVersions
    && input.ruleRefs
    && input.snapshotId
  );
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: `wf-${genId12()}`,
    taskRunId: input.taskRunId,
    requirementId: input.requirementId,
    ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    ...(input.projectionConfirmedAt ? { projectionConfirmedAt: input.projectionConfirmedAt } : {}),
    ...(input.assetVersions ? { assetVersions: input.assetVersions } : {}),
    ...(input.ruleRefs ? { ruleRefs: input.ruleRefs } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    provenanceComplete,
    input: input.simulationInput,
    forecast: input.forecast,
    createdAt: new Date().toISOString(),
  };
}

/** Result of reconciling a world-model forecast against realized execution. */
export interface WorldModelReconciliation {
  /** Delta between predicted intervention (A_hat) and realized action (A). */
  deltaA: number | 'unknown';
  /** Delta between predicted result (R_hat) and realized result (R). */
  deltaR: number | 'unknown';
  /** Attribution: execution_gap when deltaA is non-zero (deltaR is polluted),
   *  otherwise derived from the realized-result delta. */
  attribution: 'knowledge_gap' | 'rule_gap' | 'template_gap' | 'skill_gap' | 'execution_gap' | 'unclear';
}

/** Compare predicted tools/actors with realized tool calls. A mismatch is a
 *  signal that embodiment was incomplete (A != A_hat). */
function compareInterventions(
  forecast: WorldModelForecast,
  episode: KstarEpisodeRecord,
): number | 'unknown' {
  if (!forecast.aHat.plan.length && !forecast.aHat.expectedTools.length) return 'unknown';
  const realizedTools = new Set(episode.a.toolCalls.map((c) => c.name));
  const predictedTools = new Set(forecast.aHat.expectedTools);
  if (!predictedTools.size) return 'unknown';
  let missing = 0;
  for (const tool of predictedTools) if (!realizedTools.has(tool)) missing += 1;
  if (missing === 0) return 0;
  return -1;
}

/** Compare predicted acceptance signals / files with realized verification. */
function compareResults(
  forecast: WorldModelForecast,
  episode: KstarEpisodeRecord,
): number | 'unknown' {
  if (!forecast.rHat.acceptanceSignals.length && !forecast.rHat.predictedFiles.length) return 'unknown';
  const realizedFiles = new Set(episode.r.producedFiles);
  const predictedFiles = new Set(forecast.rHat.predictedFiles);
  const missingFiles = [...predictedFiles].filter((f) => !realizedFiles.has(f)).length;
  const passed = episode.r.verification !== undefined;
  const acceptanceSignalsMet = forecast.rHat.acceptanceSignals.length === 0 ? true : passed;
  if (acceptanceSignalsMet && missingFiles === 0) return 0;
  return -1;
}

/**
 * Reconcile a forecast against the realized episode using the KSTAR theory:
 * deltaA gates trust in deltaR. When deltaA != 0, the result delta is polluted
 * by an execution/embodiment gap and must be attributed there, not to the model.
 */
export function reconcileWorldModel(
  forecast: WorldModelForecast,
  episode: KstarEpisodeRecord,
): WorldModelReconciliation {
  const deltaA = compareInterventions(forecast, episode);
  if (deltaA !== 0 && deltaA !== 'unknown') {
    return {
      deltaA,
      deltaR: 'unknown',
      attribution: 'execution_gap',
    };
  }
  const deltaR = compareResults(forecast, episode);
  const attribution = deltaR === 0 ? 'unclear' : deltaR === 'unknown' ? 'unclear' : 'knowledge_gap';
  return { deltaA, deltaR, attribution };
}
