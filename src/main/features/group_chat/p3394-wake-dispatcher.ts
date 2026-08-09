import { enqueue } from './bus';
import { COMMANDER_ID, USER_ID, setActiveRecipient, setOrchestrationLedger } from './state';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';
import type { AgentWakeRequest } from '../p3394/types';
import { bindKstarRequirementWakeRequest } from '../kstar/requirement-state';

function continuation(name: string) { return `After ${name || 'the agent'} completes, continue the original Commander task, use the agent's result, and execute any remaining requested stages.`; }

function kstarDispatchNarrationText(request: AgentWakeRequest): string {
  const exp = request.kstar_decision?.expectation;
  const agent = request.agent_name || request.agent_id;
  const task = exp?.task || request.objective || request.dispatch_payload.text;
  const actionHat = exp?.action_hat || '由目标 Agent 执行任务并收集可复核证据，完成后交回 Commander 复核。';
  const resultHat = exp?.result_hat || '获得一份可复核的任务结果，并明确产物、完成情况与剩余差距。';
  const situation = exp?.situation ? `${exp.situation}；任务：${task}` : `任务：${task}`;
  return [
    `授权已确认。我现在用 S / A / R 声明这次交给 ${agent} 的协作预期。`,
    `S：当前任务状态 / 已确认上下文：${situation}`,
    `A：执行计划 / 方法：${actionHat}`,
    `R：预期结果：${resultHat}`,
  ].join('\n');
}

function isKstarCommanderDispatch(request: AgentWakeRequest): boolean {
  return request.kstar_decision?.required === true
    && (request.source === 'dispatch_to' || request.source === 'hand_off_to' || request.source === 'run_worker');
}

async function bindKstarWakeRequestAfterApproval(userId: string, request: AgentWakeRequest): Promise<void> {
  if (!isKstarCommanderDispatch(request)) return;
  const projectionId = request.asset_confirmation_snapshot?.projection_id;
  if (!projectionId) throw new Error('kstar wake request has no confirmed projection');
  await bindKstarRequirementWakeRequest(userId, {
    conversationId: request.conversation_id,
    projectionId,
    wakeRequestId: request.id,
  });
}

async function announceKstarAfterWakeApproval(userId: string, request: AgentWakeRequest): Promise<void> {
  if (!request.kstar_decision?.required) return;
  if (request.source !== 'dispatch_to' && request.source !== 'hand_off_to' && request.source !== 'run_worker') return;
  await enqueue({
    uid: userId,
    cid: request.conversation_id,
    fromActorId: COMMANDER_ID,
    forceTo: [USER_ID],
    text: kstarDispatchNarrationText(request),
    kstar_dispatch_narration: {
      target_agent_id: request.agent_id,
      ...(request.workflow_step_id ? { workflow_step_id: request.workflow_step_id } : {}),
    },
  });
}

export const groupChatWakeDispatcher: WakeDispatcher = {
  async dispatch(userId, request, context) {
    const fromActorId = request.source === 'user_mention' || request.source === 'ui_select' ? USER_ID : COMMANDER_ID;
    if (fromActorId === COMMANDER_ID) {
      await bindKstarWakeRequestAfterApproval(userId, request);
      await announceKstarAfterWakeApproval(userId, request);
    }
    const admitted = await enqueue({ uid: userId, cid: request.conversation_id, fromActorId, text: request.dispatch_payload.text, ...(request.dispatch_payload.model_text ? { model_text: request.dispatch_payload.model_text } : {}), ...(request.dispatch_payload.attachments?.length ? { attachments: [...request.dispatch_payload.attachments] } : {}), forceTo: [request.agent_id], ...(fromActorId === USER_ID ? { dispatch: true } : {}), ...(request.workflow_step_id ? { workflow_step_id: request.workflow_step_id } : {}), ...(request.kstar_decision?.required ? { kstarDecision: request.kstar_decision } : {}), ...(request.kstar_decision?.required && request.asset_confirmation_snapshot ? { kstarTerminalProvenance: { logicalRunId: request.asset_confirmation_snapshot.task_run_id, executionId: request.id, projectionId: request.asset_confirmation_snapshot.projection_id, wakeRequestId: request.id } } : {}) });
    if (!Array.isArray(admitted.to) || !admitted.to.includes(request.agent_id)) throw new Error('wake enqueue did not admit the target agent');
    if (request.source === 'dispatch_to' || request.source === 'run_worker') await setOrchestrationLedger(userId, request.conversation_id, { status: 'waiting_for_agent', blocked_on: 'agent_handoff', source_tool: request.source, owner_agent_id: request.agent_id, ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}), user_goal: request.objective, handoff_message: request.dispatch_payload.text, resume_instruction: request.resume_instruction?.trim() || continuation(request.agent_name || request.agent_id) });
    if (request.source === 'hand_off_to' && request.resume_instruction?.trim() && context.targetInteractive) {
      await setActiveRecipient(userId, request.conversation_id, request.agent_id);
      await setOrchestrationLedger(userId, request.conversation_id, { status: 'waiting_for_agent', blocked_on: 'agent_handoff', source_tool: 'hand_off_to', owner_agent_id: request.agent_id, ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}), user_goal: request.objective, handoff_message: request.dispatch_payload.text, resume_instruction: request.resume_instruction });
    }
  },
};
