import { createLogger } from '../../logger';
import { genId12, nowIso, safeId } from '../../storage';
import { mutateWakeState, readWakeState } from './wake-store';
import type {
  AgentWakeRequest,
  EvaluateWakeInput,
  WakeApproval,
  WakeEvaluation,
  WakeState,
} from './types';

const log = createLogger('p3394.wake');

function requireId(value: string, field: string): void {
  if (!safeId(value)) throw new Error(`invalid ${field}`);
}

function isApprovalActive(approval: WakeApproval, now = Date.now()): boolean {
  if (approval.status !== 'active') return false;
  if (!approval.expires_at) return true;
  const expires = Date.parse(approval.expires_at);
  return Number.isFinite(expires) && expires > now;
}

function matchingApproval(state: WakeState, input: EvaluateWakeInput): WakeApproval | null {
  return state.approvals.find((approval) => (
    approval.conversation_id === input.conversationId
    && approval.agent_id === input.agentId
    && approval.behavior_scope.includes(input.source)
    && approval.context_scope.includes(`conversation:${input.conversationId}`)
    && isApprovalActive(approval)
  )) || null;
}

function samePendingIntent(request: AgentWakeRequest, input: EvaluateWakeInput): boolean {
  return request.status === 'pending'
    && request.conversation_id === input.conversationId
    && request.agent_id === input.agentId
    && request.source === input.source
    && request.source_actor_id === input.sourceActorId
    && request.objective === input.objective;
}

export async function evaluateWake(userId: string, input: EvaluateWakeInput): Promise<WakeEvaluation> {
  requireId(userId, 'user id');
  requireId(input.conversationId, 'conversation id');
  requireId(input.agentId, 'agent id');
  if (!input.objective.trim()) throw new Error('wake objective is required');
  if (!input.dispatchPayload.text.trim()) throw new Error('wake dispatch text is required');

  return mutateWakeState(userId, (state) => {
    const approval = matchingApproval(state, input);
    if (approval) return { approved: true, approval } as const;

    const existing = state.requests.find((request) => samePendingIntent(request, input));
    if (existing) return { approved: false, request: existing } as const;

    const now = nowIso();
    const request: AgentWakeRequest = {
      id: genId12(),
      conversation_id: input.conversationId,
      ...(input.taskId ? { task_id: input.taskId } : {}),
      agent_id: input.agentId,
      ...(input.agentName?.trim() ? { agent_name: input.agentName.trim() } : {}),
      source: input.source,
      source_actor_id: input.sourceActorId,
      ...(input.sourceMessageId ? { source_message_id: input.sourceMessageId } : {}),
      objective: input.objective.trim(),
      context_scope: [`conversation:${input.conversationId}`],
      behavior_scope: [input.source],
      dispatch_payload: {
        text: input.dispatchPayload.text,
        ...(input.dispatchPayload.model_text ? { model_text: input.dispatchPayload.model_text } : {}),
        ...(input.dispatchPayload.attachments?.length ? { attachments: [...input.dispatchPayload.attachments] } : {}),
        ...(input.dispatchPayload.references?.length ? { references: [...input.dispatchPayload.references] } : {}),
      },
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    state.requests.push(request);
    log.info(`wake-request-created user=${userId} cid=${input.conversationId} agent=${input.agentId} source=${input.source}`);
    return { approved: false, request } as const;
  });
}

export async function listWakeRequests(userId: string, conversationId?: string): Promise<AgentWakeRequest[]> {
  const state = await readWakeState(userId);
  return state.requests
    .filter((request) => !conversationId || request.conversation_id === conversationId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getWakeRequest(userId: string, requestId: string): Promise<AgentWakeRequest | null> {
  requireId(requestId, 'wake request id');
  const state = await readWakeState(userId);
  return state.requests.find((request) => request.id === requestId) || null;
}

export async function approveWakeRequest(
  userId: string,
  requestId: string,
): Promise<{ request: AgentWakeRequest; approval: WakeApproval }> {
  requireId(requestId, 'wake request id');
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error('wake request not found');
    if (request.status !== 'pending' && request.status !== 'approved') {
      throw new Error(`wake request cannot be approved from ${request.status}`);
    }
    const now = nowIso();
    request.status = 'approved';
    request.updated_at = now;
    request.decided_at = request.decided_at || now;
    let approval = state.approvals.find((item) => item.request_id === request.id);
    if (!approval) {
      approval = {
        id: genId12(),
        request_id: request.id,
        conversation_id: request.conversation_id,
        ...(request.task_id ? { task_id: request.task_id } : {}),
        agent_id: request.agent_id,
        context_scope: [...request.context_scope],
        behavior_scope: [...request.behavior_scope],
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      state.approvals.push(approval);
    }
    log.info(`wake-request-approved user=${userId} request=${requestId} agent=${request.agent_id}`);
    return { request, approval };
  });
}

export async function rejectWakeRequest(
  userId: string,
  requestId: string,
  reason?: string,
): Promise<AgentWakeRequest> {
  requireId(requestId, 'wake request id');
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error('wake request not found');
    if (request.status !== 'pending') throw new Error(`wake request cannot be rejected from ${request.status}`);
    const now = nowIso();
    request.status = 'rejected';
    request.updated_at = now;
    request.decided_at = now;
    if (reason?.trim()) request.decision_reason = reason.trim();
    return request;
  });
}

export async function markWakeRequestExecuted(userId: string, requestId: string): Promise<AgentWakeRequest> {
  requireId(requestId, 'wake request id');
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error('wake request not found');
    if (request.status !== 'approved' && request.status !== 'executed') {
      throw new Error(`wake request cannot execute from ${request.status}`);
    }
    if (request.status === 'executed') return request;
    const now = nowIso();
    request.status = 'executed';
    request.updated_at = now;
    request.executed_at = now;
    return request;
  });
}
