import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const storageMocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));
vi.mock("../../../../src/main/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/main/storage")>();
  return {
    ...actual,
    readJson: (...args: Parameters<typeof actual.readJson>) =>
      storageMocks.readJson(...args),
    writeJson: (...args: Parameters<typeof actual.writeJson>) =>
      storageMocks.writeJson(...args),
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = "u1";
const TEST_CID = "cid-collab";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-collab-"));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, "data");
  vi.resetModules();
  storageMocks.readJson.mockReset();
  storageMocks.writeJson.mockReset();
  const storage = await vi.importActual<
    typeof import("../../../../src/main/storage")
  >("../../../../src/main/storage");
  storageMocks.readJson.mockImplementation(storage.readJson);
  storageMocks.writeJson.mockImplementation(storage.writeJson);
  const users = await import("../../../../src/main/features/users");
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("group_chat collaboration › storage layout", () => {
  it("places workflow state under the conversation group directory", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const paths = c.collaborationPaths(TEST_UID, TEST_CID);
    expect(paths.rootDir).toBe(
      path.join(
        tmpDir,
        "data",
        TEST_UID,
        "cloud",
        "chats",
        TEST_CID,
        "collaboration",
      ),
    );
    expect(paths.runsDir).toBe(path.join(paths.rootDir, "workflow_runs"));
    expect(paths.contextsDir).toBe(
      path.join(paths.rootDir, "workflow_contexts"),
    );
    expect(paths.activeFile).toBe(path.join(paths.rootDir, "active.json"));
    expect(paths.eventsFile).toBe(path.join(paths.rootDir, "events.jsonl"));
  });

  it("returns null instead of throwing for a workflow run with malformed step entries", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const runId = "wf-malformed";
    const runFile = c.collaborationPaths(TEST_UID, TEST_CID).runFile(runId);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(
      runFile,
      JSON.stringify({
        version: 1,
        id: runId,
        cid: TEST_CID,
        objective: "Malformed workflow",
        kind: "custom",
        status: "running",
        phase: "created",
        steps: [null],
        context_id: "wctx-malformed",
        created_by: "commander",
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:00:00.000Z",
      }),
      "utf8",
    );

    await expect(
      c.readWorkflowRun(TEST_UID, TEST_CID, runId),
    ).resolves.toBeNull();
  });
});

describe("group_chat collaboration › proposal and conflict schema", () => {
  it("normalizes legacy version 1 contexts with proposal and conflict defaults", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const contextId = "wctx-legacy";
    const contextFile = c
      .collaborationPaths(TEST_UID, TEST_CID)
      .contextFile(contextId);
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    fs.writeFileSync(
      contextFile,
      JSON.stringify({
        version: 1,
        id: contextId,
        cid: TEST_CID,
        run_id: "wf-legacy",
        objective: "Legacy shared context",
        phase: "created",
        constraints: [],
        facts: [],
        decisions: [],
        open_questions: [],
        risks: [],
        artifacts: [],
        agent_outputs: {},
        gates: [],
        updated_at: "2026-07-25T00:00:00.000Z",
      }),
      "utf8",
    );

    const context = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      contextId,
    );

    expect(context?.revision).toBe(0);
    expect(context?.proposals).toEqual([]);
    expect(context?.conflicts).toEqual([]);
  });

  it("initializes new contexts with revision 1 and empty proposal and conflict arrays", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const created = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Create proposal-ready context",
      kind: "discussion",
      created_by: "commander",
    });

    expect(created.context.revision).toBe(1);
    expect(created.context.proposals).toEqual([]);
    expect(created.context.conflicts).toEqual([]);
  });

  it("increments the context revision exactly once for each context write", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Track context writes",
      kind: "discussion",
      created_by: "commander",
    });

    expect(context.revision).toBe(1);
    await expect(
      c.readSharedTaskContext(TEST_UID, TEST_CID, context.id),
    ).resolves.toMatchObject({ revision: 1 });

    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      facts_add: [{ text: "One context write occurred" }],
    });

    expect(updated.revision).toBe(2);
    await expect(
      c.readSharedTaskContext(TEST_UID, TEST_CID, context.id),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it("serializes concurrent context patches without losing updates", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Preserve concurrent patches",
      kind: "discussion",
      created_by: "commander",
    });

    const results = await Promise.all([
      c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
        added_by: "agent-a",
        facts_add: [{ text: "Fact from agent A" }],
      }),
      c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
        added_by: "agent-b",
        facts_add: [{ text: "Fact from agent B" }],
      }),
    ]);

    expect(results.map((item) => item.revision).sort()).toEqual([2, 3]);
    const persisted = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(persisted?.revision).toBe(3);
    expect(persisted?.facts.map((item) => item.text).sort()).toEqual([
      "Fact from agent A",
      "Fact from agent B",
    ]);
  });

  it("serializes workflow context updates with concurrent patches", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Serialize workflow context updates",
      kind: "discussion",
      created_by: "commander",
    });
    const contextFile = c
      .collaborationPaths(TEST_UID, TEST_CID)
      .contextFile(context.id);
    const contextWriteRevisions: number[] = [];
    let contextWriteCount = 0;
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    let markSecondWriteCompleted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const secondWriteCompleted = new Promise<void>((resolve) => {
      markSecondWriteCompleted = resolve;
    });
    storageMocks.writeJson.mockImplementation(
      async (filePath: string, data: unknown) => {
        if (filePath === contextFile) {
          const writeNumber = ++contextWriteCount;
          contextWriteRevisions.push((data as { revision: number }).revision);
          if (writeNumber === 1) {
            markFirstWriteStarted();
            await firstWriteGate;
          }
          await storage.writeJson(filePath, data);
          if (writeNumber === 2) markSecondWriteCompleted();
          return;
        }
        await storage.writeJson(filePath, data);
      },
    );

    const patchPromise = c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      facts_add: [{ text: "Fact preserved across workflow update" }],
    });
    await firstWriteStarted;
    const readsBeforeWorkflowUpdate = storageMocks.readJson.mock.calls.length;
    const stepPromise = c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Concurrent workflow step",
      actor_id: "agent-b",
      type: "dispatch",
    });
    const workflowReadStarted =
      storageMocks.readJson.mock.calls.length > readsBeforeWorkflowUpdate;
    if (workflowReadStarted) await secondWriteCompleted;
    releaseFirstWrite();

    const [, step] = await Promise.all([patchPromise, stepPromise]);
    expect(contextWriteRevisions.sort()).toEqual([2, 3]);
    const persisted = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(persisted?.revision).toBe(3);
    expect(persisted?.facts.map((item) => item.text)).toContain(
      "Fact preserved across workflow update",
    );
    expect(persisted?.phase).toBe(step.type);
  });

  it("restores the in-memory revision and leaves persisted context unchanged when a write fails", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Recover from failed context write",
      kind: "discussion",
      created_by: "commander",
    });
    const before = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    let attemptedContext: { revision: number } | undefined;
    let attemptedRevision: number | undefined;
    storageMocks.writeJson.mockImplementationOnce(
      async (_filePath: string, data: unknown) => {
        attemptedContext = data as { revision: number };
        attemptedRevision = attemptedContext.revision;
        throw new Error("deterministic context write failure");
      },
    );

    await expect(
      c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
        added_by: "agent-a",
        facts_add: [{ text: "This fact must not persist" }],
      }),
    ).rejects.toThrow("deterministic context write failure");

    expect(attemptedRevision).toBe(2);
    expect(attemptedContext?.revision).toBe(1);
    await expect(
      c.readSharedTaskContext(TEST_UID, TEST_CID, context.id),
    ).resolves.toEqual(before);
  });
});

describe("group_chat collaboration › workflow lifecycle", () => {
  it("plans pending workflow steps and starts only dependency-ready steps", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Plan before dispatch",
      kind: "implementation",
      created_by: "commander",
    });

    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Research options",
        actor_id: "researcher",
        type: "discussion_round",
      },
    ]);
    const first = planned.steps[0];
    const plannedNext = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Implement chosen option",
        actor_id: "coder",
        type: "implementation",
        depends_on: [first.id],
      },
    ]);
    const second = plannedNext.steps[1];

    await expect(
      c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, second.id),
    ).rejects.toThrow(/dependencies are not completed/);
    const started = await c.startPlannedWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      first.id,
    );
    expect(started.status).toBe("running");
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, first.id, {
      status: "completed",
      result_summary: "Research done.",
    });
    const startedSecond = await c.startPlannedWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      second.id,
    );
    expect(startedSecond.status).toBe("running");

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain("workflow_planned");
  });

  it("creates an active workflow run with an empty shared context", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const created = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Coordinate Hermes and Codex",
      kind: "discussion",
      created_by: "commander",
    });

    expect(created.run.status).toBe("running");
    expect(created.run.phase).toBe("created");
    expect(created.run.context_id).toBe(created.context.id);
    expect(created.context.objective).toBe("Coordinate Hermes and Codex");
    expect(created.context.facts).toEqual([]);

    const activeRun = await c.readActiveWorkflowRun(TEST_UID, TEST_CID);
    const activeContext = await c.readActiveSharedTaskContext(
      TEST_UID,
      TEST_CID,
    );
    expect(activeRun?.id).toBe(created.run.id);
    expect(activeContext?.id).toBe(created.context.id);
  });

  it("reuses the active running workflow for ensureActiveWorkflowRun", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const first = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: "First objective",
      kind: "custom",
      created_by: "commander",
    });
    const second = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Second objective",
      kind: "custom",
      created_by: "commander",
    });
    expect(second.run.id).toBe(first.run.id);
    expect(second.context.id).toBe(first.context.id);
    expect(second.run.objective).toBe("First objective");
  });

  it("serializes concurrent first ensureActiveWorkflowRun callers into one workflow", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    let runWriteCount = 0;
    let releaseFirstRunWrite!: () => void;
    let markFirstRunWriteStarted!: () => void;
    const firstRunWriteGate = new Promise<void>((resolve) => {
      releaseFirstRunWrite = resolve;
    });
    const firstRunWriteStarted = new Promise<void>((resolve) => {
      markFirstRunWriteStarted = resolve;
    });
    storageMocks.writeJson.mockImplementation(
      async (filePath: string, data: unknown) => {
        if (filePath.includes("/workflow_runs/") && runWriteCount++ === 0) {
          markFirstRunWriteStarted();
          await firstRunWriteGate;
        }
        await storage.writeJson(filePath, data);
      },
    );

    const firstPromise = c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: "First concurrent objective",
      kind: "custom",
      created_by: "commander",
    });
    await firstRunWriteStarted;
    const secondPromise = c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Second concurrent objective",
      kind: "custom",
      created_by: "commander",
    });
    releaseFirstRunWrite();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(second.run.id).toBe(first.run.id);
    expect(second.context.id).toBe(first.context.id);
    expect(second.run.objective).toBe("First concurrent objective");
    expect((await c.readActiveWorkflowRun(TEST_UID, TEST_CID))?.id).toBe(
      first.run.id,
    );
  });
});

