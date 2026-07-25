import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const control = vi.hoisted(() => ({ failWakeWrites: 0 }));
vi.mock("../../../../src/main/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("../../../../src/main/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/main/storage")>();
  return {
    ...actual,
    writeJson: async (file: string, value: unknown) => {
      if (
        control.failWakeWrites > 0 &&
        file.endsWith(path.join("p3394", "wake-state.json"))
      ) {
        control.failWakeWrites -= 1;
        throw new Error("forced wake-state write failure");
      }
      return actual.writeJson(file, value);
    },
  };
});

let root: string;
const uid = "wake-recovery-user";
const cid = "wake-recovery-cid";
const agentId = "agent-recovery";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-wake-recovery-"));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  control.failWakeWrites = 0;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  vi.resetModules();
});

async function preparedStep(task: string) {
  const collaboration =
    await import("../../../../src/main/features/group_chat/collaboration");
  return collaboration.prepareNestedDispatchStep(uid, cid, {
    objective: "Wake recovery",
    actor_id: agentId,
    source_tool: "dispatch_to",
    task,
  });
}

describe("P3394 Wake workflow recovery", () => {
  it("repairs a failed Wake-state write on repeated pending evaluation", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const first = await preparedStep("same intent");
    const pending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "same intent",
      dispatchPayload: { text: "same intent" },
      workflow_step_id: first.step.id,
      workflow_resume_token: first.step.resume_token,
    });
    const redundant = await preparedStep("same intent");
    control.failWakeWrites = 1;
    await expect(
      wake.evaluateWake(uid, {
        conversationId: cid,
        agentId,
        source: "dispatch_to",
        sourceActorId: "commander",
        objective: "same intent",
        dispatchPayload: { text: "same intent" },
        workflow_step_id: redundant.step.id,
        workflow_resume_token: redundant.step.resume_token,
      }),
    ).rejects.toThrow("forced wake-state write failure");

    const repaired = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "same intent",
      dispatchPayload: { text: "same intent" },
      workflow_step_id: redundant.step.id,
      workflow_resume_token: redundant.step.resume_token,
    });
    expect(repaired.request.id).toBe(pending.request.id);
    expect(repaired.request.workflow_step_id).toBe(first.step.id);
    const run = await collaboration.readActiveWorkflowRun(uid, cid);
    expect(
      run?.steps.find((step) => step.id === redundant.step.id)?.status,
    ).toBe("skipped");
  });

  it("repairs persisted cleanup and rejection partial states before reads succeed", async () => {
    const wake =
      await import("../../../../src/main/features/p3394/wake-service");
    const wakeStore =
      await import("../../../../src/main/features/p3394/wake-store");
    const storage = await import("../../../../src/main/storage");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const bound = await preparedStep("repair rejection");
    const pending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: "dispatch_to",
      sourceActorId: "commander",
      objective: "repair rejection",
      dispatchPayload: { text: "repair rejection" },
      workflow_step_id: bound.step.id,
      workflow_resume_token: bound.step.resume_token,
    });
    const redundant = await preparedStep("repair rejection");
    const file = wakeStore.wakeStateFile(uid);
    const raw = await storage.readJson<any>(file);
    raw.requests[0].pending_cleanup_step_ids = [redundant.step.id];
    raw.requests[0].workflow_transition = "rejecting";
    raw.requests[0].decision_reason = "recover rejection";
    await storage.writeJson(file, raw);

    const recovered = await wake.getWakeRequest(uid, pending.request.id);
    expect(recovered).toMatchObject({
      status: "rejected",
      workflow_step_id: bound.step.id,
    });
    expect(recovered?.pending_cleanup_step_ids).toBeUndefined();
    expect(recovered?.workflow_transition).toBeUndefined();
    const run = await collaboration.readActiveWorkflowRun(uid, cid);
    expect(run?.steps.find((step) => step.id === bound.step.id)?.status).toBe(
      "skipped",
    );
    expect(
      run?.steps.find((step) => step.id === redundant.step.id)?.status,
    ).toBe("skipped");
  });
});
