import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../../../src/main/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let root: string;
const uid = "wake-user";
const cid = "conversation-1";
const agentId = "agent-1";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cogseed-p3394-wake-"));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.COGSEED_WORKSPACE_ROOT;
  vi.resetModules();
});

describe("P3394 wake service", () => {
  it("persists and reuses a pending wake request when the agent has no approval", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");

    const first = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "软件工程师",
      source: "user_mention",
      sourceActorId: "user",
      objective: "检查这个项目",
      dispatchPayload: { text: "@软件工程师 检查这个项目" },
    });
    const second = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "软件工程师",
      source: "user_mention",
      sourceActorId: "user",
      objective: "检查这个项目",
      dispatchPayload: { text: "@软件工程师 检查这个项目" },
    });

    expect(first.approved).toBe(false);
    expect(first.request.status).toBe("pending");
    expect(second.request.id).toBe(first.request.id);

    vi.resetModules();
    const reloaded =
      await import("../../../../src/main/features/p3394/wake-service");
    const requests = await reloaded.listWakeRequests(uid, cid);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversation_id: cid,
      agent_id: agentId,
      source: "user_mention",
      status: "pending",
      objective: "检查这个项目",
    });
  });

  it("deduplicates pending requests that differ only by source when the approval scopes overlap", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");

    const handoff = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "研究员",
      source: "hand_off_to",
      sourceActorId: "commander",
      objective: "整理论文研究报告",
      dispatchPayload: { text: "整理论文研究报告" },
      resumeInstruction: "研究完成后调度 ContentWriter。",
    });
    const mention = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "研究员",
      source: "user_mention",
      sourceActorId: "user",
      objective: "  整理论文研究报告  ",
      dispatchPayload: { text: "@研究员 整理论文研究报告" },
    });

    expect(mention.request.id).toBe(handoff.request.id);
    expect(mention.request.behavior_scope).toEqual(
      expect.arrayContaining(["hand_off_to", "user_mention"]),
    );
    expect(mention.request.resume_instruction).toBe(
      "研究完成后调度 ContentWriter。",
    );
    const requests = await wake.listWakeRequests(uid, cid);
    expect(requests).toHaveLength(1);
  });

  it("limits approval to the approved conversation and agent", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const pending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "软件工程师",
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "实现登录页",
      dispatchPayload: { text: "实现登录页" },
    });

    const approved = await wake.approveWakeRequest(uid, pending.request.id);
    expect(approved.request.status).toBe("approved");
    expect(approved.approval).toMatchObject({
      conversation_id: cid,
      agent_id: agentId,
      context_scope: [`conversation:${cid}`],
      behavior_scope: ["dispatch_to"],
      status: "active",
    });

    const sameScope = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: "软件工程师",
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "继续实现登录页",
      dispatchPayload: { text: "继续实现登录页" },
    });
    expect(sameScope.approved).toBe(true);

    const otherConversation = await wake.evaluateWake(uid, {
      conversationId: "conversation-2",
      agentId,
      agentName: "软件工程师",
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "实现另一个任务",
      dispatchPayload: { text: "实现另一个任务" },
    });
    expect(otherConversation.approved).toBe(false);

    const otherAgent = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId: "agent-2",
      agentName: "测试工程师",
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "测试登录页",
      dispatchPayload: { text: "测试登录页" },
    });
    expect(otherAgent.approved).toBe(false);
  });

  it("suppresses a retry while the approved wake dispatch is already running", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const activeCid = "wake-active-dispatch";
    await collaboration.createWorkflowRun(uid, activeCid, {
      objective: "Review report",
      created_by: "commander",
    });
    const admittedStep = await collaboration.prepareNestedDispatchStep(
      uid,
      activeCid,
      {
        objective: "Review report",
        actor_id: agentId,
        source_tool: "dispatch_to",
        task: "Review report",
      },
    );
    const pending = await wake.evaluateWake(uid, {
      conversationId: activeCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Review report",
      dispatchPayload: { text: "Review report" },
      workflow_step_id: admittedStep.step.id,
    });
    await wake.approveWakeRequest(uid, pending.request.id);
    await wake.markWakeRequestExecuted(uid, pending.request.id);
    await collaboration.startPreparedNestedDispatchStep(
      uid,
      activeCid,
      admittedStep.step.id,
    );

    const redundantStep = await collaboration.prepareNestedDispatchStep(
      uid,
      activeCid,
      {
        objective: "Review report",
        actor_id: agentId,
        source_tool: "dispatch_to",
        task: "Review report",
      },
    );
    const retried = await wake.evaluateWake(uid, {
      conversationId: activeCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "  Review report  ",
      dispatchPayload: { text: "Review report" },
      workflow_step_id: redundantStep.step.id,
    });

    expect(retried).toMatchObject({
      approved: true,
      duplicate_request: {
        id: pending.request.id,
        workflow_step_id: admittedStep.step.id,
      },
    });
    const run = await collaboration.readActiveWorkflowRun(uid, activeCid);
    expect(
      run?.steps.find((step) => step.id === redundantStep.step.id)?.status,
    ).toBe("skipped");
  });

  it("records rejection and execution as explicit state transitions", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const rejectedPending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: "run_worker",
      sourceActorId: "commander",
      objective: "运行检查",
      dispatchPayload: { text: "运行检查" },
    });
    const rejected = await wake.rejectWakeRequest(
      uid,
      rejectedPending.request.id,
      "当前不需要",
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.decision_reason).toBe("当前不需要");

    const executablePending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: "hand_off_to",
      sourceActorId: "commander",
      objective: "交付报告",
      dispatchPayload: { text: "交付报告" },
    });
    await wake.approveWakeRequest(uid, executablePending.request.id);
    const executed = await wake.markWakeRequestExecuted(
      uid,
      executablePending.request.id,
    );
    expect(executed.status).toBe("executed");
    expect(executed.executed_at).toBeTruthy();
  });

  it("binds pending Wake requests to workflow steps, reuses the first binding, adopts legacy requests, and cancels on rejection", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const boundCid = "wake-bound-conversation";
    const created = await collaboration.createWorkflowRun(uid, boundCid, {
      objective: "Prepare report",
      created_by: "commander",
    });
    const firstStep = await collaboration.prepareNestedDispatchStep(
      uid,
      boundCid,
      {
        objective: "Prepare report",
        actor_id: agentId,
        source_tool: "dispatch_to",
        task: "Prepare report",
      },
    );
    const first = await wake.evaluateWake(uid, {
      conversationId: boundCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Prepare report",
      dispatchPayload: { text: "Prepare report" },
      workflow_step_id: firstStep.step.id,
    });
    expect(first.request.workflow_step_id).toBe(firstStep.step.id);

    const redundantStep = await collaboration.prepareNestedDispatchStep(
      uid,
      boundCid,
      {
        objective: "Prepare report",
        actor_id: agentId,
        source_tool: "dispatch_to",
        task: "Prepare report",
      },
    );
    const reused = await wake.evaluateWake(uid, {
      conversationId: boundCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Prepare report",
      dispatchPayload: { text: "Prepare report" },
      workflow_step_id: redundantStep.step.id,
    });
    expect(reused.request.workflow_step_id).toBe(firstStep.step.id);
    const boundRun = await collaboration.readWorkflowRun(
      uid,
      boundCid,
      created.run.id,
    );
    expect(
      boundRun?.steps.find((step) => step.id === redundantStep.step.id)?.status,
    ).toBe("skipped");

    vi.resetModules();
    const reloaded =
      await import("../../../../src/main/features/p3394/wake-service");
    expect(
      (await reloaded.getWakeRequest(uid, first.request.id))?.workflow_step_id,
    ).toBe(firstStep.step.id);

    const legacyCid = "wake-legacy-binding";
    const legacyCreated = await collaboration.createWorkflowRun(
      uid,
      legacyCid,
      {
        objective: "Legacy report",
        created_by: "commander",
      },
    );
    const legacy = await reloaded.evaluateWake(uid, {
      conversationId: legacyCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Legacy report",
      dispatchPayload: { text: "Legacy report" },
    });
    const legacyStep = await collaboration.prepareNestedDispatchStep(
      uid,
      legacyCid,
      {
        objective: "Legacy report",
        actor_id: agentId,
        source_tool: "dispatch_to",
        task: "Legacy report",
      },
    );
    const adopted = await reloaded.evaluateWake(uid, {
      conversationId: legacyCid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Legacy report",
      dispatchPayload: { text: "Legacy report" },
      workflow_step_id: legacyStep.step.id,
    });
    expect(adopted.request.id).toBe(legacy.request.id);
    expect(adopted.request.workflow_step_id).toBe(legacyStep.step.id);
    const rejected = await reloaded.rejectWakeRequest(
      uid,
      adopted.request.id,
      "not needed",
    );
    expect(rejected.status).toBe("rejected");
    const legacyRun = await collaboration.readWorkflowRun(
      uid,
      legacyCid,
      legacyCreated.run.id,
    );
    expect(legacyRun?.steps[0].status).toBe("skipped");
  });
});

describe("P3394 wake service › workflow cleanup failures", () => {
  it("does not report successful rejection when bound-step cancellation fails", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const pending = await wake.evaluateWake(uid, {
      conversationId: "wake-missing-step",
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "Missing workflow step",
      dispatchPayload: { text: "Missing workflow step" },
      workflow_step_id: "wstep-missing",
    });

    await expect(
      wake.rejectWakeRequest(uid, pending.request.id, "reject it"),
    ).rejects.toThrow(
      /active workflow context not found|workflow step not found/,
    );
    expect((await wake.getWakeRequest(uid, pending.request.id))?.status).toBe(
      "pending",
    );
  });
});
