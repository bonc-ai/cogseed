import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = "u1";
const TEST_CID = "cid-collab-overview";

function groupDir(): string {
  return path.join(tmpDir, "data", TEST_UID, "cloud", "chats", TEST_CID);
}

function collabDir(): string {
  return path.join(groupDir(), "collaboration");
}

function messageFile(): string {
  return path.join(path.dirname(groupDir()), `${TEST_CID}.jsonl`);
}

function writeJsonp(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function appendMessageLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

interface StepFixture {
  id: string;
  title: string;
  status: string;
  actor_id?: string;
  actor_name?: string;
  depends_on?: string[];
  attempts?: number;
  result_summary?: string;
  completed_at?: string;
}

function makeRun(steps: StepFixture[], status = "running") {
  return {
    version: 1,
    id: "wf-1",
    cid: TEST_CID,
    objective: "Ship the report",
    kind: "implementation",
    status,
    phase: "executing",
    context_id: "wctx-1",
    created_by: "commander",
    created_at: "2026-08-27T10:00:00.000Z",
    updated_at: "2026-08-27T11:00:00.000Z",
    steps: steps.map((step) => ({
      id: step.id,
      run_id: "wf-1",
      title: step.title,
      actor_id: step.actor_id ?? null,
      actor_name: step.actor_name,
      type: "dispatch",
      status: step.status,
      depends_on: step.depends_on ?? [],
      attempts: Array.from({ length: step.attempts ?? 1 }, (_, index) => {
        const failed = index < (step.attempts ?? 1) - 1 || step.status === "failed";
        return {
          attempt: index + 1,
          actor_id: step.actor_id ?? null,
          actor_kind: "agent",
          status: failed ? "failed" : "completed",
          started_at: "2026-08-27T10:05:00.000Z",
          completed_at: "2026-08-27T10:20:00.000Z",
          ...(failed ? { failure_code: "runtime_failed" } : {}),
        };
      }),
      ...(step.result_summary ? { result_summary: step.result_summary } : {}),
      ...(step.status === "completed" || step.status === "failed" || step.status === "skipped"
        ? { completed_at: step.completed_at ?? "2026-08-27T10:30:00.000Z" }
        : {}),
    })),
  };
}

async function setupEnv(): Promise<void> {
  const users = await import("../../../../src/main/features/users");
  users.activateUser(TEST_UID);
}

async function loadModule() {
  return import("../../../../src/main/features/group_chat/collab_overview");
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cogseed-collab-view-"));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = path.join(tmpDir, "data");
  vi.resetModules();
  await setupEnv();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collab_overview › projection", () => {
  it("returns unavailable for a conversation without an active run", async () => {
    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);
    expect(overview.available).toBe(false);
    expect(overview.steps).toEqual([]);
    expect(overview.summary).toBeNull();
  });

  it("projects steps with dependencies, attempts and per-agent states", async () => {
    writeJsonp(path.join(collabDir(), "active.json"), { version: 1, run_id: "wf-1", context_id: "wctx-1", updated_at: "2026-08-27T10:00:00.000Z" });
    writeJsonp(path.join(collabDir(), "workflow_runs", "wf-1.json"), makeRun([
      { id: "s1", title: "Gather data", status: "completed", actor_id: "agent-a", actor_name: "Data Agent" },
      { id: "s2", title: "Render report", status: "running", actor_id: "agent-b", actor_name: "Render Agent", depends_on: ["s1"] },
      { id: "s3", title: "Review", status: "pending", actor_id: "agent-b" },
    ]));
    writeJsonp(path.join(groupDir(), "members.json"), {
      version: 1,
      actors: [
        { kind: "commander", id: "commander", joined_at: "2026-08-27T09:00:00.000Z" },
        { kind: "agent", id: "agent-a", name: "Data Agent", joined_at: "2026-08-27T09:00:00.000Z" },
        { kind: "agent", id: "agent-b", name: "Render Agent", joined_at: "2026-08-27T09:00:00.000Z" },
      ],
    });
    appendMessageLine(messageFile(), {
      id: "m1", ts: "2026-08-27T10:10:00.000Z", from: "commander", to: ["agent-a"],
      dispatch: true, text: "please gather data", turn_id: "t1",
    });
    appendMessageLine(messageFile(), {
      id: "m2", ts: "2026-08-27T10:20:00.000Z", from: "agent-a", to: ["commander"],
      text: "data ready", produced: ["/tmp/report.csv"], turn_id: "t2",
    });

    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);

    expect(overview.available).toBe(true);
    expect(overview.run.objective).toBe("Ship the report");
    expect(overview.progress).toEqual({ total: 3, completed: 1, running: 1, pending: 1, failed: 0, skipped: 0 });
    const render = overview.steps.find((step) => step.id === "s2")!;
    expect(render.depends_on).toEqual(["s1"]);
    expect(render.actor_name).toBe("Render Agent");

    const agentB = overview.actors.find((actor) => actor.id === "agent-b")!;
    expect(agentB.state).toBe("working");
    expect(agentB.active_step_title).toBe("Render report");
    const agentA = overview.actors.find((actor) => actor.id === "agent-a")!;
    expect(agentA.state).toBe("idle");
    expect(agentA.steps_done).toBe(1);

    expect(overview.handoffs.map((h) => h.kind)).toEqual(["dispatch", "handback"]);
    expect(overview.handoffs[0].to).toBe("agent-a");
    expect(overview.handoffs[1].from).toBe("agent-a");

    // 未终态：不生成汇总。
    expect(overview.summary).toBeNull();
    expect(fs.existsSync(path.join(collabDir(), "summary.json"))).toBe(false);
  });

  it("aggregates failure/retry anomalies with downstream impact", async () => {
    writeJsonp(path.join(collabDir(), "active.json"), { version: 1, run_id: "wf-1", context_id: "wctx-1", updated_at: "2026-08-27T10:00:00.000Z" });
    writeJsonp(path.join(collabDir(), "workflow_runs", "wf-1.json"), makeRun([
      { id: "s1", title: "Fetch", status: "failed", actor_id: "agent-a", attempts: 2, result_summary: "network unreachable" },
      { id: "s2", title: "Publish", status: "pending", actor_id: "agent-b", depends_on: ["s1"] },
    ]));
    appendMessageLine(messageFile(), {
      id: "m1", ts: "2026-08-27T10:15:00.000Z", from: "agent-a", to: ["user"],
      text: "error bubble", failure_kind: "model", failure_code: "model_stream_error", turn_id: "t1",
    });

    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);

    const failure = overview.anomalies.find((a) => a.kind === "failure" && a.step_id === "s1");
    expect(failure).toBeTruthy();
    expect(failure!.detail).toContain("network unreachable");
    expect(failure!.impact).toEqual(["Publish"]);

    const retry = overview.anomalies.find((a) => a.kind === "retry" && a.step_id === "s1");
    expect(retry).toBeTruthy();

    const messageFailure = overview.anomalies.find((a) => a.kind === "failure" && !a.step_id);
    expect(messageFailure).toBeTruthy();
    expect(messageFailure!.detail).toContain("model");
  });
});

