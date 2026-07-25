import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getWakeRequest: vi.fn(),
  approveWakeRequest: vi.fn(),
  rejectWakeRequest: vi.fn(),
  markWakeRequestExecuted: vi.fn(),
  resetWakeApproval: vi.fn(),
  getAgent: vi.fn(),
  isAgentEnabled: vi.fn(),
}));

vi.mock("../../../../src/main/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("../../../../src/main/features/group_chat/bus", () => ({
  enqueue: mocks.enqueue,
}));
vi.mock("../../../../src/main/features/p3394/wake-service", () => ({
  getWakeRequest: mocks.getWakeRequest,
  approveWakeRequest: mocks.approveWakeRequest,
  rejectWakeRequest: mocks.rejectWakeRequest,
  markWakeRequestExecuted: mocks.markWakeRequestExecuted,
  resetWakeApproval: mocks.resetWakeApproval,
}));
vi.mock("../../../../src/main/features/group_chat/state", () => ({
  COMMANDER_ID: "commander",
  USER_ID: "user",
  setActiveRecipient: vi.fn(),
  setOrchestrationLedger: vi.fn(),
}));
vi.mock("../../../../src/main/features/agents", () => ({
  getAgent: mocks.getAgent,
}));
vi.mock("../../../../src/main/features/component_enabled", () => ({
  isAgentEnabled: mocks.isAgentEnabled,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.enqueue.mockReset();
  mocks.getWakeRequest.mockReset();
  mocks.approveWakeRequest.mockReset();
  mocks.rejectWakeRequest.mockReset();
  mocks.markWakeRequestExecuted.mockReset();
  mocks.resetWakeApproval.mockReset();
  mocks.getAgent.mockReset();
  mocks.isAgentEnabled.mockReset();
  mocks.getAgent.mockResolvedValue({ agent_id: "agent-1", interactive: false });
  mocks.isAgentEnabled.mockReturnValue(true);
});

describe("P3394 wake controller workflow binding", () => {
  it("approves and enqueues the exact persisted workflow step", async () => {
    const request = {
      id: "wake-1",
      conversation_id: "cid-1",
      agent_id: "agent-1",
      source: "dispatch_to",
      source_actor_id: "commander",
      objective: "Prepare report",
      context_scope: ["conversation:cid-1"],
      behavior_scope: ["dispatch_to"],
      dispatch_payload: { text: "Prepare report" },
      status: "pending",
      workflow_step_id: "wstep-1",
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    } as any;
    mocks.getWakeRequest.mockResolvedValue(request);
    mocks.approveWakeRequest.mockResolvedValue({
      request: { ...request, status: "approved" },
      approval: {},
    });
    mocks.enqueue.mockResolvedValue({ to: ["agent-1"] });
    mocks.markWakeRequestExecuted.mockResolvedValue({
      ...request,
      status: "executed",
    });

    const controller =
      await import("../../../../src/main/features/p3394/wake-controller");
    const result = await controller.decideWakeRequest("user-1", {
      requestId: request.id,
      decision: "approve",
    });

    expect(result).toMatchObject({
      ok: true,
      dispatched: true,
      request: { status: "executed" },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "user-1",
        cid: "cid-1",
        forceTo: ["agent-1"],
        workflow_step_id: "wstep-1",
      }),
    );
  });

  it("resets approval and leaves the request resumable when enqueue throws", async () => {
    const request = {
      id: "wake-enqueue-fail",
      conversation_id: "cid-1",
      agent_id: "agent-1",
      source: "dispatch_to",
      source_actor_id: "commander",
      objective: "Prepare report",
      context_scope: ["conversation:cid-1"],
      behavior_scope: ["dispatch_to"],
      dispatch_payload: { text: "Prepare report" },
      status: "pending",
      workflow_step_id: "wstep-1",
      created_at: "t",
      updated_at: "t",
    } as any;
    mocks.getWakeRequest.mockResolvedValue(request);
    mocks.approveWakeRequest.mockResolvedValue({
      request: { ...request, status: "approved" },
      approval: {},
    });
    mocks.enqueue.mockRejectedValue(new Error("queue closed"));
    mocks.resetWakeApproval.mockResolvedValue({
      ...request,
      status: "pending",
    });

    const controller =
      await import("../../../../src/main/features/p3394/wake-controller");
    const result = await controller.decideWakeRequest("user-1", {
      requestId: request.id,
      decision: "approve",
    });

    expect(result).toMatchObject({ ok: false, error: "queue closed" });
    expect(mocks.resetWakeApproval).toHaveBeenCalledWith(
      "user-1",
      request.id,
      expect.stringContaining("queue closed"),
    );
    expect(mocks.markWakeRequestExecuted).not.toHaveBeenCalled();
  });

  it("resets approval when enqueue returns a message not addressed to the target", async () => {
    const request = {
      id: "wake-wrong-target",
      conversation_id: "cid-1",
      agent_id: "agent-1",
      source: "dispatch_to",
      source_actor_id: "commander",
      objective: "Prepare report",
      context_scope: ["conversation:cid-1"],
      behavior_scope: ["dispatch_to"],
      dispatch_payload: { text: "Prepare report" },
      status: "pending",
      workflow_step_id: "wstep-1",
      created_at: "t",
      updated_at: "t",
    } as any;
    mocks.getWakeRequest.mockResolvedValue(request);
    mocks.approveWakeRequest.mockResolvedValue({
      request: { ...request, status: "approved" },
      approval: {},
    });
    mocks.enqueue.mockResolvedValue({ to: ["user"] });
    mocks.resetWakeApproval.mockResolvedValue({
      ...request,
      status: "pending",
    });

    const controller =
      await import("../../../../src/main/features/p3394/wake-controller");
    const result = await controller.decideWakeRequest("user-1", {
      requestId: request.id,
      decision: "approve",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "wake enqueue did not admit the target agent",
    });
    expect(mocks.resetWakeApproval).toHaveBeenCalled();
    expect(mocks.markWakeRequestExecuted).not.toHaveBeenCalled();
  });
});