describe("group_chat collaboration › steps and gates", () => {
  it("starts and completes a dispatch step with a passing evidence gate", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Coordinate agents",
      kind: "discussion",
      created_by: "commander",
    });

    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Ask reviewer",
      actor_id: "reviewer",
      type: "dispatch",
      source_tool: "dispatch_to",
    });
    expect(step.status).toBe("running");

    const completed = await c.completeWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      step.id,
      {
        status: "completed",
        result_summary: "Reviewer found no blockers.",
      },
    );
    expect(completed.status).toBe("completed");

    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: "dispatch_result_present",
      status: "passed",
      checks: [{ name: "result_summary_present", status: "passed" }],
    });
    expect(gate.status).toBe("passed");

    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.steps[0].gate_result_id).toBe(gate.id);
    const context = await c.readActiveSharedTaskContext(TEST_UID, TEST_CID);
    expect(context?.gates.map((g) => g.id)).toContain(gate.id);
  });

  it("records failed steps without marking the whole run completed", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Coordinate agents",
      kind: "discussion",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Ask tester",
      actor_id: "tester",
      type: "dispatch",
      source_tool: "run_worker",
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: "failed",
      result_summary: "Tester failed to run.",
    });
    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.status).toBe("running");
    expect(next?.steps[0].status).toBe("failed");
  });
});

describe("group_chat collaboration › gate status invariant", () => {
  it("keeps retry, resume, and skip blocked while an active gate remains", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      {
        objective: "Preserve gate blocker across workflow transitions",
        kind: "implementation",
        created_by: "commander",
      },
    );
    const planned = await c.planWorkflowSteps(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      [
        { title: "Human approval", actor_id: "reviewer", type: "gate" },
        { title: "Retryable work", actor_id: "writer", type: "implementation" },
        { title: "New work", actor_id: "writer", type: "implementation" },
      ],
    );
    const gateStep = planned.steps[0];
    const retryable = planned.steps[1];
    const newWork = planned.steps[2];

    await c.startPlannedWorkflowStep(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      retryable.id,
    );
    await c.completeWorkflowStep(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      retryable.id,
      {
        status: "failed",
        result_summary: "Retry after approval.",
      },
    );
    await c.recordGateResult(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      gateStep.id,
      {
        name: "human_approval",
        status: "needs_review",
        reason: "User approval is required.",
        checks: [{ name: "approval", status: "needs_review" }],
      },
    );

    const retried = await c.retryWorkflowStep(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      retryable.id,
    );
    expect(retried.status).toBe("pending");
    expect(
      (await c.readWorkflowRun(TEST_UID, `${TEST_CID}-gate-invariant`, run.id))
        ?.status,
    ).toBe("blocked");

    const resumed = await c.resumeWorkflowRun(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      "Try to continue.",
    );
    expect(resumed.status).toBe("blocked");
    expect(resumed.phase).toBe("gate_needs_review");

    const skipped = await c.skipWorkflowStep(
      TEST_UID,
      `${TEST_CID}-gate-invariant`,
      run.id,
      retryable.id,
      "Skip until approval.",
    );
    expect(skipped.status).toBe("skipped");
    expect(
      (await c.readWorkflowRun(TEST_UID, `${TEST_CID}-gate-invariant`, run.id))
        ?.status,
    ).toBe("blocked");

    await expect(
      c.startPlannedWorkflowStep(
        TEST_UID,
        `${TEST_CID}-gate-invariant`,
        run.id,
        newWork.id,
      ),
    ).rejects.toThrow(/workflow run is blocked by gate/);
  });
});

describe("group_chat collaboration › workflow controls", () => {
  it("retries, skips, resumes, and aborts workflow runs", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Control workflow",
      kind: "implementation",
      created_by: "commander",
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: "Implement", actor_id: "coder", type: "implementation" },
    ]);
    const step = planned.steps[0];
    await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, step.id);
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: "failed",
      result_summary: "Tests failed.",
    });

    const retry = await c.retryWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      step.id,
    );
    expect(retry.status).toBe("pending");
    const skipped = await c.skipWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      step.id,
      "Not needed.",
    );
    expect(skipped.status).toBe("skipped");
    const resumed = await c.resumeWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
      "Continue manually.",
    );
    expect(resumed.status).toBe("running");
    const aborted = await c.abortWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
      "User stopped.",
    );
    expect(aborted.status).toBe("cancelled");

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 30);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "step_retried",
        "step_skipped",
        "workflow_resumed",
        "workflow_aborted",
      ]),
    );
  });
});

describe("group_chat collaboration › context patches", () => {
  it("merges facts, proposed decisions, risks, open questions, and artifacts", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Shared state design",
      kind: "discussion",
      created_by: "commander",
    });

    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "reviewer",
      facts_add: [
        {
          text: "events.jsonl is append-only",
          source: "agent",
          confidence: "high",
        },
      ],
      decisions_proposed: [
        {
          text: "Use JSONL as the source of truth",
          source: "agent",
          confidence: "high",
          reason: "It avoids snapshot overwrite loss.",
        },
      ],
      risks_add: [
        {
          text: "Markdown snapshots can go stale",
          source: "agent",
          confidence: "medium",
          severity: "medium",
        },
      ],
      open_questions_add: [
        {
          text: "Do we need a helper command?",
          source: "agent",
          confidence: "medium",
        },
      ],
      artifacts_add: [
        {
          id: "artifact-1",
          type: "research_note",
          path: "docs/research/tutti-agent-communication.md",
          summary: "Tutti research note",
        },
      ],
    });

    expect(updated.facts.map((item) => item.text)).toContain(
      "events.jsonl is append-only",
    );
    expect(updated.decisions.map((item) => item.text)).toContain(
      "Use JSONL as the source of truth",
    );
    expect(updated.risks[0].severity).toBe("medium");
    expect(updated.open_questions[0].text).toBe("Do we need a helper command?");
    expect(updated.artifacts[0].id).toBe("artifact-1");
  });

  it("keeps conflicting decisions out of decisions and records them as open questions", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Conflict handling",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        {
          text: "Do not use Redis for local POC",
          source: "agent",
          confidence: "high",
        },
      ],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      decisions_proposed: [
        {
          text: "Use Redis for local POC",
          source: "agent",
          confidence: "high",
          conflicts_with: ["Do not use Redis for local POC"],
        },
      ],
    });
    expect(updated.decisions.map((item) => item.text)).toEqual([
      "Do not use Redis for local POC",
    ]);
    expect(
      updated.open_questions.some((item) =>
        item.text.includes("Conflicting decision proposed"),
      ),
    ).toBe(true);
  });

  it("writes an append-only collaboration event for each context patch", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Audit context patches",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      summary: "Added audit fact",
      facts_add: [{ text: "Context patches are audited" }],
    });

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 10);
    expect(events.map((event) => event.type)).toEqual([
      "workflow_created",
      "context_patch_applied",
    ]);
    expect(events[1]).toMatchObject({
      run_id: context.run_id,
      context_id: context.id,
      actor_id: "agent-a",
      summary: "Added audit fact",
      payload: expect.objectContaining({ facts_added: 1 }),
    });
  });

  it("exposes context revision and active conflict counts in the snapshot", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Snapshot conflicts",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [{
        conflict_key: "market.entry_mode",
        proposal_kind: "recommendation",
        conflict_type: "recommendation",
        text: "Use direct entry",
      }],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      decisions_proposed: [{
        conflict_key: "market.entry_mode",
        proposal_kind: "recommendation",
        conflict_type: "recommendation",
        text: "Use a local partner",
      }],
    });
    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);

    expect(updated.revision).toBe(3);
    expect(snapshot).toMatchObject({
      run_id: run.id,
      context_id: context.id,
      context_revision: 3,
      resolved_conflicts_count: 0,
    });
    expect(snapshot?.active_conflicts).toHaveLength(1);
  });

  it("summarizes recent agent outputs and active conflicts without accepting pending proposals", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Summarize collaboration",
      kind: "discussion",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Review evidence",
      actor_id: "reviewer",
      type: "review",
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: "completed",
      result_summary: "Missing regulatory evidence",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [{
        conflict_key: "market.entry_mode",
        proposal_kind: "recommendation",
        conflict_type: "recommendation",
        text: "Use direct entry",
      }],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      decisions_proposed: [{
        conflict_key: "market.entry_mode",
        proposal_kind: "recommendation",
        conflict_type: "recommendation",
        text: "Use a local partner",
      }],
    });

    const summary = await c.buildSharedContextSummary(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(summary.startsWith(`Context Revision: ${updated.revision}`)).toBe(true);
    expect(summary).toContain("### Agent Outputs");
    expect(summary).toContain("- Reviewer: Missing regulatory evidence");
    expect(summary).toContain("### Active Conflicts");
    expect(summary).toContain(
      "- market.entry_mode (detected): Use direct entry | Use a local partner",
    );
    expect(summary).toContain(
      "Pending proposals are not accepted decisions.",
    );
    expect(summary).not.toContain("### Decisions");
  });

  it("updates active conflict review status and rejects transitions after resolution", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Review conflict status",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [{ conflict_key: "entry.mode", text: "Direct" }],
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      decisions_proposed: [{ conflict_key: "entry.mode", text: "Partner" }],
    });
    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);
    const conflictId = snapshot?.active_conflicts[0]?.id;
    expect(conflictId).toBeTruthy();

    const reviewed = await c.updateContextConflictStatus(
      TEST_UID,
      TEST_CID,
      context.id,
      conflictId!,
      { status: "awaiting_user", updated_by: "commander", reason: "Need preference" },
    );
    expect(reviewed.conflicts.find((item) => item.id === conflictId)?.status).toBe("awaiting_user");
    const proposalIds = reviewed.conflicts.find((item) => item.id === conflictId)?.proposal_ids || [];
    const resolved = await c.resolveContextConflictById(
      TEST_UID,
      TEST_CID,
      context.id,
      conflictId!,
      { decision: "accept", selected_proposal_ids: [proposalIds[0]], text: "Direct", resolved_by: "user" },
    );
    expect(resolved.conflicts.find((item) => item.id === conflictId)?.status).toBe("resolved");
    await expect(c.updateContextConflictStatus(
      TEST_UID,
      TEST_CID,
      context.id,
      conflictId!,
      { status: "under_review", updated_by: "commander" },
    )).rejects.toThrow(/already resolved/);
  });

  it("builds a compact shared context summary", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Summarize context",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      facts_add: [{ text: "Fact A", source: "agent", confidence: "high" }],
      decisions_proposed: [
        { text: "Decision A", source: "agent", confidence: "high" },
      ],
    });
    const summary = await c.buildSharedContextSummary(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(summary).toContain("Objective: Summarize context");
    expect(summary).toContain("Revision: 2");
    expect(summary).toContain("- Fact A");
    expect(summary).toContain("- Decision A");
  });
});

