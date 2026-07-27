// ============================================================
// Meta-Skill Engine Configuration
// Implements constraints from NSEAP Meta-Skill Standard v1.0
// ============================================================

export const ENGINE_CONFIG = {
  // ── Identity Contract (Meta-Skill Standard Book 2) ──────
  identity: {
    skill_class: 'meta_skill' as const,
    is_skill_of_skill: true,
    operates_on: ['Skill', 'OntologySlice', 'EvalCase', 'Workflow', 'Policy', 'MetaSkill'] as const,
    promotion_ceiling: 'staged' as const,
    production_release_allowed: false as const,
  },

  // ── Recursive Guardrails ────────────────────────────────
  recursive_guard: {
    max_self_patch_ops: 1,           // stricter than spec (<=2)
    max_self_patch_depth: 1,
    self_patch_must_pass_gates: ['Validation Gate', 'Governance Gate', 'Canary Gate'] as const,
    rejected_self_patch_buffered: true,
  },

  // ── Bounded Edit Budget ─────────────────────────────────
  edit_budget: {
    max_operations: 2,               // per patch proposal
    mutable_surfaces: ['config_keys', 'threshold_weights', 'strategy_switches'] as const,
    protected_surfaces: ['formal_rule_structures', 'HITL_requirements', 'audit_mechanisms'] as const,
  },

  // ── Three-Gate Pipeline ─────────────────────────────────
  gates: {
    fixed_order: ['Validation Gate', 'Governance Gate', 'Canary Gate'] as const,
    rejected_buffer_append_only: true,
  },

  // ── Risk Levels ─────────────────────────────────────────
  risk_levels: {
    L0: { description: 'Text/examples only, no behavioral change', auto_staged: true },
    L1: { description: 'Prompt/rubric minor change, no permission expansion', needs_eval: true },
    L2: { description: 'Skill steps/tool/workflow changes', needs_replay: true },
    L3: { description: 'Ontology/rule/policy changes', needs_expert_review: true },
    L4: { description: 'Production data/external writes', auto_publish_blocked: true },
  },

  // ── Compliance Thresholds ───────────────────────────────
  compliance: {
    registration_min: { evals: 10, negative_cases: 4 },
    release_eval: { evals: 20, failure_cases: 5, learning_records: 10, patch_proposals: 3 },
  },

  // ── Evidence Chain (no broken links) ────────────────────
  traceability_chain: [
    'baseline_skill@hash',
    'baseline_run_id',
    'evidence_bundle_id',
    'kstar_episode_id',
    'attribution_id',
    'patch_proposal_id',
    'replay_report_id',
    'human_decision_id',
    'registry_staging_receipt_id',
  ] as const,
} as const;

export type EngineConfig = typeof ENGINE_CONFIG;
