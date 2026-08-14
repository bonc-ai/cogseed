/**
 * World-model ontology: T-Box / A-Box / R-Box.
 *
 * The ontology is the knowledge base (K) of the KSTAR loop. It is NOT the
 * world-model simulation itself; it is the structured knowledge that the
 * simulation function `f(K,S,T) -> (A_hat, R_hat)` reads when predicting both
 * the future self (intervention) and the future world (result state).
 */

import type { RecallJsonRecord } from './types';
import type { AbilityAssetType, RecallAbilityAssetRecord } from './candidate-service';
import type { AbilityAssetOntologyRef } from './ontology-refs';
import type { CognitionSourceRef } from './source-service';
import type { KstarLearningSignal } from '../kstar/types';

/** Severity of a causal rule. */
export type CausalRuleSeverity = 'high' | 'medium' | 'low';

/**
 * R-Box causal rule stored on a Recall ability asset.
 *
 * This is a delta_r lesson that has been frozen into a reusable rule. It has
 * the Hermes cause -> effect -> mitigation shape rather than free-form prose.
 */
export interface WorldModelAbilityAsset {
  id: string;
  version: string;
  title: string;
  type: AbilityAssetType;
  statement: string;
  scope: string;
  maturity: RecallAbilityAssetRecord['maturity'];
  learningSignal?: KstarLearningSignal;
  causalRule?: CausalRule;
  ontologyRefs: AbilityAssetOntologyRef[];
  evidenceRefs: CognitionSourceRef[];
}

export interface WorldModelCausalRuleRef {
  id: string;
  assetId: string;
  assetVersion: string;
  rule: CausalRule;
}

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

export interface WorldModelIntervention {
  plan: string[];
  expectedTools: string[];
  expectedActors: string[];
}

export interface WorldModelPredictedResult {
  summary: string;
  acceptanceSignals: string[];
  predictedFiles: string[];
}

export interface WorldModelCausalLink {
  interventionIndex: number;
  mechanism: string;
  ruleRefs: string[];
  assumptions: string[];
}

export interface WorldModelCandidateScore {
  goalFit: number;
  feasibility: number;
  observability: number;
  causalSupport: number;
  riskPenalty: number;
  total: number;
}

export interface WorldModelCandidateForecast {
  id: string;
  aHat: WorldModelIntervention;
  rHat: WorldModelPredictedResult;
  causalLinks: WorldModelCausalLink[];
  assumptions: string[];
  predictedRisks: PredictedRisk[];
  score: WorldModelCandidateScore;
  /** Original model order for deterministic final tie-breaking. */
  modelOrder: number;
}

/** The world-model simulation output: (A_hat, R_hat) generated together. */
export interface WorldModelForecast {
  aHat: WorldModelIntervention;
  rHat: WorldModelPredictedResult;
  predictedRisks: PredictedRisk[];
  /** New Forecasts preserve all alternatives; legacy records may omit them. */
  candidates?: WorldModelCandidateForecast[];
  selectedCandidateId?: string;
  causalLinks?: WorldModelCausalLink[];
  assumptions?: string[];
}

export interface WorldModelKnowledge {
  /** Present for strong-consistency Forecasts; omitted only by legacy records. */
  projectionId?: string;
  projectionConfirmedAt?: string;
  abilityAssetRefs: string[];
  abilityAssets?: WorldModelAbilityAsset[];
  assetVersions?: Record<string, string>;
  /** Legacy records store bare rules; new records store versioned rule refs. */
  rules: Array<CausalRule | WorldModelCausalRuleRef>;
  /**
   * Ontology assets — the user's durable personal facts/preferences held in
   * memory (USER.md / MEMORY.md), modeled as `personal` ability assets.
   * Unlike abilityAssets they are NOT projection-selected: they are loaded
   * unconditionally so the world model reasons over the user's identity.
   */
  ontologyAssets?: WorldModelAbilityAsset[];
  /**
   * R-Box (ontology) — the user's durable business rules / mappings derived
   * from relation fields (isRelation: true, `A → B` values) across the
   * Personal Ontology. Persistent and slow-changing; joins the world-model
   * R-Box alongside asset CausalRules (which are the ΔR lessons).
   */
  ontologyRules?: Array<{
    id: string;
    groupId: string;
    groupTitle: string;
    field: string;
    subject: string;
    relation: string;
    object: string;
  }>;
  /**
   * T-Box — the ontology concept definitions (group ledger + field
   * vocabulary) assets point at via ontologyRefs. Loaded fresh at forecast
   * time; carries vocabulary, not field values.
   */
  ontologyTaxonomy?: {
    groups: Array<{
      groupId: string;
      title: string;
      templateId?: string;
      templateVersion?: string;
      fields: Array<{
        name: string;
        isRelation?: boolean;
        description?: string;
      }>;
    }>;
  };
}

