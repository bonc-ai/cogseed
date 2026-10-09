import { createLogger } from '../../logger';
import { getAgentDispatchPolicy, getAgentForChatDispatch, isAgentChatDispatchable } from '../agents';
import { isAgentEnabled } from '../component_enabled';
import { approveWakeRequest, getWakeRequest, markWakeRequestExecuted, rejectWakeRequest, resetWakeApproval } from './wake-service';
import type { AgentWakeRequest } from './types';
import type { WakeDispatcher } from './wake-dispatcher';
import type { WakeAssetConfirmationSnapshot } from './types';
import { commitHandoffState } from '../group_chat/state';

const log = createLogger('p3394.wake-controller');
export interface DecideWakeRequestInput { requestId: string; decision: 'approve' | 'reject'; reason?: string; assetConfirmationSnapshot?: WakeAssetConfirmationSnapshot }
export type DecideWakeRequestResult = { ok: true; request: AgentWakeRequest; dispatched: boolean } | { ok: false; error: string };
export interface DecideWakeRequestDeps { dispatcher?: WakeDispatcher; validateTarget?: (userId: string, agentId: string) => Promise<boolean> }

async function defaultDispatcher(request: AgentWakeRequest): Promise<WakeDispatcher> {
  if (request.execution_domain && request.execution_domain !== 'cogseed' && request.execution_domain !== 'group_chat') {
    throw new Error(`unsupported wake execution domain: ${request.execution_domain}`);
  }
  return (await import('../cogseed_backend/p3394-wake-dispatcher')).cogseedWakeDispatcher;
}

export async function decideWakeRequest(userId: string, input: DecideWakeRequestInput, deps: DecideWakeRequestDeps = {}): Promise<DecideWakeRequestResult> {
  try {
    const existing = await getWakeRequest(userId, input.requestId); if (!existing) return { ok: false, error: 'wake request not found' };
    if (input.decision === 'reject') return { ok: true, request: await rejectWakeRequest(userId, input.requestId, input.reason), dispatched: false };
    // Product agents are interactive: preserve the original handoff semantics
    // even though execution now runs in CogSeed Backend.
    let targetInteractive = true;
    if (deps.validateTarget) {
      if (!(await deps.validateTarget(userId, existing.agent_id))) return { ok: false, error: 'wake target agent is unavailable' };
    } else {
      const policy = await getAgentDispatchPolicy(userId, existing.agent_id);
      if (!isAgentChatDispatchable(policy) || !isAgentEnabled(userId, existing.agent_id)) return { ok: false, error: 'wake target agent is unavailable' };
      const target = await getAgentForChatDispatch(userId, existing.agent_id);
      if (!isAgentChatDispatchable(target) || !isAgentEnabled(userId, existing.agent_id)) return { ok: false, error: 'wake target agent is unavailable' };
      // Agent execution is backend-owned; interactive is a conversation
      // routing semantic and defaults to true for product agents.
      void target;
    }
    const { request } = await approveWakeRequest(userId, input.requestId, input.assetConfirmationSnapshot ? { assetConfirmationSnapshot: input.assetConfirmationSnapshot } : {});
    try {
      await (deps.dispatcher ?? await defaultDispatcher(request)).dispatch(userId, request, { targetInteractive });
      if (targetInteractive && request.source === 'hand_off_to') {
        await commitHandoffState(userId, request.conversation_id, {
          recipient_id: request.agent_id,
          ledger: {
            status: 'waiting_for_agent',
            blocked_on: 'agent_handoff',
            source_tool: 'hand_off_to',
            owner_agent_id: request.agent_id,
            ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}),
            user_goal: request.objective,
            handoff_message: request.dispatch_payload.text,
            resume_instruction: request.resume_instruction?.trim() || `After ${request.agent_name || request.agent_id} completes, continue the original Commander task.`,
          },
        });
      }
    } catch (error) {
      await resetWakeApproval(userId, request.id, `Wake dispatch failed: ${(error as Error).message}`);
      throw error;
    }
    return { ok: true, request: await markWakeRequestExecuted(userId, input.requestId), dispatched: true };
  } catch (error) { log.error(`wake decision failed request=${input.requestId}: ${(error as Error).message}`); return { ok: false, error: (error as Error).message || String(error) }; }
}
