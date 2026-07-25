import { createLogger } from "../../logger";
import { genId12, nowIso, safeId } from "../../storage";
import { mutateWakeState, readWakeState } from "./wake-store";
import {
  cancelPreparedNestedDispatchStep,
  readActiveWorkflowRun,
} from "../group_chat/collaboration";
import type {
  AgentWakeRequest,
  EvaluateWakeInput,
  WakeApproval,
  WakeEvaluation,
  WakeState,
} from "./types";

const log = createLogger("p3394.wake");

function requireId(value: string, field: string): void {
  if (!safeId(value)) throw new Error(`invalid ${field}`);
}

function isApprovalActive(approval: WakeApproval, now = Date.now()): boolean {
  if (approval.status !== "active") return false;
  if (!approval.expires_at) return true;
  const expires = Date.parse(approval.expires_at);
  return Number.isFinite(expires) && expires > now;
}

function matchingApproval(
  state: WakeState,
  input: EvaluateWakeInput,
): WakeApproval | null {
  return (
    state.approvals.find(
      (approval) =>
        approval.conversation_id === input.conversationId &&
        approval.agent_id === input.agentId &&
        approval.behavior_scope.includes(input.source) &&
        approval.context_scope.includes(
          `conversation:${input.conversationId}`,
        ) &&
        isApprovalActive(approval),
    ) || null
  );
}

