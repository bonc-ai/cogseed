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

import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { hasConfiguredModel } from '../auth';
import type {
  CausalRule,
  PredictedRisk,
  WorldModelForecast,
  WorldModelPredicateKey,
  WorldModelSimulationInput,
  WorldModelSnapshot,
} from './world-model-types';

const log = createLogger('recall.world-model');

const MAX_CAUSE = 200;
const MAX_EFFECT = 500;
const MAX_MITIGATION = 1_000;
const MAX_SUMMARY = 4_000;

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid causal rule ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid causal rule ${field}`);
  return text;
}

const VALID_PREDICATES = new Set<WorldModelPredicateKey>([
  'workspace_unavailable',
  'model_not_configured',
  'bash_unavailable',
  'skills_missing',
  'too_few_skills',
  'too_few_rules',
  'no_active_assets',
]);

/** Validate and normalize a stored causal rule. */
export function normalizeCausalRule(value: unknown): CausalRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid causal rule');
  }
  const record = value as Record<string, unknown>;
  if (
    record.predicateKey !== undefined
    && !VALID_PREDICATES.has(record.predicateKey as WorldModelPredicateKey)
  ) throw new Error('invalid causal rule predicate');
  if (record.deltaR !== 'unknown' && (typeof record.deltaR !== 'number' || !Number.isFinite(record.deltaR) || record.deltaR < -1 || record.deltaR > 1)) {
    throw new Error('invalid causal rule deltaR');
  }
  if (record.severity !== 'high' && record.severity !== 'medium' && record.severity !== 'low') {
    throw new Error('invalid causal rule severity');
  }
  return {
    cause: bounded(record.cause, 'cause', MAX_CAUSE),
    ...(record.predicateKey !== undefined ? { predicateKey: record.predicateKey as WorldModelPredicateKey } : {}),
    effect: bounded(record.effect, 'effect', MAX_EFFECT),
    mitigation: bounded(record.mitigation, 'mitigation', MAX_MITIGATION),
    severity: record.severity as CausalRule['severity'],
    deltaR: record.deltaR as CausalRule['deltaR'],
  };
}

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
  const predictedRisks = applyCausalRules(snapshot, input.k.rules);

  if (!hasConfiguredModel().configured) {
    return {
      aHat: { plan: [], expectedTools: [], expectedActors: [] },
      rHat: { summary: '', acceptanceSignals: [], predictedFiles: [] },
      predictedRisks,
    };
  }

  try {
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
        k: { abilityAssetRefs: input.k.abilityAssetRefs },
        s: input.s,
        t: input.t,
      }) + riskBlock,
      thinkingLevel: 'off',
      cacheRetention: 'none',
    });
    if (result.meta.aborted || result.meta.error) throw new Error('world model unavailable');
    const forecast = parseForecast(result.text);
    return { ...forecast, predictedRisks };
  } catch (error) {
    log.warn('world model simulation degraded to deterministic forecast', {
      taskRunId: snapshot.taskRunId,
      error: (error as Error).message,
    });
    return {
      aHat: { plan: [], expectedTools: [], expectedActors: [] },
      rHat: { summary: '', acceptanceSignals: [], predictedFiles: [] },
      predictedRisks,
    };
  }
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
    id: `snap-${input.taskRunId}`,
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
