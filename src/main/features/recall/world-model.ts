/**
 * World-model host helpers `f(K, S, T) -> (A_hat, R_hat)`.
 *
 * The Commander is the only cognitive actor: it proposes Forecast candidates
 * through kstar_control.commit_forecast and the host validates, rescoring and
 * persists them (forecast-commit.ts). This module keeps only the host-owned
 * deterministic layer: causal-rule risk prediction (Hermes F002 equivalent),
 * world snapshots, and Forecast record persistence. No model runner is
 * constructed here.
 */

import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import { genId12 } from '../../storage';
import { normalizeCausalRule } from './world-model-types';
export { reconcileWorldModel } from './world-model-reconciliation';
export type { WorldModelReconciliationOptions } from './world-model-reconciliation';

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
