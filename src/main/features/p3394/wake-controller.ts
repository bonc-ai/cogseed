import { createLogger } from "../../logger";
import { enqueue } from "../group_chat/bus";
import {
  COMMANDER_ID,
  USER_ID,
  setActiveRecipient,
  setOrchestrationLedger,
} from "../group_chat/state";
import { getAgent } from "../agents";
import { isAgentEnabled } from "../component_enabled";
import {
  approveWakeRequest,
  getWakeRequest,
  markWakeRequestExecuted,
  rejectWakeRequest,
  resetWakeApproval,
} from "./wake-service";
import type { AgentWakeRequest } from "./types";

const log = createLogger("p3394.wake-controller");

export interface DecideWakeRequestInput {
  requestId: string;
  decision: "approve" | "reject";
  reason?: string;
}

export type DecideWakeRequestResult =
  | { ok: true; request: AgentWakeRequest; dispatched: boolean }
  | { ok: false; error: string };

/**
 * Applies the human decision and, on approval, resumes the saved intent through
 * Orkas's existing group-chat enqueue choke point. This module never creates a
 * parallel Agent runtime or Conversation message store.
 */
export async function decideWakeRequest(
  userId: string,
  input: DecideWakeRequestInput,
): Promise<DecideWakeRequestResult> {
  try {
    const existing = await getWakeRequest(userId, input.requestId);
    if (!existing) return { ok: false, error: "wake request not found" };

    if (input.decision === "reject") {
      const request = await rejectWakeRequest(
        userId,
        input.requestId,
        input.reason,
      );
      return { ok: true, request, dispatched: false };
    }

    const target = await getAgent(existing.agent_id);
    if (!target || !isAgentEnabled(userId, existing.agent_id)) {
      return { ok: false, error: "wake target agent is unavailable" };
    }

    const { request } = await approveWakeRequest(userId, input.requestId);
    const fromActorId =
      request.source === "user_mention" || request.source === "ui_select"
        ? USER_ID
        : COMMANDER_ID;

    try {
      const admitted = await enqueue({
        uid: userId,
        cid: request.conversation_id,
        fromActorId,
        text: request.dispatch_payload.text,
        ...(request.dispatch_payload.model_text
          ? { model_text: request.dispatch_payload.model_text }
          : {}),
        ...(request.dispatch_payload.attachments?.length
          ? { attachments: [...request.dispatch_payload.attachments] }
          : {}),
        forceTo: [request.agent_id],
        ...(fromActorId === USER_ID ? { dispatch: true } : {}),
        ...(request.workflow_step_id
          ? { workflow_step_id: request.workflow_step_id }
          : {}),
      });
      if (
        !Array.isArray(admitted.to) ||
        !admitted.to.includes(request.agent_id)
      ) {
        throw new Error("wake enqueue did not admit the target agent");
      }
    } catch (err) {
      await resetWakeApproval(
        userId,
        request.id,
        `Wake enqueue failed: ${(err as Error).message}`,
      );
      throw err;
    }

    // Restore interactive hand-off state only after queue admission succeeds.
    if (
      request.source === "hand_off_to" &&
      request.resume_instruction?.trim() &&
      target.interactive === true
    ) {
      await setActiveRecipient(
        userId,
        request.conversation_id,
        request.agent_id,
      );
      await setOrchestrationLedger(userId, request.conversation_id, {
        status: "waiting_for_agent",
        blocked_on: "agent_handoff",
        source_tool: "hand_off_to",
        owner_agent_id: request.agent_id,
        ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}),
        user_goal: request.objective,
        handoff_message: request.dispatch_payload.text,
        resume_instruction: request.resume_instruction,
      });
    }

    const executed = await markWakeRequestExecuted(userId, input.requestId);
    return { ok: true, request: executed, dispatched: true };
  } catch (err) {
    log.error(
      `wake decision failed request=${input.requestId}: ${(err as Error).message}`,
    );
    return { ok: false, error: (err as Error).message || String(err) };
  }
}
