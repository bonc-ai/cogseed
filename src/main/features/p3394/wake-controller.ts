import { createLogger } from '../../logger';
import { getAgentDispatchPolicy, getAgentForChatDispatch, isAgentChatDispatchable } from '../agents';
import { isAgentEnabled } from '../component_enabled';
import { approveWakeRequest, getWakeRequest, markWakeRequestExecuted, rejectWakeRequest, resetWakeApproval } from './wake-service';
import type { AgentWakeRequest } from './types';
import type { WakeDispatcher } from './wake-dispatcher';
import type { WakeAssetConfirmationSnapshot } from './types';

const log = createLogger('p3394.wake-controller');
export interface DecideWakeRequestInput { requestId: string; decision: 'approve' | 'reject'; reason?: string; assetConfirmationSnapshot?: WakeAssetConfirmationSnapshot }
export type DecideWakeRequestResult = { ok: true; request: AgentWakeRequest; dispatched: boolean } | { ok: false; error: string };
export interface DecideWakeRequestDeps { dispatcher?: WakeDispatcher; validateTarget?: (userId: string, agentId: string) => Promise<boolean> }

async function defaultDispatcher(request: AgentWakeRequest): Promise<WakeDispatcher> {
  if (request.execution_domain === 'mate') return (await import('../mate_agent_backend/p3394-wake-dispatcher')).mateWakeDispatcher;
  return (await import('../group_chat/p3394-wake-dispatcher')).groupChatWakeDispatcher;
}

export async function decideWakeRequest(userId: string, input: DecideWakeRequestInput, deps: DecideWakeRequestDeps = {}): Promise<DecideWakeRequestResult> {
  try {
    const existing = await getWakeRequest(userId, input.requestId); if (!existing) return { ok: false, error: 'wake request not found' };
    if (input.decision === 'reject') return { ok: true, request: await rejectWakeRequest(userId, input.requestId, input.reason), dispatched: false };
    let targetInteractive = false;
    if (deps.validateTarget) {
      if (!(await deps.validateTarget(userId, existing.agent_id))) return { ok: false, error: 'wake target agent is unavailable' };
    } else {
      const policy = await getAgentDispatchPolicy(userId, existing.agent_id);
      if (!isAgentChatDispatchable(policy) || !isAgentEnabled(userId, existing.agent_id)) return { ok: false, error: 'wake target agent is unavailable' };
      const target = await getAgentForChatDispatch(userId, existing.agent_id);
      if (!isAgentChatDispatchable(target) || !isAgentEnabled(userId, existing.agent_id)) return { ok: false, error: 'wake target agent is unavailable' };
      targetInteractive = target.interactive === true;
    }
    const { request } = await approveWakeRequest(userId, input.requestId, input.assetConfirmationSnapshot ? { assetConfirmationSnapshot: input.assetConfirmationSnapshot } : {});
    try { await (deps.dispatcher ?? await defaultDispatcher(request)).dispatch(userId, request, { targetInteractive }); }
    catch (error) { await resetWakeApproval(userId, request.id, `Wake dispatch failed: ${(error as Error).message}`); throw error; }
    return { ok: true, request: await markWakeRequestExecuted(userId, input.requestId), dispatched: true };
  } catch (error) { log.error(`wake decision failed request=${input.requestId}: ${(error as Error).message}`); return { ok: false, error: (error as Error).message || String(error) }; }
}
