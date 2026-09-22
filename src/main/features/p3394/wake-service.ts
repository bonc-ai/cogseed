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
  WakeAssetConfirmationSnapshot,
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
        (approval.execution_domain || 'group_chat') === (input.executionDomain || 'group_chat') &&
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

function normalizeAbilityAssetIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24)
    throw new Error("invalid wake ability asset ids");
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (!safeId(id)) throw new Error("invalid wake ability asset id");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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

function sameIntent(
  request: AgentWakeRequest,
  input: EvaluateWakeInput,
): boolean {
  const incomingScope = behaviorScopeForSource(input.source);
  return (
    request.conversation_id === input.conversationId &&
    (request.execution_domain || 'group_chat') === (input.executionDomain || 'group_chat') &&
    request.agent_id === input.agentId &&
    request.dispatch_payload.run_id === input.dispatchPayload.run_id &&
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

function samePendingIntent(
  request: AgentWakeRequest,
  input: EvaluateWakeInput,
): boolean {
  return request.status === "pending" && sameIntent(request, input);
}

function canHaveQueuedWakeDispatch(source: EvaluateWakeInput["source"]): boolean {
  return source === "dispatch_to" || source === "run_worker" || source === "hand_off_to";
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
  const assetIds = Array.from(new Set([
    ...normalizeAbilityAssetIds(request.dispatch_payload.asset_ids),
    ...normalizeAbilityAssetIds(input.dispatchPayload.asset_ids),
  ]));
  request.dispatch_payload = {
    ...request.dispatch_payload,
    ...(input.dispatchPayload.run_id
      ? { run_id: input.dispatchPayload.run_id }
      : {}),
    ...(assetIds.length ? { asset_ids: assetIds } : {}),
  };
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
  if (request.execution_domain === 'cogseed') return false;
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

/** 一条唤醒只有在它绑定的 run 仍可派发时才有意义。绑定的 run 已终态、或该 run
 *  里这个 actor 已经拿到终态时，dispatcher 的预检必然拒绝——这种请求如果一直
 *  挂在 pending/approved，用户会反复点批准、每次都失败，而且它还挡住宿主侧收口
 *  （收口门要求本 run 没有 pending/approved 的 Wake）。所以系统自己把它判死：
 *  置 expired + 撤销 active 审批并写明原因。读不到 run 时不动（交给决策时的
 *  fail-closed），避免把瞬时读失败当成失效。 */
async function expireUndispatchableWakeRequests(
  userId: string,
  conversationId?: string,
): Promise<void> {
  const state = await readWakeState(userId);
  const candidates = state.requests.filter(
    (request) =>
      (!conversationId || request.conversation_id === conversationId) &&
      (request.status === "pending" || request.status === "approved") &&
      !!request.dispatch_payload.run_id,
  );
  if (!candidates.length) return;

  const { readRun } = await import("../group_chat/run_store");
  const doomed: Array<{ id: string; reason: string; cid: string; runId: string }> = [];
  for (const request of candidates) {
    const runId = String(request.dispatch_payload.run_id || "");
    const run = await readRun(userId, request.conversation_id, runId).catch(() => null);
    if (!run) continue;
    if (run.status !== "running") {
      doomed.push({ id: request.id, reason: `run_terminal:${run.status}`, cid: request.conversation_id, runId });
      continue;
    }
    const actor = run.actors.find((entry) => entry.agent_id === request.agent_id);
    if (actor && actor.terminal !== "pending") {
      doomed.push({ id: request.id, reason: `actor_terminal:${actor.terminal}`, cid: request.conversation_id, runId });
    }
  }
  if (!doomed.length) return;

  await mutateWakeState(userId, (next) => {
    const now = nowIso();
    for (const { id, reason } of doomed) {
      const request = next.requests.find((item) => item.id === id);
      if (!request || (request.status !== "pending" && request.status !== "approved")) continue;
      request.status = "expired";
      request.decision_reason = reason;
      request.updated_at = now;
      delete request.workflow_transition;
      for (const approval of next.approvals.filter(
        (item) => item.request_id === id && item.status === "active",
      )) {
        approval.status = "revoked";
        approval.updated_at = now;
      }
    }
  });

  // 判死只解决了「唤醒一直挂着」；宿主侧的收口还停在「本 run 有待审批 Wake」的
  // 旧判断上（收录口门会重新列一次 Wake，那时就能看到 expired）。所以这里主动
  // 触发一次 run 对账，让 run 走到 blocked/approval_expired 并发布汇总。
  // 动态 import 断开 bus ↔ wake-service 的静态环（bus 静态依赖本模块）。
  // 判死只解决了「唤醒一直挂着」；宿主侧的收口还停在「本 run 有待审批 Wake」的
  // 旧判断上（收录口门会重新列一次 Wake，那时就能看到 expired）。所以这里主动
  // 触发一次 run 对账，让 run 走到 blocked/approval_expired 并发布汇总。
  // 动态 import 断开 bus ↔ wake-service 的静态环（bus 静态依赖本模块）。
  try {
    const { reconcileRun } = await import("../group_chat/index");
    for (const { cid, runId } of doomed) {
      await reconcileRun(userId, cid, runId).catch((err) => {
        log.warn(`wake expiry run reconcile failed cid=${cid}: ${(err as Error).message}`);
      });
    }
  } catch (err) {
    log.warn(`wake expiry reconcile unavailable: ${(err as Error).message}`);
  }
}

async function reconcileWakeTransitions(
  userId: string,
  conversationId?: string,
): Promise<void> {
  await expireUndispatchableWakeRequests(userId, conversationId);
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
  if (input.dispatchPayload.run_id)
    requireId(input.dispatchPayload.run_id, "wake collaboration run id");
  if (!input.objective.trim()) throw new Error("wake objective is required");
  if (!input.dispatchPayload.text.trim())
    throw new Error("wake dispatch text is required");
  const normalizedAssetIds = normalizeAbilityAssetIds(
    input.dispatchPayload.asset_ids,
  );
  input = {
    ...input,
    dispatchPayload: {
      ...input.dispatchPayload,
      ...(normalizedAssetIds.length ? { asset_ids: normalizedAssetIds } : {}),
    },
  };

  await reconcileWakeTransitions(userId, input.conversationId);
  const result = await mutateWakeState(userId, async (state) => {
    const approval = matchingApproval(state, input);
    if (approval) {
      // Approval decisions enqueue the bound workflow step asynchronously. The
      // original Commander turn can still retry the same tool call before that
      // queued Agent starts. Treat that retry as the same admitted dispatch,
      // rather than letting the approval cache launch a second nested run.
      const run =
        canHaveQueuedWakeDispatch(input.source) && input.workflow_step_id
          ? await readActiveWorkflowRun(userId, input.conversationId)
          : null;
      const duplicate = run
        ? state.requests.find((request) => {
            if (
              (request.status !== "approved" && request.status !== "executed") ||
              !request.workflow_step_id ||
              !sameIntent(request, input)
            ) {
              return false;
            }
            const step = run.steps.find(
              (candidate) => candidate.id === request.workflow_step_id,
            );
            return (
              step?.status === "pending" ||
              step?.status === "running" ||
              step?.status === "blocked"
            );
          })
        : undefined;
      if (
        duplicate?.workflow_step_id &&
        input.workflow_step_id &&
        input.workflow_step_id !== duplicate.workflow_step_id
      ) {
        await cancelPreparedNestedDispatchStep(
          userId,
          input.conversationId,
          input.workflow_step_id,
          "Superseded by the already admitted Wake dispatch.",
        );
        return {
          approved: true,
          approval,
          duplicate_request: duplicate,
        } as const;
      }
      return { approved: true, approval } as const;
    }

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
      execution_domain: input.executionDomain || 'group_chat',
      execution_scope_id: input.executionScopeId || input.conversationId,
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
        ...(input.dispatchPayload.asset_ids?.length
          ? { asset_ids: [...input.dispatchPayload.asset_ids] }
          : {}),
        ...(input.dispatchPayload.run_id
          ? { run_id: input.dispatchPayload.run_id }
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
      ...(input.kstar_decision?.required
        ? {
            kstar_decision: {
              ...input.kstar_decision,
              expectation: { ...(input.kstar_decision.expectation || {}) },
            },
          }
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
  options: { assetConfirmationSnapshot?: WakeAssetConfirmationSnapshot } = {},
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
    if (options.assetConfirmationSnapshot) {
      request.asset_confirmation_snapshot = options.assetConfirmationSnapshot;
    }
    let approval = state.approvals.find(
      (item) => item.request_id === request.id,
    );
    if (!approval) {
      approval = {
        id: genId12(),
        request_id: request.id,
        conversation_id: request.conversation_id,
        execution_domain: request.execution_domain || 'group_chat',
        execution_scope_id: request.execution_scope_id || request.conversation_id,
        ...(request.task_id ? { task_id: request.task_id } : {}),
        agent_id: request.agent_id,
        context_scope: [...request.context_scope],
        behavior_scope: [...request.behavior_scope],
        status: "active",
        created_at: now,
        updated_at: now,
        ...(options.assetConfirmationSnapshot ? { asset_confirmation_snapshot: options.assetConfirmationSnapshot } : {}),
      };
      state.approvals.push(approval);
    } else {
      approval.status = "active";
      approval.updated_at = now;
      if (options.assetConfirmationSnapshot) {
        approval.asset_confirmation_snapshot = options.assetConfirmationSnapshot;
      }
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