describe("group_chat collaboration › nested dispatch recording", () => {
  it("recordNestedDispatchStep wraps a successful nested dispatch result", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const recorded = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: "User asks for review",
      actor_id: "reviewer",
      actor_name: "Reviewer",
      source_tool: "dispatch_to",
      task: "Review the plan",
      result: "No blockers.",
    });
    expect(recorded.step.status).toBe("completed");
    expect(recorded.gate.status).toBe("passed");
    expect(recorded.run.steps).toHaveLength(1);
    expect(recorded.context.agent_outputs[recorded.step.id].summary).toBe(
      "No blockers.",
    );
  });

  it("marks empty nested dispatch results as needs_review without blocking later dispatches", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const recorded = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: "User asks for review",
      actor_id: "reviewer",
      actor_name: "Reviewer",
      source_tool: "dispatch_to",
      task: "Review the plan",
      result: "   ",
    });
    expect(recorded.step.status).toBe("completed");
    expect(recorded.gate.status).toBe("needs_review");
    expect(recorded.gate.reason).toBe(
      "Nested dispatch returned an empty result.",
    );
    expect(recorded.run.status).toBe("running");
    expect(recorded.run.phase).toBe("dispatch");

    const followup = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
      objective: "User asks for review",
      actor_id: "coder",
      actor_name: "Coder",
      source_tool: "run_worker",
      task: "Continue after empty reviewer result",
      result: "Follow-up completed.",
    });
    expect(followup.run.status).toBe("running");
    expect(followup.run.steps).toHaveLength(2);
    expect(followup.gate.status).toBe("passed");
    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);
    expect(snapshot?.blocking_gate).toBeUndefined();
  });
});

describe("group_chat collaboration › gate control flow", () => {
  it("blocks new workflow steps when a gate needs review, then resumes after approval", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Gate controlled workflow",
      kind: "review",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Review output",
      actor_id: "reviewer",
      type: "review",
    });
    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: "human_review",
      status: "needs_review",
      reason: "Needs a human decision.",
      checks: [{ name: "human_review_required", status: "needs_review" }],
    });

    const blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(blockedRun?.status).toBe("blocked");
    expect(blockedRun?.phase).toBe("gate_needs_review");
    await expect(
      c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
        title: "Should not start",
        actor_id: "coder",
        type: "implementation",
      }),
    ).rejects.toThrow(/workflow run is blocked by gate/);

    const approved = await c.reviewCollaborationGate(
      TEST_UID,
      TEST_CID,
      gate.id,
      {
        decision: "approve",
        reviewed_by: "user",
        reason: "Looks good.",
      },
    );
    expect(approved.run.status).toBe("running");
    expect(approved.gate.status).toBe("passed");
    expect(approved.gate.review_decision).toBe("approved");

    const next = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Continue",
      actor_id: "coder",
      type: "implementation",
    });
    expect(next.status).toBe("running");

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain("gate_reviewed");
  });

  it("marks dependent pending steps blocked by a gate and unblocks them after approval", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Dependency gate workflow",
      kind: "implementation",
      created_by: "commander",
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: "Review checkpoint", actor_id: "reviewer", type: "gate" },
    ]);
    const gateStep = planned.steps[0];
    const withDependent = await c.planWorkflowSteps(
      TEST_UID,
      TEST_CID,
      run.id,
      [
        {
          title: "Dependent implementation",
          actor_id: "coder",
          type: "implementation",
          depends_on: [gateStep.id],
        },
      ],
    );
    const dependent = withDependent.steps[1];
    await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, gateStep.id);
    const gate = await c.recordGateResult(
      TEST_UID,
      TEST_CID,
      run.id,
      gateStep.id,
      {
        name: "review_gate",
        status: "needs_review",
        reason: "Needs approval.",
        checks: [{ name: "approval", status: "needs_review" }],
      },
    );

    let blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(
      blockedRun?.steps.find((step) => step.id === dependent.id)?.status,
    ).toBe("blocked");

    await c.reviewCollaborationGate(TEST_UID, TEST_CID, gate.id, {
      decision: "approve",
      reviewed_by: "user",
    });
    blockedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(
      blockedRun?.steps.find((step) => step.id === dependent.id)?.status,
    ).toBe("pending");
  });

  it("injects a blocking gate instruction into shared context prompt blocks", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Prompt gate awareness",
      kind: "review",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Human review",
      actor_id: "reviewer",
      type: "gate",
    });
    await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: "human_review",
      status: "needs_review",
      reason: "Manual confirmation is required.",
      checks: [{ name: "manual_confirmation", status: "needs_review" }],
    });

    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);
    expect(snapshot?.blocking_gate?.name).toBe("human_review");
    const block = await bus._buildActiveSharedTaskContextBlockForTest(
      TEST_UID,
      TEST_CID,
    );

    expect(block).toContain("### Blocking Gate");
    expect(block).toContain("Gate: human_review");
    expect(block).toContain("Status: needs_review");
    expect(block).toContain(
      "Do not call dispatch_to, hand_off_to, or run_worker",
    );
  });

  it("keeps the workflow blocked when a gate review is rejected", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Rejected gate workflow",
      kind: "review",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Quality gate",
      actor_id: "reviewer",
      type: "gate",
    });
    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: "quality_gate",
      status: "failed",
      reason: "Output is incomplete.",
      checks: [{ name: "deliverable_complete", status: "failed" }],
    });

    const rejected = await c.reviewCollaborationGate(
      TEST_UID,
      TEST_CID,
      gate.id,
      {
        decision: "reject",
        reviewed_by: "user",
        reason: "Still incomplete.",
      },
    );

    expect(rejected.run.status).toBe("blocked");
    expect(rejected.run.phase).toBe("gate_rejected");
    expect(rejected.gate.status).toBe("failed");
    expect(rejected.gate.review_decision).toBe("rejected");
    await expect(
      c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
        title: "Still blocked",
        actor_id: "coder",
        type: "implementation",
      }),
    ).rejects.toThrow(/workflow run is blocked by gate/);
  });
});

