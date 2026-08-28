import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const busMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}));
vi.mock("../../../../src/main/features/group_chat/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/main/features/group_chat/bus")>();
  return {
    ...actual,
    enqueue: busMocks.enqueue,
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = "u1";
const TEST_CID = "cid-collab-settle";

function groupDir(): string {
  return path.join(tmpDir, "data", TEST_UID, "cloud", "chats", TEST_CID);
}

function writeJsonp(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cogseed-collab-settle-"));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = path.join(tmpDir, "data");
  vi.resetModules();
  const users = await import("../../../../src/main/features/users");
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModules() {
  const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
  const settle = await import("../../../../src/main/features/group_chat/collab_settle");
  return { collaboration, settle };
}

/** Reproduce the real dispatch shape: prepare a step exactly like
 *  prepareNestedDispatchForTool does for a gateway agent, leaving it pending
 *  with no attempts (the state observed in the live broken run). */
async function seedPendingDispatchStep(sourceTool = "dispatch_to"): Promise<string> {
  const { collaboration } = await loadModules();
  const prepared = await collaboration.prepareNestedDispatchStep(TEST_UID, TEST_CID, {
    objective: "Ask Hermes a question",
    actor_id: "agent-hermes",
    actor_name: "Hermes",
    actor_kind: "agent",
    source_tool: sourceTool,
    task: "answer 1+1",
    depends_on: [],
    required_capabilities: [],
    access_mode: "write",
    write_scopes: [],
  });
  return prepared.step.id;
}

describe("collab_settle › external agent handback", () => {
  it("settles a pending gateway dispatch step to completed with the reply as summary", async () => {
    const stepId = await seedPendingDispatchStep();
    const { collaboration, settle } = await loadModules();

    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "2。不用客气。");

    const run = await collaboration.readActiveWorkflowRun(TEST_UID, TEST_CID);
    const step = run!.steps.find((s) => s.id === stepId)!;
    expect(step.status).toBe("completed");
    expect(step.result_summary).toContain("2。不用客气");
    expect(step.completed_at).toBeTruthy();
  });

  it("is a no-op for actors with no open step", async () => {
    await seedPendingDispatchStep();
    const { collaboration, settle } = await loadModules();
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-other", "hi");
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, TEST_CID);
    expect(run!.steps[0].status).toBe("pending");
  });

  it("picks the newest open step when several are open for the actor", async () => {
    await seedPendingDispatchStep();
    const second = await seedPendingDispatchStep();
    const { collaboration, settle } = await loadModules();
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "latest reply");
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, TEST_CID);
    const settled = run!.steps.find((s) => s.id === second)!;
    expect(settled.status).toBe("completed");
  });

  it("never throws when there is no active workflow run at all", async () => {
    writeJsonp(path.join(groupDir(), "meta.json"), { conversation_id: TEST_CID });
    const { settle } = await loadModules();
    await expect(
      settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "reply"),
    ).resolves.toBeUndefined();
  });
});