describe("collab_overview › end-of-run summary", () => {
  function seedTerminalFixture(status: string, steps: StepFixture[]) {
    writeJsonp(path.join(collabDir(), "active.json"), { version: 1, run_id: "wf-1", context_id: "wctx-1", updated_at: "2026-08-27T11:00:00.000Z" });
    writeJsonp(path.join(collabDir(), "workflow_runs", "wf-1.json"), makeRun(steps, status));
    writeJsonp(path.join(collabDir(), "workflow_contexts", "wctx-1.json"), {
      version: 1,
      id: "wctx-1",
      cid: TEST_CID,
      run_id: "wf-1",
      objective: "Ship the report",
      phase: "executing",
      revision: 3,
      constraints: [],
      facts: [],
      decisions: [],
      open_questions: [],
      risks: [],
      artifacts: [{ id: "art-1", type: "file", path: "/tmp/report.md", added_by: "agent-a", created_at: "2026-08-27T10:40:00.000Z" }],
      agent_outputs: {
        "s1": { actor_id: "agent-a", step_id: "s1", summary: "Collected 3 datasets", created_at: "2026-08-27T10:30:00.000Z" },
      },
      gates: [],
      proposals: [],
      conflicts: [],
      updated_at: "2026-08-27T11:00:00.000Z",
    });
    writeJsonp(path.join(groupDir(), "members.json"), {
      version: 1,
      actors: [
        { kind: "commander", id: "commander", joined_at: "2026-08-27T09:00:00.000Z" },
        { kind: "agent", id: "agent-a", name: "Data Agent", joined_at: "2026-08-27T09:00:00.000Z" },
      ],
    });
    appendMessageLine(messageFile(), {
      id: "m1", ts: "2026-08-27T10:20:00.000Z", from: "agent-a", to: ["commander"],
      text: "final answer: report generated", produced: ["/tmp/report.md"], turn_id: "t2",
    });
  }

  it("generates and persists a summary once all steps are terminal", async () => {
    seedTerminalFixture("running", [
      { id: "s1", title: "Fetch", status: "completed", actor_id: "agent-a", actor_name: "Data Agent" },
      { id: "s2", title: "Publish", status: "skipped", actor_id: "agent-a" },
    ]);

    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);

    expect(overview.summary).not.toBeNull();
    expect(overview.summary!.conclusion).toBe("all_steps_done");
    expect(overview.summary!.step_totals.completed).toBe(1);
    expect(overview.summary!.step_totals.skipped).toBe(1);
    expect(overview.summary!.final_result).toContain("report generated");
    expect(overview.summary!.artifacts).toContain("/tmp/report.md");
    const contribution = overview.summary!.contributions.find((c) => c.actor_id === "agent-a")!;
    expect(contribution.actor_name).toBe("Data Agent");
    expect(contribution.steps_completed).toBe(1);
    expect(contribution.produced_files).toContain("/tmp/report.md");
    expect(contribution.outputs[0]).toContain("Collected");

    const stored = JSON.parse(fs.readFileSync(path.join(collabDir(), "summary.json"), "utf8"));
    expect(stored.run_id).toBe("wf-1");

    const lines = fs.readFileSync(messageFile(), "utf8").trim().split("\n");
    const summaryMsg = lines.map((l) => JSON.parse(l)).find((msg) => msg.system_kind === "collab_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.collab_summary.run_id).toBe("wf-1");
    expect(summaryMsg.model_text).toContain("<collaboration-summary>");
    expect(summaryMsg.text).toContain("协作汇总");
  });

  it("is idempotent — a second projection does not duplicate the summary message", async () => {
    seedTerminalFixture("running", [
      { id: "s1", title: "Fetch", status: "completed", actor_id: "agent-a" },
    ]);
    const m = await loadModule();
    await m.buildCollabOverview(TEST_UID, TEST_CID);
    await m.buildCollabOverview(TEST_UID, TEST_CID);

    const lines = fs.readFileSync(messageFile(), "utf8").trim().split("\n");
    const summaryCount = lines.filter((l) => {
      const msg = JSON.parse(l);
      return msg.system_kind === "collab_summary";
    }).length;
    expect(summaryCount).toBe(1);
  });

  it("marks cancelled runs with the cancelled conclusion", async () => {
    seedTerminalFixture("cancelled", [
      { id: "s1", title: "Fetch", status: "skipped", actor_id: "agent-a" },
    ]);
    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);
    expect(overview.summary!.conclusion).toBe("cancelled");
  });

  it("does not generate a summary while steps are still open", async () => {
    writeJsonp(path.join(collabDir(), "active.json"), { version: 1, run_id: "wf-1", context_id: "wctx-1", updated_at: "2026-08-27T10:00:00.000Z" });
    writeJsonp(path.join(collabDir(), "workflow_runs", "wf-1.json"), makeRun([
      { id: "s1", title: "Fetch", status: "running", actor_id: "agent-a" },
    ]));
    const m = await loadModule();
    const overview = await m.buildCollabOverview(TEST_UID, TEST_CID);
    expect(overview.summary).toBeNull();
    expect(fs.existsSync(path.join(collabDir(), "summary.json"))).toBe(false);
  });
});