describe("group_chat collaboration › conflict-dependent workflow blockers", () => {
  it("blocks only context-dependent steps while unrelated work and the run stay active", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Block only market-entry dependents",
      kind: "implementation",
      created_by: "commander",
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: "Collect more evidence", actor_id: null, type: "review" },
      {
        title: "Write strategy",
        actor_id: null,
        type: "implementation",
        context_dependencies: ["market.entry_mode"],
      },
      {
        title: "Build budget",
        actor_id: null,
        type: "implementation",
        context_dependencies: ["market.entry_mode"],
      },
    ]);

    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );

    const conflict = conflicted.conflicts[0];
    const persisted = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(persisted?.status).toBe("running");
    expect(
      persisted?.steps.find((step) => step.id === planned.steps[0].id),
    ).toMatchObject({ status: "pending" });
    for (const dependent of planned.steps.slice(1)) {
      expect(
        persisted?.steps.find((step) => step.id === dependent.id),
      ).toMatchObject({
        status: "blocked",
        context_dependencies: ["market.entry_mode"],
        blocked_by_conflict_ids: [conflict.id],
      });
    }
    expect(conflict.affected_step_ids).toEqual(
      planned.steps.slice(1).map((step) => step.id),
    );
  });

  it("normalizes and blocks late-planned dependencies, synchronizes affected ids, and repairs persisted bypass attempts on start", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Block late planned work",
      kind: "implementation",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];

    const withLateStep = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Late strategy step",
        actor_id: "writer",
        type: "implementation",
        context_dependencies: [
          " MARKET.ENTRY_MODE ",
          "not a valid key",
          "market.entry_mode",
        ],
        blocked_by_conflict_ids: [
          "not a valid id",
          "wconflict-stale",
          conflict.id,
        ],
      },
    ]);
    const lateStep = withLateStep.steps[0];
    expect(lateStep).toMatchObject({
      status: "blocked",
      context_dependencies: ["market.entry_mode"],
      blocked_by_conflict_ids: [conflict.id],
    });
    const synced = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(synced?.conflicts[0].affected_step_ids).toEqual([lateStep.id]);

    const runFile = c.collaborationPaths(TEST_UID, TEST_CID).runFile(run.id);
    const bypassed = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(bypassed).not.toBeNull();
    if (!bypassed) return;
    bypassed.steps[0].status = "pending";
    delete bypassed.steps[0].blocked_by_conflict_ids;
    await storage.writeJson(runFile, bypassed);

    vi.resetModules();
    const reloaded =
      await import("../../../../src/main/features/group_chat/collaboration");
    await expect(
      reloaded.startPlannedWorkflowStep(
        TEST_UID,
        TEST_CID,
        run.id,
        lateStep.id,
      ),
    ).rejects.toThrow(/workflow step is not pending: blocked/);
    const repaired = await reloaded.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(repaired?.steps[0]).toMatchObject({
      status: "blocked",
      context_dependencies: ["market.entry_mode"],
      blocked_by_conflict_ids: [conflict.id],
    });
  });

  it("keeps retry and skip-dependent restoration blocked while the conflict remains active", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Keep retries conflict blocked",
      kind: "implementation",
      created_by: "commander",
    });
    const firstPlan = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: "Collect prerequisite", actor_id: "researcher", type: "review" },
    ]);
    const prerequisite = firstPlan.steps[0];
    const secondPlan = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Write dependent strategy",
        actor_id: "writer",
        type: "implementation",
        depends_on: [prerequisite.id],
        context_dependencies: ["market.entry_mode"],
      },
    ]);
    const dependent = secondPlan.steps[1];
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];

    const retried = await c.retryWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      dependent.id,
    );
    expect(retried).toMatchObject({
      status: "blocked",
      blocked_by_conflict_ids: [conflict.id],
    });
    const resumed = await c.resumeWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
      "Try to continue.",
    );
    expect(
      resumed.steps.find((step) => step.id === dependent.id),
    ).toMatchObject({
      status: "blocked",
      blocked_by_conflict_ids: [conflict.id],
    });
    await c.skipWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      prerequisite.id,
      "Prerequisite no longer needed.",
    );

    const persisted = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(
      persisted?.steps.find((step) => step.id === dependent.id),
    ).toMatchObject({
      status: "blocked",
      blocked_by_conflict_ids: [conflict.id],
    });
    let synced = await c.readSharedTaskContext(TEST_UID, TEST_CID, context.id);
    expect(synced?.conflicts[0].affected_step_ids).toEqual([dependent.id]);

    await c.skipWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      dependent.id,
      "Skip conflicted work.",
    );
    synced = await c.readSharedTaskContext(TEST_UID, TEST_CID, context.id);
    expect(synced?.conflicts[0].affected_step_ids).toEqual([]);
  });

  it("reconciles conflict-cleared dependent steps after their prerequisite completes", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Restore after prerequisite completion",
      kind: "implementation",
      created_by: "commander",
    });
    const prerequisitePlan = await c.planWorkflowSteps(
      TEST_UID,
      TEST_CID,
      run.id,
      [
        {
          title: "Collect prerequisite evidence",
          actor_id: "researcher",
          type: "review",
        },
      ],
    );
    const prerequisite = prerequisitePlan.steps[0];
    const dependentPlan = await c.planWorkflowSteps(
      TEST_UID,
      TEST_CID,
      run.id,
      [
        {
          title: "Write strategy after evidence",
          actor_id: "writer",
          type: "implementation",
          depends_on: [prerequisite.id],
          context_dependencies: ["market.entry_mode"],
        },
      ],
    );
    const dependent = dependentPlan.steps[1];
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    conflicted.conflicts[0].status = "resolved";
    conflicted.conflicts[0].updated_at = "2026-07-25T12:00:00.000Z";
    await storage.writeJson(
      c.collaborationPaths(TEST_UID, TEST_CID).contextFile(context.id),
      conflicted,
    );

    await c.resolveContextConflict(TEST_UID, TEST_CID, context.id, {
      decision: "accept",
      text: "Use direct entry",
      resolved_by: "user",
    });
    const beforePrerequisite = await c.readWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
    );
    expect(
      beforePrerequisite?.steps.find((step) => step.id === dependent.id)
        ?.status,
    ).toBe("blocked");
    expect(
      beforePrerequisite?.steps.find((step) => step.id === dependent.id)
        ?.blocked_by_conflict_ids ?? [],
    ).toEqual([]);

    await c.startPlannedWorkflowStep(
      TEST_UID,
      TEST_CID,
      run.id,
      prerequisite.id,
    );
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, prerequisite.id, {
      status: "completed",
      result_summary: "Evidence collected.",
    });

    const afterPrerequisite = await c.readWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
    );
    expect(
      afterPrerequisite?.steps.find((step) => step.id === dependent.id),
    ).toMatchObject({ status: "pending" });
  });

  it("clears stale affected ids for resolved and dismissed conflicts during reconciliation", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Clear terminal conflict references",
      kind: "discussion",
      created_by: "commander",
    });
    const persistedContext = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    if (!persistedContext) return;
    const timestamp = "2026-07-25T12:00:00.000Z";
    persistedContext.conflicts = [
      {
        id: "wconflict-resolved",
        conflict_key: "market.entry_mode",
        type: "recommendation",
        status: "resolved",
        proposal_ids: [],
        affected_step_ids: ["wstep-stale-resolved"],
        created_at: timestamp,
        updated_at: timestamp,
      },
      {
        id: "wconflict-dismissed",
        conflict_key: "architecture.database_strategy",
        type: "implementation",
        status: "dismissed",
        proposal_ids: [],
        affected_step_ids: ["wstep-stale-dismissed"],
        created_at: timestamp,
        updated_at: timestamp,
      },
    ];
    await storage.writeJson(
      c.collaborationPaths(TEST_UID, TEST_CID).contextFile(context.id),
      persistedContext,
    );

    const resumed = await c.resumeWorkflowRun(
      TEST_UID,
      TEST_CID,
      run.id,
      "Reconcile terminal conflicts.",
    );
    expect(resumed.status).toBe("running");
    const reconciled = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(
      reconciled?.conflicts.map((conflict) => conflict.affected_step_ids),
    ).toEqual([[], []]);
  });

  it("keeps a conflict-dependent step blocked when its gate is approved", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Preserve conflict blocker across gate approval",
      kind: "review",
      created_by: "commander",
    });
    const firstPlan = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      { title: "Review checkpoint", actor_id: "reviewer", type: "gate" },
    ]);
    const gateStep = firstPlan.steps[0];
    const secondPlan = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Implement approved strategy",
        actor_id: "coder",
        type: "implementation",
        depends_on: [gateStep.id],
        context_dependencies: ["market.entry_mode"],
      },
    ]);
    const dependent = secondPlan.steps[1];
    await c.startPlannedWorkflowStep(TEST_UID, TEST_CID, run.id, gateStep.id);
    const gate = await c.recordGateResult(
      TEST_UID,
      TEST_CID,
      run.id,
      gateStep.id,
      {
        name: "strategy_gate",
        status: "needs_review",
        checks: [{ name: "approval", status: "needs_review" }],
      },
    );
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];

    const approved = await c.reviewCollaborationGate(
      TEST_UID,
      TEST_CID,
      gate.id,
      {
        decision: "approve",
        reviewed_by: "user",
      },
    );

    expect(approved.run.status).toBe("running");
    expect(
      approved.run.steps.find((step) => step.id === dependent.id),
    ).toMatchObject({
      status: "blocked",
      blocked_by_conflict_ids: [conflict.id],
    });
    expect(approved.context.conflicts[0].affected_step_ids).toEqual([
      dependent.id,
    ]);
  });

  it("prepares conflict resolution to restore eligible steps without adding ID-based resolution", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Restore after future resolution hook",
      kind: "implementation",
      created_by: "commander",
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Write final strategy",
        actor_id: "writer",
        type: "implementation",
        context_dependencies: ["market.entry_mode"],
      },
    ]);
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    conflicted.conflicts[0].status = "resolved";
    conflicted.conflicts[0].updated_at = "2026-07-25T12:00:00.000Z";
    await storage.writeJson(
      c.collaborationPaths(TEST_UID, TEST_CID).contextFile(context.id),
      conflicted,
    );

    await c.resolveContextConflict(TEST_UID, TEST_CID, context.id, {
      decision: "accept",
      text: "Use direct entry",
      resolved_by: "user",
    });

    const restored = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(
      restored?.steps.find((step) => step.id === planned.steps[0].id),
    ).toMatchObject({ status: "pending" });
    expect(restored?.steps[0].blocked_by_conflict_ids ?? []).toEqual([]);
  });
});