describe("collab_settle › run finalization", () => {
  it("wakes the commander for synthesis when a dispatch_to run turns fully terminal", async () => {
    await seedPendingDispatchStep("dispatch_to");
    const { settle } = await loadModules();
    busMocks.enqueue.mockClear();
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "done");
    expect(busMocks.enqueue).toHaveBeenCalledTimes(1);
    const call = busMocks.enqueue.mock.calls[0][0];
    expect(call.internalControl).toBe(true);
    expect(call.forceTo).toEqual(["commander"]);
    expect(String(call.model_text)).toContain("<collab-synthesis-wake>");
    expect(fs.existsSync(path.join(groupDir(), "collaboration", "synthesis-wake.json"))).toBe(true);
  });

  it("does not wake twice for the same terminal run (marker idempotency)", async () => {
    await seedPendingDispatchStep("dispatch_to");
    const { settle } = await loadModules();
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "done");
    busMocks.enqueue.mockClear();
    // 同一 run 已全终态且标记存在：再次外部回复不重复唤醒。
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "agent-hermes", "again");
    expect(busMocks.enqueue).not.toHaveBeenCalled();
  });

  it("finalizes a terminal run directly (marker consumed, summary written)", async () => {
    // 直接构造全终态 run + 回笼标记，验证 finalize 纯逻辑（settle→wake 的
    // 集成链路由真机复验覆盖）。
    const runId = "wf-finx";
    writeJsonp(path.join(groupDir(), "collaboration", "active.json"), { version: 1, run_id: runId, context_id: "wctx-finx", updated_at: "2026-08-28T10:00:00.000Z" });
    writeJsonp(path.join(groupDir(), "collaboration", "workflow_runs", `${runId}.json`), {
      version: 1, id: runId, cid: TEST_CID, objective: "fin test", kind: "custom", status: "running",
      phase: "p", context_id: "wctx-finx", created_by: "commander",
      created_at: "2026-08-28T10:00:00.000Z", updated_at: "2026-08-28T10:05:00.000Z",
      steps: [{ id: "f1", run_id: runId, title: "dispatch_to: Hermes", actor_id: "agent-hermes",
        actor_name: "Hermes", type: "dispatch", status: "completed", depends_on: [],
        source_tool: "dispatch_to", result_summary: "ok", completed_at: "2026-08-28T10:05:00.000Z", attempts: [] }],
    });
    writeJsonp(path.join(groupDir(), "collaboration", "synthesis-wake.json"), { version: 1, run_id: runId, woken_at: "2026-08-28T10:06:00.000Z" });
    const { settle } = await loadModules();
    await settle.finalizeCollabRunAfterCommanderTurn(TEST_UID, TEST_CID);
    expect(fs.existsSync(path.join(groupDir(), "collaboration", "summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(groupDir(), "collaboration", "synthesis-wake.json"))).toBe(false);
  });

  it("hand_off_to endings finalize directly without waking the commander", async () => {
    const runId = "wf-finh";
    writeJsonp(path.join(groupDir(), "collaboration", "active.json"), { version: 1, run_id: runId, context_id: "wctx-finh", updated_at: "2026-08-28T10:00:00.000Z" });
    writeJsonp(path.join(groupDir(), "collaboration", "workflow_runs", `${runId}.json`), {
      version: 1, id: runId, cid: TEST_CID, objective: "fin test", kind: "custom", status: "running",
      phase: "p", context_id: "wctx-finh", created_by: "commander",
      created_at: "2026-08-28T10:00:00.000Z", updated_at: "2026-08-28T10:05:00.000Z",
      steps: [{ id: "h1", run_id: runId, title: "hand_off_to: Hermes", actor_id: "agent-hermes",
        actor_name: "Hermes", type: "dispatch", status: "completed", depends_on: [],
        source_tool: "hand_off_to", result_summary: "delivered", completed_at: "2026-08-28T10:05:00.000Z", attempts: [] }],
    });
    const { settle } = await loadModules();
    busMocks.enqueue.mockClear();
    // 直接调内部终态检查路径（等价于外部回复 settle 后的检查）：
    await settle.settleExternalAgentHandback(TEST_UID, TEST_CID, "nonexistent-agent", "x");
    expect(busMocks.enqueue).not.toHaveBeenCalled();
    // 直接 finalize 验证汇总生成：
    await settle.finalizeCollabRun(TEST_UID, TEST_CID);
    expect(fs.existsSync(path.join(groupDir(), "collaboration", "summary.json"))).toBe(true);
  });

  it("commander-turn finalize is a no-op without a wake marker", async () => {
    const { settle } = await loadModules();
    await settle.finalizeCollabRunAfterCommanderTurn(TEST_UID, TEST_CID);
    expect(fs.existsSync(path.join(groupDir(), "collaboration", "summary.json"))).toBe(false);
  });
});
