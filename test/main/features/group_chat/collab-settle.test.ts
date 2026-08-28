import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
async function seedPendingDispatchStep(): Promise<string> {
  const { collaboration } = await loadModules();
  const prepared = await collaboration.prepareNestedDispatchStep(TEST_UID, TEST_CID, {
    objective: "Ask Hermes a question",
    actor_id: "agent-hermes",
    actor_name: "Hermes",
    actor_kind: "agent",
    source_tool: "dispatch_to",
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