describe("group_chat collaboration › keyed context proposals", () => {
  it("detects competing proposals without accepting them as decisions and keeps the active conflict stable", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Choose a market entry mode",
      kind: "discussion",
      created_by: "commander",
    });

    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      base_context_revision: 1,
      decisions_proposed: [
        {
          conflict_key: "market.entry_mode",
          proposal_kind: "recommendation",
          conflict_type: "recommendation",
          text: "Use direct entry",
          reason: "Higher control",
          evidence_refs: ["artifact-a"],
        },
      ],
    });
    const detected = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      base_context_revision: 2,
      decisions_proposed: [
        {
          conflict_key: "market.entry_mode",
          proposal_kind: "recommendation",
          conflict_type: "recommendation",
          text: "Use a local partner",
          reason: "Lower regulatory risk",
          evidence_refs: ["artifact-b"],
        },
      ],
    });

    expect(detected.decisions).toEqual([]);
    expect(detected.proposals).toHaveLength(2);
    expect(detected.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflict_key: "market.entry_mode",
          kind: "recommendation",
          text: "Use direct entry",
          evidence_refs: ["artifact-a"],
          status: "pending",
        }),
        expect.objectContaining({
          conflict_key: "market.entry_mode",
          kind: "recommendation",
          text: "Use a local partner",
          evidence_refs: ["artifact-b"],
          status: "pending",
        }),
      ]),
    );
    expect(detected.conflicts).toHaveLength(1);
    expect(detected.conflicts[0]).toMatchObject({
      conflict_key: "market.entry_mode",
      type: "recommendation",
      status: "detected",
      proposal_ids: detected.proposals.map((proposal) => proposal.id),
    });

    const conflictId = detected.conflicts[0].id;
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-c",
      base_context_revision: 3,
      decisions_proposed: [
        {
          conflict_key: "market.entry_mode",
          proposal_kind: "recommendation",
          conflict_type: "recommendation",
          text: "Acquire a local incumbent",
          evidence_refs: ["artifact-c"],
        },
      ],
    });

    expect(updated.conflicts).toHaveLength(1);
    expect(updated.conflicts[0].id).toBe(conflictId);
    expect(updated.conflicts[0].proposal_ids).toEqual(
      updated.proposals.map((proposal) => proposal.id),
    );
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 0);
    expect(
      events.filter((event) => event.type === "proposal_recorded"),
    ).toHaveLength(3);
    const conflictEvents = events.filter(
      (event) => event.type === "conflict_detected",
    );
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0].payload).toMatchObject({
      conflict_id: conflictId,
      proposal_count: 2,
    });
    expect(JSON.stringify(conflictEvents[0])).not.toContain("Use direct entry");
    expect(JSON.stringify(conflictEvents[0])).not.toContain(
      "Use a local partner",
    );
  });

  it("detects competing proposals only once for identical normalized text in the active lifecycle", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Deduplicate proposal text",
      kind: "discussion",
      created_by: "commander",
    });

    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      base_context_revision: 1,
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      base_context_revision: 2,
      decisions_proposed: [
        { conflict_key: "MARKET.ENTRY_MODE", text: "  use   DIRECT entry  " },
      ],
    });

    expect(updated.decisions).toEqual([]);
    expect(updated.proposals).toHaveLength(1);
    expect(updated.proposals[0]).toMatchObject({
      conflict_key: "market.entry_mode",
      kind: "decision",
      text: "Use direct entry",
      status: "pending",
    });
    expect(updated.conflicts).toEqual([]);
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 0);
    expect(
      events.filter((event) => event.type === "proposal_recorded"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "conflict_detected"),
    ).toHaveLength(0);
  });

  it.each(["resolved", "dismissed"] as const)(
    "detects competing proposals again after a %s conflict becomes terminal",
    async (terminalStatus) => {
      const c =
        await import("../../../../src/main/features/group_chat/collaboration");
      const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
        objective: `Recur after ${terminalStatus}`,
        kind: "discussion",
        created_by: "commander",
      });
      await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
        added_by: "agent-a",
        base_context_revision: 1,
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use direct entry" },
        ],
      });
      const firstCycle = await c.applyContextPatch(
        TEST_UID,
        TEST_CID,
        context.id,
        {
          added_by: "agent-b",
          base_context_revision: 2,
          decisions_proposed: [
            { conflict_key: "market.entry_mode", text: "Use a local partner" },
          ],
        },
      );
      const firstConflictId = firstCycle.conflicts[0].id;
      const terminalAt = "2026-07-25T12:00:00.000Z";
      firstCycle.conflicts[0].status = terminalStatus;
      firstCycle.conflicts[0].updated_at = terminalAt;
      firstCycle.proposals.forEach((proposal, index) => {
        proposal.status =
          terminalStatus === "resolved" && index === 0
            ? "accepted"
            : "rejected";
        proposal.resolved_at = terminalAt;
      });
      fs.writeFileSync(
        c.collaborationPaths(TEST_UID, TEST_CID).contextFile(context.id),
        JSON.stringify(firstCycle),
        "utf8",
      );

      await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
        added_by: "agent-c",
        base_context_revision: firstCycle.revision,
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use direct entry" },
        ],
      });
      const recurrent = await c.applyContextPatch(
        TEST_UID,
        TEST_CID,
        context.id,
        {
          added_by: "agent-d",
          base_context_revision: firstCycle.revision + 1,
          decisions_proposed: [
            { conflict_key: "market.entry_mode", text: "Use a local partner" },
          ],
        },
      );

      expect(recurrent.proposals).toHaveLength(4);
      expect(recurrent.conflicts).toHaveLength(2);
      expect(recurrent.conflicts[0]).toMatchObject({
        id: firstConflictId,
        status: terminalStatus,
      });
      expect(recurrent.conflicts[1]).toMatchObject({
        conflict_key: "market.entry_mode",
        status: "detected",
      });
      expect(recurrent.conflicts[1].id).not.toBe(firstConflictId);
      expect(recurrent.conflicts[1].proposal_ids).toEqual(
        recurrent.proposals.slice(2).map((proposal) => proposal.id),
      );
    },
  );

  it("detects competing proposals against current locked state on a stale base revision", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Merge a stale patch safely",
      kind: "discussion",
      created_by: "commander",
    });
    const current = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      base_context_revision: 1,
      facts_add: [{ text: "Current constraint remains authoritative" }],
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const currentFactId = current.facts[0].id;

    const stale = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      base_context_revision: 1,
      facts_add: [
        { text: "Current constraint remains authoritative" },
        { text: "A local partner is available" },
      ],
      risks_add: [
        { text: "Partner diligence may delay launch", severity: "medium" },
      ],
      open_questions_add: [{ text: "Which partner has the right license?" }],
      artifacts_add: [
        { id: "artifact-stale", type: "note", summary: "Partner evidence" },
      ],
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use a local partner" },
      ],
      obsolete_item_ids: [currentFactId],
    });

    expect(stale.facts.map((item) => item.text)).toEqual([
      "Current constraint remains authoritative",
      "A local partner is available",
    ]);
    expect(stale.risks.map((item) => item.text)).toContain(
      "Partner diligence may delay launch",
    );
    expect(stale.open_questions.map((item) => item.text)).toContain(
      "Which partner has the right license?",
    );
    expect(stale.artifacts.map((item) => item.id)).toContain("artifact-stale");
    expect(stale.decisions).toEqual([]);
    expect(stale.proposals).toHaveLength(2);
    expect(stale.conflicts).toHaveLength(1);
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 0);
    expect(
      events.filter((event) => event.type === "context_revision_mismatch"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "context_revision_mismatch")
        ?.payload,
    ).toMatchObject({
      base_context_revision: 1,
      current_context_revision: 2,
      obsolete_count_ignored: 1,
    });
  });

  it("detects competing proposals for every key in one patch and records each conflict event", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Detect multiple keyed conflicts",
      kind: "discussion",
      created_by: "commander",
    });

    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      base_context_revision: 1,
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
        { conflict_key: "market.entry_mode", text: "Use a local partner" },
        { conflict_key: "architecture.database_strategy", text: "Use JSONL" },
        { conflict_key: "architecture.database_strategy", text: "Use SQLite" },
      ],
    });

    expect(updated.conflicts).toHaveLength(2);
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 0);
    expect(
      events.filter((event) => event.type === "conflict_detected"),
    ).toHaveLength(2);
  });

  it("parses the keyed proposal wire contract with validated fields and defaults", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const result = c.extractContextPatchBlocks(
      `<context-patch>${JSON.stringify({
        base_context_revision: 7,
        decisions_proposed: [
          {
            text: "Use a local partner",
            conflict_key: "MARKET.ENTRY_MODE",
            proposal_kind: "recommendation",
            conflict_type: "implementation",
            evidence_refs: [" artifact-a ", "artifact-a", "", 42],
          },
          {
            text: "Legacy fallback",
            conflict_key: "not a valid key",
            proposal_kind: "fact",
            conflict_type: "unknown",
            evidence_refs: ["artifact-b"],
          },
        ],
      })}</context-patch>`,
      "agent-a",
    );

    expect(result.errors).toEqual([]);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].base_context_revision).toBe(7);
    expect(result.patches[0].decisions_proposed?.[0]).toMatchObject({
      conflict_key: "market.entry_mode",
      proposal_kind: "recommendation",
      conflict_type: "implementation",
      evidence_refs: ["artifact-a"],
    });
    expect(result.patches[0].decisions_proposed?.[1]).toMatchObject({
      proposal_kind: "decision",
      conflict_type: "recommendation",
      evidence_refs: ["artifact-b"],
    });
    expect(
      result.patches[0].decisions_proposed?.[1].conflict_key,
    ).toBeUndefined();
  });

  it("keeps the shared task context patch contract in one canonical static prompt source", () => {
    const promptsDir = path.join(process.cwd(), "src", "main", "prompts");
    const canonicalPath = path.join(
      promptsDir,
      "chat_shared_task_context_protocol.md",
    );
    const canonicalExists = fs.existsSync(canonicalPath);
    expect(canonicalExists).toBe(true);
    if (!canonicalExists) return;

    const canonical = fs.readFileSync(canonicalPath, "utf8");
    for (const field of [
      "base_context_revision",
      "conflict_key",
      "proposal_kind",
      "conflict_type",
      "evidence_refs",
    ]) {
      expect(canonical, `canonical prompt must document ${field}`).toContain(
        field,
      );
    }
    expect(canonical).toMatch(/copy[^\n]+revision|revision[^\n]+copy/i);
    expect(canonical).toContain("proposal_kind: \"decision\"");
    expect(canonical).toContain("conflict_type: \"recommendation\"");
    expect(canonical).toContain("<context-patch>");
    expect(canonical).not.toContain("## Runtime injection");

    for (const promptName of [
      "chat_agent_in_group.md",
      "chat_commander.md",
      "chat_cli_agent.md",
    ]) {
      const roleSource = fs.readFileSync(
        path.join(promptsDir, promptName),
        "utf8",
      );
      for (const schemaToken of [
        "base_context_revision",
        "conflict_key",
        "proposal_kind",
        "conflict_type",
        "evidence_refs",
        "<context-patch>",
      ]) {
        expect(
          roleSource,
          `${promptName} must not duplicate ${schemaToken}`,
        ).not.toContain(schemaToken);
      }
    }
  });
});

describe("group_chat collaboration › structured context patch extraction", () => {
  it("extracts valid context-patch blocks and removes them from visible text", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const result = c.extractContextPatchBlocks(
      "Summary for user.\n<context-patch>\n{\"facts_add\":[{\"text\":\"Shared files are the first transport\"}],\"decisions_proposed\":[{\"text\":\"Keep Redis out of the local POC\"}]}\n</context-patch>\nTail.",
      "agent-a",
    );

    expect(result.errors).toEqual([]);
    expect(result.cleanText).toBe("Summary for user.\nTail.");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].added_by).toBe("agent-a");
    expect(result.patches[0].facts_add?.[0].text).toBe(
      "Shared files are the first transport",
    );
    expect(result.patches[0].decisions_proposed?.[0].text).toBe(
      "Keep Redis out of the local POC",
    );
  });

  it("rejects look-alike and malformed context-patch blocks without stripping them", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const malformed = "Visible\n<context-patch>{bad json}</context-patch>";
    const result = c.extractContextPatchBlocks(malformed, "agent-a");

    expect(result.patches).toEqual([]);
    expect(result.cleanText).toBe(malformed);
    expect(result.errors[0]).toContain("invalid context-patch JSON");

    const lookalike = c.extractContextPatchBlocks(
      "<context_patch>{\"facts_add\":[{\"text\":\"wrong tag\"}]}</context_patch>",
      "agent-a",
    );
    expect(lookalike.cleanText).toContain("<context_patch>");
    expect(lookalike.patches).toEqual([]);
  });
});

describe("group_chat collaboration › conflict resolution and event replay", () => {
  it("resolves conflicting decisions and replays the collaboration event log", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Resolve conflict",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [{ text: "Use shared files first" }],
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-b",
      decisions_proposed: [
        { text: "Use Redis first", conflicts_with: ["Use shared files first"] },
      ],
    });
    let current = await c.readSharedTaskContext(TEST_UID, TEST_CID, context.id);
    expect(
      current?.open_questions.some((item) =>
        item.text.includes("Conflicting decision proposed"),
      ),
    ).toBe(true);

    current = await c.resolveContextConflict(TEST_UID, TEST_CID, context.id, {
      decision: "accept",
      text: "Use shared files first",
      resolved_by: "user",
      reason: "Matches local PC constraints.",
    });

    expect(current.decisions.map((item) => item.text)).toContain(
      "Use shared files first",
    );
    expect(
      current.open_questions.some((item) =>
        item.text.includes("Conflicting decision proposed"),
      ),
    ).toBe(false);
    const replay = await c.replayCollaborationEvents(TEST_UID, TEST_CID);
    expect(replay.total_events).toBeGreaterThanOrEqual(4);
    expect(replay.by_type.context_patch_applied).toBe(2);
    expect(replay.by_type.conflict_resolved).toBe(1);
  });

  it("serializes legacy conflict resolution with concurrent context patches", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Serialize legacy resolution",
      kind: "discussion",
      created_by: "commander",
    });
    const contextFile = c
      .collaborationPaths(TEST_UID, TEST_CID)
      .contextFile(context.id);
    let contextWriteCount = 0;
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    let markSecondWriteCompleted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const secondWriteCompleted = new Promise<void>((resolve) => {
      markSecondWriteCompleted = resolve;
    });
    storageMocks.writeJson.mockImplementation(
      async (filePath: string, data: unknown) => {
        if (filePath === contextFile) {
          const writeNumber = ++contextWriteCount;
          if (writeNumber === 1) {
            markFirstWriteStarted();
            await firstWriteGate;
          }
          await storage.writeJson(filePath, data);
          if (writeNumber === 2) markSecondWriteCompleted();
          return;
        }
        await storage.writeJson(filePath, data);
      },
    );

    const patchPromise = c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      facts_add: [{ text: "Fact preserved across resolution" }],
    });
    await firstWriteStarted;
    const readsBeforeResolution = storageMocks.readJson.mock.calls.length;
    const resolutionPromise = c.resolveContextConflict(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        decision: "accept",
        text: "Decision preserved across patch",
        resolved_by: "user",
      },
    );
    const resolutionReadStarted =
      storageMocks.readJson.mock.calls.length > readsBeforeResolution;
    if (resolutionReadStarted) await secondWriteCompleted;
    releaseFirstWrite();

    const results = await Promise.all([patchPromise, resolutionPromise]);
    expect(results.map((item) => item.revision).sort()).toEqual([2, 3]);
    const persisted = await c.readSharedTaskContext(
      TEST_UID,
      TEST_CID,
      context.id,
    );
    expect(persisted?.revision).toBe(3);
    expect(persisted?.facts.map((item) => item.text)).toContain(
      "Fact preserved across resolution",
    );
    expect(persisted?.decisions.map((item) => item.text)).toContain(
      "Decision preserved across patch",
    );
  });
});