function normalizeIntentText(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function behaviorScopeForSource(
  source: EvaluateWakeInput["source"],
): EvaluateWakeInput["source"][] {
  return source === "hand_off_to" ? ["hand_off_to", "user_mention"] : [source];
}

function scopesOverlap(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  const set = new Set(left && left.length ? left : []);
  return right.some((item) => set.has(item));
}

function samePendingIntent(
  request: AgentWakeRequest,
  input: EvaluateWakeInput,
): boolean {
  const incomingScope = behaviorScopeForSource(input.source);
  return (
    request.status === "pending" &&
    request.conversation_id === input.conversationId &&
    request.agent_id === input.agentId &&
    normalizeIntentText(request.objective) ===
      normalizeIntentText(input.objective) &&
    scopesOverlap(
      request.behavior_scope?.length
        ? request.behavior_scope
        : [request.source],
      incomingScope,
    )
  );
}

function mergePendingIntent(
  request: AgentWakeRequest,
  input: EvaluateWakeInput,
): AgentWakeRequest {
  const scope = new Set([
    ...(request.behavior_scope || [request.source]),
    ...behaviorScopeForSource(input.source),
  ]);
  request.behavior_scope = Array.from(scope);
  if (input.agentName?.trim() && !request.agent_name)
    request.agent_name = input.agentName.trim();
  if (input.resumeInstruction?.trim() && !request.resume_instruction)
    request.resume_instruction = input.resumeInstruction.trim();
  if (!request.workflow_step_id && input.workflow_step_id) {
    request.workflow_step_id = input.workflow_step_id;
    if (input.workflow_resume_token)
      request.workflow_resume_token = input.workflow_resume_token;
  } else if (
    request.workflow_step_id === input.workflow_step_id &&
    !request.workflow_resume_token &&
    input.workflow_resume_token
  ) {
    request.workflow_resume_token = input.workflow_resume_token;
  }
  request.updated_at = nowIso();
  return request;
}

function requestNeedsWorkflowReconciliation(
  request: AgentWakeRequest,
): boolean {
  return !!(
    request.pending_cleanup_step_ids?.length ||
    request.workflow_transition === "rejecting" ||
    (request.workflow_transition === "approving" && request.workflow_step_id) ||
    (request.status === "rejected" && request.workflow_step_id)
  );
}

async function reconcileWakeRequestWorkflow(
  userId: string,
  requestId: string,
): Promise<AgentWakeRequest> {
  return mutateWakeState(userId, async (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("wake request not found");
    const cleanupIds = Array.from(
      new Set(request.pending_cleanup_step_ids || []),
    );
    for (const stepId of cleanupIds) {
      await cancelPreparedNestedDispatchStep(
        userId,
        request.conversation_id,
        stepId,
        "Superseded by the existing pending Wake request.",
      );
    }
    if (cleanupIds.length) delete request.pending_cleanup_step_ids;

    if (
      request.workflow_transition === "approving" &&
      request.workflow_step_id
    ) {
      const run = await readActiveWorkflowRun(userId, request.conversation_id);
      const step = run?.steps.find(
        (candidate) => candidate.id === request.workflow_step_id,
      );
      if (!step || step.status === "pending" || step.status === "blocked") {
        const now = nowIso();
        request.status = "pending";
        request.updated_at = now;
        delete request.workflow_transition;
        for (const approval of state.approvals.filter(
          (item) => item.request_id === request.id && item.status === "active",
        )) {
          approval.status = "revoked";
          approval.updated_at = now;
        }
        return request;
      }
      if (
        step.status === "running" ||
        step.status === "completed" ||
        step.status === "failed" ||
        step.status === "skipped"
      ) {
        const now = nowIso();
        request.status = "executed";
        request.executed_at = request.executed_at || now;
        request.updated_at = now;
        delete request.workflow_transition;
        return request;
      }
    }

    if (
      request.workflow_transition === "rejecting" ||
      request.status === "rejected"
    ) {
      if (request.workflow_step_id) {
        await cancelPreparedNestedDispatchStep(
          userId,
          request.conversation_id,
          request.workflow_step_id,
          request.decision_reason || "Wake request rejected.",
        );
      }
      const now = nowIso();
      request.status = "rejected";
      request.updated_at = now;
      request.decided_at = request.decided_at || now;
      delete request.workflow_transition;
    }
    return request;
  });
}

async function reconcileWakeTransitions(
  userId: string,
  conversationId?: string,
): Promise<void> {
  const state = await readWakeState(userId);
  const requestIds = state.requests
    .filter(
      (request) =>
        (!conversationId || request.conversation_id === conversationId) &&
        requestNeedsWorkflowReconciliation(request),
    )
    .map((request) => request.id);
  for (const requestId of requestIds)
    await reconcileWakeRequestWorkflow(userId, requestId);
}

export async function evaluateWake(
  userId: string,
  input: EvaluateWakeInput,
): Promise<WakeEvaluation> {
  requireId(userId, "user id");
  requireId(input.conversationId, "conversation id");
  requireId(input.agentId, "agent id");
  if (!input.objective.trim()) throw new Error("wake objective is required");
  if (!input.dispatchPayload.text.trim())
    throw new Error("wake dispatch text is required");

  await reconcileWakeTransitions(userId, input.conversationId);
  const result = await mutateWakeState(userId, (state) => {
    const approval = matchingApproval(state, input);
    if (approval) return { approved: true, approval } as const;

    const existing = state.requests.find((request) =>
      samePendingIntent(request, input),
    );
    if (existing) {
      if (
        input.workflow_step_id &&
        existing.workflow_step_id &&
        existing.workflow_step_id !== input.workflow_step_id
      ) {
        existing.pending_cleanup_step_ids = Array.from(
          new Set([
            ...(existing.pending_cleanup_step_ids || []),
            input.workflow_step_id,
          ]),
        );
      }
      return {
        approved: false,
        request: mergePendingIntent(existing, input),
      } as const;
    }

    const now = nowIso();
    const request: AgentWakeRequest = {
      id: genId12(),
      conversation_id: input.conversationId,
      ...(input.taskId ? { task_id: input.taskId } : {}),
      agent_id: input.agentId,
      ...(input.agentName?.trim()
        ? { agent_name: input.agentName.trim() }
        : {}),
      source: input.source,
      source_actor_id: input.sourceActorId,
      ...(input.sourceMessageId
        ? { source_message_id: input.sourceMessageId }
        : {}),
      objective: input.objective.trim(),
      context_scope: [`conversation:${input.conversationId}`],
      behavior_scope: behaviorScopeForSource(input.source),
      dispatch_payload: {
        text: input.dispatchPayload.text,
        ...(input.dispatchPayload.model_text
          ? { model_text: input.dispatchPayload.model_text }
          : {}),
        ...(input.dispatchPayload.attachments?.length
          ? { attachments: [...input.dispatchPayload.attachments] }
          : {}),
        ...(input.dispatchPayload.references?.length
          ? { references: [...input.dispatchPayload.references] }
          : {}),
      },
      status: "pending",
      ...(input.resumeInstruction?.trim()
        ? { resume_instruction: input.resumeInstruction.trim() }
        : {}),
      ...(input.workflow_step_id
        ? { workflow_step_id: input.workflow_step_id }
        : {}),
      ...(input.workflow_resume_token
        ? { workflow_resume_token: input.workflow_resume_token }
        : {}),
      created_at: now,
      updated_at: now,
    };
    state.requests.push(request);
    log.info(
      `wake-request-created user=${userId} cid=${input.conversationId} agent=${input.agentId} source=${input.source}`,
    );
    return { approved: false, request } as const;
  });
  if (result.approved) return result;
  const request = await reconcileWakeRequestWorkflow(userId, result.request.id);
  return { approved: false, request };
}

export async function listWakeRequests(
  userId: string,
  conversationId?: string,
): Promise<AgentWakeRequest[]> {
  await reconcileWakeTransitions(userId, conversationId);
  const state = await readWakeState(userId);
  return state.requests
    .filter(
      (request) =>
        !conversationId || request.conversation_id === conversationId,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getWakeRequest(
  userId: string,
  requestId: string,
): Promise<AgentWakeRequest | null> {
  requireId(requestId, "wake request id");
  const raw = await readWakeState(userId);
  const existing = raw.requests.find((request) => request.id === requestId);
  if (existing && requestNeedsWorkflowReconciliation(existing)) {
    await reconcileWakeRequestWorkflow(userId, requestId);
  }
  const state = await readWakeState(userId);
  return state.requests.find((request) => request.id === requestId) || null;
}

export async function approveWakeRequest(
  userId: string,
  requestId: string,
): Promise<{ request: AgentWakeRequest; approval: WakeApproval }> {
  requireId(requestId, "wake request id");
  await reconcileWakeTransitions(userId);
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("wake request not found");
    if (request.status !== "pending" && request.status !== "approved") {
      throw new Error(`wake request cannot be approved from ${request.status}`);
    }
    const now = nowIso();
    request.status = "approved";
    request.workflow_transition = "approving";
    request.updated_at = now;
    request.decided_at = request.decided_at || now;
    let approval = state.approvals.find(
      (item) => item.request_id === request.id,
    );
    if (!approval) {
      approval = {
        id: genId12(),
        request_id: request.id,
        conversation_id: request.conversation_id,
        ...(request.task_id ? { task_id: request.task_id } : {}),
        agent_id: request.agent_id,
        context_scope: [...request.context_scope],
        behavior_scope: [...request.behavior_scope],
        status: "active",
        created_at: now,
        updated_at: now,
      };
      state.approvals.push(approval);
    } else {
      approval.status = "active";
      approval.updated_at = now;
    }
    log.info(
      `wake-request-approved user=${userId} request=${requestId} agent=${request.agent_id}`,
    );
    return { request, approval };
  });
}

export async function rejectWakeRequest(
  userId: string,
  requestId: string,
  reason?: string,
): Promise<AgentWakeRequest> {
  requireId(requestId, "wake request id");
  await reconcileWakeTransitions(userId);
  const staged = await mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("wake request not found");
    if (request.status === "rejected") return request;
    if (request.status !== "pending")
      throw new Error(`wake request cannot be rejected from ${request.status}`);
    request.workflow_transition = "rejecting";
    if (reason?.trim()) request.decision_reason = reason.trim();
    request.updated_at = nowIso();
    return request;
  });
  try {
    return await reconcileWakeRequestWorkflow(userId, staged.id);
  } catch (err) {
    try {
      await resetWakeApproval(userId, staged.id, reason);
    } catch (rollbackErr) {
      log.warn(
        `wake rejection rollback failed request=${requestId}: ${(rollbackErr as Error).message}`,
      );
    }
    throw err;
  }
}

export async function resetWakeApproval(
  userId: string,
  requestId: string,
  reason?: string,
): Promise<AgentWakeRequest> {
  requireId(requestId, "wake request id");
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("wake request not found");
    const now = nowIso();
    request.status = "pending";
    delete request.workflow_transition;
    request.updated_at = now;
    delete request.decided_at;
    delete request.executed_at;
    if (reason?.trim()) request.decision_reason = reason.trim();
    for (const approval of state.approvals.filter(
      (item) => item.request_id === requestId && item.status === "active",
    )) {
      approval.status = "revoked";
      approval.updated_at = now;
    }
    return request;
  });
}

export async function markWakeRequestExecuted(
  userId: string,
  requestId: string,
): Promise<AgentWakeRequest> {
  requireId(requestId, "wake request id");
  return mutateWakeState(userId, (state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error("wake request not found");
    if (request.status !== "approved" && request.status !== "executed") {
      throw new Error(`wake request cannot execute from ${request.status}`);
    }
    if (request.status === "executed") return request;
    const now = nowIso();
    request.status = "executed";
    delete request.workflow_transition;
    request.updated_at = now;
    request.executed_at = now;
    return request;
  });
}
