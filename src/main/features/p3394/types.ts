export type WakeSource =
  | 'user_mention'
  | 'dispatch_to'
  | 'hand_off_to'
  | 'run_worker'
  | 'plan_step'
  | 'resume'
  | 'ui_select';

export type WakeRequestStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';
export type WakeApprovalStatus = 'active' | 'revoked' | 'expired';

export interface WakeDispatchPayload {
  text: string;
  model_text?: string;
  attachments?: string[];
  references?: Array<{ source_cid: string; source_msg_id: string }>;
}

export interface AgentWakeRequest {
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
}

export interface WakeApproval {
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
}

export interface WakeState {
  version: 1;
  requests: AgentWakeRequest[];
  approvals: WakeApproval[];
  updated_at: string;
}

export interface EvaluateWakeInput {
  conversationId: string;
  taskId?: string;
  agentId: string;
  agentName?: string;
  source: WakeSource;
  sourceActorId: string;
  sourceMessageId?: string;
  objective: string;
  dispatchPayload: WakeDispatchPayload;
}

export type WakeEvaluation =
  | { approved: true; approval: WakeApproval }
  | { approved: false; request: AgentWakeRequest };