describe("group_chat collaboration › stored conflict resolution", () => {
  it("resolves a stored context conflict by id with provenance and restores eligible steps", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Resolve stored context conflict",
      kind: "implementation",
      created_by: "commander",
    });
    const planned = await c.planWorkflowSteps(TEST_UID, TEST_CID, run.id, [
      {
        title: "Write strategy",
        actor_id: "writer",
        type: "implementation",
        context_dependencies: ["market.entry_mode"],
      },
      { title: "Unrelated review", actor_id: "reviewer", type: "review" },
    ]);
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        {
          conflict_key: "market.entry_mode",
          text: "Use direct entry",
          evidence_refs: ["evidence-a"],
        },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      TEST_CID,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          {
            conflict_key: "market.entry_mode",
            text: "Use a local partner",
            evidence_refs: ["evidence-b"],
          },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];
    const selected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    );
    const rejected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use direct entry",
    );
    expect(selected).toBeDefined();
    expect(rejected).toBeDefined();

    const resolved = await c.resolveContextConflictById(
      TEST_UID,
      TEST_CID,
      context.id,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected!.id],
        text: "Use a local partner",
        reason: "Matches the user constraint to minimize initial investment",
        resolved_by: "commander",
      },
    );

    expect(resolved.conflicts[0]).toMatchObject({
      id: conflict.id,
      status: "resolved",
      resolution: {
        decision: "accept",
        selected_proposal_ids: [selected!.id],
        text: "Use a local partner",
        reason: "Matches the user constraint to minimize initial investment",
        resolved_by: "commander",
      },
    });
    expect(resolved.conflicts[0].resolution?.resolved_at).toEqual(
      expect.any(String),
    );
    expect(
      resolved.proposals.find((proposal) => proposal.id === selected!.id),
    ).toMatchObject({ status: "accepted" });
    expect(
      resolved.proposals.find((proposal) => proposal.id === rejected!.id),
    ).toMatchObject({ status: "rejected" });
    expect(resolved.decisions).toHaveLength(1);
    expect(resolved.decisions[0]).toMatchObject({
      text: "Use a local partner",
      added_by: "commander",
      source_ref: expect.stringContaining(conflict.id),
      reason: "Matches the user constraint to minimize initial investment",
    });
    expect(resolved.decisions[0].source_ref).toContain(selected!.id);

    const persistedRun = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    const restoredStep = persistedRun?.steps.find(
      (step) => step.id === planned.steps[0].id,
    );
    expect(restoredStep?.status).toBe("pending");
    expect(restoredStep).not.toHaveProperty("blocked_by_conflict_ids");
    expect(
      persistedRun?.steps.find((step) => step.id === planned.steps[1].id)
        ?.status,
    ).toBe("pending");

    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 50);
    const event = events.find((item) => item.type === "conflict_resolved");
    expect(event?.payload).toMatchObject({
      conflict_id: conflict.id,
      decision: "accept",
      selected_proposal_ids: [selected!.id],
      resolved_by: "commander",
    });
  });

  it("validates conflict resolution and enforces accept, merge, and reject semantics", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const makeConflict = async (suffix: string) => {
      const { context } = await c.createWorkflowRun(
        TEST_UID,
        `${TEST_CID}-${suffix}`,
        {
          objective: `Resolve ${suffix}`,
          kind: "discussion",
          created_by: "commander",
        },
      );
      await c.applyContextPatch(TEST_UID, `${TEST_CID}-${suffix}`, context.id, {
        added_by: "agent-a",
        decisions_proposed: [
          { conflict_key: "architecture.database_strategy", text: "Use JSONL" },
        ],
      });
      const conflictContext = await c.applyContextPatch(
        TEST_UID,
        `${TEST_CID}-${suffix}`,
        context.id,
        {
          added_by: "agent-b",
          decisions_proposed: [
            {
              conflict_key: "architecture.database_strategy",
              text: "Use SQLite",
            },
            {
              conflict_key: "architecture.database_strategy",
              text: "Use a hosted database",
            },
          ],
        },
      );
      return {
        cid: `${TEST_CID}-${suffix}`,
        contextId: context.id,
        context: conflictContext,
        conflict: conflictContext.conflicts[0],
      };
    };

    const accepted = await makeConflict("accept");
    const acceptProposal = accepted.context.proposals.find(
      (proposal) => proposal.text === "Use SQLite",
    )!;
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        accepted.cid,
        accepted.contextId,
        accepted.conflict.id,
        {
          decision: "accept",
          selected_proposal_ids: [
            acceptProposal.id,
            accepted.context.proposals[0].id,
          ],
          text: "Invalid multiple selection",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/exactly one proposal/);
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        accepted.cid,
        accepted.contextId,
        accepted.conflict.id,
        {
          decision: "accept",
          selected_proposal_ids: ["wproposal-outside"],
          text: "Use SQLite",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/does not belong/);
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        accepted.cid,
        accepted.contextId,
        accepted.conflict.id,
        {
          decision: "accept",
          selected_proposal_ids: [acceptProposal.id],
          text: "   ",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/resolution text is required/);
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        accepted.cid,
        accepted.contextId,
        "wconflict-missing",
        {
          decision: "reject",
          selected_proposal_ids: [],
          text: "No decision is supportable",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/context conflict not found/);

    const merged = await makeConflict("merge");
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        merged.cid,
        merged.contextId,
        merged.conflict.id,
        {
          decision: "merge",
          selected_proposal_ids: [merged.context.proposals[0].id],
          text: "Invalid single-proposal merge",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/at least two proposals/);
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        merged.cid,
        merged.contextId,
        merged.conflict.id,
        {
          decision: "reject",
          selected_proposal_ids: [merged.context.proposals[0].id],
          text: "Invalid rejection selection",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/no selected proposals/);
    const mergedIds = merged.context.proposals
      .slice(0, 2)
      .map((proposal) => proposal.id);
    const mergeResult = await c.resolveContextConflictById(
      TEST_UID,
      merged.cid,
      merged.contextId,
      merged.conflict.id,
      {
        decision: "merge",
        selected_proposal_ids: mergedIds,
        text: "Use JSONL with a SQLite migration boundary",
        resolved_by: "commander",
      },
    );
    expect(mergeResult.conflicts[0].status).toBe("resolved");
    expect(
      mergeResult.proposals
        .filter((proposal) => mergedIds.includes(proposal.id))
        .every((proposal) => proposal.status === "superseded"),
    ).toBe(true);
    expect(
      mergeResult.proposals
        .filter((proposal) => !mergedIds.includes(proposal.id))
        .every((proposal) => proposal.status === "rejected"),
    ).toBe(true);
    expect(mergeResult.decisions).toHaveLength(1);
    expect(mergeResult.decisions[0].text).toBe(
      "Use JSONL with a SQLite migration boundary",
    );
    await expect(
      c.resolveContextConflictById(
        TEST_UID,
        merged.cid,
        merged.contextId,
        merged.conflict.id,
        {
          decision: "merge",
          selected_proposal_ids: mergedIds,
          text: "Try again",
          resolved_by: "commander",
        },
      ),
    ).rejects.toThrow(/already resolved|nonterminal/);

    const rejected = await makeConflict("reject");
    const rejectedResult = await c.resolveContextConflictById(
      TEST_UID,
      rejected.cid,
      rejected.contextId,
      rejected.conflict.id,
      {
        decision: "reject",
        selected_proposal_ids: [],
        text: "Neither proposal is supportable",
        reason: "Evidence is insufficient",
        resolved_by: "user",
      },
    );
    expect(rejectedResult.conflicts[0]).toMatchObject({
      status: "dismissed",
      resolution: {
        decision: "reject",
        selected_proposal_ids: [],
        text: "Neither proposal is supportable",
        resolved_by: "user",
      },
    });
    expect(
      rejectedResult.proposals.every(
        (proposal) => proposal.status === "rejected",
      ),
    ).toBe(true);
    expect(rejectedResult.decisions).toEqual([]);
  });

  it("does not restore a conflict-blocked step while a gate or dependency still blocks it", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(
      TEST_UID,
      `${TEST_CID}-gated`,
      {
        objective: "Preserve other blockers during conflict resolution",
        kind: "implementation",
        created_by: "commander",
      },
    );
    const planned = await c.planWorkflowSteps(
      TEST_UID,
      `${TEST_CID}-gated`,
      run.id,
      [
        { title: "Review gate", actor_id: "reviewer", type: "gate" },
        {
          title: "Dependent implementation",
          actor_id: "writer",
          type: "implementation",
          depends_on: [run.id],
          context_dependencies: ["market.entry_mode"],
        },
      ],
    );
    const dependent = planned.steps[1];
    await c.applyContextPatch(TEST_UID, `${TEST_CID}-gated`, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      `${TEST_CID}-gated`,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];
    const gate = await c.recordGateResult(
      TEST_UID,
      `${TEST_CID}-gated`,
      run.id,
      planned.steps[0].id,
      {
        name: "review_gate",
        status: "needs_review",
        reason: "Needs user review",
        checks: [{ name: "approval", status: "needs_review" }],
      },
    );
    const chosen = conflicted.proposals[1];

    const resolved = await c.resolveContextConflictById(
      TEST_UID,
      `${TEST_CID}-gated`,
      context.id,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [chosen.id],
        text: chosen.text,
        resolved_by: "commander",
      },
    );
    const persisted = await c.readWorkflowRun(
      TEST_UID,
      `${TEST_CID}-gated`,
      run.id,
    );
    expect(resolved.conflicts[0].status).toBe("resolved");
    expect(
      persisted?.steps.find((step) => step.id === dependent.id)?.status,
    ).toBe("blocked");
    expect(
      persisted?.steps.find((step) => step.id === dependent.id)
        ?.blocked_by_conflict_ids,
    ).toBeUndefined();
    expect(persisted?.status).toBe("blocked");
    expect(gate.status).toBe("needs_review");
  });
});

