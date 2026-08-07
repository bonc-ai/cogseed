import { enqueue } from './bus';
import { COMMANDER_ID, USER_ID, setActiveRecipient, setOrchestrationLedger } from './state';
import type { WakeDispatcher } from '../p3394/wake-dispatcher';

function continuation(name: string) { return `After ${name || 'the agent'} completes, continue the original Commander task, use the agent's result, and execute any remaining requested stages.`; }
export const groupChatWakeDispatcher: WakeDispatcher = {
  async dispatch(userId, request, context) {
    const fromActorId = request.source === 'user_mention' || request.source === 'ui_select' ? USER_ID : COMMANDER_ID;
    const admitted = await enqueue({ uid: userId, cid: request.conversation_id, fromActorId, text: request.dispatch_payload.text, ...(request.dispatch_payload.model_text ? { model_text: request.dispatch_payload.model_text } : {}), ...(request.dispatch_payload.attachments?.length ? { attachments: [...request.dispatch_payload.attachments] } : {}), forceTo: [request.agent_id], ...(fromActorId === USER_ID ? { dispatch: true } : {}), ...(request.workflow_step_id ? { workflow_step_id: request.workflow_step_id } : {}), ...(request.kstar_decision?.required ? { kstarDecision: request.kstar_decision } : {}) });
    if (!Array.isArray(admitted.to) || !admitted.to.includes(request.agent_id)) throw new Error('wake enqueue did not admit the target agent');
    if (request.source === 'dispatch_to' || request.source === 'run_worker') await setOrchestrationLedger(userId, request.conversation_id, { status: 'waiting_for_agent', blocked_on: 'agent_handoff', source_tool: request.source, owner_agent_id: request.agent_id, ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}), user_goal: request.objective, handoff_message: request.dispatch_payload.text, resume_instruction: request.resume_instruction?.trim() || continuation(request.agent_name || request.agent_id) });
    if (request.source === 'hand_off_to' && request.resume_instruction?.trim() && context.targetInteractive) {
      await setActiveRecipient(userId, request.conversation_id, request.agent_id);
      await setOrchestrationLedger(userId, request.conversation_id, { status: 'waiting_for_agent', blocked_on: 'agent_handoff', source_tool: 'hand_off_to', owner_agent_id: request.agent_id, ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}), user_goal: request.objective, handoff_message: request.dispatch_payload.text, resume_instruction: request.resume_instruction });
    }
  },
};