export interface WorldModelSituation {
  snapshotId?: string;
  workspaceId?: string;
  conversationSummary: string;
  environment?: {
    workspaceAvailable: boolean;
    modelConfigured: boolean;
    fileSystemAvailable: boolean;
    shellAvailable: boolean;
  };
  execution?: {
    groupChatStatus: 'idle' | 'running' | 'aborted';
    availableActors: string[];
    availableTools?: string[];
    accessConstraints: string[];
    energyConstraints: string[];
  };
  lifecycle?: {
    requirementStatus?: string;
    projectionStatus: 'confirmed';
  };
  recall?: {
    selectedAssetCount: number;
    selectedRuleCount: number;
  };
}

export interface WorldModelTask {
  userGoal: string;
  constraints: string[];
  acceptanceCriteria?: string[];
}

/** Inputs to the world-model simulation f(K, S, T). */
export interface WorldModelSimulationInput {
  k: WorldModelKnowledge;
  s: WorldModelSituation;
  t: WorldModelTask;
}

/** Persisted world-model forecast record. */
export interface ActionDeltaDetail {
  missingTools: string[];
  unexpectedTools: string[];
  missingActors: string[];
  unexpectedActors: string[];
  missingPlanSteps: string[];
  extraActions: string[];
  failedActions: string[];
  orderMismatch: boolean;
}

export interface AcceptanceSignalResult {
  signal: string;
  status: 'met' | 'not_met' | 'unknown';
  evidence: string;
}

export interface ResultDeltaDetail {
  acceptanceSignals: AcceptanceSignalResult[];
  missingPredictedFiles: string[];
  unexpectedProducedFiles: string[];
  terminalStatus: 'completed' | 'failed' | 'cancelled' | 'waiting_input';
}

export interface WorldModelReconciliation {
  deltaA: number | 'unknown';
  deltaR: number | 'unknown';
  attribution: 'knowledge_gap' | 'rule_gap' | 'template_gap' | 'skill_gap' | 'execution_gap' | 'unclear';
  actionDelta: ActionDeltaDetail;
  resultDelta: ResultDeltaDetail;
}

export interface WorldModelForecastRecord extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  requirementId: string;
  /** Strong-consistency provenance. Legacy records may omit these fields. */
  projectionId?: string;
  projectionConfirmedAt?: string;
  assetVersions?: Record<string, string>;
  ruleRefs?: string[];
  snapshotId?: string;
  provenanceComplete?: boolean;
  input: WorldModelSimulationInput;
  forecast: WorldModelForecast;
  createdAt: string;
}


// ── Pure validation (kept dependency-free so callers like candidate-service
//    can import it without pulling in the LLM runner) ──────────────────────

const CAUSAL_RULE_VALID_PREDICATES = new Set<WorldModelPredicateKey>([
  'workspace_unavailable',
  'model_not_configured',
  'bash_unavailable',
  'skills_missing',
  'too_few_skills',
  'too_few_rules',
  'no_active_assets',
]);

/** Validate and normalize a stored causal rule (R-Box entry). */
export function normalizeCausalRule(value: unknown): CausalRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid causal rule');
  }
  const record = value as Record<string, unknown>;
  if (
    record.predicateKey !== undefined
    && !CAUSAL_RULE_VALID_PREDICATES.has(record.predicateKey as WorldModelPredicateKey)
  ) throw new Error('invalid causal rule predicate');
  if (
    record.deltaR !== 'unknown'
    && (typeof record.deltaR !== 'number' || !Number.isFinite(record.deltaR) || record.deltaR < -1 || record.deltaR > 1)
  ) throw new Error('invalid causal rule deltaR');
  if (record.severity !== 'high' && record.severity !== 'medium' && record.severity !== 'low') {
    throw new Error('invalid causal rule severity');
  }
  const cause = typeof record.cause === 'string' ? record.cause.replace(/\s+/g, ' ').trim() : '';
  const effect = typeof record.effect === 'string' ? record.effect.replace(/\s+/g, ' ').trim() : '';
  const mitigation = typeof record.mitigation === 'string' ? record.mitigation.replace(/\s+/g, ' ').trim() : '';
  if (!cause || cause.length > 200) throw new Error('invalid causal rule cause');
  if (!effect || effect.length > 500) throw new Error('invalid causal rule effect');
  if (!mitigation || mitigation.length > 1000) throw new Error('invalid causal rule mitigation');
  return {
    cause,
    ...(record.predicateKey !== undefined ? { predicateKey: record.predicateKey as WorldModelPredicateKey } : {}),
    effect,
    mitigation,
    severity: record.severity as CausalRule['severity'],
    deltaR: record.deltaR as CausalRule['deltaR'],
  };
}
