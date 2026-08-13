/**
 * World-model ontology: T-Box / A-Box / R-Box.
 *
 * The ontology is the knowledge base (K) of the KSTAR loop. It is NOT the
 * world-model simulation itself; it is the structured knowledge that the
 * simulation function `f(K,S,T) -> (A_hat, R_hat)` reads when predicting both
 * the future self (intervention) and the future world (result state).
 */

import type { RecallJsonRecord } from './types';

/** Severity of a causal rule. */
export type CausalRuleSeverity = 'high' | 'medium' | 'low';

/**
 * R-Box causal rule stored on a Recall ability asset.
 *
 * This is a delta_r lesson that has been frozen into a reusable rule. It has
 * the Hermes cause -> effect -> mitigation shape rather than free-form prose.
 */
export interface CausalRule {
  /** The triggering condition or situation (human-readable). */
  cause: string;
  /** Optional deterministic predicate key used to match the rule against an
   *  A-Box snapshot. When absent, the rule participates only in the LLM
   *  simulation layer, not the deterministic F002 risk pass. */
  predicateKey?: WorldModelPredicateKey;
  /** The predicted failure or consequence when `cause` is present. */
  effect: string;
  /** How to prevent or recover from `effect`. */
  mitigation: string;
  severity: CausalRuleSeverity;
  /** The result delta that produced (or last validated) this rule. */
  deltaR: number | 'unknown';
}

/** Built-in A-Box predicates used by the deterministic F002 risk pass. */
export type WorldModelPredicateKey =
  | 'workspace_unavailable'
  | 'model_not_configured'
  | 'bash_unavailable'
  | 'skills_missing'
  | 'too_few_skills'
  | 'too_few_rules'
  | 'no_active_assets';

/** T-Box world state categories. */
export interface WorldModelEnvironmentState {
  workspace: { ok: boolean; path?: string };
  model: { configured: boolean; profile?: string };
  tools: { fileSystem: boolean; bash: boolean };
}

export interface WorldModelCoreState {
  groupChat: { status: 'idle' | 'running' | 'aborted' };
  kstar?: { requirementStatus?: string };
  recall?: { projectionStatus?: string };
}

export interface WorldModelSkillsState {
  total: number;
  categories: string[];
  status: 'ok' | 'empty' | 'missing' | 'unknown';
}

export interface WorldModelOntologyState {
  totalAssets: number;
  activeAssets: number;
  totalRules: number;
}

/** A-Box: a concrete world-state snapshot. */
export interface WorldModelSnapshot {
  schemaVersion: 1;
  ownerId: string;
  id: string;
  taskRunId: string;
  environment: WorldModelEnvironmentState;
  core: WorldModelCoreState;
  skills: WorldModelSkillsState;
  ontology: WorldModelOntologyState;
  createdAt: string;
}

/** A predicted risk produced by applying R-Box rules to an A-Box snapshot. */
export interface PredictedRisk {
  ruleId: string;
  cause: string;
  effect: string;
  mitigation: string;
  severity: CausalRuleSeverity;
  deltaR: number | 'unknown';
}

/** The world-model simulation output: (A_hat, R_hat) generated together. */
export interface WorldModelForecast {
  /** A_hat = predicted self / intervention sequence. */
  aHat: {
    plan: string[];
    expectedTools: string[];
    expectedActors: string[];
  };
  /** R_hat = predicted world / result state. */
  rHat: {
    summary: string;
    acceptanceSignals: string[];
    predictedFiles: string[];
  };
  /** Deterministic risks matched from the R-Box before LLM simulation. */
  predictedRisks: PredictedRisk[];
}

/** Inputs to the world-model simulation f(K, S, T). */
export interface WorldModelSimulationInput {
  /** K = ontology snapshot (ability assets that form the knowledge base). */
  k: {
    abilityAssetRefs: string[];
    rules: CausalRule[];
  };
  /** S = current situation snapshot. */
  s: {
    workspaceId?: string;
    conversationSummary: string;
  };
  /** T = task to forecast. */
  t: {
    userGoal: string;
    constraints: string[];
  };
}

/** Persisted world-model forecast record. */
export interface WorldModelForecastRecord extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  requirementId: string;
  input: WorldModelSimulationInput;
  forecast: WorldModelForecast;
  createdAt: string;
}
