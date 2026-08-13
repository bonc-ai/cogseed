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

const MAX_SUMMARY = 4_000;
import type {
  CausalRule,
  PredictedRisk,
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
    'You are a world model. Given knowledge K, situation S, and task T, predict both',
    'the future self (intervention) and the future world (result state) in ONE simulation.',
    'Return exactly one JSON object and no markdown.',
    'Schema: {"plan":["step"],"expectedTools":["tool"],"expectedActors":["actor"],"predictedResult":{"summary":"...","acceptanceSignals":["..."],"predictedFiles":["..."]}}',
    'Do not execute tools or invent facts. `plan` is the predicted intervention sequence;',
    '`predictedResult` is the world state you predict after that intervention.',
    'Use the provided risk constraints as hard grounding when relevant.',
  ].join('\n');
}

function parseForecast(text: string): WorldModelForecast {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('model output is not strict JSON');
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model output must be an object');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.plan) || record.plan.some((x) => typeof x !== 'string')) throw new Error('invalid plan');
  if (!Array.isArray(record.expectedTools) || record.expectedTools.some((x) => typeof x !== 'string')) throw new Error('invalid expectedTools');
  if (!Array.isArray(record.expectedActors) || record.expectedActors.some((x) => typeof x !== 'string')) throw new Error('invalid expectedActors');
  const predictedResult = record.predictedResult as Record<string, unknown>;
  if (typeof predictedResult?.summary !== 'string' || predictedResult.summary.length > MAX_SUMMARY) throw new Error('invalid predictedResult.summary');
  if (!Array.isArray(predictedResult.acceptanceSignals) || predictedResult.acceptanceSignals.some((x) => typeof x !== 'string')) throw new Error('invalid acceptanceSignals');
  if (!Array.isArray(predictedResult.predictedFiles) || predictedResult.predictedFiles.some((x) => typeof x !== 'string')) throw new Error('invalid predictedFiles');
  return {
    aHat: {
      plan: record.plan as string[],
      expectedTools: record.expectedTools as string[],
      expectedActors: record.expectedActors as string[],
    },
    rHat: {
      summary: predictedResult.summary,
      acceptanceSignals: predictedResult.acceptanceSignals as string[],
      predictedFiles: predictedResult.predictedFiles as string[],
    },
    predictedRisks: [],
  };
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
): Promise<WorldModelForecast> {
  if (!hasConfiguredModel().configured) {
    throw new Error('world model simulation requires a configured model');
  }

  const predictedRisks = applyCausalRules(snapshot, bareCausalRules(input.k.rules));

  const { runner } = await buildRunner({
    sessionId: `kstar-forecast-${snapshot.taskRunId}`,
    userId,
    systemPrompt: forecastSystemPrompt(),
    disableTools: true,
    ephemeralSession: true,
    skillList: [],
  });
  const riskBlock = predictedRisks.length
    ? `\n\nKnown risk constraints (do not contradict these):\n${JSON.stringify(predictedRisks.map((r) => ({ cause: r.cause, effect: r.effect, mitigation: r.mitigation, severity: r.severity })))}`
    : '';
  const result = await runner.run({
    message: JSON.stringify({
      k: input.k,
      s: input.s,
      t: input.t,
    }) + riskBlock,
    thinkingLevel: 'off',
    cacheRetention: 'none',
  });
  if (result.meta.aborted || result.meta.error) throw new Error('world model unavailable');
  const forecast = parseForecast(result.text);
  return { ...forecast, predictedRisks };
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