describe("group_chat collaboration › conflict facades", () => {
  it("lists active conflicts and derives trusted user provenance without accepting resolved_by input", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const { context } = await c.createWorkflowRun(
      TEST_UID,
      `${TEST_CID}-facade`,
      {
        objective: "Facade conflict resolution",
        kind: "discussion",
        created_by: "commander",
      },
    );
    await c.applyContextPatch(TEST_UID, `${TEST_CID}-facade`, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      `${TEST_CID}-facade`,
      context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];
    const selected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    )!;

    const listed = await groupChat.listCollaborationConflicts(
      TEST_UID,
      `${TEST_CID}-facade`,
    );
    expect(listed.ok).toBe(true);
    expect(listed.conflicts.map((item) => item.id)).toEqual([conflict.id]);

    const resolved = await groupChat.resolveCollaborationConflict(
      TEST_UID,
      `${TEST_CID}-facade`,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
        reason: "User selected the lower-cost path.",
        resolved_by: "attacker",
      } as never,
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.collaboration?.status).toBe("running");
    const updated = await c.readSharedTaskContext(
      TEST_UID,
      `${TEST_CID}-facade`,
      context.id,
    );
    expect(updated?.conflicts[0].resolution?.resolved_by).toBe("user");
  });

  it("returns the resolved snapshot before an active-run replacement can interleave", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-snapshot-binding`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Return the resolved workflow snapshot",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, cid, initial.context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      cid,
      initial.context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];
    const selected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    )!;
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let activeReadCount = 0;
    let releaseSnapshotRead!: () => void;
    let markSnapshotReadStarted!: () => void;
    const snapshotReadGate = new Promise<void>((resolve) => {
      releaseSnapshotRead = resolve;
    });
    const snapshotReadStarted = new Promise<void>((resolve) => {
      markSnapshotReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile && ++activeReadCount === 2) {
        const captured = await storage.readJson(filePath);
        markSnapshotReadStarted();
        await snapshotReadGate;
        return captured;
      }
      return storage.readJson(filePath);
    });

    const resolutionPromise = groupChat.resolveCollaborationConflict(
      TEST_UID,
      cid,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
      },
    );
    await snapshotReadStarted;

    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement workflow after snapshot",
        kind: "discussion",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseSnapshotRead();
    const resolved = await resolutionPromise;
    const replacement = await replacementPromise;
    expect(resolved.collaboration).toMatchObject({
      run_id: initial.run.id,
      context_id: initial.context.id,
    });
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });

  it("lists conflicts from the locked active snapshot before an active-run replacement", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-list-binding`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "List the current active conflicts",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, cid, initial.context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      cid,
      initial.context.id,
      {
        added_by: "agent-b",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    const conflict = conflicted.conflicts[0];
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let releaseActiveRead!: () => void;
    let markActiveReadStarted!: () => void;
    const activeReadGate = new Promise<void>((resolve) => {
      releaseActiveRead = resolve;
    });
    const activeReadStarted = new Promise<void>((resolve) => {
      markActiveReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile) {
        markActiveReadStarted();
        await activeReadGate;
      }
      return storage.readJson(filePath);
    });

    const listPromise = groupChat.listCollaborationConflicts(TEST_UID, cid);
    await activeReadStarted;
    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement workflow after list",
        kind: "discussion",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseActiveRead();
    const listed = await listPromise;
    const replacement = await replacementPromise;
    expect(listed.conflicts.map((item) => item.id)).toEqual([conflict.id]);
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });

  it("allows a trusted actor facade to record commander provenance", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const cid = `${TEST_CID}-actor-facade`;
    const { context } = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Actor facade conflict resolution",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, cid, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(TEST_UID, cid, context.id, {
      added_by: "agent-b",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use a local partner" },
      ],
    });
    const conflict = conflicted.conflicts[0];
    const selected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    )!;

    await groupChat.resolveCollaborationConflictForActor(
      TEST_UID,
      cid,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
      },
      "commander",
    );

    const updated = await c.readSharedTaskContext(TEST_UID, cid, context.id);
    expect(updated?.conflicts[0].resolution?.resolved_by).toBe("commander");
  });
});

describe("group_chat collaboration › active context binding", () => {
  it("holds the conversation lock across active-context lookup and resolution", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-active-binding`;
    const { context } = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Resolve the current active context",
      kind: "discussion",
      created_by: "commander",
    });
    await c.applyContextPatch(TEST_UID, cid, context.id, {
      added_by: "agent-a",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    const conflicted = await c.applyContextPatch(TEST_UID, cid, context.id, {
      added_by: "agent-b",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use a local partner" },
      ],
    });
    const conflict = conflicted.conflicts[0];
    const selected = conflicted.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    )!;
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let releaseActiveRead!: () => void;
    let markActiveReadStarted!: () => void;
    const activeReadGate = new Promise<void>((resolve) => {
      releaseActiveRead = resolve;
    });
    const activeReadStarted = new Promise<void>((resolve) => {
      markActiveReadStarted = resolve;
    });
    let gateNextActiveRead = true;
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile && gateNextActiveRead) {
        gateNextActiveRead = false;
        markActiveReadStarted();
        await activeReadGate;
      }
      return storage.readJson(filePath);
    });

    const resolutionPromise = groupChat.resolveCollaborationConflict(
      TEST_UID,
      cid,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
      },
    );
    await activeReadStarted;

    let activeSwitchFinished = false;
    const activeSwitchPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "A competing active workflow must wait",
        kind: "discussion",
        created_by: "commander",
      })
      .then(() => {
        activeSwitchFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeSwitchFinished).toBe(false);

    releaseActiveRead();
    await resolutionPromise;
    await activeSwitchPromise;
    expect(activeSwitchFinished).toBe(true);
    expect(
      (await c.readSharedTaskContext(TEST_UID, cid, context.id))?.conflicts[0]
        .status,
    ).toBe("resolved");
  });
});

describe("group_chat collaboration › coherent active reads", () => {
  it("locks readActiveWorkflowRun across an active-run replacement", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-active-run-read`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Read the active workflow coherently",
      kind: "discussion",
      created_by: "commander",
    });
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let releaseActiveRead!: () => void;
    let markActiveReadStarted!: () => void;
    const activeReadGate = new Promise<void>((resolve) => {
      releaseActiveRead = resolve;
    });
    const activeReadStarted = new Promise<void>((resolve) => {
      markActiveReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile) {
        markActiveReadStarted();
        await activeReadGate;
      }
      return storage.readJson(filePath);
    });

    const readPromise = c.readActiveWorkflowRun(TEST_UID, cid);
    await activeReadStarted;
    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement after active run read",
        kind: "discussion",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseActiveRead();
    const read = await readPromise;
    const replacement = await replacementPromise;
    expect(read?.id).toBe(initial.run.id);
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });

  it("locks readActiveSharedTaskContext across an active-run replacement", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-active-context-read`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Read the active context coherently",
      kind: "discussion",
      created_by: "commander",
    });
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let releaseActiveRead!: () => void;
    let markActiveReadStarted!: () => void;
    const activeReadGate = new Promise<void>((resolve) => {
      releaseActiveRead = resolve;
    });
    const activeReadStarted = new Promise<void>((resolve) => {
      markActiveReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile) {
        markActiveReadStarted();
        await activeReadGate;
      }
      return storage.readJson(filePath);
    });

    const readPromise = c.readActiveSharedTaskContext(TEST_UID, cid);
    await activeReadStarted;
    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement after active context read",
        kind: "discussion",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseActiveRead();
    const read = await readPromise;
    const replacement = await replacementPromise;
    expect(read?.id).toBe(initial.context.id);
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });

  it("keeps gate-review snapshots bound to the reviewed active run", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-gate-review-read`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Review the active gate coherently",
      kind: "review",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, cid, initial.run.id, {
      title: "Approval gate",
      actor_id: "reviewer",
      type: "gate",
    });
    const gate = await c.recordGateResult(
      TEST_UID,
      cid,
      initial.run.id,
      step.id,
      {
        name: "approval_gate",
        status: "needs_review",
        reason: "Approval required.",
        checks: [{ name: "approval", status: "needs_review" }],
      },
    );
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let activeReadCount = 0;
    let releaseSnapshotRead!: () => void;
    let markSnapshotReadStarted!: () => void;
    const snapshotReadGate = new Promise<void>((resolve) => {
      releaseSnapshotRead = resolve;
    });
    const snapshotReadStarted = new Promise<void>((resolve) => {
      markSnapshotReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile && ++activeReadCount === 2) {
        markSnapshotReadStarted();
        await snapshotReadGate;
      }
      return storage.readJson(filePath);
    });

    const reviewPromise = groupChat.reviewCollaborationGate(
      TEST_UID,
      cid,
      gate.id,
      {
        decision: "reject",
        reason: "Still needs approval.",
      },
    );
    await snapshotReadStarted;
    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement after gate review",
        kind: "review",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseSnapshotRead();
    const reviewed = await reviewPromise;
    const replacement = await replacementPromise;
    expect(reviewed.collaboration).toMatchObject({
      run_id: initial.run.id,
      context_id: initial.context.id,
    });
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });

  it("keeps runtime snapshots bound to the active run during replacement", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const storage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const cid = `${TEST_CID}-runtime-read`;
    const initial = await c.createWorkflowRun(TEST_UID, cid, {
      objective: "Read runtime collaboration coherently",
      kind: "discussion",
      created_by: "commander",
    });
    const activeFile = c.collaborationPaths(TEST_UID, cid).activeFile;
    let releaseActiveRead!: () => void;
    let markActiveReadStarted!: () => void;
    const activeReadGate = new Promise<void>((resolve) => {
      releaseActiveRead = resolve;
    });
    const activeReadStarted = new Promise<void>((resolve) => {
      markActiveReadStarted = resolve;
    });
    storageMocks.readJson.mockImplementation(async (filePath: string) => {
      if (filePath === activeFile) {
        markActiveReadStarted();
        await activeReadGate;
      }
      return storage.readJson(filePath);
    });

    const runtimePromise = groupChat.runtimeStatus(TEST_UID, cid);
    await activeReadStarted;
    let replacementFinished = false;
    const replacementPromise = c
      .createWorkflowRun(TEST_UID, cid, {
        objective: "Replacement after runtime snapshot",
        kind: "discussion",
        created_by: "commander",
      })
      .then((replacement) => {
        replacementFinished = true;
        return replacement;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementFinished).toBe(false);

    releaseActiveRead();
    const runtime = await runtimePromise;
    const replacement = await replacementPromise;
    expect(runtime.collaboration).toMatchObject({
      run_id: initial.run.id,
      context_id: initial.context.id,
    });
    expect((await c.readActiveWorkflowRun(TEST_UID, cid))?.id).toBe(
      replacement.run.id,
    );
  });
});

describe("group_chat collaboration › discussion protocol", () => {
  it("records proposal/critique/revision discussion rounds as workflow steps and events", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Discuss architecture",
      kind: "discussion",
      created_by: "commander",
    });

    const step = await c.recordDiscussionRound(TEST_UID, TEST_CID, run.id, {
      title: "Proposal critique revision",
      actor_id: "reviewer",
      opinion: "SharedTaskContext is the right local state layer.",
      critiques: ["Gate resume needs explicit handling."],
      revision: "Add gate approval resume before planner automation.",
    });

    expect(step.status).toBe("completed");
    expect(step.type).toBe("discussion_round");
    const events = await c.readCollaborationEvents(TEST_UID, TEST_CID, 20);
    expect(events.map((event) => event.type)).toContain("discussion_recorded");
  });
});

