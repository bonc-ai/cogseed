import type { KStarDecisionRecord } from '../kstar/dispatch-decision';

export type WakeSource =
  | "user_mention"
  | "dispatch_to"
  | "hand_off_to"
  | "run_worker"
  | "plan_step"
  | "resume"
  | "ui_select";

export type WakeRequestStatus =
  "pending" | "approved" | "rejected" | "executed" | "expired";
export type WakeApprovalStatus = "active" | "revoked" | "expired";
export interface WakeAssetConfirmationSnapshot {
  projection_id: string;
  wake_request_id: string;
  projection_status: 'confirmed';
  confirmed_at: string;
  asset_ids: string[];
  asset_versions: Record<string, string>;
  task_run_id: string;
  conversation_id: string;
}

export interface WakeDispatchPayload {
  text: string;
  model_text?: string;
  attachments?: string[];
  references?: Array<{ source_cid: string; source_msg_id: string }>;
}

export type WakeExecutionDomain = 'group_chat' | 'mate';

export interface AgentWakeRequest {
  execution_domain?: WakeExecutionDomain;
  execution_scope_id?: string;
  id: string;
  conversation_id: string;
  task_id?: string;
  agent_id: string;
  agent_name?: string;
  source: WakeSource;
  source_actor_id: string;
  source_message_id?: string;
  objective: string;
  context_scope: string[];
  behavior_scope: WakeSource[];
  dispatch_payload: WakeDispatchPayload;
  status: WakeRequestStatus;
  decision_reason?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  executed_at?: string;
  /** Commander-owned continuation to restore if a wake-gated hand_off_to is approved. */
  resume_instruction?: string;
  /** Bound collaboration workflow step for exact-once nested dispatch lifecycle. */
  workflow_step_id?: string;
  workflow_resume_token?: string;
  pending_cleanup_step_ids?: string[];
  workflow_transition?: "rejecting" | "approving";
  asset_confirmation_snapshot?: WakeAssetConfirmationSnapshot;
  /** Commander-selected KSTAR evidence contract restored after approval. */
  kstar_decision?: KStarDecisionRecord;
}

export interface WakeApproval {
  execution_domain?: WakeExecutionDomain;
  execution_scope_id?: string;
  id: string;
  request_id: string;
  conversation_id: string;
  task_id?: string;
  agent_id: string;
  context_scope: string[];
  behavior_scope: WakeSource[];
  status: WakeApprovalStatus;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  asset_confirmation_snapshot?: WakeAssetConfirmationSnapshot;
}

export interface WakeState {
  version: 1;
  requests: AgentWakeRequest[];
  approvals: WakeApproval[];
  updated_at: string;
}

export interface EvaluateWakeInput {
  executionDomain?: WakeExecutionDomain;
  executionScopeId?: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  agentName?: string;
  source: WakeSource;
  sourceActorId: string;
  sourceMessageId?: string;
  objective: string;
  dispatchPayload: WakeDispatchPayload;
  resumeInstruction?: string;
  workflow_step_id?: string;
  workflow_resume_token?: string;
  kstar_decision?: KStarDecisionRecord;
}

export type WakeEvaluation =
  | {
      approved: true;
      approval: WakeApproval;
      /** The same approved dispatch is already queued/running; do not run it again. */
      duplicate_request?: AgentWakeRequest;
    }
  | { approved: false; request: AgentWakeRequest };
