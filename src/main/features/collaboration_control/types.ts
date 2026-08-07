export type WorkflowRunKind =
  "discussion" | "implementation" | "review" | "custom";
export type WorkflowRunStatus =
  "created" | "running" | "blocked" | "failed" | "completed" | "cancelled";
export type WorkflowStepType =
  | "prompt"
  | "discussion_round"
  | "implementation"
  | "test"
  | "review"
  | "gate"
  | "summary"
  | "dispatch";
export type WorkflowStepStatus =
  "pending" | "running" | "blocked" | "failed" | "completed" | "skipped";
export type WorkflowAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkflowAttemptFailureCode =
  | "coordinator_tool_idle"
  | "coordinator_agent_idle"
  | "runtime_failed"
  | "dependency_failed";
export type WorkflowAttemptActorKind = "agent" | "anonymous_worker";
export type GateStatus = "passed" | "failed" | "needs_review";
export type ContextItemSource =
  "user" | "agent" | "code" | "artifact" | "system" | "spec";
export type ContextConfidence = "low" | "medium" | "high";
export type ContextProposalKind = "fact" | "decision" | "recommendation";
export type ContextProposalStatus =
  "pending" | "accepted" | "rejected" | "superseded";
export type ContextConflictType =
  | "fact"
  | "recommendation"
  | "implementation"
  | "quality"
  | "preference"
  | "safety";
export type ContextConflictStatus =
  | "detected"
  | "gathering_evidence"
  | "under_review"
  | "awaiting_user"
  | "resolved"
  | "dismissed";

export interface ContextProposal {
  id: string;
  conflict_key: string;
  kind: ContextProposalKind;
  text: string;
  reason?: string;
  evidence_refs: string[];
  confidence: ContextConfidence;
  proposed_by: string;
  status: ContextProposalStatus;
  created_at: string;
  resolved_at?: string;
}

export interface ContextConflictResolution {
  decision: "accept" | "reject" | "merge";
  selected_proposal_ids: string[];
  text: string;
  reason?: string;
  resolved_by: string;
  resolved_at: string;
}

export interface ContextConflict {
  id: string;
  conflict_key: string;
  type: ContextConflictType;
  status: ContextConflictStatus;
  proposal_ids: string[];
  affected_step_ids: string[];
  resolution?: ContextConflictResolution;
  created_at: string;
  updated_at: string;
}

export interface OutputContract {
  kind:
    | "analysis"
    | "plan"
    | "implementation_result"
    | "test_result"
    | "review_result"
    | "discussion_opinion"
    | "dispatch_result";
  required_fields: string[];
  optional_fields?: string[];
  artifact_required?: boolean;
}

export interface WorkflowAttempt {
  attempt: number;
  actor_id: string | null;
  actor_kind: WorkflowAttemptActorKind;
  actor_name?: string;
  status: WorkflowAttemptStatus;
  failure_code?: WorkflowAttemptFailureCode;
  started_at: string;
  completed_at?: string;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  title: string;
  actor_id: string | null;
  type: WorkflowStepType;
  status: WorkflowStepStatus;
  depends_on: string[];
  context_dependencies?: string[];
  blocked_by_conflict_ids?: string[];
  expected_output?: OutputContract;
  result_ref?: string;
  result_summary?: string;
  gate_result_id?: string;
  source_tool?: "dispatch_to" | "hand_off_to" | "run_worker";
  /** Exact nested-dispatch intent used to validate Wake/resume reuse. */
  dispatch_intent?: string;
  objective?: string;
  actor_name?: string;
  actor_kind?: WorkflowAttemptActorKind;
  original_actor_id?: string | null;
  current_actor_id?: string | null;
  required_capabilities?: string[];
  access_mode?: "read" | "write";
  write_scopes?: string[];
  attempts?: WorkflowAttempt[];
  resume_token?: string;
  started_at?: string;
  completed_at?: string;
}

export interface WorkflowRun {
  version: 1;
  id: string;
  cid: string;
  objective: string;
  kind: WorkflowRunKind;
  status: WorkflowRunStatus;
  phase: string;
  steps: WorkflowStep[];
  context_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveWorkflowFile {
  version: 1;
  run_id: string;
  context_id: string;
  updated_at: string;
}

export interface ContextItem {
  id: string;
  text: string;
  source: ContextItemSource;
  source_ref?: string;
  confidence: ContextConfidence;
  added_by: string;
  created_at: string;
}

export interface DecisionItem extends ContextItem {
  reason?: string;
}

export interface RiskItem extends ContextItem {
  severity: "low" | "medium" | "high";
}

export interface ArtifactRef {
  id: string;
  type: string;
  path?: string;
  summary?: string;
  added_by: string;
  created_at: string;
}

export interface AgentOutputSummary {
  actor_id: string;
  step_id: string;
  summary: string;
  created_at: string;
}

export interface GateCheck {
  name: string;
  status: GateStatus;
  reason?: string;
}

export type GateReviewDecision = "approved" | "rejected";

export interface GateResult {
  id: string;
  run_id: string;
  step_id: string;
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  reason?: string;
  blocks_workflow?: boolean;
  review_decision?: GateReviewDecision;
  reviewed_by?: string;
  reviewed_at?: string;
  review_reason?: string;
  created_at: string;
}

export interface SharedTaskContext {
  version: 1;
  id: string;
  cid: string;
  run_id: string;
  objective: string;
  phase: string;
  revision: number;
  constraints: ContextItem[];
  facts: ContextItem[];
  decisions: DecisionItem[];
  open_questions: ContextItem[];
  risks: RiskItem[];
  artifacts: ArtifactRef[];
  agent_outputs: Record<string, AgentOutputSummary>;
  gates: GateResult[];
  proposals: ContextProposal[];
  conflicts: ContextConflict[];
  updated_at: string;
}

export type CollaborationEventType =
  | "workflow_created"
  | "workflow_planned"
  | "workflow_resumed"
  | "workflow_aborted"
  | "step_retried"
  | "step_skipped"
  | "step_started"
  | "step_completed"
  | "handoff_finalization_failed"
  | "step_attempt_started"
  | "step_attempt_finished"
  | "gate_recorded"
  | "gate_reviewed"
  | "context_patch_applied"
  | "proposal_recorded"
  | "conflict_detected"
  | "conflict_status_updated"
  | "context_revision_mismatch"
  | "conflict_resolved"
  | "events_replayed"
  | "discussion_recorded";

export interface CollaborationEvent {
  version: 1;
  id: string;
  cid: string;
  run_id: string;
  context_id?: string;
  type: CollaborationEventType;
  actor_id?: string | null;
  step_id?: string;
  gate_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