describe("group_chat collaboration › runtime snapshot", () => {
  it("summarizes active workflow status and context counts for IPC", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const { run, context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Expose shared state",
      kind: "discussion",
      created_by: "commander",
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: "Review context",
      actor_id: "reviewer",
      type: "review",
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: "completed",
      result_summary: "Looks consistent.",
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: "reviewer",
      facts_add: [{ text: "Runtime status includes collaboration counts" }],
      decisions_proposed: [{ text: "Show a compact renderer card" }],
      risks_add: [
        {
          text: "Renderer must tolerate missing collaboration data",
          severity: "low",
        },
      ],
      open_questions_add: [{ text: "Do we need expand/collapse later?" }],
    });

    const snapshot = await c.readCollaborationSnapshot(TEST_UID, TEST_CID);

    expect(snapshot?.run_id).toBe(run.id);
    expect(snapshot?.context_id).toBe(context.id);
    expect(snapshot?.objective).toBe("Expose shared state");
    expect(snapshot?.steps).toHaveLength(1);
    expect(snapshot?.steps[0].status).toBe("completed");
    expect(snapshot?.facts_count).toBe(1);
    expect(snapshot?.decisions_count).toBe(1);
    expect(snapshot?.risks_count).toBe(1);
    expect(snapshot?.open_questions_count).toBe(1);
    expect(snapshot?.facts_preview[0].text).toBe(
      "Runtime status includes collaboration counts",
    );
    expect(snapshot?.decisions_preview[0].text).toBe(
      "Show a compact renderer card",
    );
    expect(snapshot?.risks_preview[0].severity).toBe("low");
    expect(snapshot?.open_questions_preview[0].text).toBe(
      "Do we need expand/collapse later?",
    );
    expect(snapshot?.recent_events.map((event) => event.type)).toEqual([
      "workflow_created",
      "step_started",
      "step_completed",
      "context_patch_applied",
    ]);
  });
});

describe("group_chat collaboration › runtime facade", () => {
  it("includes the active collaboration snapshot in runtimeStatus", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const groupChat = await import("../../../../src/main/features/group_chat");
    await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: "Runtime facade snapshot",
      kind: "discussion",
      created_by: "commander",
    });

    const runtime = await groupChat.runtimeStatus(TEST_UID, TEST_CID);

    expect(runtime.processing).toBe(false);
    expect(runtime.collaboration?.objective).toBe("Runtime facade snapshot");
  });
});

describe("group_chat collaboration › nested workflow steps", () => {
  it("prepares, blocks, reuses, and settles one context-dependent nested step exactly once", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const initial = await c.createWorkflowRun(TEST_UID, `${TEST_CID}-nested`, {
      objective: "Write the final strategy",
      kind: "custom",
      created_by: "commander",
    });
    const conflicted = await c.applyContextPatch(
      TEST_UID,
      `${TEST_CID}-nested`,
      initial.context.id,
      {
        added_by: "reviewer",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use direct entry" },
        ],
      },
    );
    const active = await c.applyContextPatch(
      TEST_UID,
      `${TEST_CID}-nested`,
      initial.context.id,
      {
        added_by: "writer",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      },
    );
    expect(active.conflicts).toHaveLength(1);

    const prepared = await c.prepareNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-nested`,
      {
        objective: "Write the final strategy",
        actor_id: "agent-writer",
        actor_name: "Writer",
        source_tool: "dispatch_to",
        task: "Write the final strategy",
        context_dependencies: ["market.entry_mode"],
      },
    );
    expect(prepared.blocked).toBe(true);
    expect(prepared.step.status).toBe("blocked");
    expect(prepared.step.id).toMatch(/^wstep-/);
    expect(prepared.context.conflicts[0].affected_step_ids).toContain(
      prepared.step.id,
    );

    const resolved = await c.resolveContextConflictById(
      TEST_UID,
      `${TEST_CID}-nested`,
      initial.context.id,
      active.conflicts[0].id,
      {
        decision: "accept",
        selected_proposal_ids: [
          active.proposals.find((item) => item.text === "Use a local partner")!
            .id,
        ],
        text: "Use a local partner",
        resolved_by: "commander",
      },
    );
    expect(resolved.conflicts[0].status).toBe("resolved");
    const unblocked = await c.readWorkflowRun(
      TEST_UID,
      `${TEST_CID}-nested`,
      initial.run.id,
    );
    expect(unblocked?.steps[0].id).toBe(prepared.step.id);
    expect(unblocked?.steps[0].status).toBe("pending");

    const resumed = await c.prepareNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-nested`,
      {
        objective: "Write the final strategy",
        actor_id: "agent-writer",
        actor_name: "Writer",
        source_tool: "dispatch_to",
        task: "Write the final strategy",
        context_dependencies: ["market.entry_mode"],
        resume_step_id: prepared.step.id,
        resume_token: prepared.step.resume_token,
      },
    );
    expect(resumed.step.id).toBe(prepared.step.id);
    await c.startPreparedNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-nested`,
      prepared.step.id,
    );
    const completed = await c.finishNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-nested`,
      prepared.step.id,
      { result: "final strategy" },
    );
    expect(completed.status).toBe("completed");
    await expect(
      c.finishNestedDispatchStep(
        TEST_UID,
        `${TEST_CID}-nested`,
        prepared.step.id,
        { result: "final strategy" },
      ),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      c.finishNestedDispatchStep(
        TEST_UID,
        `${TEST_CID}-nested`,
        prepared.step.id,
        { error: "different settlement" },
      ),
    ).rejects.toThrow(/already settled/);
    const events = await c.readCollaborationEvents(
      TEST_UID,
      `${TEST_CID}-nested`,
      100,
    );
    expect(
      events.filter(
        (event) =>
          event.type === "step_completed" && event.step_id === prepared.step.id,
      ),
    ).toHaveLength(1);
  });
});

describe("group_chat collaboration › nested workflow settlement outcomes", () => {
  it.each([
    ["success", { result: "done" }, "completed"],
    ["pre-stream failure", { error: "dependency unavailable" }, "failed"],
    ["model throw", { error: "model exploded" }, "failed"],
    ["abort", { aborted: true }, "skipped"],
  ] as const)(
    "settles %s exactly once without a running orphan",
    async (_label, outcome, expectedStatus) => {
      const c =
        await import("../../../../src/main/features/group_chat/collaboration");
      const cid = `${TEST_CID}-${_label.replace(/[^a-z0-9]+/gi, "-")}`;
      const prepared = await c.prepareNestedDispatchStep(TEST_UID, cid, {
        objective: "settlement test",
        actor_id: "agent-settlement",
        source_tool: "run_worker",
        task: "settlement test",
      });
      await c.startPreparedNestedDispatchStep(TEST_UID, cid, prepared.step.id);
      const settled = await c.finishNestedDispatchStep(
        TEST_UID,
        cid,
        prepared.step.id,
        outcome,
      );
      const repeated = await c.finishNestedDispatchStep(
        TEST_UID,
        cid,
        prepared.step.id,
        outcome,
      );
      expect(settled.status).toBe(expectedStatus);
      expect(repeated.status).toBe(expectedStatus);
      const run = await c.readWorkflowRun(TEST_UID, cid, prepared.run.id);
      expect(
        run?.steps.find((step) => step.id === prepared.step.id),
      ).toMatchObject({
        status: expectedStatus,
        completed_at: expect.any(String),
      });
      const events = await c.readCollaborationEvents(TEST_UID, cid, 100);
      expect(
        events.filter(
          (event) =>
            event.type === "step_completed" &&
            event.step_id === prepared.step.id,
        ),
      ).toHaveLength(1);
    },
  );
});

describe("group_chat collaboration › nested finish persistence retry", () => {
  it("can retry a finish after the first persistence attempt fails", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const prepared = await c.prepareNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-finish-retry`,
      {
        objective: "finish retry",
        actor_id: "agent-retry",
        source_tool: "dispatch_to",
        task: "finish retry",
      },
    );
    await c.startPreparedNestedDispatchStep(
      TEST_UID,
      `${TEST_CID}-finish-retry`,
      prepared.step.id,
    );
    const runFile = c
      .collaborationPaths(TEST_UID, `${TEST_CID}-finish-retry`)
      .runFile(prepared.run.id);
    const actualStorage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    let failed = false;
    storageMocks.writeJson.mockImplementation(async (file, value) => {
      if (
        !failed &&
        file === runFile &&
        JSON.stringify(value).includes("\"status\":\"completed\"")
      ) {
        failed = true;
        throw new Error("forced finish write failure");
      }
      return actualStorage.writeJson(file, value);
    });

    await expect(
      c.finishNestedDispatchStep(
        TEST_UID,
        `${TEST_CID}-finish-retry`,
        prepared.step.id,
        { result: "retry result" },
      ),
    ).rejects.toThrow("forced finish write failure");
    storageMocks.writeJson.mockImplementation(actualStorage.writeJson);
    await expect(
      c.finishNestedDispatchStep(
        TEST_UID,
        `${TEST_CID}-finish-retry`,
        prepared.step.id,
        { result: "retry result" },
      ),
    ).resolves.toMatchObject({ status: "completed" });
  });
});

describe("group_chat collaboration › terminal settlement repair", () => {
  it("repairs missing context output and gate without duplicating completion events", async () => {
    const c =
      await import("../../../../src/main/features/group_chat/collaboration");
    const cid = `${TEST_CID}-terminal-repair`;
    const prepared = await c.prepareNestedDispatchStep(TEST_UID, cid, {
      objective: "repair terminal state",
      actor_id: "agent-repair",
      source_tool: "dispatch_to",
      task: "repair terminal state",
    });
    await c.startPreparedNestedDispatchStep(TEST_UID, cid, prepared.step.id);
    await c.finishNestedDispatchStep(TEST_UID, cid, prepared.step.id, {
      result: "repair result",
    });
    const beforeEvents = await c.readCollaborationEvents(TEST_UID, cid, 0);
    expect(
      beforeEvents.filter(
        (event) =>
          event.type === "step_completed" && event.step_id === prepared.step.id,
      ),
    ).toHaveLength(1);

    const actualStorage = await vi.importActual<
      typeof import("../../../../src/main/storage")
    >("../../../../src/main/storage");
    const contextFile = c
      .collaborationPaths(TEST_UID, cid)
      .contextFile(prepared.context.id);
    const broken = await actualStorage.readJson<any>(contextFile);
    delete broken.agent_outputs[prepared.step.id];
    broken.gates = broken.gates.filter(
      (gate: any) => gate.step_id !== prepared.step.id,
    );
    await actualStorage.writeJson(contextFile, broken);

    await c.finishNestedDispatchStep(TEST_UID, cid, prepared.step.id, {
      result: "repair result",
    });
    const repaired = await c.readSharedTaskContext(
      TEST_UID,
      cid,
      prepared.context.id,
    );
    expect(repaired?.agent_outputs[prepared.step.id].summary).toBe(
      "repair result",
    );
    expect(
      repaired?.gates.filter((gate) => gate.step_id === prepared.step.id),
    ).toHaveLength(1);
    const afterEvents = await c.readCollaborationEvents(TEST_UID, cid, 0);
    expect(
      afterEvents.filter(
        (event) =>
          event.type === "step_completed" && event.step_id === prepared.step.id,
      ),
    ).toHaveLength(1);
    expect(
      afterEvents.filter(
        (event) =>
          event.type === "gate_recorded" && event.step_id === prepared.step.id,
      ),
    ).toHaveLength(1);
  });
});
