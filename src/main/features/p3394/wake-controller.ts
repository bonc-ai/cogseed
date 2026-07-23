import { createLogger } from '../../logger';
import { enqueue } from '../group_chat/bus';
import { COMMANDER_ID, USER_ID } from '../group_chat/state';
import {
  approveWakeRequest,
  getWakeRequest,
  markWakeRequestExecuted,
  rejectWakeRequest,
} from './wake-service';
import type { AgentWakeRequest } from './types';

const log = createLogger('p3394.wake-controller');

export interface DecideWakeRequestInput {
  requestId: string;
  decision: 'approve' | 'reject';
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
    if (!existing) return { ok: false, error: 'wake request not found' };

    if (input.decision === 'reject') {
      const request = await rejectWakeRequest(userId, input.requestId, input.reason);
      return { ok: true, request, dispatched: false };
    }

    const { request } = await approveWakeRequest(userId, input.requestId);
    const fromActorId = request.source === 'user_mention' || request.source === 'ui_select'
      ? USER_ID
      : COMMANDER_ID;
    await enqueue({
      uid: userId,
      cid: request.conversation_id,
      fromActorId,
      text: request.dispatch_payload.text,
      ...(request.dispatch_payload.model_text ? { model_text: request.dispatch_payload.model_text } : {}),
      ...(request.dispatch_payload.attachments?.length
        ? { attachments: [...request.dispatch_payload.attachments] }
        : {}),
      forceTo: [request.agent_id],
      dispatch: true,
    });
    const executed = await markWakeRequestExecuted(userId, input.requestId);
    return { ok: true, request: executed, dispatched: true };
  } catch (err) {
    log.error(`wake decision failed request=${input.requestId}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message || String(err) };
  }
}
