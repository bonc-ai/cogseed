// ============================================================
// NSEAP Meta-Skill Engine — Core Type Definitions
// Based on KSTAR methodology (arXiv:2308.03990) and NSEAP standards v1.0
// ============================================================

// ── KSTAR Five-Tuple ────────────────────────────────────────
export interface KSTAREpisode {
  episode_id: string;
  bundle_id: string;
  k_snapshot_ref: string;       // Knowledge: ontology snapshot reference
  situation: string;            // Situation: context/scenario
  task: string;                 // Task: what needed to be done
  action_hat: string;           // Predicted action (Â)
  result_hat: string;           // Predicted result (R̂)
  actual_action: string;        // What was actually done
  actual_result: string;        // What actually happened
  delta_r: number;              // DeltaR = actual - predicted result (core learning signal)
  delta_a: number;              // DeltaA = predicted vs actual action deviation (trust gate)
  delta_a_confidence_gate: 'pass' | 'warn' | 'fail';
  timestamp: string;
  session_id: string;
  user_id: string;
  attribution_refs: string[];
  patch_refs: string[];
}

// ── Ontology Types ──────────────────────────────────────────
export interface OntologyClass {
  id: string;
  label: string;
  description: string;
  alternative_labels?: string[];
  class_kind: string;
  grain: string;
  identifier_properties?: string[];
  parent?: string;                    // 类层级关系（如 CoursePaper → AcademicPaper）
  query_entry?: boolean;              // 是否为 Agent 查询入口
  annotations?: Record<string, any>;  // 额外注解
}

export interface OntologyRule {
  id: string;
  type: string;
  name: string;
  description: string;
  applies_to: { classes: string[]; properties?: string[] };
  condition: { when: string; user_expressions?: string[]; user_exceptions?: string[] };
  action: { type: string; instruction: string };
  severity: 'blocking' | 'warning' | 'info';
  evidence?: Array<{ text: string; source: string }>;
  confidence: number;
  review_required?: boolean;          // 是否需要人工审核
}

export interface OntologyExample {
  id: string;
  name?: string;                      // 示例名称
  type: 'positive_fewshot' | 'negative_fewshot' | 'reasoning_drill' | 'clarification_example';
  user_query: string;
  expected_understanding: string;
  expected_query_plan?: string[];     // 预期查询计划（推理步骤）
  expected_behavior: { status: string; explanation: string; referenced_rbox_rules?: string[] };
  evidence?: string;                  // 示例依据
  confidence?: number;                // 置信度
}

export interface OntologyIndividual {
  individual_id: string;
  class: string;
  assertions: Array<{ property: string; value: string }>;
}

export interface OntologySlice {
  tbox: OntologyClass[];
  rbox: OntologyRule[];
  abox: OntologyExample[];
  individuals?: OntologyIndividual[];  // ABox 实例事实
}

export interface OntologyManifest {
  id: string;
  iri: string;
  version: string;
  title: string;
  description: string;
  file_path: string;
}

// ── SkillPackage Types ──────────────────────────────────────
export interface SkillRef {
  skill_id: string;
  skill_name: string;
  skill_version: string;
  skill_path: string;
  ontology_refs: string[];
  status: 'staged' | 'production' | 'draft' | 'rejected';
  level: 0 | 1 | 2 | 3 | 4 | 5;
}

export interface SkillPackage {
  ref: SkillRef;
  nine_element_contract: {
    trigger_semantics: { use_when: string[]; do_not_use_when: string[] };
    business_context_mapping: { relevant_tbox: string[]; applicable_rbox: string[]; current_abox: string[] };
    executable_workflow: string;
    tool_resource_binding: string[];
    validation_contract: string;
    eval_replay_regression_contract: string;
    failure_attribution: string;
    kstar_evolution_hook: string;
    governance_boundaries: { non_claims: string[] };
  };
}

// ── Patch Types ─────────────────────────────────────────────
export type PatchType =
  | 'SkillPatch'
  | 'OntologyPatch'
  | 'EvalPatch'
  | 'WorkflowPatch'
  | 'ToolConfigPatch'
  | 'PolicyPatch'
  | 'MetaSkillPatch'
  | 'MemoryPatch';

export type PatchTarget = 'TBox' | 'RBox' | 'ABox' | 'Skill' | 'ToolBinding' | 'Workflow' | 'Eval' | 'Policy' | 'MetaSkill';

export interface PatchProposal {
  proposal_id: string;
  type: PatchType;
  target: PatchTarget;
  target_id: string;            // skill_id or ontology_id
  target_version: string;
  diff_ref: string;             // reference to the diff
  description: string;
  before_hash: string;
  after_hash: string;
  operation_count: number;      // <= 2 (bounded edit budget)
  mutable_surface: boolean;     // true = safe to patch, false = protected
  evidence_refs: string[];      // episode_ids supporting this patch
  risk_level: 0 | 1 | 2 | 3 | 4;
  expected_improvement: string;
  rollback_plan: string;
  status: 'proposed' | 'validation_passed' | 'governance_passed' | 'canary_passed' | 'staged' | 'rejected';
  governance_fields: GovernanceFields;
}

// ── Governance ──────────────────────────────────────────────
export interface GovernanceFields {
  schema_version: string;
  source_mode: 'real' | 'desensitized' | 'synthetic' | 'manual' | 'stub';
  authority_level: 'draft' | 'proposal' | 'reviewed' | 'approved' | 'released';
  owner_team: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  author_team: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  approver_team: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | null;
  source_refs: string[];
  evidence_refs: string[];
  artifact_hash: string;
  data_boundary: 'internal' | 'desensitized' | 'customer_private' | 'synthetic' | 'rehearsal';
  export_allowed: boolean;
  non_claim_note: string;
}

// ── Interaction Context ─────────────────────────────────────
export interface InteractionContext {
  session_id: string;
  user_id: string;
  user_query: string;
  agent_id: string;
  matched_skill_id: string | null;
  matched_skill_name: string | null;
  ontology_refs: string[];
  timestamp: string;
  conversation_history: Array<{ role: 'user' | 'agent'; content: string }>;
}

// ── Evidence Bundle ─────────────────────────────────────────
export interface EvidenceBundle {
  bundle_id: string;
  episode_id: string;
  interaction: InteractionContext;
  kstar: KSTAREpisode;
  ontology_snapshots: Array<{ ontology_id: string; version: string; slice: OntologySlice }>;
  skill_snapshots: Array<{ skill_id: string; version: string; path: string }>;
  governance: GovernanceFields;
}

// ── Registry ────────────────────────────────────────────────
export interface RegistryEntry {
  artifact_id: string;
  artifact_type: 'skill' | 'ontology' | 'episode' | 'patch' | 'bundle';
  version: string;
  status: string;
  path: string;
  hash: string;
  updated_at: string;
}
