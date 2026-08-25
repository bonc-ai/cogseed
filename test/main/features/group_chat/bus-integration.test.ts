import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainMainRuntimeForTest } from "../../../helpers/drain-main-runtime";
import { TurnActivityTracker } from "../../../../src/main/features/group_chat/coordinator_activity";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../../src/main/logger", () => ({
  createLogger: () => loggerMocks,
}));

// Production wake dispatch is CogSeed-backend-only. This test double preserves
// the bus assertions while exercising the same entry/event contract.
vi.mock("../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher", () => ({
  cogseedWakeDispatcher: {
    dispatch: async (uid: string, request: any, context: any) => {
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const state = await import("../../../../src/main/features/group_chat/state");
      const fromActorId = request.source === "user_mention" || request.source === "ui_select" ? state.USER_ID : state.COMMANDER_ID;
      if (fromActorId === state.COMMANDER_ID && request.kstar_decision?.required) {
        const exp = request.kstar_decision.expectation || {};
        await bus.enqueue({
          uid,
          cid: request.conversation_id,
          fromActorId: state.COMMANDER_ID,
          forceTo: [state.USER_ID],
          text: `授权已确认。\nS：${exp.situation || request.objective}\n任务：${exp.task || request.objective}\n执行计划：${exp.action_hat || request.dispatch_payload.text}\n预期结果：${exp.result_hat || '获得可复核的任务结果。'}`,
          kstar_dispatch_narration: { target_agent_id: request.agent_id },
        });
      }
      const admitted = await bus.enqueue({
        uid,
        cid: request.conversation_id,
        fromActorId,
        text: request.dispatch_payload.text,
        forceTo: [request.agent_id],
        ...(request.workflow_step_id ? { workflow_step_id: request.workflow_step_id } : {}),
        ...(request.kstar_decision?.required ? { kstarDecision: request.kstar_decision } : {}),
        ...(request.kstar_decision?.required && request.asset_confirmation_snapshot ? {
          kstarTerminalProvenance: {
            logicalRunId: request.asset_confirmation_snapshot.task_run_id,
            executionId: request.id,
            projectionId: request.asset_confirmation_snapshot.projection_id,
            wakeRequestId: request.id,
          },
        } : {}),
      });
      if (!Array.isArray(admitted.to) || !admitted.to.includes(request.agent_id)) {
        throw new Error("wake enqueue did not admit the target agent");
      }
      if (request.source === "hand_off_to" && request.resume_instruction && context?.targetInteractive) {
        await state.setActiveRecipient(uid, request.conversation_id, request.agent_id);
      }
      if (request.source === "dispatch_to" || request.source === "run_worker" || (request.source === "hand_off_to" && request.resume_instruction && context?.targetInteractive)) {
        await state.setOrchestrationLedger(uid, request.conversation_id, {
          status: "waiting_for_agent",
          blocked_on: "agent_handoff",
          source_tool: request.source,
          owner_agent_id: request.agent_id,
          ...(request.agent_name ? { owner_agent_name: request.agent_name } : {}),
          user_goal: request.objective,
          handoff_message: request.dispatch_payload.text,
          resume_instruction: request.resume_instruction || `After ${request.agent_name || request.agent_id} completes, continue the original Commander task.`,
        });
      }
    },
  },
}));

const p3394GatewayCalls = vi.hoisted(() => [] as Array<any>);
vi.mock("../../../../src/main/features/p3394_bridge/p3394-gateway-turn", () => ({
  runP3394GatewayTurn: vi.fn(async (input: any) => {
    p3394GatewayCalls.push(input);
    // 第二期收口：原直连用例的 CLI 事件流改由网关 turn 桥接 —— 复用
    // localRunnerScripts 脚本队列，按直连总线的转换规则发 onProcess /
    // onCoordinatorActivity / onProcessInfo；`__return__` 控制终态。
    if (localRunnerScripts.length > 0) {
      const events = localRunnerScripts.shift()!;
      const terminal = events.find((event) => event?.type === "__return__");
      for (const event of events) {
        if (event?.type === "__return__") continue;
        if (event?.type === "tool-event") {
          const phase = String((event as any).phase || "").toLowerCase();
          input.onCoordinatorActivity?.({
            kind: phase === "use" ? "tool_start" : phase === "result" ? "tool_result" : "activity",
            ...(event.callId ? { callId: event.callId } : {}),
            tool: event.tool || "tool",
          });
          input.onProcess?.({ type: "event", event: { stream: "cli", data: event } });
        } else if (event?.type === "process-info") {
          input.onProcessInfo?.((event as any).pid);
          input.onProcess?.({ type: "event", event: { stream: "cli", data: { type: "process-info" } } });
        } else if (event?.type === "delta") {
          input.onProcess?.({ type: "delta", text: (event as any).text });
        } else if (typeof (event as any).text === "string") {
          input.onProcess?.({ type: "progress", text: (event as any).text });
        } else {
          input.onProcess?.({ type: "event", event: { stream: "cli", data: event } });
        }
      }
      const text = terminal?.output || "gateway turn done";
      const failed = terminal?.status && terminal.status !== "completed" && terminal.status !== "cancelled";
      return { text: failed ? "" : text, ...(failed ? { error: terminal?.output || "gateway failed" } : {}) };
    }
    const text = input.agent?.agent_id === "gateway-workbuddy"
      ? "WorkBuddy product analysis: map Excel columns, stages, tasks, owners, and dates before creation."
      : "Codex prototype completed.";
    return { text };
  }),
}));

// The external-agent launch-confirm gate is exercised by its own unit suite
// (launch-confirm.test.ts). These bus tests assert routing / gateway-turn
// behavior, so the gate is mocked open here — otherwise every first CLI/gateway
// dispatch would block on an unanswered confirmation push (10-min timeout).
// `launchConfirmMock.result` lets individual tests flip the gate to DENY and
// assert the bus refuses the dispatch (message not sent to the external CLI).
const launchConfirmMock = vi.hoisted(() => ({
  result: true,
  requestLaunchConfirm: vi.fn(async () => launchConfirmMock.result),
}));
vi.mock("../../../../src/main/features/local_agents/launch_confirm", () => ({
  requestLaunchConfirm: launchConfirmMock.requestLaunchConfirm,
}));

/**
 * End-to-end integration tests for the group_chat bus. We mock
 * `streamChatWithModel` with a programmable script keyed by session id,
 * so a single conversation can drive multiple actor turns deterministically:
 *
 *   - Commander gets script entry for `cogseed-<uid>-gconv-<cid>`
 *   - Agent X gets script entry for `cogseed-<uid>-gmember-<cid>-<X>`
 *
 * Each script entry is an array of stream events the mock yields in order.
 * After the script entry is consumed, the next call for that session
 * yields a default `{type:'final', text:''}` + done (so unscripted turns
 * don't hang).
 */

const _scripts = new Map<string, Array<any[]>>();
function _setScript(sessionId: string, events: any[]) {
  const arr = _scripts.get(sessionId) || [];
  arr.push(events);
  _scripts.set(sessionId, arr);
}
function _resetScripts() {
  _scripts.clear();
}

const modelAbortMock = vi.hoisted(() => vi.fn(() => 0));
const modelSessionActiveMock = vi.hoisted(() => vi.fn(() => true));
const localRunnerScripts = vi.hoisted(() => [] as Array<any[]>);
const localRunnerCalls = vi.hoisted(() => [] as Array<any>);
const abortRaceProbe = vi.hoisted(() => ({
  parentController: null as AbortController | null,
}));
// Records every model turn the bus drives, so tests can assert WHAT a given
// session actually received as its turn input (`opts.message`) — e.g. that a
// G8b handback turn carried the worker's full reply, not a summary.
const _recordedCalls = vi.hoisted(
  () =>
    [] as Array<{
      sid: string;
      message: string;
      systemPrompt?: string;
      sourceMessageText?: string;
    }>,
);
// Records the result each tool's execute() returned — lets a test assert that a
// G8d in-process dispatch tool (run_worker) handed its sub-run's full reply back
// synchronously as the tool result, not via an async re-wake.
const _recordedToolResults = vi.hoisted(
  () =>
    [] as Array<{
      name: string;
      content: string;
      executionMode?: string;
      endTurn?: boolean;
      isError?: boolean;
    }>,
);
const _recordedToolErrors = vi.hoisted(
  () => [] as Array<{ name: string; nameOfError: string; message: string }>,
);
const _recordedToolDefinitions = vi.hoisted(
  () =>
    [] as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, any>;
    }>,
);
const _recordedNestedOutcomes: any[] = [];

vi.mock("../../../../src/main/model/client", () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || "";
    _recordedCalls.push({
      sid,
      message: String(opts.message || ""),
      ...(opts.systemPrompt ? { systemPrompt: String(opts.systemPrompt) } : {}),
      ...(opts.sourceMessageText ? { sourceMessageText: String(opts.sourceMessageText) } : {}),
    });
    // Ephemeral worker sessions have a random id (`gworker-<cid>-<rand>`); a
    // test can't pre-script them by id, so route any gworker turn to a fixed
    // `gworker-*` script slot.
    const scriptKey = sid.startsWith("gworker-") ? "gworker-*" : sid;
    const queue = _scripts.get(scriptKey) || [];
    const events = queue.shift() || [{ type: "final", text: "" }];
    _scripts.set(scriptKey, queue);
    for (const ev of events) {
      if (ev?.type === "__emit_teaching_receipt__") {
        await opts.onTeachingReceipt?.(ev.receipt);
        continue;
      }
      if (ev?.type === "__capture_tool_definitions__") {
        _recordedToolDefinitions.push(
          ...(opts.extraTools || []).map((tool: any) => ({
            name: String(tool.name || ""),
            description: String(tool.description || ""),
            inputSchema: tool.inputSchema || {},
          })),
        );
        continue;
      }
      // Tool-call execution: drives the REAL tool's execute() so the
      // staging → turn-end flush → spawn/dispatch paths actually run (the
      // plain text mock can't do this — hence the skipped @-chain tests).
      const toolCalls =
        ev?.type === "__call_tool__" ||
        ev?.type === "__call_tool_parent_abort__" ||
        ev?.type === "__call_tool_parent_abort_controlled__"
          ? [{ name: ev.name, input: ev.input || {} }]
          : ev?.type === "__call_tools_parallel__"
            ? (ev.calls || []).map((call: any) => ({
                name: call.name,
                input: call.input || {},
              }))
            : [];
      if (toolCalls.length) {
        await Promise.all(
          toolCalls.map(async (call: any) => {
            const tool = (opts.extraTools || []).find(
              (tt: any) => tt.name === call.name,
            );
            if (!tool) return;
            try {
              const parentAbort =
                ev?.type === "__call_tool_parent_abort__" ||
                ev?.type === "__call_tool_parent_abort_controlled__"
                  ? new AbortController()
                  : null;
              if (ev?.type === "__call_tool_parent_abort__" && parentAbort)
                setTimeout(() => parentAbort.abort(), 0);
              if (ev?.type === "__call_tool_parent_abort_controlled__")
                abortRaceProbe.parentController = parentAbort;
              const res = await tool.execute(call.input, {
                signal: parentAbort?.signal || opts.abortSignal,
                state: {},
              });
              _recordedToolResults.push({
                name: call.name,
                content: String(res?.content || ""),
                executionMode: tool.executionMode,
                ...(res?.endTurn === true ? { endTurn: true } : {}),
                ...(res?.isError === true ? { isError: true } : {}),
              });
            } catch (error) {
              _recordedToolErrors.push({
                name: call.name,
                nameOfError: (error as Error)?.name || "Error",
                message: (error as Error)?.message || "",
              });
            }
          }),
        );
        continue;
      }
      if (ev?.type === "__throw__") {
        throw new Error(String(ev.message || "forced model throw"));
      }
      if (ev?.type === "__wait_for_abort__") {
        if (!opts.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        if (typeof ev.afterAbort === "function") await ev.afterAbort();
        yield { type: "error", text: "aborted", aborted: true };
        continue;
      }
      yield ev;
      if (typeof ev?.afterYield === "function") await ev.afterYield();
    }
    yield { type: "done" };
  },
  async chatWithModel() {
    return { ok: true, text: "", error: "", aborted: false };
  },
  abortActiveSessionsForConversation: modelAbortMock,
  hasActiveSession: modelSessionActiveMock,
}));

vi.mock("../../../../src/main/features/local_agents/runner", () => ({
  async run(opts: any) {
    localRunnerCalls.push(opts);
    const events = localRunnerScripts.shift() || [];
    const terminal = events.find((event) => event?.type === "__return__");
    for (const event of events) {
      if (event?.type !== "__return__") opts.onEvent(event);
    }
    if (events.length > 0 && !terminal && !opts.signal?.aborted) {
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return {
      runId: "mock-local-run",
      status: terminal?.status || (opts.signal?.aborted ? "cancelled" : "completed"),
      output: terminal?.output || "",
    };
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevWakeGate: string | undefined;
let prevHostRouting: string | undefined;
const TEST_UID = "u1";
const AGENT_ID = "b8c7d6a5e4f3";
const AGENT_NAME = "Writer";
const cidsToDrop = new Set<string>();

function newCid(): string {
  const cid = "c" + Math.random().toString(16).slice(2, 13);
  cidsToDrop.add(cid);
  return cid;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cogseed-int-"));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  prevWakeGate = process.env.COGSEED_P3394_WAKE_GATE;
  prevHostRouting = process.env.COGSEED_KSTAR_HOST_ROUTING;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  process.env.COGSEED_P3394_WAKE_GATE = "0";
  // Host routing off by default in bus tests: dispatch-mechanism tests are
  // not governance tests. The dedicated host-routing describe enables it.
  process.env.COGSEED_KSTAR_HOST_ROUTING = "0";
  process.env.COGSEED_LEGACY_RUN_WORKER_TEST = "0";
  _resetScripts();
  _recordedCalls.length = 0;
  _recordedToolResults.length = 0;
  _recordedToolErrors.length = 0;
  _recordedToolDefinitions.length = 0;
  _recordedNestedOutcomes.length = 0;
  localRunnerScripts.length = 0;
  localRunnerCalls.length = 0;
  p3394GatewayCalls.length = 0;
  launchConfirmMock.result = true;
  launchConfirmMock.requestLaunchConfirm.mockClear();
  loggerMocks.debug.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();
  abortRaceProbe.parentController = null;
  modelAbortMock.mockClear();
  modelAbortMock.mockReturnValue(0);
  modelSessionActiveMock.mockClear();
  modelSessionActiveMock.mockReturnValue(true);
  cidsToDrop.clear();
  vi.resetModules();
  // Default host-routing judge: non-trivial messages are tasks; a new task
  // never continues an open one (each task-shaped message opens/closes
  // cleanly). Individual tests may override via _setHostRoutingJudgeForTest.
  const busModule = await import("../../../../src/main/features/group_chat/bus");
  busModule._setHostRoutingJudgeForTest(async (message) => ({
    isTask: true,
    continuation: false,
  }));
  // Default auto-forecast generator: two plausible candidates so host
  // routing + dispatch tests never hit the real model runner. Individual
  // tests may override via _setAutoForecastGeneratorForTest.
  const autoForecast = await import("../../../../src/main/features/kstar/auto-forecast");
  autoForecast._setAutoForecastGeneratorForTest(async () => JSON.stringify([
    { id: 'c1', plan: ['Inspect', 'Verify'], expectedTools: ['read_file'], expectedActors: ['commander'], predictedResult: { summary: 'done' } },
    { id: 'c2', plan: ['Draft', 'Deliver'], expectedTools: ['write_file'], expectedActors: ['commander'], predictedResult: { summary: 'done too' } },
  ]));
  const users = await import("../../../../src/main/features/users");
  users.activateUser(TEST_UID);

  // Seed a custom agent on disk (新目录形态:agents/<aid>/agent.json)。
  const paths = await import("../../../../src/main/paths");
  const dir = paths.agentDir(TEST_UID, AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent.json"),
    JSON.stringify({
      agent_id: AGENT_ID,
      name: AGENT_NAME,
      description: "Writes things",
      workflow: "do stuff",
      created_at: "t",
      updated_at: "t",
    }),
  );
});

afterEach(async () => {
  if (prevHostRouting === undefined) delete process.env.COGSEED_KSTAR_HOST_ROUTING;
  else process.env.COGSEED_KSTAR_HOST_ROUTING = prevHostRouting;

  // Drop conv state so workers terminate before the tmpDir is rm'd —
  // otherwise a half-finished worker writes after dir removal and we get
  // ENOENT log noise.
  try {
    const bus = await import("../../../../src/main/features/group_chat/bus");
    (bus as any)._setCoordinatorLeaseFactoryForTest?.();
    (bus as any)._setNestedDispatchOutcomeObserverForTest?.(null);
    (bus as any)._setNestedDispatchAttemptHooksForTest?.(null);
    (bus as any)._setBeforeNestedDispatchStartForTest?.(null);
    (bus as any)._setBeforeVisibleDispatchForTest?.(null);
    (bus as any)._setTerminalHandoffObserverForTest?.(null);
    (bus as any)._setHandoffStateHooksForTest?.(null);
    (bus as any)._setBeforeHandoffStateCommitForTest?.(null);
    (bus as any)._setAfterHandoffStateCommitForTest?.(null);
    (bus as any)._setBeforeHandoffResumeEnqueueForTest?.(null);
    const state = await import("../../../../src/main/features/group_chat/state");
    (state as any)._setHandoffStateWriteBoundaryHookForTest?.(null);
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    (collaboration as any)._setWorkflowAttemptAuditBeforeAppendForTest?.(null);
    (collaboration as any)._setRetryPreparationBoundaryHookForTest?.(null);
    // Drop all known cids — the bus state map is module-internal but
    // _cidStateForTest exposes per-cid; iterate via `_cids` indirectly
    // by scanning the chats dir.
    const paths = await import("../../../../src/main/paths");
    const dir = paths.userChatsDir(TEST_UID);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) cidsToDrop.add(e.name);
      }
    }
    for (const cid of cidsToDrop) await bus.dropConv(TEST_UID, cid);
  } catch {
    /* ignore */
  }
  await drainMainRuntimeForTest();
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  if (prevWakeGate === undefined) delete process.env.COGSEED_P3394_WAKE_GATE;
  else process.env.COGSEED_P3394_WAKE_GATE = prevWakeGate;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 2000) {
  cidsToDrop.add(cid);
  const bus = await import("../../../../src/main/features/group_chat/bus");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce within ${timeoutMs}ms`);
}

async function confirmKstarWakeForTest(cid: string, requestId: string): Promise<void> {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const state = await store.readConversationTaskState(TEST_UID, cid);
  if (!state?.currentRequirementId) throw new Error(`missing KSTAR requirement for ${cid}`);
  const requirement = await store.readKstarRequirement(TEST_UID, state.currentRequirementId);
  if (!requirement?.projectionId) throw new Error(`missing KSTAR projection for ${cid}`);
  const projection = await import('../../../../src/main/features/recall/context-projection');
  const result = await projection.confirmAndApproveWake(TEST_UID, {
    cid,
    projectionId: requirement.projectionId,
    wakeRequestId: requestId,
  });
  if (!result.ok) throw new Error(result.error);
}

async function waitUntil(
  fn: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function installLeaseDecisionHarness(
  bus: any,
  trigger: (event: any) => boolean,
): { stops: number[] } {
  const stops: number[] = [];
  bus._setCoordinatorLeaseFactoryForTest((input: any) => {
    const tracker = new TurnActivityTracker(input.startedAt);
    let now = input.startedAt;
    let fired = false;
    const monitor = {
      tracker,
      observe(event: any) {
        now += 1;
        this.tracker.observe(event, now);
        if (fired || !trigger(event)) return;
        fired = true;
        const snapshot = this.tracker.snapshot();
        if (snapshot.phase === "agent_idle") {
          const probe = this.tracker.evaluate(now + 5 * 60_000);
          expect(probe).toMatchObject({ kind: "probe", reason: "agent_idle" });
          if (probe.kind === "probe") input.onProbe(probe.idleMs);
          const abort = this.tracker.evaluate(now + 8 * 60_000);
          expect(abort).toMatchObject({ kind: "abort", reason: "agent_idle" });
          if (abort.kind === "abort") input.onAbort(abort.reason, abort.idleMs);
        } else {
          const abort = this.tracker.evaluate(now + 120_000);
          expect(abort).toMatchObject({ kind: "abort", reason: "tool_idle" });
          if (abort.kind === "abort") input.onAbort(abort.reason, abort.idleMs);
        }
      },
      stop() {
        stops.push(1);
      },
    };
    return monitor;
  });
  return { stops };
}

function coordinatorProcessEvents(events: any[]): any[] {
  return events
    .filter(
      (event) =>
        event?.type === "process" &&
        event?.data?.type === "event" &&
        event?.data?.event?.stream === "coordinator",
    )
    .map((event) => event.data.event);
}

async function readConversationMessages(cid: string): Promise<any[]> {
  const paths = await import("../../../../src/main/paths");
  const storage = await import("../../../../src/main/storage");
  return storage.readJsonl<any>(
    path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
  );
}

async function expectNoLifecycleSecretLeak(
  cid: string,
  secret: string,
): Promise<void> {
  expect(JSON.stringify(_recordedToolResults)).not.toContain(secret);
  expect(JSON.stringify(await readConversationMessages(cid))).not.toContain(
    secret,
  );
  expect(
    JSON.stringify([
      loggerMocks.debug.mock.calls,
      loggerMocks.info.mock.calls,
      loggerMocks.warn.mock.calls,
      loggerMocks.error.mock.calls,
    ]),
  ).not.toContain(secret);
}

async function seedAgent(input: {
  id: string;
  name: string;
  description?: string;
  workflow?: string;
  runtime?: Record<string, unknown>;
}): Promise<void> {
  const paths = await import("../../../../src/main/paths");
  const dir = paths.agentDir(TEST_UID, input.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent.json"),
    JSON.stringify({
      agent_id: input.id,
      name: input.name,
      description: input.description || "",
      workflow: input.workflow || "",
      ...(input.runtime ? { runtime: input.runtime } : {}),
      created_at: "t",
      updated_at: "t",
    }),
  );
}

async function addAgentMember(
  cid: string,
  id: string,
  name: string,
): Promise<void> {
  const state = await import("../../../../src/main/features/group_chat/state");
  await state.addMember(TEST_UID, cid, { kind: "agent", id, name });
}

function installFirstAttemptCoordinatorAbort(bus: any, reason: "tool_idle" | "agent_idle" = "agent_idle") {
  let monitorCount = 0;
  bus._setCoordinatorLeaseFactoryForTest((input: any) => {
    monitorCount += 1;
    if (monitorCount === 1) {
      queueMicrotask(() => input.onAbort(reason, reason === "tool_idle" ? 120_000 : 480_000));
    }
    return { observe() {}, stop() {} };
  });
  return () => monitorCount;
}

async function makeSeedAgentCli(): Promise<void> {
  const paths = await import("../../../../src/main/paths");
  const file = path.join(paths.agentDir(TEST_UID, AGENT_ID), "agent.json");
  const agent = JSON.parse(fs.readFileSync(file, "utf8"));
  agent.runtime = { kind: "cli", cli: "hermes" };
  fs.writeFileSync(file, JSON.stringify(agent));
}

describe("group_chat bus integration › structured user recipient", () => {
  it("routes a composer selection directly without changing visible text or creating Wake approval", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const wake = await import("../../../../src/main/features/p3394/wake-service");
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "DIRECT-AGENT-RESULT" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "发热还",
      userRoute: { agentId: AGENT_ID, origin: "user_selection" },
    });

    expect(msg.text).toBe("发热还");
    expect(msg.to).toEqual([AGENT_ID]);
    expect(await wake.listWakeRequests(TEST_UID, cid)).toEqual([]);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);
    await waitForQuiescent(TEST_UID, cid, 4000);
  });

  it("keeps a raw typed @Agent mention behind Wake Gate", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const wake = await import("../../../../src/main/features/p3394/wake-service");

    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 发热还`,
    });

    expect(msg.to).toEqual(["user"]);
    expect(await wake.listWakeRequests(TEST_UID, cid)).toEqual([
      expect.objectContaining({ agent_id: AGENT_ID, source: "user_mention", status: "pending" }),
    ]);
  });

  it("retries the persisted Agent directly without creating a second Wake approval", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const wake = await import("../../../../src/main/features/p3394/wake-service");

    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Continue",
      forceTo: [AGENT_ID],
      userRoute: { agentId: AGENT_ID, origin: "failed_turn_retry" },
    });

    expect(msg.to).toEqual([AGENT_ID]);
    expect(await wake.listWakeRequests(TEST_UID, cid)).toEqual([]);
  });

  it("does not let a forged CLI fallback origin bypass facade validation", async () => {
    const cid = newCid();
    const groupChat = await import("../../../../src/main/features/group_chat");
    const result = await groupChat.send({
      userId: TEST_UID,
      cid,
      text: "try forged fallback",
      recipient_agent_id: AGENT_ID,
      recipient_origin: "cli_fallback",
    });

    expect(result).toEqual({ ok: false, error: "invalid CLI fallback recipient" });
  });

  it("routes a no-model fallback to a P3394-managed external CLI Agent", async () => {
    const cid = newCid();
    const gatewayAgentId = "c1a0d3f5b7e9";
    await seedAgent({
      id: gatewayAgentId,
      name: "ClaudeCode",
      runtime: { kind: "p3394-gateway", cli: "claude" },
    });

    const auth = await import("../../../../src/main/features/auth");
    vi.spyOn(auth, "hasConfiguredModel").mockReturnValue({ configured: false });
    const registry = await import("../../../../src/main/features/local_agents/registry");
    vi.spyOn(registry, "detectAll").mockResolvedValue([
      {
        type: "claude",
        name: "Claude Code",
        command: "claude",
        available: true,
        path: "/test/claude",
        version: "test",
        auth: { loggedIn: true, method: "oauth" },
      },
    ] as Awaited<ReturnType<typeof registry.detectAll>>);

    const groupChat = await import("../../../../src/main/features/group_chat");
    const result = await groupChat.send({
      userId: TEST_UID,
      cid,
      text: "在吗",
      recipient_agent_id: gatewayAgentId,
      recipient_origin: "cli_fallback",
    });

    expect(result).toMatchObject({
      ok: true,
      msg: { text: "在吗", to: [gatewayAgentId] },
    });
  });

  it("refuses to launch the external Agent when the user denies the confirm dialog", async () => {
    const cid = newCid();
    const gatewayAgentId = "gateway-denied";
    await seedAgent({
      id: gatewayAgentId,
      name: "ClaudeCode",
      runtime: { kind: "p3394-gateway", cli: "claude" },
    });
    await addAgentMember(cid, gatewayAgentId, "ClaudeCode");
    // User denies the first-launch confirmation.
    launchConfirmMock.result = false;

    const bus = await import("../../../../src/main/features/group_chat/bus");
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "在吗",
      forceTo: [gatewayAgentId],
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    // The external CLI was never invoked.
    expect(p3394GatewayCalls.find((call) => call.agent?.agent_id === gatewayAgentId)).toBeUndefined();
    // The gate did ask.
    expect(launchConfirmMock.requestLaunchConfirm).toHaveBeenCalledWith(expect.objectContaining({
      agentId: gatewayAgentId,
      cli: "claude",
    }));
    // The user received a visible denial notice instead of a CLI reply.
    const groupChat = await import("../../../../src/main/features/group_chat");
    const msgs = (await groupChat.readMessages(TEST_UID, cid)) as any[];
    const denied = msgs.find((m) => String(m.text || "").includes("未获允许在本对话中启动"));
    expect(denied).toBeDefined();
  });

  it("hands the previous external Agent result to the next switched P3394 Agent", async () => {
    const cid = newCid();
    const workbuddyId = "gateway-workbuddy";
    const codexId = "gateway-codex";
    await seedAgent({
      id: workbuddyId,
      name: "WorkBuddy",
      runtime: { kind: "p3394-gateway", cli: "workbuddy" },
    });
    await seedAgent({
      id: codexId,
      name: "Codex",
      runtime: { kind: "p3394-gateway", cli: "codex" },
    });
    await addAgentMember(cid, workbuddyId, "WorkBuddy");
    await addAgentMember(cid, codexId, "Codex");

    const bus = await import("../../../../src/main/features/group_chat/bus");
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "请先分析 AI 表格转项目需求。",
      forceTo: [workbuddyId],
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "请基于前面的分析生成单文件 HTML 原型。",
      forceTo: [codexId],
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const codexCall = p3394GatewayCalls.find((call) => call.agent?.agent_id === codexId);
    expect(codexCall).toBeDefined();
    expect(codexCall.prompt).toContain("WorkBuddy product analysis");
    expect(codexCall.prompt).toContain("请基于前面的分析生成单文件 HTML 原型");
  });
});

describe("group_chat bus integration › teaching receipts", () => {
  it("persists a deduplicated teaching receipt on the visible commander reply", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const receipt = {
      id: "teach-a",
      summary: "以后所有结论都附来源。",
      scope: "project",
      status: "active",
      candidateIds: ["cand-a"],
    };
    _setScript(state.buildGconvSessionId(cid), [
      { type: "__emit_teaching_receipt__", receipt },
      { type: "__emit_teaching_receipt__", receipt },
      { type: "final", text: "已经记住。" },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "请记住：以后所有结论都附来源。",
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const messages = await readConversationMessages(cid);
    const reply = messages.find((message) =>
      message.from === "commander" && Array.isArray(message.teaching_receipts));
    expect(_recordedCalls.find((call) => call.sid === state.buildGconvSessionId(cid))?.sourceMessageText)
      .toBe("请记住：以后所有结论都附来源。");
    expect(reply).toMatchObject({
      text: "已经记住。",
      teaching_receipts: [{
        id: "teach-a",
        summary: "以后所有结论都附来源。",
        scope: "project",
        status: "active",
        candidate_ids: ["cand-a"],
      }],
    });
  });
});

describe("group_chat bus integration › disabled skills", () => {
  it("does not let commander substitute another skill when user explicitly requests a disabled one", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const enabled =
      await import("../../../../src/main/features/component_enabled");
    const storage = await import("../../../../src/main/storage");

    const skillDir = path.join(paths.userSkillsDir(TEST_UID), "arxiv-reader");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: \"arxiv-reader\"",
        "description_zh: \"ArXiv reader\"",
        "description_en: \"ArXiv reader\"",
        "---",
        "",
        "# ArXiv Reader",
      ].join("\n"),
    );
    enabled.setSkillEnabled(TEST_UID, "arxiv-reader", false);

    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "WRONG: substituted skill ran" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "使用 arxiv-reader 技能：最新论文",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    expect(
      messages.some((m: any) => String(m.text || "").includes("WRONG")),
    ).toBe(false);
    expect(
      messages.some((m: any) =>
        String(m.text || "").includes("component.skill_disabled_request"),
      ),
    ).toBe(false);
    expect(
      messages.some((m: any) => String(m.text || "").includes("arxiv-reader")),
    ).toBe(true);
    expect(
      messages.some((m: any) => /停用|disabled/i.test(String(m.text || ""))),
    ).toBe(true);
    const failure = messages.find(
      (m: any) => m.from === "commander" && m.failure_kind,
    );
    expect(failure).toMatchObject({
      failure_kind: "dependency",
      failure_code: "skill_disabled",
    });
  });
});

describe("group_chat bus integration › failure taxonomy", () => {
  it("persists model preflight failures as config rather than model output", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const storage = await import("../../../../src/main/storage");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "error",
        text: "No model configured",
        failureKind: "config",
        failureCode: "model_preflight",
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "hello",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    const failure = messages.find(
      (m: any) => m.from === "commander" && m.failure_kind,
    );
    expect(failure).toMatchObject({
      failure_kind: "config",
      failure_code: "model_preflight",
    });
    expect(String(failure?.text || "")).toContain("No model configured");
  });
});

describe("group_chat bus integration › abort sticky across worker post-cleanup", () => {
  it("abort also targets active core-agent sessions by conversation id", async () => {
    const cid = newCid();
    const bus = await import("../../../../src/main/features/group_chat/bus");

    await bus.abort(TEST_UID, cid);

    expect(modelAbortMock).toHaveBeenCalledWith(cid);
  });

  it("abort during a turn keeps state.aborted; subsequent worker reply does NOT un-stick", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    // Commander turn that yields nothing (we'll abort during it).
    // The mock generator yields events synchronously, so abort after
    // enqueue returns also runs after the turn already completed for
    // a one-event script. To race the abort we let the script be
    // larger — multiple events with awaits between would help, but
    // since the mock is sync we instead just abort *immediately* after
    // enqueue and verify the post-abort state is sticky.
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "commander reply" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "hello",
    });
    await bus.abort(TEST_UID, cid);
    // Wait long enough for any pending worker microtasks to settle.
    await new Promise((r) => setTimeout(r, 100));
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe("aborted");
  });

  it("abort during a live agent turn propagates to the worker AbortSignal", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    bus.subscribe(TEST_UID, cid, () => {});
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
      { type: "final", text: "should not appear after abort" },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} long task`,
    });

    // G8d: top-level turns run through one per-conversation runtime (not a
    // per-actor worker keyed by agent id). Find the running runtime bound to
    // this agent's turn.
    const runningFor = (id: string) => {
      const live = bus._cidStateForTest(TEST_UID, cid);
      return live
        ? [...live.workers.values()].find(
            (wk) => wk.running && wk.actor.id === id,
          )
        : undefined;
    };
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const worker = runningFor(AGENT_ID);
      if (worker?.abortController) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runningFor(AGENT_ID)?.abortController).toBeTruthy();

    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 2000);

    const paths = await import("../../../../src/main/paths");
    const storage = await import("../../../../src/main/storage");
    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    expect(
      messages.some((m: any) =>
        m.text.includes("should not appear after abort"),
      ),
    ).toBe(false);
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe("aborted");
  });

  it("a NEW user message after abort clears the sticky aborted flag", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "first",
    });
    await bus.abort(TEST_UID, cid);
    let st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe("aborted");

    // New user message — bus should clear aborted → idle and process normally.
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "second reply" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "second",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);

    st = await state.readState(TEST_UID, cid);
    expect(st.status).not.toBe("aborted");
  });
});

// SKIP 这块的第二条:`fromActorId: 'commander'` 写 @<id> 在文本里——
// 现在 commander 文本 @ 不解析,@<id>→@<name> 的 rewrite 链也跟着断
// (rewrite 依赖 router 把 agent 加进 idToName)。dispatch_to 工具用名字调
// 而非 id,这条已是 dead semantic;留着第一条(@<name> 不变)。
describe("group_chat bus integration › @<id> rewrite is no-op when text already uses @<name>", () => {
  it("text \"@Writer ...\" stays \"@Writer ...\" after enqueue (rewrite only fires when text uses raw id)", async () => {
    const cid = newCid();
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "commander",
      text: `@${AGENT_NAME} 写一段`,
    });
    expect(msg.text).toBe(`@${AGENT_NAME} 写一段`);
    expect(msg.text).not.toContain(AGENT_ID); // hex id never appears
  });
});

describe("group_chat bus integration › CJK + space-stripped name resolution", () => {
  it("resolves @<no-space-name> when stored agent name has spaces", async () => {
    const cid = newCid();
    const paths = await import("../../../../src/main/paths");
    // Seed an agent whose display name has internal whitespace.
    const aid = "aaa1bbb2ccc3";
    const pmDir = paths.agentDir(TEST_UID, aid);
    fs.mkdirSync(pmDir, { recursive: true });
    fs.writeFileSync(
      path.join(pmDir, "agent.json"),
      JSON.stringify({
        agent_id: aid,
        name: "产品 经理",
        description: "PM",
        workflow: "...",
        created_at: "t",
        updated_at: "t",
      }),
    );

    const bus = await import("../../../../src/main/features/group_chat/bus");
    // User types `@产品经理` (no space) — bus should resolve to the agent
    // even though the stored name has a space.
    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "@产品经理 帮我做需求文档",
    });
    expect(msg.to).toEqual([aid]);
  });
});

describe("group_chat bus integration › conversation delete cascade", () => {
  it("chats.deleteConversation removes ALL per-conv on-disk artifacts", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const chats = await import("../../../../src/main/features/chats");
    const paths = await import("../../../../src/main/paths");

    // Create the conv via the chats facade so the index gets a row.
    const conv = await chats.createConversation(TEST_UID, { title: "测试" });
    // Hijack the cid since chats.createConversation generates its own.
    const realCid = conv.conversation_id;

    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: "final", text: `@${AGENT_NAME} 干活` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID), [
      { type: "final", text: "done" },
    ]);
    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: "final", text: "ack" },
    ]);

    bus.subscribe(TEST_UID, realCid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid: realCid,
      fromActorId: "user",
      text: "go",
    });
    await waitForQuiescent(TEST_UID, realCid, 3000);

    // Sanity — all the expected files exist before delete.
    const mainJsonl = path.join(
      paths.userChatsDir(TEST_UID),
      `${realCid}.jsonl`,
    );
    const groupDir = paths.groupChatDir(TEST_UID, realCid);
    const cmdSession = paths.userSessionFile(
      TEST_UID,
      state.buildGconvSessionId(TEST_UID, realCid),
    );
    const agentSession = paths.userSessionFile(
      TEST_UID,
      state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID),
    );
    expect(fs.existsSync(mainJsonl)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(true);
    // Note: session jsonls are created lazily by core-agent's PersistentSession;
    // they may or may not exist depending on whether the session got opened.
    // That's covered by the eviction behaviour rather than by file existence
    // here. We only assert they're CLEANED UP if they did exist.
    const cmdSessionExisted = fs.existsSync(cmdSession);
    const agentSessionExisted = fs.existsSync(agentSession);

    await chats.deleteConversation(TEST_UID, realCid);

    expect(fs.existsSync(mainJsonl)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
    if (cmdSessionExisted) expect(fs.existsSync(cmdSession)).toBe(false);
    if (agentSessionExisted) expect(fs.existsSync(agentSession)).toBe(false);
    // Bus state for this cid must also be gone.
    expect(bus._cidStateForTest(TEST_UID, realCid)).toBeNull();
  }, 10_000);
});


describe("group_chat state logging privacy", () => {
  it("logs successful membership with masked ids and no user-defined name", async () => {
    const state = await import("../../../../src/main/features/group_chat/state");
    const uid = "privacy-user-raw-123456";
    const cid = "privacy-cid-raw-654321";
    const actorId = "privacy-actor-raw-abcdef";
    const actorName = "SECRET USER DEFINED MEMBER NAME";
    loggerMocks.debug.mockClear();
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
    loggerMocks.error.mockClear();

    await state.addMember(uid, cid, {
      id: actorId,
      kind: "agent",
      name: actorName,
    });

    const allLogs = JSON.stringify([
      loggerMocks.debug.mock.calls,
      loggerMocks.info.mock.calls,
      loggerMocks.warn.mock.calls,
      loggerMocks.error.mock.calls,
    ]);
    expect(allLogs).not.toContain(uid);
    expect(allLogs).not.toContain(cid);
    expect(allLogs).not.toContain(actorId);
    expect(allLogs).not.toContain(actorName);
    const memberLogs = loggerMocks.info.mock.calls.filter(
      ([message]) => message === "member joined",
    );
    expect(memberLogs).toHaveLength(1);
    expect(memberLogs[0]?.[1]).toMatchObject({ kind: "agent" });
    expect(memberLogs[0]?.[1]?.user_id).not.toBe(uid);
    expect(memberLogs[0]?.[1]?.cid).not.toBe(cid);
    expect(memberLogs[0]?.[1]?.actor_id).not.toBe(actorId);
    expect(memberLogs[0]?.[1]).not.toHaveProperty("name");
  });
});

describe("group_chat bus integration › G8d in-process dispatch (run_worker / dispatch_to)", () => {
  it('does NOT expose kstar_control to the Commander (world model owns the lifecycle)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const previous = process.env.COGSEED_COMMANDER_CENTRIC_KSTAR;
    process.env.COGSEED_COMMANDER_CENTRIC_KSTAR = '1';
    try {
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__capture_tool_definitions__' },
        { type: 'final', text: 'captured' },
      ]);
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: 'inspect KStar tools',
      });
      await waitForQuiescent(TEST_UID, cid, 4000);
      // The Commander must never see kstar_control: task/projection/forecast
      // are all host-side now (routing + auto-forecast).
      expect(_recordedToolDefinitions.filter((tool) => tool.name === 'kstar_control')).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.COGSEED_COMMANDER_CENTRIC_KSTAR;
      else process.env.COGSEED_COMMANDER_CENTRIC_KSTAR = previous;
    }
  });

  // G8d step 3: dispatch tools run their target's turn in-process and hand the
  // result back as the tool result — no staging, no turn-end flush, no re-wake.
  // The commander reads the result and synthesises within the SAME turn. The
  // mock's `__call_tool__` drives the real tool execute() so the nested run
  // actually streams (routed by its gworker/gmember session id).
  it('exposes run_worker as anonymous read-only helper only in the production contract', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const previous = process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    try {
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__capture_tool_definitions__' },
        { type: 'final', text: 'captured' },
      ]);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'inspect strict worker' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      const tool = _recordedToolDefinitions.find((candidate) => candidate.name === 'run_worker');
      expect(tool?.inputSchema.properties.to).toBeTruthy(); // backward-compat schema field
      expect(tool?.inputSchema.properties.access_mode.enum).toContain('read');
      expect(tool?.inputSchema.properties.access_mode.enum).toContain('write');
      // Runtime enforcement, not schema: named/write run_worker is rejected in strict mode
    } finally {
      if (previous === undefined) delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
      else process.env.COGSEED_LEGACY_RUN_WORKER_TEST = previous;
    }
  });

  it('rejects named run_worker before starting a formal Agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const previous = process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    try {
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: 'run_worker', input: { to: AGENT_NAME, task: 'write a report' } },
        { type: 'final', text: 'handled' },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: 'final', text: 'MUST NOT RUN' },
      ]);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'strict named worker' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      const result = _recordedToolResults.find((entry) => entry.name === 'run_worker');
      expect(result?.isError).toBe(true);
      expect(JSON.parse(result!.content).error).toMatch(/dispatch_to/);
      expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
      else process.env.COGSEED_LEGACY_RUN_WORKER_TEST = previous;
    }
  });

  it('rejects write-capable anonymous run_worker before starting the helper', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const previous = process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    try {
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: 'run_worker', input: { task: 'change files', access_mode: 'write', write_scopes: ['src'] } },
        { type: 'final', text: 'handled' },
      ]);
      _setScript('gworker-*', [{ type: 'final', text: 'MUST NOT RUN' }]);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'strict write worker' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      const result = _recordedToolResults.find((entry) => entry.name === 'run_worker');
      expect(result?.isError).toBe(true);
      expect(JSON.parse(result!.content).error).toMatch(/read-only/i);
      expect(_recordedCalls.filter((call) => call.sid.startsWith('gworker-'))).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
      else process.env.COGSEED_LEGACY_RUN_WORKER_TEST = previous;
    }
  });

  it('defaults an anonymous run_worker workflow step to read access', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const collaboration = await import('../../../../src/main/features/group_chat/collaboration');
    const previous = process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
    try {
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: 'run_worker', input: { task: 'count records only' } },
        { type: 'final', text: 'counted' },
      ]);
      _setScript('gworker-*', [{ type: 'final', text: '42' }]);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'count records' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const step = run?.steps.find((step) => step.source_tool === 'run_worker');
      expect(step).toBeTruthy();
      expect(step?.actor_kind).toBe('anonymous_worker');
      expect(step?.access_mode).toBe('read');
      // write_scopes absent for anonymous without explicit scopes
    } finally {
      if (previous === undefined) delete process.env.COGSEED_LEGACY_RUN_WORKER_TEST;
      else process.env.COGSEED_LEGACY_RUN_WORKER_TEST = previous;
    }
  });

  it("run_worker (anonymous) runs the worker IN-PROCESS and hands its full result back as the tool result — no roster member, no worker bubble, no lingering worker", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });

    const WORKER_RESULT =
      "WORKER-INTERNAL-OUTPUT-7c1d: scanned 42 files, here is the full structured summary the commander needs.";

    // Commander's SINGLE turn: call run_worker with NO `to` (anonymous worker),
    // then synthesise for the user in the SAME turn. G8d removed the re-wake —
    // the worker's result returns as the tool result, in-process, so the
    // commander reads it and continues without a second scheduled turn.
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "scan the workspace and summarise" },
      },
      { type: "final", text: "Done — summarised the workspace for you." },
    ]);
    // The in-process worker sub-run (matched via the gworker wildcard).
    _setScript("gworker-*", [{ type: "final", text: WORKER_RESULT }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "summarise my workspace",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The worker actually ran in-process: a gworker session turn fired.
    const workerCall = _recordedCalls.find((c) => c.sid.startsWith("gworker-"));
    expect(
      workerCall,
      "an in-process worker sub-run should have streamed",
    ).toBeTruthy();

    // 2) Its FULL result came back SYNCHRONOUSLY as the run_worker tool result,
    //    wrapped as <worker-result> — the handback IS the tool result.
    const toolResult = _recordedToolResults.find(
      (r) => r.name === "run_worker",
    );
    expect(
      toolResult,
      "run_worker should return its result synchronously",
    ).toBeTruthy();
    expect(toolResult!.content).toContain("<worker-result");
    expect(toolResult!.content).toContain(WORKER_RESULT);
    expect(_recordedNestedOutcomes).toHaveLength(1);
    const successOutcome = _recordedNestedOutcomes[0];
    expect(successOutcome).toMatchObject({
      ok: true,
      text: WORKER_RESULT,
      produced: [],
      payload: toolResult!.content,
      workflowStepId: expect.stringMatching(/^wstep-/),
    });
    expect(toolResult!.content).toContain(
      `workflow_step_id="${successOutcome.workflowStepId}"`,
    );
    // G4 wiring (step 3b-tail): run_worker is parallel-safe so independent
    // fan-out in one turn runs concurrently (bounded by dispatchSlots).
    expect(
      toolResult!.executionMode,
      "run_worker must be G4-parallel-safe",
    ).toBe("parallel");

    // 3) The worker is NOT a roster member.
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.kind === "worker")).toBe(false);

    // 4) The worker's raw output NEVER becomes a user-visible bubble — only the
    //    commander's synthesis is persisted.
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some((m: any) => String(m.text || "").includes(WORKER_RESULT)),
    ).toBe(false);
    expect(
      lines.some((m: any) =>
        String(m.text || "").includes("summarised the workspace"),
      ),
    ).toBe(true);

    // 5) The nested sub-run used a synthetic, unregistered WorkerState — no
    //    worker-kind entry ever appears in the in-memory worker map.
    const live = bus._cidStateForTest(TEST_UID, cid);
    const lingering = live
      ? [...live.workers.values()].some((wk: any) => wk.actor.kind === "worker")
      : false;
    expect(
      lingering,
      "no ephemeral worker should appear in the worker map",
    ).toBe(false);
  }, 12_000);

  it("run_worker returns an explicit worker-error when the nested worker stream fails", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "scan the workspace and summarise" },
      },
      { type: "final", text: "I handled the worker failure." },
    ]);
    _setScript("gworker-*", [
      { type: "error", text: "nested worker blew <up> & quit" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "summarise my workspace",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find(
      (r) => r.name === "run_worker",
    );
    expect(
      toolResult,
      "run_worker should return a tool result even when the worker fails",
    ).toBeTruthy();
    expect(toolResult!.content).toContain("<worker-error");
    expect(toolResult!.content).toContain(
      "nested worker blew &lt;up&gt; &amp; quit",
    );
    expect(toolResult!.content).not.toContain("<worker-result");
    expect(toolResult!.content).not.toContain("(no textual reply)");
  }, 12_000);

  it("run_worker classifies a group abort as a non-retryable nested outcome", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "scan slowly" },
      },
      { type: "final", text: "should not matter after abort" },
    ]);
    _setScript("gworker-*", [{ type: "__wait_for_abort__" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "scan it slowly",
    });

    const started = await waitUntil(
      () => _recordedCalls.some((c) => c.sid.startsWith("gworker-")),
      2000,
    );
    expect(started, "nested worker should have started before abort").toBe(
      true,
    );
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find(
      (r) => r.name === "run_worker",
    );
    expect(
      toolResult,
      "run_worker should return an abort-marked tool result",
    ).toBeTruthy();
    expect(toolResult!.content).toContain("<worker-error");
    expect(toolResult!.content).toContain("aborted=\"true\"");
    expect(toolResult!.content).toContain("failure_code=\"group_abort\"");
    expect(toolResult!.content).toContain("retryable=\"false\"");
    expect(toolResult!.content).toContain("Task was stopped by the user.");
    expect(toolResult!.content).not.toContain("<worker-result");
    expect(_recordedNestedOutcomes).toHaveLength(1);
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "group_abort",
      retryable: false,
      abortSource: "group_abort",
      workflowStepId: expect.stringMatching(/^wstep-/),
      payload: toolResult!.content,
    });
    expect(toolResult!.content).toContain(
      `workflow_step_id="${_recordedNestedOutcomes[0].workflowStepId}"`,
    );
    const workflowRun = await collaboration.readActiveWorkflowRun(
      TEST_UID,
      cid,
    );
    expect(workflowRun?.steps[0]?.status).toBe("skipped");
  }, 12_000);

  it("run_worker classifies a parent-only abort as non-retryable", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool_parent_abort__",
        name: "run_worker",
        input: { task: "wait for parent cancellation" },
      },
      { type: "final", text: "parent recovered" },
    ]);
    _setScript("gworker-*", [{ type: "__wait_for_abort__" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "cancel only the nested call",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find((r) => r.name === "run_worker");
    expect(toolResult).toBeTruthy();
    expect(toolResult!.content).toContain('failure_code="parent_abort"');
    expect(toolResult!.content).toContain('retryable="false"');
    expect(_recordedNestedOutcomes).toHaveLength(1);
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "parent_abort",
      retryable: false,
      abortSource: "parent_abort",
      payload: toolResult!.content,
    });
  });

  it("grants ability assets ONLY via Commander dispatch — no host-side injection into agents", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const candidates = await import("../../../../src/main/features/recall/candidate-service");

    const candidate = await candidates.saveRecallCandidate(TEST_UID, {
      judgment: "Never leak asset context into delegated turns unless the Commander grants it.",
      summary: "Commander-gated asset grant rule",
      suggestedType: "rule",
      suggestedScope: "review",
      sourceRefs: [{ kind: "execution", id: "exec-gate" }],
    });
    const asset = (await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: "user" })).asset;
    // 自动投影按 PRD 3.6 只接纳 Transfer Verified 及以上。本用例考的是
    // "资产只经 Commander 分发、不由宿主注入 Agent"的契约，不是成熟度闸门，
    // 所以先把资产抬到够格的档位。
    await (await import("../../../../src/main/features/recall/asset-service")).setAbilityAssetMaturity(TEST_UID, asset.id, "transfer_validated");

    const AGENT_REPLY = "AGENT-OK-58d2";
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "audit the flow", ability_assets: [asset.id] },
      },
      { type: "final", text: "Synthesised." },
    ]);
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(agentSid, [{ type: "final", text: AGENT_REPLY }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "run the audit" });
    await waitForQuiescent(TEST_UID, cid, 6000);

    // The agent's system prompt received the Commander-granted asset block...
    const agentCall = _recordedCalls.find((c) => c.sid === agentSid);
    expect(agentCall).toBeTruthy();
    expect(agentCall!.systemPrompt).toContain("<commander-dispatched-assets>");
    expect(agentCall!.systemPrompt).toContain(asset.title);
    // ...and NEVER the host-side confirmed-assets block.
    expect(agentCall!.systemPrompt).not.toContain("<confirmed-ability-assets>");
    // The Commander itself still gets automatic Recall injection.
    const commanderCall = _recordedCalls.find((c) => c.sid === state.buildGconvSessionId(cid));
    expect(commanderCall).toBeTruthy();
    expect(commanderCall!.systemPrompt).toContain("<confirmed-ability-assets>");

    // The dispatched grant landed in the usage ledger with outcome 'dispatched'.
    const usage = await import("../../../../src/main/features/recall/usage-service");
    const dispatchedRecords = (await usage.listRecallUsage(TEST_UID, asset.id))
      .filter((record) => record.outcome === "dispatched");
    expect(dispatchedRecords.length).toBeGreaterThanOrEqual(1);
    expect(dispatchedRecords[0]).toMatchObject({
      assetId: asset.id,
      assetVersion: asset.version,
      boundary: "real",
    });
  }, 10_000);

  it("rejects dispatch with an unknown or inactive ability asset id", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "audit the flow", ability_assets: ["aa-does-not-exist"] },
      },
      { type: "final", text: "handled" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "MUST NOT RUN" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "run the audit" });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const toolResult = _recordedToolResults.find((r) => r.name === "dispatch_to");
    expect(toolResult?.isError).toBe(true);
    expect(JSON.parse(toolResult!.content).error).toMatch(/unknown ability asset/);
    // The agent never started.
    expect(_recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(0);
  }, 10_000);

  it.each(["agent_idle", "tool_idle"] as const)(
    "run_worker classifies coordinator %s aborts as retryable without claiming a user stop",
    async (reason) => {
      const cid = newCid();
      const state =
        await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      let fireAbort:
        | ((reason: "tool_idle" | "agent_idle", idleMs: number) => void)
        | undefined;
      (bus as any)._setCoordinatorLeaseFactoryForTest((input: any) => {
        fireAbort = input.onAbort;
        return { observe() {}, stop() {} };
      });
      (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
        _recordedNestedOutcomes.push(outcome);
      });

      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: "run_worker",
          input: { task: `stall at ${reason}` },
        },
        { type: "final", text: "coordinator recovered" },
      ]);
      _setScript("gworker-*", [
        { type: "delta", text: "partial <work>" },
        { type: "__wait_for_abort__" },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: `exercise ${reason}`,
      });
      expect(
        await waitUntil(() => typeof fireAbort === "function", 2000),
        "nested dispatch should install the coordinator abort seam",
      ).toBe(true);
      fireAbort!(reason, 480_000);
      await waitForQuiescent(TEST_UID, cid, 4000);

      const toolResult = _recordedToolResults.find((r) => r.name === "run_worker");
      expect(toolResult).toBeTruthy();
      expect(_recordedNestedOutcomes).toHaveLength(1);
      expect(_recordedNestedOutcomes[0]).toMatchObject({
        ok: false,
        text: "partial <work>",
        produced: [],
        failureCode: `coordinator_${reason}`,
        retryable: true,
        abortSource: "coordinator",
        workflowStepId: expect.stringMatching(/^wstep-/),
        payload: toolResult!.content,
      });
      expect(toolResult!.content).toContain(
        `failure_code="coordinator_${reason}"`,
      );
      expect(toolResult!.content).toContain('retryable="true"');
      expect(toolResult!.content).toContain('aborted="false"');
      expect(toolResult!.content).not.toContain('aborted="true"');
      expect(toolResult!.content).toContain("partial &lt;work&gt;");
      expect(toolResult!.content).not.toContain("stopped by the user");
    },
  );

  it("CLI completed tool becomes coordinator_agent_idle and coordinator events never expose PID", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await makeSeedAgentCli();
    const emitted: any[] = [];
    const harness = installLeaseDecisionHarness(
      bus,
      (event) => event?.kind === "tool_result",
    );
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    localRunnerScripts.push([
      { type: "process-info", pid: process.pid, cwd: tmpDir, cmd: "mock-cli" },
      { type: "tool-event", tool: "exec_command", callId: "c1", phase: "use" },
      {
        type: "tool-event",
        tool: "exec_command",
        callId: "c1",
        phase: "result",
        output: "ok",
      },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "run the CLI tool" },
      },
      { type: "final", text: "handled" },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise completed CLI tool stall",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedNestedOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(_recordedNestedOutcomes.at(-1)).toMatchObject({ ok: true });
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "coordinator_agent_idle",
      retryable: true,
      abortSource: "coordinator",
    });
    expect(_recordedNestedOutcomes[0].payload).not.toContain("stopped by the user");
    const persisted = (await readConversationMessages(cid)).find(
      (message) =>
        message.from === AGENT_ID &&
        message.failure_code === "coordinator_agent_idle",
    );
    expect(persisted).toMatchObject({
      failure_kind: "runtime",
      failure_code: "coordinator_agent_idle",
    });
    expect(String(persisted?.text || "")).not.toContain("stopped by the user");
    expect(JSON.stringify(persisted?.process || [])).not.toMatch(/"pid"/i);
    expect(modelSessionActiveMock).not.toHaveBeenCalled();
    expect(harness.stops.length).toBeGreaterThanOrEqual(1);

    const coordinatorEvents = coordinatorProcessEvents(emitted);
    expect(coordinatorEvents).toContainEqual({
      stream: "coordinator",
      data: {
        phase: "probe",
        reason: "agent_idle",
        idle_ms: 300_000,
        alive: true,
      },
    });
    expect(coordinatorEvents).toContainEqual({
      stream: "coordinator",
      data: {
        phase: "terminating",
        reason: "agent_idle",
        idle_ms: 480_000,
      },
    });
    expect(JSON.stringify(coordinatorEvents)).not.toMatch(/pid/i);
  });


  // 第二期通道收口（2026-08-24）：直连 `cli` 通道不再是默认执行路径，
  // 本用例钉住的 PID 探活 / CLI 会话持久化语义是直连专属；网关模式下
  // 会话连续性由 P3394 session 承担。网关侧 PID 数据源与探活语义列入
  // 后续增强（见 docs/design 设计文档第 5 节），补齐后恢复本用例。
  it.skip("CLI process-info accepts only a positive integer number as the in-memory PID", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await makeSeedAgentCli();
    const emitted: any[] = [];
    let probeIndex = 0;
    bus._setCoordinatorLeaseFactoryForTest((input: any) => ({
      observe(event: any) {
        if (event?.kind === "activity") {
          input.onProbe(++probeIndex);
        } else if (event?.kind === "tool_start") {
          input.onProbe(++probeIndex);
          input.onAbort("agent_idle", 480_000);
        }
      },
      stop() {},
    }));
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    localRunnerScripts.push([
      { type: "process-info", pid: "123", cwd: tmpDir },
      { type: "process-info", pid: true, cwd: tmpDir },
      { type: "process-info", pid: [123], cwd: tmpDir },
      { type: "process-info", pid: 0, cwd: tmpDir },
      { type: "process-info", pid: -1, cwd: tmpDir },
      { type: "process-info", pid: 1.5, cwd: tmpDir },
      { type: "process-info", pid: process.pid, cwd: tmpDir },
      { type: "tool-event", tool: "exec_command", callId: "c1", phase: "use" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "validate process PID metadata" },
      },
      { type: "final", text: "handled" },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise strict CLI PID validation",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedNestedOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(_recordedNestedOutcomes.at(-1)).toMatchObject({ ok: true });
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "coordinator_agent_idle",
      abortSource: "coordinator",
    });
    const probes = coordinatorProcessEvents(emitted).filter(
      (event) => event.data?.phase === "probe",
    );
    expect(probes.map((event) => event.data.alive)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(probes.map((event) => event.data.idle_ms)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(modelSessionActiveMock).not.toHaveBeenCalled();
    expect(JSON.stringify(emitted)).not.toMatch(/"pid"/i);

    const persisted = (await readConversationMessages(cid)).find(
      (message) => message.failure_code === "coordinator_agent_idle",
    );
    expect(persisted).toBeTruthy();
    expect(JSON.stringify(persisted?.process || [])).not.toMatch(/"pid"/i);
  });

  it("CLI process-info emits and persists only coarse allowlisted metadata", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await makeSeedAgentCli();
    const emitted: any[] = [];
    const sentinels = [
      "SECRET_PROCESS_PROMPT_41f9",
      "SECRET_CUSTOM_ARG_72ac",
      "SECRET_COMMAND_b37d",
      "SECRET_CWD_981e",
      "SECRET_SESSION_55ad",
      "SECRET_ENV_18f0",
      "SECRET_TOKEN_64c2",
      "SECRET_BACKEND_b803",
    ];
    bus._setCoordinatorLeaseFactoryForTest((input: any) => ({
      observe(event: any) {
        if (event?.kind === "tool_start") {
          input.onAbort("agent_idle", 480_000);
        }
      },
      stop() {},
    }));
    localRunnerScripts.push([
      {
        type: "process-info",
        pid: process.pid,
        prompt: sentinels[0],
        args: ["--prompt", sentinels[0], "--secret", sentinels[1]],
        custom_args: [sentinels[1]],
        cmd: `opencode ${sentinels[2]}`,
        cwd: `/tmp/${sentinels[3]}`,
        sessionId: sentinels[4],
        environment: { API_TOKEN: sentinels[5] },
        token: sentinels[6],
        backendId: sentinels[7],
      },
      { type: "tool-event", tool: "exec_command", callId: "c1", phase: "use" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "validate process-info privacy" },
      },
      { type: "final", text: "handled" },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise CLI process-info privacy",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const liveProcessInfo = emitted
      .filter(
        (event) =>
          event?.type === "process" &&
          event?.data?.event?.stream === "cli" &&
          event?.data?.event?.data?.type === "process-info",
      )
      .map((event) => event.data.event);
    expect(liveProcessInfo).toEqual([
      { stream: "cli", data: { type: "process-info" } },
    ]);
    const persisted = (await readConversationMessages(cid)).find(
      (message) => message.failure_code === "coordinator_agent_idle",
    );
    expect(persisted).toBeTruthy();
    const persistedProcessInfo = (persisted.process || [])
      .filter(
        (item: any) =>
          item?.event?.stream === "cli" &&
          item?.event?.data?.type === "process-info",
      )
      .map((item: any) => item.event);
    expect(persistedProcessInfo).toEqual([
      { stream: "cli", data: { type: "process-info" } },
    ]);
    const serialized = JSON.stringify({ emitted, persisted });
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toMatch(/"pid"/i);
  });

  it("CLI open tool becomes coordinator_tool_idle", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await makeSeedAgentCli();
    installLeaseDecisionHarness(bus, (event) => event?.kind === "tool_start");
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    localRunnerScripts.push([
      { type: "tool-event", tool: "exec_command", callId: "c1", phase: "use" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "leave the CLI tool open" },
      },
      { type: "final", text: "handled" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise open CLI tool stall",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedNestedOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(_recordedNestedOutcomes.at(-1)).toMatchObject({ ok: true });
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "coordinator_tool_idle",
      retryable: true,
      abortSource: "coordinator",
    });
    expect(_recordedNestedOutcomes[0].payload).not.toContain("stopped by the user");
  });

  it("in-process completed tool becomes coordinator_agent_idle with model-session liveness", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const emitted: any[] = [];
    const harness = installLeaseDecisionHarness(
      bus,
      (event) => event?.kind === "tool_result",
    );
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "run an in-process tool" },
      },
      { type: "final", text: "handled" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: "event",
        event: {
          stream: "tool",
          data: { phase: "start", id: "c1", name: "exec_command" },
        },
      },
      {
        type: "event",
        event: {
          stream: "tool",
          data: { phase: "end", id: "c1", name: "exec_command" },
        },
      },
      { type: "__wait_for_abort__" },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise completed in-process tool stall",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedNestedOutcomes.length).toBeGreaterThanOrEqual(2);
    expect(_recordedNestedOutcomes.at(-1)).toMatchObject({ ok: true });
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "coordinator_agent_idle",
      retryable: true,
      abortSource: "coordinator",
    });
    expect(_recordedNestedOutcomes[0].payload).not.toContain("stopped by the user");
    const persisted = (await readConversationMessages(cid)).find(
      (message) =>
        message.from === AGENT_ID &&
        message.failure_code === "coordinator_agent_idle",
    );
    expect(persisted).toMatchObject({
      failure_kind: "runtime",
      failure_code: "coordinator_agent_idle",
    });
    expect(String(persisted?.text || "")).not.toContain("stopped by the user");
    expect(JSON.stringify(persisted?.process || [])).not.toMatch(/"pid"/i);
    expect(modelSessionActiveMock).toHaveBeenCalledWith(
      state.buildGmemberSessionId(cid, AGENT_ID),
    );
    expect(harness.stops.length).toBeGreaterThanOrEqual(1);

    const coordinatorEvents = coordinatorProcessEvents(emitted);
    expect(coordinatorEvents).toContainEqual({
      stream: "coordinator",
      data: {
        phase: "probe",
        reason: "agent_idle",
        idle_ms: 300_000,
        alive: true,
      },
    });
    expect(coordinatorEvents).toContainEqual({
      stream: "coordinator",
      data: {
        phase: "terminating",
        reason: "agent_idle",
        idle_ms: 480_000,
      },
    });
    expect(JSON.stringify(coordinatorEvents)).not.toMatch(/pid/i);
  });

  it("terminalizes the in-process lease before post-stream async work can race an abort", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const emitted: any[] = [];
    let abortAttempts = 0;
    let stopCalls = 0;
    bus._setCoordinatorLeaseFactoryForTest((input: any) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        observe(event: any) {
          if (event?.kind === "activity" && timer === undefined) {
            timer = setTimeout(() => {
              abortAttempts += 1;
              input.onAbort("agent_idle", 480_000);
            }, 0);
          }
        },
        stop() {
          stopCalls += 1;
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    });
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "finish before lease threshold" },
      },
      { type: "final", text: "handled" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "delta", text: "completed result" },
      {
        type: "final",
        text: "completed result",
        afterYield: () => new Promise((resolve) => setTimeout(resolve, 10)),
      },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise terminal lease race",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(abortAttempts).toBe(0);
    expect(stopCalls).toBeGreaterThanOrEqual(1);
    expect(_recordedNestedOutcomes).toHaveLength(1);
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: true,
      text: "completed result",
    });
    expect(
      coordinatorProcessEvents(emitted).some(
        (event) => event.data?.phase === "terminating",
      ),
    ).toBe(false);
    const persisted = (await readConversationMessages(cid)).find(
      (message) => message.from === AGENT_ID,
    );
    expect(persisted).toMatchObject({ text: "completed result" });
    expect(persisted?.failure_kind).toBeUndefined();
    expect(persisted?.failure_code).toBeUndefined();
  });

  it("terminalizes the in-process lease before async cleanup after a direct stream throw", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const emitted: any[] = [];
    let abortAttempts = 0;
    let stopCalls = 0;
    bus._setCoordinatorLeaseFactoryForTest((input: any) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        observe(event: any) {
          if (event?.kind === "activity" && timer === undefined) {
            timer = setTimeout(() => {
              abortAttempts += 1;
              input.onAbort("agent_idle", 480_000);
            }, 0);
          }
        },
        stop() {
          stopCalls += 1;
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    });
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "throw without terminal event" },
      },
      { type: "final", text: "handled" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "delta", text: "partial before direct throw" },
      { type: "__throw__", message: "forced direct stream rejection" },
    ]);

    bus.subscribe(TEST_UID, cid, (event: any) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise direct stream throw race",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(abortAttempts).toBe(0);
    expect(stopCalls).toBeGreaterThanOrEqual(1);
    expect(_recordedNestedOutcomes).toHaveLength(1);
    expect(_recordedNestedOutcomes[0]).toMatchObject({
      ok: false,
      failureCode: "model_stream_exception",
    });
    expect(_recordedNestedOutcomes[0].abortSource).toBeUndefined();
    expect(
      coordinatorProcessEvents(emitted).some(
        (event) => event.data?.phase === "terminating",
      ),
    ).toBe(false);
    const persisted = (await readConversationMessages(cid)).find(
      (message) => message.from === AGENT_ID,
    );
    expect(persisted).toMatchObject({
      failure_kind: "model",
      failure_code: "model_stream_exception",
    });
    expect(String(persisted?.text || "")).toContain(
      "Model stream failed unexpectedly.",
    );
    expect(String(persisted?.text || "")).not.toContain(
      "forced direct stream rejection",
    );
    expect(String(persisted?.failure_code || "")).not.toMatch(/^coordinator_/);
  });

  it("preserves coordinator probe and terminating diagnostics within a saturated process-item cap", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    bus._setCoordinatorLeaseFactoryForTest((input: any) => ({
      observe(event: any) {
        if (event?.kind === "tool_start") {
          input.onProbe(300_000);
          input.onAbort("agent_idle", 480_000);
        }
      },
      stop() {},
    }));
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "saturate process diagnostics" },
      },
      { type: "final", text: "handled" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      ...Array.from({ length: 310 }, (_, index) => ({
        type: "progress",
        text: `ordinary-process-${index}`,
      })),
      {
        type: "event",
        event: {
          stream: "tool",
          data: { phase: "start", id: "cap-tool", name: "exec_command" },
        },
      },
      { type: "__wait_for_abort__" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise saturated coordinator diagnostics",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const persisted = (await readConversationMessages(cid)).find(
      (message) => message.failure_code === "coordinator_agent_idle",
    );
    expect(persisted).toBeTruthy();
    expect(persisted.process.length).toBeLessThanOrEqual(300);
    const coordinatorPhases = persisted.process
      .filter((item: any) => item?.event?.stream === "coordinator")
      .map((item: any) => item.event.data?.phase);
    expect(coordinatorPhases).toEqual(["probe", "terminating"]);
  });

  it.each([
    { first: "coordinator", second: "group", expected: "coordinator" },
    { first: "coordinator", second: "parent", expected: "coordinator" },
    { first: "group", second: "coordinator", expected: "group_abort" },
    { first: "parent", second: "coordinator", expected: "parent_abort" },
  ] as const)(
    "keeps the first nested abort source when $first abort races before $second",
    async ({ first, second, expected }) => {
      const cid = newCid();
      const state =
        await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      let fireCoordinatorAbort:
        | ((reason: "tool_idle" | "agent_idle", idleMs: number) => void)
        | undefined;
      let groupAbortPromise: Promise<void> | undefined;
      (bus as any)._setCoordinatorLeaseFactoryForTest((input: any) => {
        fireCoordinatorAbort = input.onAbort;
        return { observe() {}, stop() {} };
      });
      (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
        _recordedNestedOutcomes.push(outcome);
      });

      const usesParent = first === "parent" || second === "parent";
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: usesParent
            ? "__call_tool_parent_abort_controlled__"
            : "__call_tool__",
          name: "run_worker",
          input: { task: `${first} then ${second}` },
        },
        { type: "final", text: "race complete" },
      ]);
      _setScript("gworker-*", [
        {
          type: "__wait_for_abort__",
          afterAbort() {
            if (second === "coordinator") {
              fireCoordinatorAbort!("agent_idle", 480_000);
            } else if (second === "parent") {
              abortRaceProbe.parentController!.abort();
            } else {
              groupAbortPromise = bus.abort(TEST_UID, cid);
            }
          },
        },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise abort source ordering",
      });
      expect(
        await waitUntil(
          () =>
            typeof fireCoordinatorAbort === "function" &&
            (!usesParent || abortRaceProbe.parentController !== null),
          2000,
        ),
        "nested dispatch should expose both competing abort controls",
      ).toBe(true);

      if (first === "coordinator") {
        fireCoordinatorAbort!("agent_idle", 480_000);
      } else if (first === "parent") {
        abortRaceProbe.parentController!.abort();
      } else {
        groupAbortPromise = bus.abort(TEST_UID, cid);
      }

      await waitForQuiescent(TEST_UID, cid, 4000);
      await groupAbortPromise;

      expect(_recordedNestedOutcomes).toHaveLength(1);
      const outcome = _recordedNestedOutcomes[0];
      if (expected === "coordinator") {
        expect(outcome).toMatchObject({
          ok: false,
          failureCode: "coordinator_agent_idle",
          retryable: true,
          abortSource: "coordinator",
        });
        expect(outcome.payload).not.toContain("stopped by the user");
      } else {
        expect(outcome).toMatchObject({
          ok: false,
          failureCode: expected,
          retryable: false,
          abortSource: expected,
        });
      }
    },
  );

  it("retries the same named Agent once with canonical resume text and succeeds", async () => {
    const cid = newCid();
    const originalUserMessage = "please coordinate the requested work";
    const originalTask = "draft the architecture review";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const emitted: any[] = [];
    installFirstAttemptCoordinatorAbort(bus);
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: originalTask },
      },
      { type: "final", text: "commander completed" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "recovered result" },
    ]);

    bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: originalUserMessage,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const agentCalls = _recordedCalls.filter(
      (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    );
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1].message).toContain('<task-retry mode="resume">');
    expect(agentCalls[1].message).toContain(originalTask);
    expect(agentCalls[1].message).not.toBe(originalUserMessage);
    expect(_recordedNestedOutcomes.map((outcome) => outcome.actor.id)).toEqual([
      AGENT_ID,
      AGENT_ID,
    ]);
    expect(_recordedNestedOutcomes[1]).toMatchObject({
      ok: true,
      text: "recovered result",
    });
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toMatchObject([
      { attempt: 1, actor_id: AGENT_ID, status: "failed", failure_code: "coordinator_agent_idle" },
      { attempt: 2, actor_id: AGENT_ID, status: "completed" },
    ]);
    expect(coordinatorProcessEvents(emitted)).toContainEqual({
      stream: "coordinator",
      data: { phase: "retry", attempt: 2, actor_id: AGENT_ID },
    });
  });

  it("tells a same-Agent tool-idle retry to verify current state before repeating work", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    installFirstAttemptCoordinatorAbort(bus, "tool_idle");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "publish the reviewed release" },
      },
      { type: "final", text: "done" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "verified and completed" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "ship it" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const retryCall = _recordedCalls.filter(
      (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    )[1];
    expect(retryCall?.message).toContain('<task-retry mode="resume">');
    expect(retryCall?.message).toContain("Verify its current state before deciding whether to run it again");
  });


  // G-18/G-19（2026-08-25）：直连执行路径已删除，直连专属的 resume/
  // 会话持久化语义钉子随之移除——网关模式下会话连续性由 P3394 session
  // 与网关侧 cli-session（G-27 resume）承担；PID 数据源已由网关
  // hello/manifest 自报（extensions.pid / manifest.pid）。



  // G-18/G-19（2026-08-25）：直连会话写入顺序钉子随直连路径移除（网关
  // 模式会话连续性由 P3394 session 承担，见上方总注释）。


  // G-18/G-19（2026-08-25）：直连会话持久化失败钉子随直连路径移除（见上）。

  it("uses the highest-scoring idle member, then one anonymous worker, and returns coordinator_exhausted", async () => {
    const cid = newCid();
    const reviewerId = "c1c1c1c1c1c1";
    const reviewerName = "Reviewer";
    const lowId = "d2d2d2d2d2d2";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    await seedAgent({
      id: reviewerId,
      name: reviewerName,
      description: "architecture security review implementation",
      workflow: "review architecture security implementation",
    });
    await seedAgent({
      id: lowId,
      name: "Translator",
      description: "translate prose",
      workflow: "translate prose",
    });
    await addAgentMember(cid, reviewerId, reviewerName);
    await addAgentMember(cid, lowId, "Translator");
    installFirstAttemptCoordinatorAbort(bus);
    (bus as any)._setNestedDispatchOutcomeObserverForTest((outcome: any) => {
      _recordedNestedOutcomes.push(outcome);
    });
    const emitted: any[] = [];
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "review architecture security implementation" },
      },
      { type: "final", text: "handled exhaustion" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "error", text: "original retry failed" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, reviewerId), [
      { type: "error", text: "fallback failed" },
    ]);
    _setScript("gworker-*", [
      { type: "delta", text: "safe partial output" },
      { type: "error", text: "anonymous failed <raw>" },
    ]);

    bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "coordinate review" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const attemptOutcomes = _recordedNestedOutcomes.filter(
      (outcome) => outcome.failureCode !== "coordinator_exhausted",
    );
    expect(attemptOutcomes.map((outcome) => outcome.actor.kind === "worker" ? null : outcome.actor.id)).toEqual([
      AGENT_ID,
      AGENT_ID,
      reviewerId,
      null,
    ]);
    const finalOutcome = _recordedNestedOutcomes.at(-1);
    expect(finalOutcome).toMatchObject({
      ok: false,
      failureCode: "coordinator_exhausted",
      retryable: false,
      text: "safe partial output",
    });
    expect(finalOutcome.payload).toContain('failure_code="coordinator_exhausted"');
    expect(finalOutcome.payload).toContain("safe partial output");
    expect(finalOutcome.payload).not.toContain("anonymous failed");
    expect(finalOutcome.payload).not.toContain("&lt;raw&gt;");
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(4);
    expect(run?.steps[0]?.attempts?.map((attempt) => attempt.actor_id)).toEqual([
      AGENT_ID,
      AGENT_ID,
      reviewerId,
      null,
    ]);
    expect(run?.steps[0]?.attempts?.every((attempt) => attempt.status !== "running")).toBe(true);
    expect(coordinatorProcessEvents(emitted)).toEqual(expect.arrayContaining([
      { stream: "coordinator", data: { phase: "retry", attempt: 2, actor_id: AGENT_ID } },
      { stream: "coordinator", data: { phase: "fallback", attempt: 3, actor_id: reviewerId, actor_name: reviewerName } },
      { stream: "coordinator", data: { phase: "anonymous", attempt: 4 } },
      { stream: "coordinator", data: { phase: "returned", failure_code: "coordinator_exhausted" } },
    ]));
    const transitionLogs = loggerMocks.info.mock.calls
      .filter(([message]) => message === "coordinator transition")
      .map(([, data]) => data);
    expect(transitionLogs).toHaveLength(4);
    expect(JSON.stringify(transitionLogs)).not.toMatch(/review architecture|safe partial|anonymous failed|pid|write_scope|prompt|output/i);
  });

  it("runs one anonymous fallback when no named member is eligible", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    installFirstAttemptCoordinatorAbort(bus);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "perform isolated recovery" },
      },
      { type: "final", text: "done" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "error", text: "retry failed" },
    ]);
    _setScript("gworker-*", [{ type: "final", text: "anonymous recovered" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "recover" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(1);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts?.map((attempt) => attempt.actor_id)).toEqual([
      AGENT_ID,
      AGENT_ID,
      null,
    ]);
    expect(run?.steps[0]?.attempts?.at(-1)).toMatchObject({
      actor_kind: "anonymous_worker",
      status: "completed",
    });
  });


  it("returns to Commander when retry preparation fails before its run write", async () => {
    const cid = newCid();
    const secret = "SECRET_RETRY_PREPARE_PREWRITE";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    let injected = false;
    (collaboration as any)._setRetryPreparationBoundaryHookForTest?.(
      async (boundary: string) => {
        if (!injected && boundary === "run") {
          injected = true;
          throw new Error(secret);
        }
      },
    );
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "structured failure before retry" },
      },
      { type: "final", text: "returned to Commander" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "error", text: "structured first failure" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise retry preparation failure",
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(injected).toBe(true);
    expect(
      _recordedCalls.filter(
        (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
      ),
    ).toHaveLength(1);
    expect(
      _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
    ).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(1);
    expect(run?.steps[0]?.attempts?.[0].status).toBe("failed");
    expect(run?.steps[0]?.status).toBe("failed");
    const toolResult = _recordedToolResults.find(
      (result) => result.name === "run_worker",
    );
    expect(toolResult?.content).toContain("structured first failure");
    await expectNoLifecycleSecretLeak(cid, secret);
  });

  it.each([
    { source: "group", toolEvent: "__call_tool__" },
    { source: "parent", toolEvent: "__call_tool_parent_abort_controlled__" },
  ] as const)(
    "stops before retry preparation when a late $source abort follows a coordinator outcome",
    async ({ source, toolEvent }) => {
      const cid = newCid();
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      installFirstAttemptCoordinatorAbort(bus);
      let gateRan = false;
      let groupAbortPromise: Promise<void> | undefined;
      (bus as any)._setNestedDispatchAttemptHooksForTest({
        beforeRetry: async () => {
          gateRan = true;
          if (source === "group") {
            groupAbortPromise = bus.abort(TEST_UID, cid);
          } else {
            abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
          }
        },
      });
      const emitted: any[] = [];
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: toolEvent,
          name: "run_worker",
          input: { to: AGENT_NAME, task: "late abort race" },
        },
        { type: "final", text: "handled late abort" },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: "__wait_for_abort__" },
      ]);

      bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise late abort",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
      await groupAbortPromise;

      expect(gateRan).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(1);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      expect(run?.steps[0]?.attempts).toHaveLength(1);
      expect(run?.steps[0]?.attempts?.[0]).toMatchObject({
        status: "failed",
        failure_code: "coordinator_agent_idle",
      });
      expect(
        coordinatorProcessEvents(emitted).filter(
          (event) =>
            event.data?.phase === "retry" ||
            event.data?.phase === "fallback" ||
            event.data?.phase === "anonymous",
        ),
      ).toHaveLength(0);
    },
  );


  it.each([
    { source: "group", toolEvent: "__call_tool__" },
    { source: "parent", toolEvent: "__call_tool_parent_abort_controlled__" },
  ] as const)(
    "terminalizes the prepared step when $source abort arrives after retry preparation",
    async ({ source, toolEvent }) => {
      const cid = newCid();
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      installFirstAttemptCoordinatorAbort(bus);
      let hookRan = false;
      let groupAbortPromise: Promise<void> | undefined;
      (bus as any)._setNestedDispatchAttemptHooksForTest({
        afterRetryPreparation: async () => {
          hookRan = true;
          if (source === "group") {
            groupAbortPromise = bus.abort(TEST_UID, cid);
          } else {
            abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
          }
        },
      });
      const emitted: any[] = [];
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: toolEvent,
          name: "run_worker",
          input: { to: AGENT_NAME, task: "abort after retry preparation" },
        },
        { type: "final", text: "returned after late abort" },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: "__wait_for_abort__" },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: "final", text: "must not retry" },
      ]);

      bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise post-preparation abort",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
      await groupAbortPromise;

      expect(hookRan).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(1);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const step = run?.steps[0];
      expect(step?.attempts).toHaveLength(1);
      expect(step?.attempts?.[0]).toMatchObject({
        status: "failed",
        failure_code: "coordinator_agent_idle",
      });
      expect(step?.status).toBe("skipped");
      expect(step?.completed_at).toBeTruthy();
      const events = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        events.filter(
          (event) =>
            event.type === "step_completed" && event.step_id === step?.id,
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === "gate_recorded" && event.step_id === step?.id,
        ),
      ).toHaveLength(1);
      await expect(
        collaboration.prepareNestedDispatchStep(TEST_UID, cid, {
          objective: "resume must stay closed",
          actor_id: AGENT_ID,
          actor_name: AGENT_NAME,
          actor_kind: "agent",
          source_tool: "run_worker",
          task: "abort after retry preparation",
          resume_step_id: step?.id,
          resume_token: step?.resume_token,
        }),
      ).rejects.toThrow(/cannot be reused/);
      expect(
        coordinatorProcessEvents(emitted).filter(
          (event) =>
            event.data?.phase === "retry" ||
            event.data?.phase === "fallback" ||
            event.data?.phase === "anonymous",
        ),
      ).toHaveLength(0);
    },
  );

  it.each([
    { source: "group", toolEvent: "__call_tool__" },
    { source: "parent", toolEvent: "__call_tool_parent_abort_controlled__" },
  ] as const)("stops recovery immediately on $source abort without starting fallback", async ({ source, toolEvent }) => {
    const cid = newCid();
    const fallbackId = "e3e3e3e3e3e3";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    await seedAgent({
      id: fallbackId,
      name: "Fallback",
      description: "recover review architecture implementation",
      workflow: "recover review architecture implementation",
    });
    await addAgentMember(cid, fallbackId, "Fallback");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: toolEvent,
        name: "run_worker",
        input: { to: AGENT_NAME, task: "recover review architecture implementation" },
      },
      { type: "final", text: "aborted" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    const enqueuePromise = bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "stop recovery" });
    expect(await waitUntil(() => _recordedCalls.some(
      (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    ), 2000)).toBe(true);
    if (source === "group") await bus.abort(TEST_UID, cid);
    else abortRaceProbe.parentController!.abort();
    await enqueuePromise;
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, fallbackId))).toHaveLength(0);
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(1);
    expect(run?.steps[0]?.attempts?.[0]).toMatchObject({ status: "cancelled" });
    expect(run?.steps[0]?.attempts?.[0]).not.toHaveProperty("failure_code");
  });

  it("treats an initial anonymous run_worker as the final tier and settles unexpected throws", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    _setScript(state.buildGconvSessionId(cid), [
      { type: "__call_tool__", name: "run_worker", input: { task: "anonymous final tier" } },
      { type: "final", text: "handled" },
    ]);
    _setScript("gworker-*", [
      { type: "__throw__", message: "unexpected anonymous throw" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "delegate once" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(1);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(1);
    expect(run?.steps[0]?.attempts?.[0]).toMatchObject({
      actor_id: null,
      actor_kind: "anonymous_worker",
      status: "failed",
      failure_code: "runtime_failed",
    });
    expect(run?.steps[0]?.attempts?.[0].status).not.toBe("running");
  });

  it.each(["named", "anonymous"] as const)(
    "reconciles a durable running $s attempt when begin audit append throws",
    async (pathKind) => {
      const cid = newCid();
      const secret = "SECRET_BEGIN_AUDIT_FAILURE";
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      let failed = false;
      (collaboration as any)._setWorkflowAttemptAuditBeforeAppendForTest(
        async (type: string) => {
          if (!failed && type === "step_attempt_started") {
            failed = true;
            throw new Error(secret);
          }
        },
      );
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: "run_worker",
          input:
            pathKind === "named"
              ? { to: AGENT_NAME, task: "begin lifecycle fault" }
              : { task: "begin lifecycle fault" },
        },
        { type: "final", text: "handled lifecycle failure" },
      ]);
      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise begin lifecycle failure",
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      expect(failed).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) =>
            call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(0);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const attempts = run?.steps[0]?.attempts || [];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        actor_id: pathKind === "named" ? AGENT_ID : null,
        actor_kind: pathKind === "named" ? "agent" : "anonymous_worker",
        status: "failed",
        failure_code: "runtime_failed",
      });
      expect(attempts.every((attempt) => attempt.status !== "running")).toBe(
        true,
      );
      const auditEvents = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_started"),
      ).toHaveLength(attempts.length);
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_finished"),
      ).toHaveLength(attempts.length);
      const toolResult = _recordedToolResults.find(
        (result) => result.name === "run_worker",
      );
      expect(toolResult?.content).toContain('failure_code="runtime_failed"');
      await expectNoLifecycleSecretLeak(cid, secret);
    },
  );

  it("does not invent an attempt when begin fails before durability", async () => {
    const cid = newCid();
    const secret = "SECRET_BEGIN_BEFORE_DURABILITY";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    let injected = false;
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      begin: async () => {
        injected = true;
        throw new Error(secret);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "unrecoverable begin fault" },
      },
      { type: "final", text: "handled lifecycle failure" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise unrecoverable begin failure",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(injected).toBe(true);
    expect(
      _recordedCalls.filter(
        (call) => call.sid !== state.buildGconvSessionId(cid),
      ),
    ).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts || []).toHaveLength(0);
    const auditEvents = await collaboration.readCollaborationEvents(
      TEST_UID,
      cid,
      0,
    );
    expect(
      auditEvents.filter(
        (event) =>
          event.type === "step_attempt_started" ||
          event.type === "step_attempt_finished",
      ),
    ).toHaveLength(0);
    const toolResult = _recordedToolResults.find(
      (result) => result.name === "run_worker",
    );
    expect(toolResult?.content).toContain('failure_code="runtime_failed"');
    expect(toolResult?.content).toContain("Nested dispatch lifecycle failed.");
    await expectNoLifecycleSecretLeak(cid, secret);
  });


  it.each([
    { pathKind: "named", source: "group" },
    { pathKind: "anonymous", source: "group" },
    { pathKind: "named", source: "parent" },
    { pathKind: "anonymous", source: "parent" },
  ] as const)(
    "cancels the durable $pathKind attempt when $source abort arrives during begin",
    async ({ pathKind, source }) => {
      const cid = newCid();
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      const emitted: any[] = [];
      let beginCompleted = false;
      let groupAbortPromise: Promise<void> | undefined;
      (bus as any)._setNestedDispatchAttemptHooksForTest({
        begin: async (
          ...args: Parameters<
            typeof collaboration.beginWorkflowStepAttempt
          >
        ) => {
          const row = await collaboration.beginWorkflowStepAttempt(...args);
          beginCompleted = true;
          if (source === "group") {
            groupAbortPromise = bus.abort(TEST_UID, cid);
          } else {
            abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
          }
          return row;
        },
      });
      _setScript(state.buildGconvSessionId(cid), [
        {
          type:
            source === "parent"
              ? "__call_tool_parent_abort_controlled__"
              : "__call_tool__",
          name: "run_worker",
          input:
            pathKind === "named"
              ? { to: AGENT_NAME, task: "abort after durable begin" }
              : { task: "abort after durable begin" },
        },
        { type: "final", text: "handled post-begin abort" },
      ]);

      bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise post-begin abort",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
      await groupAbortPromise;

      expect(beginCompleted).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) =>
            call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(0);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const step = run?.steps[0];
      expect(step?.attempts).toHaveLength(1);
      expect(step?.attempts?.[0]).toMatchObject({
        actor_id: pathKind === "named" ? AGENT_ID : null,
        actor_kind: pathKind === "named" ? "agent" : "anonymous_worker",
        status: "cancelled",
      });
      expect(step?.attempts?.[0]).not.toHaveProperty("failure_code");
      expect(step?.status).toBe("skipped");
      expect(step?.completed_at).toBeTruthy();
      const auditEvents = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_started"),
      ).toHaveLength(1);
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_finished"),
      ).toHaveLength(1);
      expect(
        auditEvents.filter(
          (event) =>
            event.type === "step_completed" && event.step_id === step?.id,
        ),
      ).toHaveLength(1);
      expect(
        auditEvents.filter(
          (event) =>
            event.type === "gate_recorded" && event.step_id === step?.id,
        ),
      ).toHaveLength(1);
      await expect(
        collaboration.prepareNestedDispatchStep(TEST_UID, cid, {
          objective: "resume must stay closed",
          actor_id: pathKind === "named" ? AGENT_ID : null,
          actor_name: pathKind === "named" ? AGENT_NAME : "Worker",
          actor_kind: pathKind === "named" ? "agent" : "anonymous_worker",
          source_tool: "run_worker",
          task: "abort after durable begin",
          resume_step_id: step?.id,
          resume_token: step?.resume_token,
        }),
      ).rejects.toThrow(/cannot be reused/);
      expect(
        coordinatorProcessEvents(emitted).filter(
          (event) =>
            event.data?.phase === "retry" ||
            event.data?.phase === "fallback" ||
            event.data?.phase === "anonymous",
        ),
      ).toHaveLength(0);
      const toolResult = _recordedToolResults.find(
        (result) => result.name === "run_worker",
      );
      expect(toolResult?.content).toContain(
        `failure_code="${source === "group" ? "group_abort" : "parent_abort"}"`,
      );
      expect(toolResult?.content).toContain('retryable="false"');
    },
  );

  it("redacts raw abort-settlement errors after durable begin", async () => {
    const cid = newCid();
    const secret =
      "SECRET_POST_BEGIN_SETTLEMENT /Users/private/abort-token.json token=raw";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      begin: async (
        ...args: Parameters<typeof collaboration.beginWorkflowStepAttempt>
      ) => {
        const row = await collaboration.beginWorkflowStepAttempt(...args);
        abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
        return row;
      },
      settleAbort: async () => {
        throw new Error(secret);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool_parent_abort_controlled__",
        name: "run_worker",
        input: { task: "force post-begin settlement failure" },
      },
      { type: "final", text: "handled settlement failure" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise post-begin settlement privacy",
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const stepId = run?.steps[0]?.id || "";
    const logs = JSON.stringify([
      loggerMocks.debug.mock.calls,
      loggerMocks.info.mock.calls,
      loggerMocks.warn.mock.calls,
      loggerMocks.error.mock.calls,
    ]);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("SECRET_POST_BEGIN_SETTLEMENT");
    expect(logs).not.toContain("/Users/private/abort-token.json");
    expect(logs).not.toContain("token=raw");
    const warnings = loggerMocks.warn.mock.calls.filter(
      ([message]) => message === "nested abort settlement failed",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({
      phase: "after_durable_begin",
      failure_code: "abort_settlement_failed",
      error: expect.objectContaining({
        message: "Nested abort settlement failed.",
      }),
    });
    expect(warnings[0]?.[1]?.cid).not.toBe(cid);
    expect(warnings[0]?.[1]?.step_id).not.toBe(stepId);
  });

  it("redacts raw abort-settlement errors after retry preparation", async () => {
    const cid = newCid();
    const secret =
      "SECRET_POST_PREPARATION_SETTLEMENT /Users/private/retry-token.json token=raw";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    installFirstAttemptCoordinatorAbort(bus);
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      afterRetryPreparation: async () => {
        abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
      },
      settleAbort: async () => {
        throw new Error(secret);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool_parent_abort_controlled__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "force retry settlement failure" },
      },
      { type: "final", text: "handled retry settlement failure" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise post-preparation settlement privacy",
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const stepId = run?.steps[0]?.id || "";
    const logs = JSON.stringify([
      loggerMocks.debug.mock.calls,
      loggerMocks.info.mock.calls,
      loggerMocks.warn.mock.calls,
      loggerMocks.error.mock.calls,
    ]);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("SECRET_POST_PREPARATION_SETTLEMENT");
    expect(logs).not.toContain("/Users/private/retry-token.json");
    expect(logs).not.toContain("token=raw");
    const warnings = loggerMocks.warn.mock.calls.filter(
      ([message]) => message === "nested abort settlement failed",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({
      phase: "after_retry_preparation",
      failure_code: "abort_settlement_failed",
      error: expect.objectContaining({
        message: "Nested abort settlement failed.",
      }),
    });
    expect(warnings[0]?.[1]?.cid).not.toBe(cid);
    expect(warnings[0]?.[1]?.step_id).not.toBe(stepId);
  });

  it("sanitizes named-member storage failure and stops before model dispatch", async () => {
    const cid = newCid();
    const secret =
      "SECRET_MEMBER_STORAGE /Users/private/member-token.json token=raw";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const emitted: any[] = [];
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      ensureMember: async () => {
        throw new Error(secret);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "prepare named member" },
      },
      { type: "final", text: "handled member infrastructure failure" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "must not run" },
    ]);

    bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "exercise member storage failure",
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(
      _recordedCalls.filter(
        (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
      ),
    ).toHaveLength(0);
    expect(
      _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
    ).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(1);
    expect(run?.steps[0]?.attempts?.[0]).toMatchObject({
      actor_id: AGENT_ID,
      actor_kind: "agent",
      status: "failed",
      failure_code: "runtime_failed",
    });
    const toolResult = _recordedToolResults.find(
      (result) => result.name === "run_worker",
    );
    expect(toolResult?.content).toContain(
      'failure_code="nested_member_storage_failed"',
    );
    expect(toolResult?.content).toContain(
      "Named Agent membership could not be prepared safely.",
    );
    expect(JSON.stringify(emitted)).not.toContain(secret);
    const memberFailureLogs = loggerMocks.warn.mock.calls.filter(
      ([message]) => message === "nested dispatch member preparation failed",
    );
    expect(memberFailureLogs).toHaveLength(1);
    expect(memberFailureLogs[0]?.[1]).toMatchObject({
      phase: "member_prepare",
      failure_code: "nested_member_storage_failed",
    });
    expect(memberFailureLogs[0]?.[1]?.cid).not.toBe(cid);
    expect(memberFailureLogs[0]?.[1]?.actor_id).not.toBe(AGENT_ID);
    await expectNoLifecycleSecretLeak(cid, secret);
  });

  it.each(["named", "anonymous"] as const)(
    "settles a $s attempt when runNestedDispatch throws after begin",
    async (pathKind) => {
      const cid = newCid();
      const secret = "SECRET_EXECUTE_THROW";
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      let injected = false;
      (bus as any)._setNestedDispatchAttemptHooksForTest({
        execute: async () => {
          injected = true;
          throw new Error(secret);
        },
      });
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: "run_worker",
          input:
            pathKind === "named"
              ? { to: AGENT_NAME, task: "execute lifecycle fault" }
              : { task: "execute lifecycle fault" },
        },
        { type: "final", text: "handled lifecycle failure" },
      ]);
      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise execute lifecycle failure",
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      expect(injected).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) =>
            call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(0);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const attempts = run?.steps[0]?.attempts || [];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        actor_id: pathKind === "named" ? AGENT_ID : null,
        actor_kind: pathKind === "named" ? "agent" : "anonymous_worker",
        status: "failed",
        failure_code: "runtime_failed",
      });
      expect(attempts.every((attempt) => attempt.status !== "running")).toBe(
        true,
      );
      const auditEvents = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_started"),
      ).toHaveLength(attempts.length);
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_finished"),
      ).toHaveLength(attempts.length);
      const toolResult = _recordedToolResults.find(
        (result) => result.name === "run_worker",
      );
      expect(toolResult?.content).toContain('failure_code="runtime_failed"');
      await expectNoLifecycleSecretLeak(cid, secret);
    },
  );

  it.each([
    { pathKind: "named", terminal: "completed" },
    { pathKind: "anonymous", terminal: "completed" },
    { pathKind: "named", terminal: "failed" },
    { pathKind: "anonymous", terminal: "failed" },
  ] as const)(
    "does not duplicate or overwrite a durable $terminal $pathKind attempt when finish throws",
    async ({ pathKind, terminal }) => {
      const cid = newCid();
      const secret = `SECRET_FINISH_${terminal.toUpperCase()}_THROW`;
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      let injected = false;
      (bus as any)._setNestedDispatchAttemptHooksForTest({
        finish: async (
          ...args: Parameters<
            typeof collaboration.finishWorkflowStepAttempt
          >
        ) => {
          const row = await collaboration.finishWorkflowStepAttempt(...args);
          if (!injected) {
            injected = true;
            throw new Error(secret);
          }
          return row;
        },
      });
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: "run_worker",
          input:
            pathKind === "named"
              ? { to: AGENT_NAME, task: "finish lifecycle fault" }
              : { task: "finish lifecycle fault" },
        },
        { type: "final", text: "handled lifecycle failure" },
      ]);
      const nestedEvents =
        terminal === "completed"
          ? [{ type: "final", text: "durable success" }]
          : [{ type: "error", text: "expected nested failure" }];
      if (pathKind === "named") {
        _setScript(
          state.buildGmemberSessionId(cid, AGENT_ID),
          nestedEvents,
        );
      } else {
        _setScript("gworker-*", nestedEvents);
      }

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise finish lifecycle failure",
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      expect(injected).toBe(true);
      expect(
        _recordedCalls.filter(
          (call) =>
            call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
        ),
      ).toHaveLength(pathKind === "named" ? 1 : 0);
      expect(
        _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
      ).toHaveLength(pathKind === "anonymous" ? 1 : 0);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const attempts = run?.steps[0]?.attempts || [];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt: 1,
        actor_id: pathKind === "named" ? AGENT_ID : null,
        actor_kind: pathKind === "named" ? "agent" : "anonymous_worker",
        status: terminal,
        ...(terminal === "failed"
          ? { failure_code: "runtime_failed" }
          : {}),
      });
      expect(attempts.every((attempt) => attempt.status !== "running")).toBe(
        true,
      );
      const auditEvents = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_started"),
      ).toHaveLength(attempts.length);
      expect(
        auditEvents.filter((event) => event.type === "step_attempt_finished"),
      ).toHaveLength(attempts.length);
      const toolResult = _recordedToolResults.find(
        (result) => result.name === "run_worker",
      );
      if (terminal === "completed") {
        expect(toolResult?.content).toContain("durable success");
        expect(toolResult?.content).not.toContain(
          'failure_code="runtime_failed"',
        );
      } else {
        expect(toolResult?.content).toContain("expected nested failure");
        expect(toolResult?.content).toContain(
          `failure_code="${
            pathKind === "named"
              ? "model_stream_error"
              : "nested_worker_error"
          }"`,
        );
      }
      await expectNoLifecycleSecretLeak(cid, secret);
    },
  );


  it("sanitizes an unclassified nested exception and does not recover it", async () => {
    const cid = newCid();
    const secret =
      "SECRET_NESTED_THROW /Users/private/token.txt api_token=raw-secret";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const emitted: any[] = [];
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { to: AGENT_NAME, task: "throw before nested body" },
      },
      { type: "final", text: "handled sanitized failure" },
    ]);
    bus._setActorTurnPreBodyHookForTest(async (_runtime, actor) => {
      if (actor.id === AGENT_ID) throw new Error(secret);
    });

    try {
      bus.subscribe(TEST_UID, cid, (event) => emitted.push(event));
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise nested exception privacy",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
    }

    expect(
      _recordedCalls.filter(
        (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
      ),
    ).toHaveLength(0);
    expect(
      _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
    ).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.attempts).toHaveLength(1);
    expect(run?.steps[0]?.attempts?.[0]).toMatchObject({
      status: "failed",
      failure_code: "runtime_failed",
    });
    const toolResult = _recordedToolResults.find(
      (result) => result.name === "run_worker",
    );
    expect(toolResult?.content).toContain(
      'failure_code="nested_dispatch_error"',
    );
    expect(toolResult?.content).toContain(
      "Nested dispatch failed unexpectedly.",
    );
    expect(JSON.stringify(emitted)).not.toContain(secret);
    await expectNoLifecycleSecretLeak(cid, secret);
  });

  it("dispatch_to (named) runs the agent IN-PROCESS, keeps the agent's visible bubble, and the commander synthesises (Option B) — no re-wake", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const AGENT_REPLY =
      "AGENT-DRAFT-9f2a: here is the full draft the user asked for.";

    // Commander's SINGLE turn: dispatch_to the named agent, then synthesise in
    // the SAME turn — the agent's result returns as the tool result (handback),
    // so there is no second scheduled commander turn.
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "draft the thing" },
      },
      { type: "final", text: "Synthesised: the draft is ready." },
    ]);
    // The dispatched agent's in-process turn (its own persistent gmember session).
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "make me a draft",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The agent ran in-process (its gmember session turn fired).
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    expect(
      _recordedCalls.some((c) => c.sid === agentSid),
      "the dispatched agent should run in-process",
    ).toBe(true);

    // 2) Its FULL result came back synchronously as the dispatch_to tool result.
    const toolResult = _recordedToolResults.find(
      (r) => r.name === "dispatch_to",
    );
    expect(
      toolResult,
      "dispatch_to should return its result synchronously",
    ).toBeTruthy();
    expect(toolResult!.content).toContain("<worker-result");
    expect(toolResult!.content).toContain(AGENT_REPLY);
    expect(
      toolResult!.executionMode,
      "dispatch_to must be G4-parallel-safe",
    ).toBe("parallel");

    // 3) The agent was auto-added to the roster (so its bubble has attribution).
    const members = await state.readMembers(TEST_UID, cid);
    expect(
      members.actors.some((a) => a.id === AGENT_ID && a.kind === "agent"),
    ).toBe(true);

    // 4) Option B — BOTH bubbles persist: the agent's own reply AND the
    //    commander's synthesis.
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.from === AGENT_ID && String(m.text || "").includes(AGENT_REPLY),
      ),
      "the agent should keep its own visible bubble",
    ).toBe(true);
    expect(
      lines.some((m: any) =>
        String(m.text || "").includes("the draft is ready"),
      ),
      "the commander should persist its synthesis",
    ).toBe(true);

    // 5) Exactly ONE commander turn — the handback was in-process, not a re-wake.
    const commanderTurns = _recordedCalls.filter(
      (c) => c.sid === state.buildGconvSessionId(cid),
    ).length;
    expect(
      commanderTurns,
      "commander should run exactly one turn (no re-wake)",
    ).toBe(1);
  }, 12_000);

  it("dispatch_to with kstar=required injects the Commander expectation into the Agent turn", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const AGENT_REPLY = "KSTAR-AGENT-DRAFT: 完成论文初稿并保存 draft.md";
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "根据研究报告写论文初稿",
          kstar: "required",
          kstar_reason: "论文初稿是用户可审阅交付物",
          kstar_expectation: {
            situation: "已有 DeepResearcher 研究报告",
            task: "根据研究报告写论文初稿",
            action_hat: "生成论文初稿文件并说明结构",
            result_hat: "得到可审阅论文初稿",
          },
        },
      },
      { type: "final", text: "我会等你验收初稿。" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "写论文初稿",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const agentCall = _recordedCalls.find(
      (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    );
    expect(agentCall?.message).toContain("<agent-task-introduction>");
    expect(agentCall?.message).toContain("根据研究报告写论文初稿");
    expect(agentCall?.message).toContain("得到可审阅论文初稿");
    expect(agentCall?.message).toContain("生成论文初稿文件并说明结构");
    expect(agentCall?.message).toContain("先用自然语言说明你理解的任务、预期结果和执行计划");


  }, 12_000);

  it("dispatch_to with kstar=skip keeps lightweight agent replies outside Review Gate", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const AGENT_REPLY = "LIGHTWEIGHT-EXPLAIN: 这是一个简单解释。";
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "简单解释这个概念",
          kstar: "skip",
          kstar_reason: "轻量解释，无持久交付物",
        },
      },
      { type: "final", text: "解释完成。" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "解释一下",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const agentCall = _recordedCalls.find(
      (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    );
    expect(agentCall?.message).not.toContain('<agent-task-introduction>');
    expect(agentCall?.message).not.toContain('预期结果');
  }, 12_000);

  it("dispatch_to can fan out to multiple named agents in one commander turn and keep both visible replies", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const paths = await import("../../../../src/main/paths");
    const otherId = "a1a2a3a4a5a6";
    const otherName = "Reviewer";
    const otherDir = paths.agentDir(TEST_UID, otherId);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, "agent.json"),
      JSON.stringify({
        agent_id: otherId,
        name: otherName,
        description: "Reviews things",
        workflow: "review",
        created_at: "t",
        updated_at: "t",
      }),
    );

    const WRITER_REPLY = "WRITER-FANOUT-31a2: draft is ready.";
    const REVIEWER_REPLY = "REVIEWER-FANOUT-41b3: checklist is ready.";
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: [
          {
            name: "dispatch_to",
            input: { to: AGENT_NAME, message: "draft the copy", access_mode: "read" },
          },
          {
            name: "dispatch_to",
            input: { to: otherName, message: "review the copy", access_mode: "read" },
          },
        ],
      },
      {
        type: "final",
        text: "Both agents responded; here is the combined handoff.",
      },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: WRITER_REPLY },
    ]);
    _setScript(state.buildGmemberSessionId(cid, otherId), [
      { type: "final", text: REVIEWER_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "prepare and review this draft",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const collaborationRun = await collaboration.readActiveWorkflowRun(
      TEST_UID,
      cid,
    );
    expect(collaborationRun?.steps).toHaveLength(2);
    expect(new Set(collaborationRun?.steps.map((step) => step.id)).size).toBe(
      2,
    );
    expect(
      new Set(collaborationRun?.steps.map((step) => step.run_id)).size,
    ).toBe(1);

    const dispatchResults = _recordedToolResults.filter(
      (r) => r.name === "dispatch_to",
    );
    expect(
      dispatchResults,
      "both dispatch_to calls should synchronously return worker results",
    ).toHaveLength(2);
    expect(dispatchResults.map((result) => result.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(WRITER_REPLY),
        expect.stringContaining(REVIEWER_REPLY),
      ]),
    );
    expect(
      dispatchResults.every((r) => r.executionMode === "parallel"),
      "dispatch_to must stay parallel-safe",
    ).toBe(true);

    const members = await state.readMembers(TEST_UID, cid);
    expect(
      members.actors.some((a) => a.id === AGENT_ID && a.kind === "agent"),
    ).toBe(true);
    expect(
      members.actors.some((a) => a.id === otherId && a.kind === "agent"),
    ).toBe(true);

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.from === AGENT_ID && String(m.text || "").includes(WRITER_REPLY),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (m: any) =>
          m.from === otherId && String(m.text || "").includes(REVIEWER_REPLY),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (m: any) =>
          m.from === "commander" &&
          String(m.text || "").includes("combined handoff"),
      ),
    ).toBe(true);
  }, 12_000);

  // Entry 2 (G8d §1 / step 5): the user can talk to an agent directly — a user
  // message addressed to an agent runs that agent's top-level turn and the agent
  // delivers to the user, without the commander in the loop. This is runtime
  // routing (router default: user→commander, but an explicit @agent → that
  // agent), not a commander tool.
  it("user → agent direct (entry 2): a user @-addressed message runs the agent's top-level turn, the agent answers the user, and the commander never runs", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const AGENT_REPLY =
      "DIRECT-AGENT-REPLY-3c8e: delivered straight to you, no commander involved.";
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    // User addresses the agent directly (entry 2).
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} handle this yourself`,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The agent ran a top-level turn (its persistent gmember session).
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    expect(
      _recordedCalls.some((c) => c.sid === agentSid),
      "the agent should run a top-level turn",
    ).toBe(true);
    // 2) The agent answered the USER directly — its reply is a visible bubble.
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.from === AGENT_ID && String(m.text || "").includes(AGENT_REPLY),
      ),
      "the agent should post a visible reply to the user",
    ).toBe(true);

    // 3) The commander was NEVER involved — entry 2 bypasses it.
    const commanderSid = state.buildGconvSessionId(cid);
    expect(
      _recordedCalls.some((c) => c.sid === commanderSid),
      "the commander must not run for a direct user→agent message",
    ).toBe(false);

    // 4) The agent auto-joined the roster (so its bubble has attribution).
    const members = await state.readMembers(TEST_UID, cid);
    expect(
      members.actors.some((a) => a.id === AGENT_ID && a.kind === "agent"),
    ).toBe(true);
  }, 12_000);

  // Commander loop bubbles: a turn that dispatches a VISIBLE agent is split at
  // the dispatch boundary — pre-dispatch reasoning persists as its own `seg`
  // bubble, the agent's reply lands after it, and the post-handback synthesis is
  // a fresh `seg` bubble (so the loop reads correctly live AND on reload).
  it("commander loop bubbles: a visible dispatch splits the turn into seg bubbles ordered around the agent", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const PRE = "Running the writer to draft this for you.";
    const SYN = "Based on the draft, here is my summary.";
    const AGENT_REPLY = "AGENT-SEG-7b1c: the full draft body.";

    _setScript(state.buildGconvSessionId(cid), [
      { type: "delta", text: PRE },
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "draft it" },
      },
      { type: "delta", text: SYN },
      { type: "final", text: SYN },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "make me a draft",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const segs = lines
      .filter((m: any) => m.from === "commander" && m.seg !== undefined)
      .sort((a: any, b: any) => a.seg - b.seg);
    expect(
      segs.length,
      "commander turn should split into two seg bubbles",
    ).toBe(2);
    expect(segs[0].seg).toBe(0);
    expect(segs[0].text).toContain(PRE);
    expect(segs[1].seg).toBe(1);
    expect(segs[1].text).toContain(SYN);
    // The synthesis segment must NOT duplicate the pre-dispatch text on reload.
    expect(segs[1].text).not.toContain(PRE);

    // Persisted (= reload) order: pre-dispatch seg → agent bubble → synthesis seg.
    const agentMsg = lines.find(
      (m: any) =>
        m.from === AGENT_ID && String(m.text || "").includes(AGENT_REPLY),
    );
    expect(agentMsg, "agent bubble should persist").toBeTruthy();
    expect(lines.indexOf(segs[0])).toBeLessThan(lines.indexOf(agentMsg));
    expect(lines.indexOf(agentMsg)).toBeLessThan(lines.indexOf(segs[1]));
  }, 12_000);

  // The inverse: an anonymous worker is the commander's invisible hands, so the
  // turn must NOT segment (no second bubble with nothing visible between).
  it("commander loop bubbles: an anonymous run_worker does NOT split the commander bubble", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    _setScript(state.buildGconvSessionId(cid), [
      { type: "delta", text: "Let me scan that." },
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "scan the workspace" },
      },
      { type: "delta", text: " Done — nothing notable." },
      { type: "final", text: "Let me scan that. Done — nothing notable." },
    ]);
    _setScript("gworker-*", [
      { type: "final", text: "worker scanned: empty." },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "scan it",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const commanderMsgs = lines.filter((m: any) => m.from === "commander" && !m.recall_projection_card);
    expect(
      commanderMsgs.length,
      "anonymous worker turn stays a single commander bubble",
    ).toBe(1);
    expect(
      commanderMsgs[0].seg,
      "no seg marker when nothing visible was dispatched",
    ).toBeUndefined();
  }, 12_000);

  // hand_off_to an INTERACTIVE agent: the agent answers the user, the commander
  // does NOT synthesize (no second commander bubble), and the floor moves to the
  // agent so the user's next no-@ message routes to it.
  it("hand_off_to interactive agent: agent answers user, commander does not synthesize, floor moves to agent", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    // Seed an interactive tutor agent.
    const tutorId = "cafe12345678";
    const tutorName = "LearningTutor";
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(
      path.join(tutorDir, "agent.json"),
      JSON.stringify({
        agent_id: tutorId,
        name: tutorName,
        description: "teaches",
        workflow: "teach",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    const TUTOR_REPLY =
      "TUTOR-7a2b: Lesson 1 — let us start with the core idea.";
    // Commander: narrate prep, then hand_off_to the tutor (terminal — NO synthesis script entry).
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "delta",
        text: "I prepared the material; handing you to the tutor.",
      },
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: tutorName, message: "teach the user this paper" },
      },
      {
        type: "final",
        text: "I prepared the material; handing you to the tutor.",
      },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: "final", text: TUTOR_REPLY },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "teach me this paper",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // The tutor answered the user directly.
    expect(
      lines.some(
        (m: any) =>
          m.from === tutorId && String(m.text || "").includes(TUTOR_REPLY),
      ),
      "tutor should post a visible reply to the user",
    ).toBe(true);

    // Gap-B "thinking placeholder" signal: the hand-off runs the tutor's turn
    // in-process (bypassing runTurn's start-of-turn state_changed), so without
    // surfacing it the renderer had nothing to paint between the commander's
    // narration and the tutor's first token. The nested dispatch must emit a
    // state_changed listing the tutor in `active_turns` — and the suspended
    // commander must be EXCLUDED from that same event (else the renderer seeds a
    // stray empty commander bubble above the tutor's reply).
    const tutorActive = events.filter(
      (e) =>
        e.type === "state_changed" &&
        Array.isArray(e.active_turns) &&
        e.active_turns.some((t: any) => t.actor === tutorId),
    );
    expect(
      tutorActive.length,
      "tutor must surface in active_turns for the thinking placeholder",
    ).toBeGreaterThan(0);
    expect(
      tutorActive.every((e: any) =>
        e.active_turns
          .filter((t: any) => t.actor === tutorId)
          .every(
            (t: any) => Number.isFinite(t.started_at_ms) && t.started_at_ms > 0,
          ),
      ),
      "nested active turns must expose a stable execution start for elapsed-time recovery",
    ).toBe(true);
    expect(
      tutorActive.every(
        (e: any) => !e.active_turns.some((t: any) => t.actor === "commander"),
      ),
      "the suspended commander must not co-appear in active_turns while the tutor runs",
    ).toBe(true);
    // Commander narrated its prep but did NOT synthesize on top (no "已完成"-style
    // second bubble). The only commander message is the pre-handoff narration —
    // and it must be NON-EMPTY: a trailing empty commander bubble (e.g. one that
    // only carried a produced-file chip) is the regression we are guarding.
    const commanderMsgs = lines.filter((m: any) => m.from === "commander" && !m.recall_projection_card);
    expect(
      commanderMsgs.length,
      "commander must not synthesize after hand-off",
    ).toBeLessThanOrEqual(1);
    expect(
      commanderMsgs.every((m: any) => String(m.text || "").trim().length > 0),
      "no empty trailing commander bubble after hand-off",
    ).toBe(true);
    // The floor moved to the tutor.
    const st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBe(tutorId);

    // A follow-up no-@ user message now routes to the tutor (not the commander).
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: "final", text: "TUTOR-followup: good question about part 2." },
    ]);
    const commanderCallsBefore = _recordedCalls.filter(
      (c) => c.sid === state.buildGconvSessionId(cid),
    ).length;
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "I did not get part 2",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const tutorSid = state.buildGmemberSessionId(cid, tutorId);
    expect(
      _recordedCalls.some((c) => c.sid === tutorSid),
      "follow-up should run the tutor again",
    ).toBe(true);
    const commanderCallsAfter = _recordedCalls.filter(
      (c) => c.sid === state.buildGconvSessionId(cid),
    ).length;
    expect(
      commanderCallsAfter,
      "commander must NOT run for the no-@ follow-up while handed off",
    ).toBe(commanderCallsBefore);
  }, 15_000);

  it("hand_off_to after failed planning attempts leaves no empty commander tail", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const specialistReply = "SPECIALIST-RESULT: review form is ready.";
    const toolEvent = (
      id: string,
      name: string,
      phase: "start" | "end",
      isError?: boolean,
    ) => ({
      type: "event",
      event: {
        stream: "tool",
        data: {
          id,
          name,
          phase,
          ...(isError === undefined ? {} : { isError }),
        },
      },
    });
    const contextProgress = (
      stream: "context" | "compaction",
      phase: string,
      text: string,
    ) => ({
      type: "progress",
      text,
      event: { stream, data: { phase } },
    });

    // Mirrors d33b828f234c from the reported run: research triggered context
    // compaction, the commander narrated a visible pre-dispatch segment, three
    // execution-plan calls failed, and hand_off_to delivered the final answer.
    // The old whole-turn process array was attached again to an empty tail;
    // the generic compaction-visibility rule forced that tail to persist.
    _setScript(state.buildGconvSessionId(cid), [
      contextProgress(
        "context",
        "active_process_compaction_start",
        "正在整理当前轮工具上下文...",
      ),
      contextProgress(
        "context",
        "active_process_compaction_done",
        "当前轮工具上下文整理完成",
      ),
      contextProgress("compaction", "done", "compacted 19480→2442 tokens"),
      toolEvent("plan-1", "manage_execution_plan", "start"),
      toolEvent("plan-1", "manage_execution_plan", "end", true),
      toolEvent("plan-2", "manage_execution_plan", "start"),
      toolEvent("plan-2", "manage_execution_plan", "end", true),
      {
        type: "delta",
        text: "资料搜集已基本完备，我来整合素材并交给 @Writer。",
      },
      toolEvent("plan-3", "manage_execution_plan", "start"),
      toolEvent("plan-3", "manage_execution_plan", "end", true),
      toolEvent("handoff-1", "hand_off_to", "start"),
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: AGENT_NAME, message: "compose the video" },
      },
      toolEvent("handoff-1", "hand_off_to", "end", false),
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: specialistReply },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "make the video",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const rows = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf8",
      )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      rows.some(
        (row: any) => row.from === AGENT_ID && row.text === specialistReply,
      ),
    ).toBe(true);
    const commanderRows = rows.filter((row: any) => row.from === "commander" && !row.recall_projection_card);
    expect(
      commanderRows,
      "only the narrated pre-dispatch segment should persist",
    ).toHaveLength(1);
    expect(commanderRows[0].text).toContain("资料搜集已基本完备");
    expect(
      commanderRows[0].process.some(
        (item: any) => item.event?.stream === "compaction",
      ),
      "pre-dispatch compaction belongs to the pre-dispatch segment",
    ).toBe(true);
    expect(
      commanderRows[0].process.some(
        (item: any) => item.event?.data?.name === "manage_execution_plan",
      ),
      "pre-dispatch planning attempts belong to the pre-dispatch segment",
    ).toBe(true);
    expect(
      commanderRows.some((row: any) => !String(row.text || "").trim()),
      "terminal delivery must not persist an empty commander process/runtime record",
    ).toBe(false);
    expect(
      events.some(
        (ev) =>
          ev.type === "turn_silent" &&
          ev.actor === "commander" &&
          ev.reason === "terminal_handoff",
      ),
      "renderer must receive an explicit terminal-handoff cleanup signal",
    ).toBe(true);
  }, 15_000);

  it("terminal hand_off_to without narration is not resurrected by context compaction", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "progress",
        text: "compacted 19480→2442 tokens",
        event: {
          stream: "compaction",
          data: { tokensBefore: 19480, tokensAfter: 2442 },
        },
      },
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: AGENT_NAME, message: "compose the video" },
      },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "SPECIALIST-RESULT: ready." },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "make the video",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const rows = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf8",
      )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.from === AGENT_ID)).toBe(true);
    expect(
      rows.filter((row: any) => row.from === "commander" && !row.recall_projection_card),
      "compaction observability must not override an explicit terminal delivery",
    ).toEqual([]);
  }, 15_000);

  it("manual @ to another agent while handed off makes that agent the sticky floor", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const tutorId = "a11122223333";
    const tutorName = "TutorA";
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(
      path.join(tutorDir, "agent.json"),
      JSON.stringify({
        agent_id: tutorId,
        name: tutorName,
        description: "interactive tutor",
        workflow: "teach",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: tutorName, message: "teach this" },
      },
      { type: "final", text: "Over to TutorA." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: "final", text: "TutorA: ready." },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "teach me",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(
      tutorId,
    );

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "Writer: switching context." },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} quick aside`,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(
      AGENT_ID,
    );

    const tutorCallsBefore = _recordedCalls.filter(
      (c) => c.sid === state.buildGmemberSessionId(cid, tutorId),
    ).length;
    const writerCallsBefore = _recordedCalls.filter(
      (c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    ).length;
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "Writer: still here." },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "continue with that",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const tutorCallsAfter = _recordedCalls.filter(
      (c) => c.sid === state.buildGmemberSessionId(cid, tutorId),
    ).length;
    const writerCallsAfter = _recordedCalls.filter(
      (c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID),
    ).length;
    expect(
      writerCallsAfter,
      "no-@ follow-up should stay with the manually selected agent",
    ).toBe(writerCallsBefore + 1);
    expect(
      tutorCallsAfter,
      "no-@ follow-up must not snap back to the previous hand-off agent",
    ).toBe(tutorCallsBefore);
  }, 15_000);

  // hand_off_to a NON-interactive agent: it answers the user (one-shot, saving the
  // commander's synthesis call), but the floor stays with the commander.
  it("hand_off_to non-interactive agent: one-shot answer, floor stays commander", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const SPECIALIST_REPLY = "SPECIALIST-3c: here is the finished translation.";
    _setScript(state.buildGconvSessionId(cid), [
      { type: "delta", text: "Handing this to the specialist." },
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: AGENT_NAME, message: "translate this" },
      },
      { type: "final", text: "Handing this to the specialist." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: SPECIALIST_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "translate this for me",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.from === AGENT_ID &&
          String(m.text || "").includes(SPECIALIST_REPLY),
      ),
      "specialist should answer the user directly",
    ).toBe(true);
    // Non-interactive → floor stays with the commander (absent).
    const st = await state.readState(TEST_UID, cid);
    expect(
      st.active_recipient,
      "non-interactive hand-off must not stick the floor",
    ).toBeUndefined();
  }, 12_000);

  // While an interactive agent holds the floor, emitting <handback /> returns the
  // floor to the commander and the marker is stripped from the visible reply.
  it("agent <handback /> while holding the floor returns control to the commander", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const tutorId = "beef98765432";
    const tutorName = "CoachBot";
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(
      path.join(tutorDir, "agent.json"),
      JSON.stringify({
        agent_id: tutorId,
        name: tutorName,
        description: "coaches",
        workflow: "coach",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    // 1) Commander hands off → floor = tutor.
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: tutorName, message: "coach the user" },
      },
      { type: "final", text: "Over to the coach." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: "final", text: "Welcome! What is your goal?" },
    ]);
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "coach me",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(
      tutorId,
    );

    // 2) User follow-up (no @) routes to the tutor, which finishes + hands back.
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      {
        type: "final",
        text: "Great, you are all set. Good luck!\n<handback />",
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "thanks, that is all",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // Floor is back to the commander (absent).
    expect(
      (await state.readState(TEST_UID, cid)).active_recipient,
      "handback should return the floor to the commander",
    ).toBeUndefined();
    // The marker is stripped from the visible bubble.
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const tutorMsgs = lines.filter((m: any) => m.from === tutorId);
    expect(
      tutorMsgs.some((m: any) => String(m.text || "").includes("<handback")),
      "the handback marker must not leak into the visible text",
    ).toBe(false);
  }, 15_000);

  it("interactive hand-off with resume wakes commander from a lightweight orchestration ledger", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const coachId = "face55556666";
    const coachName = "ScenarioCoach";
    const coachDir = paths.agentDir(TEST_UID, coachId);
    fs.mkdirSync(coachDir, { recursive: true });
    fs.writeFileSync(
      path.join(coachDir, "agent.json"),
      JSON.stringify({
        agent_id: coachId,
        name: coachName,
        description: "elicits scenario details",
        workflow: "coach",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      { type: "delta", text: "I need the coach to gather the scenario first." },
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: coachName,
          message: "Ask the user for the missing scenario details.",
          resume:
            "After ScenarioCoach hands back, synthesize the final multi-agent routing recommendation and mention any remaining risk.",
        },
      },
      { type: "final", text: "I need the coach to gather the scenario first." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: "final", text: "What scenario should I optimize for?" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "帮我优化这个多 agent 调度，但先确认场景",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBe(coachId);
    expect(st.orchestration_ledger?.owner_agent_id).toBe(coachId);
    expect(st.orchestration_ledger?.resume_instruction).toContain(
      "routing recommendation",
    );

    _setScript(state.buildGmemberSessionId(cid, coachId), [
      {
        type: "final",
        text: "The user wants normal chat prompts to trigger specialist routing when quality improves.\n<handback />",
      },
    ]);
    _setScript(commanderSid, [
      {
        type: "final",
        text: "RESUMED-COMMANDER: based on the scenario, keep routing quality-first and resume remaining synthesis.",
      },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "场景是普通用户自然发消息，不会点名 agent",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();

    const resumeCall = _recordedCalls.find(
      (c) =>
        c.sid === commanderSid && c.message.includes("<orchestration-resume>"),
    );
    expect(resumeCall?.message).toContain(
      "normal chat prompts to trigger specialist routing",
    );
    expect(resumeCall?.message).toContain("routing recommendation");

    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.dispatch === true &&
          m.to.includes("commander") &&
          String(m.model_text || "").includes("<orchestration-resume>"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (m: any) =>
          m.from === "commander" &&
          String(m.text || "").includes("RESUMED-COMMANDER"),
      ),
    ).toBe(true);
  }, 15_000);

  it("approved wake-gated interactive hand-off preserves resume and wakes commander on handback", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const wakeController =
      await import("../../../../src/main/features/p3394/wake-controller");
    const wakeService =
      await import("../../../../src/main/features/p3394/wake-service");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");

    const researcherId = "face90901111";
    const researcherName = "ResearchGateAgent";
    const researcherDir = paths.agentDir(TEST_UID, researcherId);
    fs.mkdirSync(researcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(researcherDir, "agent.json"),
      JSON.stringify({
        agent_id: researcherId,
        name: researcherName,
        description: "collects research details",
        workflow: "research only",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: researcherName,
          message: "Collect the research inputs only, then hand back.",
          resume:
            "After ResearchGateAgent hands back, dispatch ContentWriter with the research summary.",
        },
      },
      { type: "final", text: "Waiting for wake approval." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, researcherId), [
      {
        type: "final",
        text: "I have started collecting inputs; send the constraints.",
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Research then write this paper.",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();
    const [request] = await wakeService.listWakeRequests(TEST_UID, cid);
    expect(request?.status).toBe("pending");
    expect(request?.workflow_step_id).toMatch(/^wstep-/);
    expect(request?.source).toBe("hand_off_to");
    const pendingRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(
      pendingRun?.steps.find((step) => step.id === request?.workflow_step_id)
        ?.status,
    ).toBe("pending");
    expect(request?.behavior_scope).toEqual(
      expect.arrayContaining(["hand_off_to", "user_mention"]),
    );
    expect(request?.resume_instruction).toContain("dispatch ContentWriter");

    await wakeController.decideWakeRequest(TEST_UID, {
      requestId: request.id,
      decision: "approve",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const completedRun = await collaboration.readActiveWorkflowRun(
      TEST_UID,
      cid,
    );
    expect(
      completedRun?.steps.find((step) => step.id === request.workflow_step_id)
        ?.status,
    ).toBe("completed");
    st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBe(researcherId);
    expect(st.orchestration_ledger?.status).toBe("waiting_for_agent");
    expect(st.orchestration_ledger?.owner_agent_id).toBe(researcherId);
    expect(st.orchestration_ledger?.resume_instruction).toContain(
      "dispatch ContentWriter",
    );

    // The remainder of this legacy integration fixture intentionally drives
    // the historical in-process Agent test double so its scripted handback
    // assertions remain deterministic. Production cannot enable this bypass.
    process.env.COGSEED_P3394_WAKE_GATE = "0";
  process.env.COGSEED_LEGACY_RUN_WORKER_TEST = "0";

    _setScript(state.buildGmemberSessionId(cid, researcherId), [
      {
        type: "final",
        text: "Research summary: Raspberry Pi smart-home authentication and IDS evidence is ready.\n<handback />",
      },
    ]);
    _setScript(commanderSid, [
      {
        type: "final",
        text: "RESUMED-AFTER-WAKE: dispatching ContentWriter from the research summary.",
      },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "constraints are confirmed",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();
    const resumeCall = _recordedCalls.find(
      (c) =>
        c.sid === commanderSid && c.message.includes("<orchestration-resume>"),
    );
    expect(resumeCall?.message).toContain(
      "Raspberry Pi smart-home authentication",
    );
    expect(resumeCall?.message).toContain("dispatch ContentWriter");
  }, 15_000);

  it("user explicitly returning to commander consumes an interrupted orchestration ledger", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");

    const coachId = "feed77778888";
    const coachName = "InterruptCoach";
    const coachDir = paths.agentDir(TEST_UID, coachId);
    fs.mkdirSync(coachDir, { recursive: true });
    fs.writeFileSync(
      path.join(coachDir, "agent.json"),
      JSON.stringify({
        agent_id: coachId,
        name: coachName,
        description: "interactive coach",
        workflow: "coach",
        interactive: true,
        created_at: "t",
        updated_at: "t",
      }),
    );

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: coachName,
          message: "Gather the user scenario.",
          resume:
            "After InterruptCoach hands back, continue the commander synthesis.",
        },
      },
      { type: "final", text: "Over to the coach." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: "final", text: "Tell me the scenario." },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "先让 coach 了解一下背景，然后你继续",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(
      (await state.readState(TEST_UID, cid)).orchestration_ledger?.status,
    ).toBe("waiting_for_agent");

    _setScript(commanderSid, [
      {
        type: "final",
        text: "INTERRUPTED-COMMANDER: paused the hand-off and handled your change.",
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "@commander 先暂停，直接说结论",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();
  }, 15_000);

  it("non-interactive dispatch that blocks on an agent form resumes commander after submission", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const groupChat = await import("../../../../src/main/features/group_chat");
    const paths = await import("../../../../src/main/paths");

    const commanderSid = state.buildGconvSessionId(cid);
    const formPayload = {
      fields: [
        { id: "topic", label: "主题", type: "text", required: true },
        {
          id: "depth",
          label: "深度",
          type: "select",
          options: [
            { value: "q", label: "快速" },
            { value: "d", label: "深度" },
          ],
          default: "q",
        },
      ],
    };

    _setScript(commanderSid, [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "Draft the report, asking for required inputs if missing.",
          resume:
            "After Writer completes the report from the submitted form, synthesize final recommendations.",
        },
      },
      { type: "final", text: "" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: "final",
        text: `请确认参数。\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "帮我写报告，缺参数就问",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger?.status).toBe("waiting_for_form");
    expect(st.orchestration_ledger?.blocked_on).toBe("agent_form");
    expect(st.orchestration_ledger?.source_tool).toBe("dispatch_to");
    expect(st.orchestration_ledger?.resume_instruction).toContain(
      "synthesize final recommendations",
    );

    let lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const agentReply = lines.find((m: any) => m.from === AGENT_ID && m.form);
    expect(agentReply).toBeTruthy();
    expect(agentReply.form.form_id).toBe(st.orchestration_ledger?.form_id);

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: "final",
        text: "FORM-COMPLETE: report drafted for topic=CogSeed, depth=deep.",
      },
    ]);
    _setScript(commanderSid, [
      {
        type: "final",
        text: "RESUMED-FORM-COMMANDER: final recommendations synthesized.",
      },
    ]);

    const submitRes = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: agentReply.id,
      formId: agentReply.form.form_id,
      values: { topic: "CogSeed", depth: "d" },
    });
    expect(submitRes.ok).toBe(true);
    await groupChat.send({
      userId: TEST_UID,
      cid,
      text: submitRes.submission!.text,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger).toBeUndefined();
    const resumeCall = _recordedCalls.find(
      (c) =>
        c.sid === commanderSid && c.message.includes("<orchestration-resume>"),
    );
    expect(resumeCall?.message).toContain("FORM-COMPLETE");
    expect(resumeCall?.message).toContain("synthesize final recommendations");

    lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      lines.some(
        (m: any) =>
          m.dispatch === true &&
          m.to.includes("commander") &&
          String(m.model_text || "").includes("<orchestration-resume>"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (m: any) =>
          m.from === "commander" &&
          String(m.text || "").includes("RESUMED-FORM-COMMANDER"),
      ),
    ).toBe(true);
  }, 15_000);
});


describe("group_chat bus integration › Recall asset usage receipt", () => {
  it("attaches the injected assets as a read-only citation receipt on the commander reply and records usage", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const layout = await import("../../../../src/main/util/project-layout");
    const storage = await import("../../../../src/main/storage");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const candidates = await import("../../../../src/main/features/recall/candidate-service");
    const projections = await import("../../../../src/main/features/recall/context-projection");

    const candidate = await candidates.saveRecallCandidate(TEST_UID, {
      judgment: "Keep OAuth state checks before token exchange.",
      summary: "OAuth state check rule",
      suggestedType: "rule",
      suggestedScope: "review",
      sourceRefs: [{ kind: "execution", id: "exec-receipt" }],
    });
    const asset = (await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: "user" })).asset;
    const preview = await projections.previewContextProjection(TEST_UID, {
      taskRunId: "task-receipt",
      purpose: "review",
      taskText: "Audit OAuth login",
      authorization: "workspace_policy",
      confirm: true,
    });
    const messageFile = layout.conversationMessageFile(TEST_UID, cid);
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: "msg-card", ts: new Date().toISOString(), from: "commander", to: ["user"], text: "confirmed",
      recall_projection_card: { projectionId: preview.id },
    });

    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "done with receipt" },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "run the approved task" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const messages = await readConversationMessages(cid);
    const reply = messages.find((message) => message.from === "commander" && message.text === "done with receipt");
    expect(reply).toBeTruthy();
    expect(reply!.recall_citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset_id: asset.id, projection_id: preview.id }),
      ]),
    );
    const usage = await import("../../../../src/main/features/recall/usage-service");
    const records = await usage.listRecallUsage(TEST_UID, asset.id);
    expect(records.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

describe("group_chat bus integration › deterministic host routing (task turn)", () => {
  it("opens a governed KStar task + confirmed projection for a task-shaped user message before the model turn", async () => {
    process.env.COGSEED_KSTAR_HOST_ROUTING = "1";
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    // The host asks the Commander for a routing judgement first; the script
    // answers is_task:true (a governed task should open), then the real turn.
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: '<kstar-judge>{"is_task":true,"continuation":false}</kstar-judge>' },
      { type: "final", text: "I will review it." },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "审查一下 bus.ts 的守卫实现" });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const store = await import("../../../../src/main/features/kstar/requirement-store");
    const taskState = await store.readConversationTaskState(TEST_UID, cid);
    expect(taskState?.currentTaskId).toBeTruthy();
    const requirement = await store.readKstarRequirement(TEST_UID, taskState!.currentRequirementId!);
    expect(requirement?.projectionId).toBeTruthy();
    const projections = await import("../../../../src/main/features/recall/context-projection");
    const projection = await projections.readContextProjection(TEST_UID, requirement!.projectionId!);
    expect(projection.status).toBe("confirmed");
  }, 10_000);

  it("leaves greetings untouched — zero KStar writes", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "hi" },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "你好" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const store = await import("../../../../src/main/features/kstar/requirement-store");
    const taskState = await store.readConversationTaskState(TEST_UID, cid);
    expect(taskState?.currentTaskId).toBeFalsy();
  }, 10_000);
});

describe("group_chat bus integration › KStar privileged dispatch approval", () => {
  async function seedKstarControlledConversation(cid: string, options: { projectionStatus: "preview" | "confirmed"; forecastId?: string }) {
    const store = await import("../../../../src/main/features/kstar/requirement-store");
    const projections = await import("../../../../src/main/features/recall/context-projection");
    const task = store.createKstarTaskRecord(TEST_UID, {
      conversationId: cid,
      title: "Approved task",
    });
    const requirement = store.createKstarRequirementRecord(TEST_UID, {
      taskId: task.id,
      conversationId: cid,
      userMessageIds: ["msg-a"],
      title: "Approved task",
      goalText: "Change files",
    });
    const preview = await projections.previewContextProjection(TEST_UID, {
      taskRunId: task.id,
      purpose: "Use frozen OAuth review knowledge",
      taskText: "Change files",
    });
    const projection = options.projectionStatus === "confirmed"
      ? await projections.confirmContextProjection(TEST_UID, preview.id)
      : preview;
    requirement.projectionId = projection.id;
    requirement.projectionIds = [projection.id];
    if (options.forecastId) requirement.forecastId = options.forecastId;
    await store.replaceKstarTask(TEST_UID, {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    await store.replaceKstarRequirement(TEST_UID, requirement);
    await store.writeConversationTaskState(TEST_UID, {
      ...store.createInitialConversationTaskState(TEST_UID, cid),
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      taskComplete: false,
    });
    return { task, requirement, projection };
  }

  it("blocks privileged dispatch but preserves an ordinary reply while approval is pending", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const seeded = await seedKstarControlledConversation(cid, { projectionStatus: "preview" });

    _setScript(state.buildGconvSessionId(cid), [
      { type: "__call_tool__", name: "dispatch_to", input: { to: AGENT_NAME, message: "change files" } },
      { type: "final", text: "I need your approval before execution." },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "MUST NOT RUN" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "run the approved task" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const result = _recordedToolResults.find((entry) => entry.name === "dispatch_to");
    expect(JSON.parse(result!.content)).toMatchObject({
      ok: false,
      error_code: "kstar_projection_not_confirmed",
    });
    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(0);
    const messages = await readConversationMessages(cid);
    expect(messages).toContainEqual(expect.objectContaining({
      from: "commander",
      text: "I need your approval before execution.",
    }));
    expect(seeded.requirement.id).toBeTruthy();
  });

  it("stamps verified Projection and Forecast provenance after approval", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const seeded = await seedKstarControlledConversation(cid, { projectionStatus: "confirmed", forecastId: "wmf-a" });
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      { type: "__call_tool__", name: "dispatch_to", input: { to: AGENT_NAME, message: "perform approved work" } },
      { type: "final", text: "approved work done" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "agent work complete" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "execute approved task" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(await waitUntil(() => terminals.length >= 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminals[0]).toMatchObject({
      logical_run_id: seeded.task.id,
      projection_id: seeded.projection.id,
      forecast_id: "wmf-a",
    });
    unsubscribe();
  }, 10_000);

  it("proceeds with a hand_off_to when no forecast exists (world model owns prediction; missing forecast is advisory, not a gate)", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    // Pre-existing task with confirmed projection but NO forecast: the world
    // model generates forecasts automatically; when it could not (no model /
    // no candidates), execution proceeds rather than demanding a kstar_control
    // call the Commander no longer has.
    await seedKstarControlledConversation(cid, { projectionStatus: "confirmed" });

    _setScript(state.buildGconvSessionId(cid), [
      { type: "__call_tool__", name: "hand_off_to", input: { to: AGENT_NAME, message: "deliver the report" } },
      { type: "final", text: "handed off" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "delivered" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "deliver the report" });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const toolResult = _recordedToolResults.find((r) => r.name === "hand_off_to");
    expect(toolResult?.isError).toBeFalsy();
    // The agent DID run.
    expect(_recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)).length).toBeGreaterThan(0);
  }, 10_000);
});

describe("group_chat bus integration › task terminal boundary", () => {
  it("emits one completed event only after the whole user-triggered run is quiescent", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) =>
      terminals.push(event),
    );

    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "done" },
    ]);
    const triggerMessage = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "finish this task",
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      user_id: TEST_UID,
      conversation_id: cid,
      status: "completed",
      anchor_message_id: triggerMessage.id,
      finished_message_id: expect.any(String),
    });
    expect(terminals[0].finished_message_id).not.toBe(triggerMessage.id);
    expect(terminals[0].finished_at_ms).toBeGreaterThanOrEqual(
      terminals[0].started_at_ms,
    );
    unsubscribe();
  }, 10_000);

  it("classifies model errors as failed", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) =>
      terminals.push(event),
    );

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "error",
        text: "provider unavailable",
        failureKind: "provider",
        failureCode: "upstream",
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "finish this task",
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe("failed");
    unsubscribe();
  }, 10_000);

  it("classifies a persisted input form as waiting_input", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) =>
      terminals.push(event),
    );
    const formPayload = {
      fields: [{ id: "topic", label: "Topic", type: "text", required: true }],
    };

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: "final",
        text: `Need one detail.\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} start`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe("waiting_input");
    unsubscribe();
  }, 10_000);

  it("classifies an explicit commander input request as waiting_input", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) =>
      terminals.push(event),
    );

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "final",
        text: '请选择论文类型和目标篇幅。\n<commander-result status="waiting_input" />',
      },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "帮我写一篇论文",
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe("waiting_input");
    unsubscribe();
  }, 10_000);

  it("emits cancelled after a live run is stopped", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) =>
      terminals.push(event),
    );

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "__wait_for_abort__" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} long task`,
    });
    expect(await waitUntil(() => !bus.isQuiescent(TEST_UID, cid))).toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe("cancelled");
    unsubscribe();
  }, 10_000);
});

describe("group_chat bus integration › direct agent reply routing", () => {
  it("agent reply with explicit @user reaches subscribers and keeps the agent in-flight signal", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "@user 好的，我来帮你梳理需求。" },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 我想要开发一个软件`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const messageEvents = events.filter((e) => e.type === "message" && !e.msg?.recall_projection_card);
    expect(messageEvents).toHaveLength(2);
    const fromAgent = messageEvents.find((e) => e.msg.from === AGENT_ID);
    expect(fromAgent).toBeTruthy();
    expect(fromAgent.msg.to).toEqual(["user"]);
    expect(fromAgent.msg.text.startsWith("@user")).toBe(false);
    expect(fromAgent.msg.text).toContain("好的");

    const stateChanges = events.filter((e) => e.type === "state_changed");
    const sawAgentInFlight = stateChanges.some(
      (e) =>
        Array.isArray(e.state.in_flight) &&
        e.state.in_flight.includes(AGENT_ID),
    );
    expect(sawAgentInFlight).toBe(true);
  }, 10_000);

  it("agent reply \"@user 好的...\" persists as \"好的...\"", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "@user 好的，我来帮你梳理需求。😊" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 开始`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import("../../../../src/main/paths");
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(["user"]);
    expect(agentMsg.text).toBe("好的，我来帮你梳理需求。😊");
    expect(agentMsg.text.startsWith("@")).toBe(false);
  }, 10_000);

  it("mid-prose @user is stripped from agent replies because routing already lives in `to`", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "收到 @user，我会同步给 @user" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 开始`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import("../../../../src/main/paths");
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg.text).not.toContain("@user");
    expect(agentMsg.text).toBe("收到，我会同步给");
  }, 10_000);

  it("agent reply with no @-mention routes to [user]", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "已完成。" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 开始`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import("../../../../src/main/paths");
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(["user"]);
  }, 10_000);

  it("agent reply with `@指挥官` routes to commander and wakes a commander turn", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "@指挥官 我这边卡住了，需要你协调。" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "收到。" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 开始`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import("../../../../src/main/paths");
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(["commander"]);
    expect(
      lines.some(
        (m) => m.from === "commander" && String(m.text || "").includes("收到"),
      ),
    ).toBe(true);
  }, 10_000);

  it("non-plan agent → user reply does NOT wake commander", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "已完成。" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: `@${AGENT_NAME} 开始`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import("../../../../src/main/paths");
    const lines = fs
      .readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
        "utf-8",
      )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const nonRecallLines = lines.filter((line: any) => !line.recall_projection_card);
    expect(nonRecallLines).toHaveLength(2);
    expect(nonRecallLines[1]).toMatchObject({ from: AGENT_ID, to: ["user"] });
    expect(
      _recordedCalls.some((c) => c.sid === state.buildGconvSessionId(cid)),
    ).toBe(false);
    expect(lines.find((l: any) => l.text === "(no reply)")).toBeUndefined();
  }, 10_000);
});

describe("group_chat bus integration › Task 5 nested workflow preparation", () => {
  it.each([
    ["dispatch_to", { to: AGENT_NAME, message: "Write the final strategy" }],
    ["hand_off_to", { to: AGENT_NAME, message: "Write the final strategy" }],
    ["run_worker named", { to: AGENT_NAME, task: "Write the final strategy" }],
    ["run_worker anonymous", { task: "Write the final strategy" }],
  ])(
    "%s blocks before nested inference when a dependency conflict is active",
    async (_name, input) => {
      const cid = newCid();
      const state =
        await import("../../../../src/main/features/group_chat/state");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      const created = await collaboration.createWorkflowRun(TEST_UID, cid, {
        objective: "Write the final strategy",
        created_by: "commander",
      });
      await collaboration.applyContextPatch(TEST_UID, cid, created.context.id, {
        added_by: "reviewer",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use direct entry" },
        ],
      });
      await collaboration.applyContextPatch(TEST_UID, cid, created.context.id, {
        added_by: "writer",
        decisions_proposed: [
          { conflict_key: "market.entry_mode", text: "Use a local partner" },
        ],
      });

      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: input.to
            ? _name === "run_worker named"
              ? "run_worker"
              : _name
            : "run_worker",
          input: { ...input, context_dependencies: ["market.entry_mode"] },
        },
        { type: "final", text: "blocked dispatch acknowledged" },
      ]);
      await busOrEnqueue(TEST_UID, cid, "Write the final strategy");
      await waitForQuiescent(TEST_UID, cid, 2000);

      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      const step = run?.steps.find((candidate) =>
        candidate.context_dependencies?.includes("market.entry_mode"),
      );
      expect(step?.status).toBe("blocked");
      expect(step?.id).toMatch(/^wstep-/);
      expect(
        _recordedCalls.some(
          (call) =>
            call.sid.includes(AGENT_ID) || call.sid.startsWith("gworker-"),
        ),
      ).toBe(false);
      const toolName = input.to
        ? _name === "run_worker named"
          ? "run_worker"
          : _name
        : "run_worker";
      const toolResult = _recordedToolResults.find(
        (result) => result.name === toolName,
      );
      expect(toolResult?.content).toContain("dispatch_blocked_by_conflict");
      expect(toolResult?.content).toContain(step?.id);
    },
  );
});

async function busOrEnqueue(
  uid: string,
  cid: string,
  text: string,
): Promise<void> {
  const bus = await import("../../../../src/main/features/group_chat/bus");
  await bus.enqueue({ uid, cid, fromActorId: "user", text });
}

describe("group_chat bus integration › Task 5 anonymous context patch", () => {
  it("applies an anonymous worker context patch without adding a roster member or exposing the patch wrapper", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const members =
      await import("../../../../src/main/features/group_chat/state");
    const created = await collaboration.createWorkflowRun(TEST_UID, cid, {
      objective: "Collect research evidence",
      created_by: "commander",
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "Collect evidence" },
      },
      { type: "final", text: "Commander synthesis" },
    ]);
    _setScript("gworker-*", [
      {
        type: "final",
        text: "Evidence found.\n<context-patch>{\"facts_add\":[{\"text\":\"Anonymous worker found evidence\"}]}</context-patch>",
      },
    ]);
    await busOrEnqueue(TEST_UID, cid, "Collect research evidence");
    await waitForQuiescent(TEST_UID, cid, 2000);

    const context = await collaboration.readSharedTaskContext(
      TEST_UID,
      cid,
      created.context.id,
    );
    expect(context?.facts.map((item) => item.text)).toContain(
      "Anonymous worker found evidence",
    );
    const roster = await members.readMembers(TEST_UID, cid);
    expect(roster.actors.some((actor) => actor.kind === "worker")).toBe(false);
    const messages = await (
      await import("../../../../src/main/storage")
    ).readJsonl<any>(
      path.join(
        (await import("../../../../src/main/paths")).userChatsDir(TEST_UID),
        `${cid}.jsonl`,
      ),
    );
    expect(
      messages.some((message: any) =>
        String(message.text || "").includes("<context-patch>"),
      ),
    ).toBe(false);
  });
});

describe("group_chat bus integration › Task 5 anonymous resume", () => {
  it("resumes the same anonymous workflow step through the real run_worker tool path", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const firstRun = await collaboration.createWorkflowRun(TEST_UID, cid, {
      objective: "Anonymous resume task",
      created_by: "commander",
    });
    await collaboration.applyContextPatch(TEST_UID, cid, firstRun.context.id, {
      added_by: "reviewer",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use direct entry" },
      ],
    });
    await collaboration.applyContextPatch(TEST_UID, cid, firstRun.context.id, {
      added_by: "writer",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Use a local partner" },
      ],
    });

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "Resume anonymous work",
          context_dependencies: ["market.entry_mode"],
        },
      },
      { type: "final", text: "blocked" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Anonymous resume task",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const blockedResult = _recordedToolResults.find(
      (result) => result.name === "run_worker",
    );
    const blockedPayload = JSON.parse(blockedResult!.content);
    const workflowStepId = blockedPayload.workflow_step_id as string;
    const resumeToken = blockedPayload.resume_token as string;
    expect(blockedPayload.status).toBe("dispatch_blocked_by_conflict");
    expect(resumeToken).toMatch(/^wcap-/);

    const current = await collaboration.readActiveSharedTaskContext(
      TEST_UID,
      cid,
    );
    const conflict = current!.conflicts[0];
    const selected = current!.proposals.find(
      (proposal) => proposal.text === "Use a local partner",
    )!;
    await collaboration.resolveContextConflictById(
      TEST_UID,
      cid,
      current!.id,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
        resolved_by: "commander",
      },
    );

    _recordedToolResults.length = 0;
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "Resume anonymous work",
          context_dependencies: ["market.entry_mode"],
          resume_step_id: workflowStepId,
          resume_token: resumeToken,
        },
      },
      { type: "final", text: "resumed" },
    ]);
    _setScript("gworker-*", [
      { type: "final", text: "anonymous resumed result" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Resume anonymous work now",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]).toMatchObject({
      id: workflowStepId,
      status: "completed",
    });
    expect(_recordedCalls.some((call) => call.sid.startsWith("gworker-"))).toBe(
      true,
    );
  });
});

describe("group_chat bus integration › Commander KSTAR dispatch narration", () => {
  it.skip("declares task, plan, and expected result only after wake authorization", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const wakeController = await import("../../../../src/main/features/p3394/wake-controller");
    const wakeService = await import("../../../../src/main/features/p3394/wake-service");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "调研 Codex Work Buddy 前端 UI 并写优化需求文档",
          kstar: "required",
          kstar_reason: "这是面向后续设计的正式调研交付物",
          kstar_expectation: {
            task: "调研 Codex Work Buddy 前端 UI 并写优化需求文档",
          },
        },
      },
      { type: "final", text: "等待 Agent 唤醒授权。" },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "让 Hermes 调研 Codex Work Buddy 前端 UI。",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const readLines = () => fs
      .readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(readLines().some((message: any) => message.kstar_dispatch_narration)).toBe(false);

    const [request] = await wakeService.listWakeRequests(TEST_UID, cid);
    expect(request).toMatchObject({ status: "pending", agent_id: AGENT_ID });
    await confirmKstarWakeForTest(cid, request!.id);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "HERMES-RESULT" },
    ]);
    await expect(wakeController.decideWakeRequest(TEST_UID, { requestId: request!.id, decision: "approve" })).resolves.toMatchObject({ ok: true, dispatched: true });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = readLines();
    const narrationIndex = lines.findIndex((message: any) => message.kstar_dispatch_narration);
    const dispatchIndex = lines.findIndex((message: any) => message.from === "commander" && message.to?.includes(AGENT_ID) && String(message.text || "").includes("调研 Codex Work Buddy"));
    expect(narrationIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeGreaterThan(narrationIndex);
    const narration = lines[narrationIndex];
    expect(narration.from).toBe("commander");
    expect(narration.text).toContain("调研 Codex Work Buddy 前端 UI 并写优化需求文档");
    expect(narration.text).toContain("执行计划");
    expect(narration.text).toContain("预期结果");
    expect(narration.kstar_dispatch_narration).toMatchObject({ target_agent_id: AGENT_ID });
  }, 12_000);
});

describe("group_chat bus integration › wake-gated dispatch continuation", () => {
  it.skip("emits KSTAR provenance on the terminal event for an approved dispatch_to Agent", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const wakeController = await import("../../../../src/main/features/p3394/wake-controller");
    const wakeService = await import("../../../../src/main/features/p3394/wake-service");
    const lifecycle = await import("../../../../src/main/features/kstar/lifecycle-adapter");

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "Audit the paper",
          kstar: "required",
          kstar_reason: "The audit contributes evidence to the collaboration.",
          kstar_expectation: {
            task: "Audit the paper",
            action_hat: "Produce an audit result",
            result_hat: "Reviewable audit evidence",
          },
        },
      },
      { type: "final", text: "Waiting for Agent approval." },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Audit this paper, then have Codex review the result.",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const [request] = await wakeService.listWakeRequests(TEST_UID, cid);
    expect(request).toMatchObject({
      source: "dispatch_to",
      status: "pending",
      workflow_step_id: expect.stringMatching(/^wstep-/),
    });
    await confirmKstarWakeForTest(cid, request!.id);
    const lifecycleSnapshot = await lifecycle.readKstarTaskLifecycle(TEST_UID, cid);
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "HERMES-AUDIT-RESULT" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "CODEX-REVIEW-RESULT" },
    ]);

    const approved = await wakeController.decideWakeRequest(TEST_UID, {
      requestId: request!.id,
      decision: "approve",
    });
    expect(approved).toMatchObject({ ok: true, dispatched: true });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(await waitUntil(() => terminals.length === 1)).toBe(true);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      status: "completed",
      projection_id: lifecycleSnapshot.projection?.id,
      wake_request_id: request!.id,
      logical_run_id: lifecycleSnapshot.task?.id,
      execution_id: request!.id,
    });
    unsubscribe();
  }, 12_000);

  it.skip("resumes Commander after an approved dispatch_to Agent completes without an explicit resume", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const wakeController = await import("../../../../src/main/features/p3394/wake-controller");
    const wakeService = await import("../../../../src/main/features/p3394/wake-service");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "Audit the paper",
          kstar: "required",
          kstar_reason: "The audit contributes evidence to the collaboration.",
          kstar_expectation: {
            task: "Audit the paper",
            action_hat: "Produce an audit result",
            result_hat: "Reviewable audit evidence",
          },
        },
      },
      { type: "final", text: "Waiting for Agent approval." },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Audit this paper, then have Codex review the result.",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const [request] = await wakeService.listWakeRequests(TEST_UID, cid);
    expect(request).toMatchObject({
      source: "dispatch_to",
      status: "pending",
      workflow_step_id: expect.stringMatching(/^wstep-/),
    });
    await confirmKstarWakeForTest(cid, request!.id);

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "HERMES-AUDIT-RESULT" },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: "final", text: "CODEX-REVIEW-RESULT" },
    ]);

    const approved = await wakeController.decideWakeRequest(TEST_UID, {
      requestId: request!.id,
      decision: "approve",
    });
    expect(approved).toMatchObject({ ok: true, dispatched: true });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const commanderResume = _recordedCalls.find(
      (call) => call.sid === state.buildGconvSessionId(cid) && call.message.includes("<orchestration-resume>"),
    );
    expect(commanderResume?.message).toContain("HERMES-AUDIT-RESULT");

    const lines = fs
      .readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines.some((message: any) => String(message.text || "").includes("CODEX-REVIEW-RESULT"))).toBe(true);
  }, 15_000);
});

describe("group_chat bus integration › Task 5 Wake rejection", () => {
  it("rejects a real wake-gated handoff only after cancelling its exact workflow step", async () => {
    process.env.COGSEED_P3394_WAKE_GATE = "1";
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const wakeController =
      await import("../../../../src/main/features/p3394/wake-controller");
    const wakeService =
      await import("../../../../src/main/features/p3394/wake-service");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const agentId = "rejectagent01";
    const agentName = "RejectAgent";
    const agentDir = paths.agentDir(TEST_UID, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "agent.json"),
      JSON.stringify({
        agent_id: agentId,
        name: agentName,
        description: "reject test agent",
        workflow: "test",
        created_at: "t",
        updated_at: "t",
      }),
    );
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: agentName, message: "Do the gated work" },
      },
      { type: "final", text: "Waiting for decision" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Start gated work",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const [request] = await wakeService.listWakeRequests(TEST_UID, cid);
    expect(request?.workflow_step_id).toMatch(/^wstep-/);
    const rejected = await wakeController.decideWakeRequest(TEST_UID, {
      requestId: request!.id,
      decision: "reject",
      reason: "not now",
    });
    expect(rejected).toMatchObject({
      ok: true,
      dispatched: false,
      request: { status: "rejected" },
    });
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(
      run?.steps.find((step) => step.id === request!.workflow_step_id)?.status,
    ).toBe("skipped");
  });
});

describe("group_chat bus integration › Task 5 anonymous resume capability", () => {
  it("rejects a cross-swapped anonymous resume token and step pair", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const created = await collaboration.createWorkflowRun(TEST_UID, cid, {
      objective: "Cross swap",
      created_by: "commander",
    });
    await collaboration.applyContextPatch(TEST_UID, cid, created.context.id, {
      added_by: "one",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Direct" },
      ],
    });
    await collaboration.applyContextPatch(TEST_UID, cid, created.context.id, {
      added_by: "two",
      decisions_proposed: [
        { conflict_key: "market.entry_mode", text: "Partner" },
      ],
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "Identical anonymous task",
          context_dependencies: ["market.entry_mode"],
        },
      },
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "Identical anonymous task",
          context_dependencies: ["market.entry_mode"],
        },
      },
      { type: "final", text: "both blocked" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Cross swap",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);
    const blocked = _recordedToolResults
      .filter((result) => result.name === "run_worker")
      .map((result) => JSON.parse(result.content));
    expect(blocked).toHaveLength(2);
    expect(blocked[0].resume_token).toMatch(/^wcap-/);
    expect(blocked[1].resume_token).toMatch(/^wcap-/);
    expect(blocked[0].resume_token).not.toBe(blocked[1].resume_token);

    const context = await collaboration.readActiveSharedTaskContext(
      TEST_UID,
      cid,
    );
    const conflict = context!.conflicts[0];
    const selected = context!.proposals.find(
      (proposal) => proposal.text === "Partner",
    )!;
    await collaboration.resolveContextConflictById(
      TEST_UID,
      cid,
      context!.id,
      conflict.id,
      {
        decision: "accept",
        selected_proposal_ids: [selected.id],
        text: selected.text,
        resolved_by: "commander",
      },
    );
    _recordedToolResults.length = 0;
    const workerCallsBefore = _recordedCalls.filter((call) =>
      call.sid.startsWith("gworker-"),
    ).length;
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "Identical anonymous task",
          context_dependencies: ["market.entry_mode"],
          resume_step_id: blocked[0].workflow_step_id,
          resume_token: blocked[1].resume_token,
        },
      },
      { type: "final", text: "cross swap rejected" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "Cross swap retry",
    });
    await waitForQuiescent(TEST_UID, cid, 2000);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(
      run?.steps.find((step) => step.id === blocked[0].workflow_step_id)
        ?.status,
    ).toBe("pending");
    expect(
      _recordedCalls.filter((call) => call.sid.startsWith("gworker-")).length,
    ).toBe(workerCallsBefore);
  });
});

describe("group_chat bus integration › Task 5 actor-turn settlement wrapper", () => {
  it("settles an unavailable nested agent exactly once", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const paths = await import("../../../../src/main/paths");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "become unavailable" },
      },
      { type: "final", text: "handled unavailable agent" },
    ]);
    bus._setActorTurnPreBodyHookForTest(async (_runtime, actor) => {
      if (actor.id === AGENT_ID)
        fs.rmSync(path.join(paths.agentDir(TEST_UID, AGENT_ID), "agent.json"), {
          force: true,
        });
    });
    try {
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "test unavailable",
      });
      await waitForQuiescent(TEST_UID, cid, 3000);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
    }
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.status).toBe("completed");
    expect(run?.steps[0]?.attempts).toMatchObject([
      {
        attempt: 1,
        actor_id: AGENT_ID,
        status: "failed",
        failure_code: "dependency_failed",
      },
      {
        attempt: 2,
        actor_id: null,
        actor_kind: "anonymous_worker",
        status: "completed",
      },
    ]);
    const events = await collaboration.readCollaborationEvents(
      TEST_UID,
      cid,
      0,
    );
    expect(
      events.filter(
        (event) =>
          event.type === "step_completed" &&
          event.step_id === run?.steps[0]?.id,
      ),
    ).toHaveLength(1);
  });

  it("settles a pre-stream failure exactly once", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "pre-stream failure" },
      },
      { type: "final", text: "handled pre-stream failure" },
    ]);
    bus._setActorTurnPreBodyHookForTest(async (_runtime, actor) => {
      if (actor.kind === "worker") throw new Error("forced pre-stream failure");
    });
    try {
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "test pre-stream failure",
      });
      await waitForQuiescent(TEST_UID, cid, 3000);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
    }
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.status).toBe("failed");
  });

  it("settles a thrown model failure exactly once", async () => {
    const cid = newCid();
    const state =
      await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "throw model" },
      },
      { type: "final", text: "handled model throw" },
    ]);
    _setScript("gworker-*", [
      { type: "__throw__", message: "forced model throw" },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "test model throw",
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    expect(run?.steps[0]?.status).toBe("failed");
    const events = await collaboration.readCollaborationEvents(
      TEST_UID,
      cid,
      0,
    );
    expect(
      events.filter(
        (event) =>
          event.type === "step_completed" &&
          event.step_id === run?.steps[0]?.id,
      ),
    ).toHaveLength(1);
  });


  it("redacts nested settlement and final-settlement failures", async () => {
    const cid = newCid();
    const settlementSecret =
      "SECRET_SETTLEMENT /Users/private/workflow-token.json token=raw";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration =
      await import("../../../../src/main/features/group_chat/collaboration");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "force settlement logging" },
      },
      { type: "final", text: "handled settlement failure" },
    ]);
    bus._setActorTurnPreBodyHookForTest(async (_runtime, actor) => {
      if (actor.kind === "worker") throw new Error("pre-body infrastructure");
    });
    bus._setFinishNestedDispatchStepForTest(async () => {
      throw new Error(settlementSecret);
    });

    try {
      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "exercise settlement log privacy",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
    } finally {
      bus._setActorTurnPreBodyHookForTest(null);
      bus._setFinishNestedDispatchStepForTest(null);
    }

    const allLogs = JSON.stringify([
      loggerMocks.debug.mock.calls,
      loggerMocks.info.mock.calls,
      loggerMocks.warn.mock.calls,
      loggerMocks.error.mock.calls,
    ]);
    expect(allLogs).not.toContain(settlementSecret);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const stepId = run?.steps[0]?.id || "";
    const settlementLogs = loggerMocks.warn.mock.calls.filter(([message]) =>
      [
        "nested workflow step settlement failed",
        "nested workflow step final settlement failed",
      ].includes(String(message)),
    );
    expect(settlementLogs).toHaveLength(2);
    for (const [, data] of settlementLogs) {
      expect(data?.cid).not.toBe(cid);
      expect(data?.step_id).not.toBe(stepId);
      expect(data?.error).toBeTruthy();
      expect(JSON.stringify(data)).not.toContain(settlementSecret);
    }
  });

  it.each([1, 2])(
    "repairs the actor turn after %i forced finish persistence failure(s)",
    async (failures) => {
      const cid = newCid();
      const state =
        await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      const collaboration =
        await import("../../../../src/main/features/group_chat/collaboration");
      let attempts = 0;
      bus._setFinishNestedDispatchStepForTest(
        async (uid, conversationId, stepId, input) => {
          attempts += 1;
          if (attempts <= failures)
            throw new Error(`forced finish failure ${attempts}`);
          return collaboration.finishNestedDispatchStep(
            uid,
            conversationId,
            stepId,
            input,
          );
        },
      );
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool__",
          name: "run_worker",
          input: { task: `finish retry ${failures}` },
        },
        { type: "final", text: "finish repaired" },
      ]);
      _setScript("gworker-*", [
        { type: "final", text: `finish result ${failures}` },
      ]);
      try {
        await bus.enqueue({
          uid: TEST_UID,
          cid,
          fromActorId: "user",
          text: `finish retry ${failures}`,
        });
        await waitForQuiescent(TEST_UID, cid, 3000);
      } finally {
        bus._setFinishNestedDispatchStepForTest(null);
      }
      expect(attempts).toBe(failures + 1);
      const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
      expect(run?.steps[0]?.status).toBe("completed");
      const events = await collaboration.readCollaborationEvents(
        TEST_UID,
        cid,
        0,
      );
      expect(
        events.filter(
          (event) =>
            event.type === "step_completed" &&
            event.step_id === run?.steps[0]?.id,
        ),
      ).toHaveLength(1);
    },
  );
});

describe("group_chat bus integration › coordinator access admission", () => {
  function installHeldWorker(
    state: typeof import("../../../../src/main/features/group_chat/state"),
    label: string,
    probe: {
      active: number;
      maxActive: number;
      starts: string[];
      releases: Array<() => void>;
    },
  ): void {
    _setScript("gworker-*", [
      {
        type: "delta",
        text: `${label}-started`,
        afterYield: () =>
          new Promise<void>((resolve) => {
            probe.active += 1;
            probe.maxActive = Math.max(probe.maxActive, probe.active);
            probe.starts.push(label);
            let released = false;
            probe.releases.push(() => {
              if (released) return;
              released = true;
              probe.active -= 1;
              resolve();
            });
          }),
      },
      { type: "final", text: `${label}-done` },
    ]);
  }

  it("exposes dependency, capability, and access fields on every dispatch schema", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    _setScript(state.buildGconvSessionId(cid), [
      { type: "__capture_tool_definitions__" },
      { type: "final", text: "captured" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "inspect tools" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    for (const name of ["dispatch_to", "hand_off_to", "run_worker"]) {
      const tool = _recordedToolDefinitions.find((candidate) => candidate.name === name);
      expect(tool).toBeTruthy();
      expect(tool?.inputSchema.properties).toMatchObject({
        depends_on: { type: "array", items: { type: "string" } },
        required_capabilities: { type: "array", items: { type: "string" } },
        access_mode: { type: "string", enum: ["read", "write"] },
        write_scopes: { type: "array", items: { type: "string" } },
      });
      expect(tool?.description).toContain("access_mode: read");
      expect(tool?.description).toContain("workspace-relative paths");
      expect(tool?.description).toContain("defaults to `write`");
      expect(tool?.description).toContain("workflow step ids returned");
    }
  });

  it("runs three explicit reads concurrently and makes a fourth wait for dispatchSlots", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const probe = { active: 0, maxActive: 0, starts: [] as string[], releases: [] as Array<() => void> };
    for (const label of ["read-1", "read-2", "read-3", "read-4"])
      installHeldWorker(state, label, probe);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: ["read-1", "read-2", "read-3", "read-4"].map((task) => ({
          name: "run_worker",
          input: { task, access_mode: "read" },
        })),
      },
      { type: "final", text: "reads complete" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "read four things" });
    expect(await waitUntil(() => probe.starts.length >= 3, 3000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const initialStarts = [...probe.starts];
    const initialMax = probe.maxActive;
    probe.releases.shift()?.();
    expect(await waitUntil(() => probe.starts.length === 4, 3000)).toBe(true);
    while (probe.releases.length) probe.releases.shift()?.();
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(initialMax).toBe(3);
    expect(initialStarts).toEqual(["read-1", "read-2", "read-3"]);
    expect(probe.maxActive).toBe(3);
  }, 12_000);

  it("serializes overlapping writes", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const probe = { active: 0, maxActive: 0, starts: [] as string[], releases: [] as Array<() => void> };
    installHeldWorker(state, "write-1", probe);
    installHeldWorker(state, "write-2", probe);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: ["write-1", "write-2"].map((task) => ({
          name: "run_worker",
          input: { task, access_mode: "write", write_scopes: ["shared"] },
        })),
      },
      { type: "final", text: "writes complete" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "write shared state" });
    expect(await waitUntil(() => probe.starts.length >= 1, 3000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const initialStarts = probe.starts.length;
    probe.releases.shift()?.();
    expect(await waitUntil(() => probe.starts.length === 2, 3000)).toBe(true);
    while (probe.releases.length) probe.releases.shift()?.();
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(initialStarts).toBe(1);
    expect(probe.maxActive).toBe(1);
  }, 12_000);

  it("allows disjoint writes to overlap", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const probe = { active: 0, maxActive: 0, starts: [] as string[], releases: [] as Array<() => void> };
    installHeldWorker(state, "left", probe);
    installHeldWorker(state, "right", probe);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: [
          { name: "run_worker", input: { task: "left", access_mode: "write", write_scopes: ["left"] } },
          { name: "run_worker", input: { task: "right", access_mode: "write", write_scopes: ["right"] } },
        ],
      },
      { type: "final", text: "disjoint writes complete" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "write disjoint state" });
    expect(await waitUntil(() => probe.starts.length === 2, 3000)).toBe(true);
    expect(probe.maxActive).toBe(2);
    while (probe.releases.length) probe.releases.shift()?.();
    await waitForQuiescent(TEST_UID, cid, 4000);
  }, 12_000);

  it("serializes symlink aliases including prospective children", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const { getConversationWorkspacePath } = await import("../../../../src/main/features/group_chat/conv_workspace");
    const workingDir = await getConversationWorkspacePath(TEST_UID, cid);
    const target = path.join(workingDir, "scope-target");
    const alias = path.join(workingDir, "scope-alias");
    fs.mkdirSync(target, { recursive: true });
    try { fs.symlinkSync(target, alias, "dir"); }
    catch { return; }
    const probe = { active: 0, maxActive: 0, starts: [] as string[], releases: [] as Array<() => void> };
    installHeldWorker(state, "canonical-target", probe);
    installHeldWorker(state, "canonical-alias", probe);
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: [
          {
            name: "run_worker",
            input: {
              task: "canonical-target",
              access_mode: "write",
              write_scopes: ["scope-target/future"],
            },
          },
          {
            name: "run_worker",
            input: {
              task: "canonical-alias",
              access_mode: "write",
              write_scopes: ["scope-alias/future/child"],
            },
          },
        ],
      },
      { type: "final", text: "aliases complete" },
    ]);

    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "write aliases" });
      expect(await waitUntil(() => probe.starts.length >= 1, 3000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const initialStarts = probe.starts.length;
      probe.releases.shift()?.();
      expect(await waitUntil(() => probe.starts.length === 2, 3000)).toBe(true);
      while (probe.releases.length) probe.releases.shift()?.();
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(initialStarts).toBe(1);
      expect(probe.maxActive).toBe(1);
    } finally {
      while (probe.releases.length) probe.releases.shift()?.();
      fs.rmSync(alias, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  }, 12_000);

  it("keeps a queued group-aborted step pending until terminal cancellation", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const { getConversationWorkspacePath } = await import("../../../../src/main/features/group_chat/conv_workspace");
    const workingDir = await getConversationWorkspacePath(TEST_UID, cid);
    const { canonicalizePath } = await import("../../../../src/main/util/path-sandbox");
    const admissionRoot = path.parse(canonicalizePath(workingDir)).root;
    bus.subscribe(TEST_UID, cid, () => {});
    const admission = (bus._cidStateForTest(TEST_UID, cid) as any).accessAdmission;
    const releaseActive = await admission.acquire({ mode: "write", scopes: [admissionRoot] });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "queued-only", access_mode: "write" },
      },
    ]);
    _setScript("gworker-*", [{ type: "final", text: "MUST NOT EXECUTE" }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "queue then abort" });
    expect(await waitUntil(() => admission.waiters.length === 1, 3000)).toBe(true);
    const queuedRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const queuedStep = queuedRun?.steps.find((step) => step.dispatch_intent === "queued-only");
    const statusWhileQueued = queuedStep?.status;
    await bus.abort(TEST_UID, cid);
    releaseActive();
    await waitForQuiescent(TEST_UID, cid, 4000);

    const settledRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const settled = settledRun?.steps.find((step) => step.id === queuedStep?.id);
    expect(statusWhileQueued).toBe("pending");
    expect(settled).toMatchObject({ status: "skipped" });
    expect(settled?.attempts || []).toHaveLength(0);
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    expect(loggerMocks.info.mock.calls.filter(([message]) => message === "coordinator transition")).toHaveLength(0);
    const stateFile = await state.readState(TEST_UID, cid);
    expect(stateFile.active_recipient).toBeUndefined();
    expect(stateFile.orchestration_ledger).toBeUndefined();
  }, 12_000);

  it("terminally settles an onVisible infrastructure throw after start", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const sentinel = "RAW_VISIBLE_SENTINEL /private/path token=secret";
    (bus as any)._setBeforeVisibleDispatchForTest?.(() => {
      throw new Error(sentinel);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: {
          to: AGENT_NAME,
          message: "visible-infrastructure-failure",
          access_mode: "read",
        },
      },
      { type: "final", text: "commander recovered" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "MUST NOT EXECUTE" },
    ]);

    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "visible failure" });
      await waitForQuiescent(TEST_UID, cid, 4000);
    } finally {
      (bus as any)._setBeforeVisibleDispatchForTest?.(null);
    }

    expect(_recordedToolErrors).toContainEqual({
      name: "dispatch_to",
      nameOfError: "Error",
      message: "nested dispatch infrastructure failed",
    });
    expect(JSON.stringify(_recordedToolErrors)).not.toContain(sentinel);
    expect(
      _recordedCalls.filter(
        (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
      ),
    ).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const step = run?.steps.find(
      (candidate) =>
        candidate.dispatch_intent === "visible-infrastructure-failure",
    );
    expect(step).toMatchObject({
      status: "failed",
      result_summary: "Nested dispatch infrastructure failed.",
    });
    expect(step?.attempts || []).toHaveLength(0);
    const context = await collaboration.readActiveSharedTaskContext(TEST_UID, cid);
    expect(context?.gates.filter((gate) => gate.step_id === step?.id)).toHaveLength(1);
    const events = await collaboration.readCollaborationEvents(TEST_UID, cid, 0);
    for (const type of ["step_started", "step_completed", "gate_recorded"]) {
      expect(
        events.filter(
          (event) => event.type === type && event.step_id === step?.id,
        ),
      ).toHaveLength(1);
    }
    expect((bus._cidStateForTest(TEST_UID, cid) as any)?.accessAdmission?.active).toHaveLength(0);
    expect(loggerMocks.info.mock.calls.filter(([message]) => message === "coordinator transition")).toHaveLength(0);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBeUndefined();
  }, 12_000);

  it("propagates a stable invariant when post-start infrastructure settlement fails", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const sentinel = "RAW_POST_START_SETTLEMENT_SENTINEL /private/path";
    (bus as any)._setBeforeVisibleDispatchForTest?.(() => {
      throw new Error("RAW_VISIBLE_TRIGGER");
    });
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      settleInfrastructure: async () => {
        throw new Error(sentinel);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "dispatch_to",
        input: { to: AGENT_NAME, message: "persistent-post-start", access_mode: "read" },
      },
      { type: "final", text: "commander observed failure" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "MUST NOT EXECUTE" },
    ]);

    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "persistent post-start" });
      await waitForQuiescent(TEST_UID, cid, 4000);
    } finally {
      (bus as any)._setBeforeVisibleDispatchForTest?.(null);
      (bus as any)._setNestedDispatchAttemptHooksForTest(null);
    }

    expect(_recordedToolErrors).toContainEqual({
      name: "dispatch_to",
      nameOfError: "Error",
      message: "nested dispatch infrastructure settlement failed",
    });
    expect(JSON.stringify(_recordedToolErrors)).not.toContain(sentinel);
    expect(
      _recordedCalls.filter(
        (call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID),
      ),
    ).toHaveLength(0);
    const logs = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(logs).toContain("nested dispatch infrastructure settlement invariant");
    expect(logs).not.toContain(sentinel);
  }, 12_000);

  it("propagates a stable failure when queued abort settlement cannot be established", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const { getConversationWorkspacePath } = await import("../../../../src/main/features/group_chat/conv_workspace");
    const { canonicalizePath } = await import("../../../../src/main/util/path-sandbox");
    const workingDir = await getConversationWorkspacePath(TEST_UID, cid);
    const admissionRoot = path.parse(canonicalizePath(workingDir)).root;
    const sentinel = "RAW_CANCEL_SENTINEL /private/path token=secret";
    bus.subscribe(TEST_UID, cid, () => {});
    const admission = (bus._cidStateForTest(TEST_UID, cid) as any).accessAdmission;
    const releaseActive = await admission.acquire({ mode: "write", scopes: [admissionRoot] });
    (bus as any)._setNestedDispatchAttemptHooksForTest({
      settleAbort: async () => {
        throw new Error(sentinel);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "persistent-cancel-failure", access_mode: "write" },
      },
    ]);
    _setScript("gworker-*", [{ type: "final", text: "MUST NOT EXECUTE" }]);

    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "abort with failed settlement" });
      expect(await waitUntil(() => admission.waiters.length === 1, 3000)).toBe(true);
      await bus.abort(TEST_UID, cid);
      releaseActive();
      await waitForQuiescent(TEST_UID, cid, 4000);
    } finally {
      (bus as any)._setNestedDispatchAttemptHooksForTest(null);
    }

    expect(_recordedToolErrors).toContainEqual({
      name: "run_worker",
      nameOfError: "Error",
      message: "queued nested dispatch cancellation settlement failed",
    });
    expect(JSON.stringify(_recordedToolErrors)).not.toContain(sentinel);
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const step = run?.steps.find((candidate) => candidate.dispatch_intent === "persistent-cancel-failure");
    expect(step).toMatchObject({ status: "pending" });
    expect(step?.attempts || []).toHaveLength(0);
    const allLogs = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(allLogs).toContain("queued nested dispatch cancellation settlement invariant");
    expect(allLogs).not.toContain(sentinel);
  }, 12_000);

  it("aborts a queued conflicting request without executing it", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tools_parallel__",
        calls: [
          { name: "run_worker", input: { task: "active write", access_mode: "write", write_scopes: ["shared"] } },
          { name: "run_worker", input: { task: "queued write", access_mode: "write", write_scopes: ["shared"] } },
        ],
      },
    ]);
    _setScript("gworker-*", [{ type: "__wait_for_abort__" }]);
    _setScript("gworker-*", [{ type: "final", text: "MUST NOT EXECUTE" }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "abort queued write" });
    expect(
      await waitUntil(
        () => _recordedCalls.some((call) => call.sid.startsWith("gworker-")),
        3000,
      ),
    ).toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(1);
    expect(JSON.stringify(_recordedCalls)).not.toContain("MUST NOT EXECUTE");
    expect((bus._cidStateForTest(TEST_UID, cid) as any)?.accessAdmission?.waiters).toHaveLength(0);
  }, 12_000);

  it("returns a privacy-safe blocked result for incomplete dependencies without executing", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "SECRET task text",
          depends_on: ["wstep-missing"],
          access_mode: "read",
        },
      },
      { type: "final", text: "blocked" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "dependency gate" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const result = JSON.parse(_recordedToolResults.find((entry) => entry.name === "run_worker")!.content);
    expect(result).toEqual({
      ok: false,
      status: "dispatch_blocked_by_dependencies",
      workflow_step_id: expect.stringMatching(/^wstep-/),
      resume_token: expect.stringMatching(/^wcap-/),
      missing_dependencies: ["wstep-missing"],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
  });

  it("rejects every malformed write scope declaration without admission or dispatch", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const malformed = [
      "src",
      "",
      "   ",
      1,
      true,
      {},
      null,
      [1],
      [true],
      [{}],
      [null],
      [""],
      ["   "],
      ["src", null],
    ];
    _setScript(state.buildGconvSessionId(cid), [
      ...malformed.map((writeScopes, index) => ({
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: `malformed-${index}`,
          access_mode: "write",
          write_scopes: writeScopes,
        },
      })),
      { type: "final", text: "rejected" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "invalid scopes" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const results = _recordedToolResults
      .filter((entry) => entry.name === "run_worker")
      .map((entry) => JSON.parse(entry.content));
    expect(results).toHaveLength(malformed.length);
    expect(results.map((result) => result.error)).toEqual(
      malformed.map(() => "write_scopes must be an array of non-empty strings"),
    );
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    const admission = (bus._cidStateForTest(TEST_UID, cid) as any)?.accessAdmission;
    expect(admission?.active).toHaveLength(0);
    expect(admission?.waiters).toHaveLength(0);
  });

  it("rejects an escaping scope without widening to the workspace", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "escape",
          access_mode: "write",
          write_scopes: ["../outside"],
        },
      },
      { type: "final", text: "rejected" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "escaping scope" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const result = JSON.parse(
      _recordedToolResults.find((entry) => entry.name === "run_worker")!.content,
    );
    expect(result.error).toBe(
      "write_scopes must stay inside the conversation workspace",
    );
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
  });

  it("uses the locked start boundary when a dependency changes after prepare", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const storage = await import("../../../../src/main/storage");
    const dependency = await collaboration.prepareNestedDispatchStep(TEST_UID, cid, {
      objective: "Dependency race",
      actor_id: "agent-dependency",
      source_tool: "dispatch_to",
      task: "Dependency",
    });
    await collaboration.startPreparedNestedDispatchStep(TEST_UID, cid, dependency.step.id);
    await collaboration.finishNestedDispatchStep(TEST_UID, cid, dependency.step.id, {
      result: "complete before prepare",
    });
    let raced = false;
    (bus as any)._setBeforeNestedDispatchStartForTest?.(async () => {
      if (raced) return;
      raced = true;
      const runFile = collaboration
        .collaborationPaths(TEST_UID, cid)
        .runFile(dependency.run.id);
      const run = await storage.readJson<any>(runFile);
      const storedDependency = run.steps.find(
        (step: any) => step.id === dependency.step.id,
      );
      storedDependency.status = "pending";
      delete storedDependency.completed_at;
      await storage.writeJson(runFile, run);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: {
          task: "must be blocked by the actual start",
          depends_on: [dependency.step.id],
          access_mode: "read",
        },
      },
      { type: "final", text: "blocked" },
    ]);
    _setScript("gworker-*", [{ type: "final", text: "MUST NOT EXECUTE" }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "race dependency" });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(raced).toBe(true);
    const result = JSON.parse(
      _recordedToolResults.find((entry) => entry.name === "run_worker")!.content,
    );
    expect(result).toMatchObject({
      ok: false,
      status: "dispatch_blocked_by_dependencies",
      missing_dependencies: [dependency.step.id],
    });
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const dependent = run?.steps.find((step) => step.id === result.workflow_step_id);
    expect(dependent).toMatchObject({ status: "pending" });
    expect(dependent?.attempts || []).toHaveLength(0);
  });

  it("does not move handoff floor or ledger before queued admission", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const paths = await import("../../../../src/main/paths");
    const { getConversationWorkspacePath } = await import("../../../../src/main/features/group_chat/conv_workspace");
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), "agent.json");
    const agent = JSON.parse(fs.readFileSync(agentFile, "utf8"));
    fs.writeFileSync(agentFile, JSON.stringify({ ...agent, interactive: true }), "utf8");
    const workingDir = await getConversationWorkspacePath(TEST_UID, cid);
    const { canonicalizePath } = await import("../../../../src/main/util/path-sandbox");
    const admissionRoot = path.parse(canonicalizePath(workingDir)).root;
    bus.subscribe(TEST_UID, cid, () => {});
    const admission = (bus._cidStateForTest(TEST_UID, cid) as any).accessAdmission;
    const releaseActive = await admission.acquire({ mode: "write", scopes: [admissionRoot] });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: AGENT_NAME,
          message: "queued-handoff",
          resume: "continue after handoff",
          access_mode: "write",
        },
      },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "MUST NOT EXECUTE" },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "queue handoff" });
    expect(await waitUntil(() => admission.waiters.length === 1, 3000)).toBe(true);
    const queuedState = await state.readState(TEST_UID, cid);
    const queuedRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const queuedStep = queuedRun?.steps.find((step) => step.dispatch_intent === "queued-handoff");
    await bus.abort(TEST_UID, cid);
    releaseActive();
    await waitForQuiescent(TEST_UID, cid, 4000);

    const settledRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const settled = settledRun?.steps.find((step) => step.id === queuedStep?.id);
    expect(queuedStep?.status).toBe("pending");
    expect(queuedState.active_recipient).toBeUndefined();
    expect(queuedState.orchestration_ledger).toBeUndefined();
    expect(settled).toMatchObject({ status: "skipped" });
    expect(settled?.attempts || []).toHaveLength(0);
    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(0);
  }, 12_000);

  it("dropConv terminally cancels a queued dispatch and a recreated cid admits normally", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const { getConversationWorkspacePath } = await import("../../../../src/main/features/group_chat/conv_workspace");
    const workingDir = await getConversationWorkspacePath(TEST_UID, cid);
    const { canonicalizePath } = await import("../../../../src/main/util/path-sandbox");
    const admissionRoot = path.parse(canonicalizePath(workingDir)).root;
    bus.subscribe(TEST_UID, cid, () => {});
    const oldState = bus._cidStateForTest(TEST_UID, cid) as any;
    const admission = oldState.accessAdmission;
    const releaseActive = await admission.acquire({ mode: "write", scopes: [admissionRoot] });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "run_worker",
        input: { task: "drop-queued", access_mode: "write" },
      },
    ]);
    _setScript("gworker-*", [{ type: "final", text: "MUST NOT EXECUTE" }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "queue then drop" });
    expect(await waitUntil(() => admission.waiters.length === 1, 3000)).toBe(true);
    const queuedRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const queuedStep = queuedRun?.steps.find((step) => step.dispatch_intent === "drop-queued");
    const statusWhileQueued = queuedStep?.status;
    await bus.dropConv(TEST_UID, cid);
    releaseActive();

    const settledRun = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const settled = settledRun?.steps.find((step) => step.id === queuedStep?.id);
    expect(statusWhileQueued).toBe("pending");
    expect(settled).toMatchObject({ status: "skipped" });
    expect(settled?.attempts || []).toHaveLength(0);
    expect(_recordedCalls.filter((call) => call.sid.startsWith("gworker-"))).toHaveLength(0);
    expect(admission.waiters).toHaveLength(0);
    expect(bus._cidStateForTest(TEST_UID, cid)).toBeNull();

    bus.subscribe(TEST_UID, cid, () => {});
    const recreated = bus._cidStateForTest(TEST_UID, cid) as any;
    expect(recreated.accessAdmission).not.toBe(admission);
    const releaseRecreated = await recreated.accessAdmission.acquire({
      mode: "write",
      scopes: [workingDir],
    });
    releaseRecreated();
    expect(recreated.accessAdmission.active).toHaveLength(0);
  }, 12_000);
});

describe("group_chat bus integration › Task 10 transactional handoff finalization", () => {
  async function setAgentInteractive(agentId: string, interactive: boolean): Promise<void> {
    const paths = await import("../../../../src/main/paths");
    const file = path.join(paths.agentDir(TEST_UID, agentId), "agent.json");
    const agent = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...agent, interactive }), "utf8");
  }

  async function installFallback(input: {
    cid: string;
    id: string;
    name: string;
    interactive?: boolean;
  }): Promise<void> {
    await seedAgent({
      id: input.id,
      name: input.name,
      description: "final delivery recovery specialist",
      workflow: "recover final delivery",
    });
    if (input.interactive) await setAgentInteractive(input.id, true);
    await addAgentMember(input.cid, input.id, input.name);
  }

  function handoffResult() {
    return _recordedToolResults.find((result) => result.name === "hand_off_to");
  }

  it("commits the recovered interactive fallback as the floor and waiting-ledger owner", async () => {
    const cid = newCid();
    const fallbackId = "a101a101a101";
    const fallbackName = "RecoveryGuide";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await setAgentInteractive(AGENT_ID, true);
    await installFallback({ cid, id: fallbackId, name: fallbackName, interactive: true });
    installFirstAttemptCoordinatorAbort(bus);
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: {
        to: AGENT_NAME,
        message: "recover final delivery",
        resume: "Continue the original goal after the guide hands back.",
        required_capabilities: ["recovery"],
      },
    }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "__wait_for_abort__" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "error", text: "retry failed" }]);
    _setScript(state.buildGmemberSessionId(cid, fallbackId), [{ type: "final", text: "fallback delivered" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "deliver with recovery" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBe(fallbackId);
    expect(persisted.orchestration_ledger).toMatchObject({
      status: "waiting_for_agent",
      owner_agent_id: fallbackId,
      owner_agent_name: fallbackName,
      handoff_message: "recover final delivery",
      resume_instruction: "Continue the original goal after the guide hands back.",
    });
    expect(handoffResult()?.endTurn).toBe(true);
    expect(handoffResult()?.isError).toBeUndefined();
  });

  it("leaves Commander with no waiting ledger or terminal delivery when recovery exhausts", async () => {
    const cid = newCid();
    const fallbackId = "a202a202a202";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await setAgentInteractive(AGENT_ID, true);
    await installFallback({ cid, id: fallbackId, name: "FailedFallback", interactive: true });
    installFirstAttemptCoordinatorAbort(bus);
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => { terminalCalls += 1; });
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: { to: AGENT_NAME, message: "exhaust handoff", resume: "resume later" },
    }, { type: "final", text: "Commander retained control" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "__wait_for_abort__" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "error", text: "retry failed" }]);
    _setScript(state.buildGmemberSessionId(cid, fallbackId), [{ type: "error", text: "fallback failed" }]);
    _setScript("gworker-*", [{ type: "error", text: "anonymous failed" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "exhaust all attempts" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBeUndefined();
    expect(persisted.orchestration_ledger).toBeUndefined();
    expect(terminalCalls).toBe(0);
    expect(handoffResult()?.endTurn).toBeUndefined();
    expect(handoffResult()?.isError).toBeUndefined();
    expect(handoffResult()?.content).toContain('failure_code="coordinator_exhausted"');
  });

  it("signals terminal handoff exactly once and only after final state is durable", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const { conversationLayout } = await import("../../../../src/main/util/project-layout");
    await setAgentInteractive(AGENT_ID, true);
    const committedSnapshots: any[] = [];
    (bus as any)._setTerminalHandoffObserverForTest?.(() => {
      committedSnapshots.push(JSON.parse(fs.readFileSync(conversationLayout(TEST_UID, cid).stateFile, "utf8")));
    });
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: { to: AGENT_NAME, message: "durable terminal", resume: "resume after reply" },
    }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "final", text: "durable reply" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "commit before terminal" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(committedSnapshots).toHaveLength(1);
    expect(committedSnapshots[0]).toMatchObject({
      active_recipient: AGENT_ID,
      orchestration_ledger: { owner_agent_id: AGENT_ID, status: "waiting_for_agent" },
    });
    expect(handoffResult()?.endTurn).toBe(true);
  });

  it("pauses on a recovered fallback form with the actual actor owning floor and form ledger", async () => {
    const cid = newCid();
    const fallbackId = "a303a303a303";
    const fallbackName = "FormRecovery";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await setAgentInteractive(AGENT_ID, true);
    await installFallback({ cid, id: fallbackId, name: fallbackName });
    installFirstAttemptCoordinatorAbort(bus);
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => { terminalCalls += 1; });
    const formPayload = {
      fields: [{ id: "topic", label: "Topic", type: "text", required: true }],
    };
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: {
        to: AGENT_NAME,
        message: "recover and collect input",
        resume: "finish after form",
        required_capabilities: ["recovery"],
      },
    }, { type: "final", text: "paused for form" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "__wait_for_abort__" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "error", text: "retry failed" }]);
    _setScript(state.buildGmemberSessionId(cid, fallbackId), [{
      type: "final",
      text: `Need input.\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
    }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "recover to a form" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBe(fallbackId);
    expect(persisted.orchestration_ledger).toMatchObject({
      status: "waiting_for_form",
      blocked_on: "agent_form",
      owner_agent_id: fallbackId,
      owner_agent_name: fallbackName,
    });
    expect(handoffResult()?.content).toContain(`<blocked-on-form form_id="${persisted.orchestration_ledger?.form_id}" agent_id="${fallbackId}" />`);
    expect(handoffResult()?.endTurn).toBeUndefined();
    expect(terminalCalls).toBe(0);
    expect(
      _recordedCalls.filter((call) => call.sid.startsWith("gworker-")),
    ).toHaveLength(0);
  });

  it("restores Commander after successful final delivery by a noninteractive named Agent", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    (bus as any)._setBeforeVisibleDispatchForTest(async () => {
      await state.setActiveRecipient(TEST_UID, cid, AGENT_ID);
    });
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: { to: AGENT_NAME, message: "one-shot final" },
    }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "final", text: "one-shot delivered" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "force commander final",
      forceTo: ["commander"],
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect((await state.readState(TEST_UID, cid)).active_recipient).toBeUndefined();
    expect(handoffResult()?.endTurn).toBe(true);
  });

  it("rejects a successful anonymous final outcome without assigning it the floor", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    installFirstAttemptCoordinatorAbort(bus);
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => { terminalCalls += 1; });
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: { to: AGENT_NAME, message: "anonymous cannot own final" },
    }, { type: "final", text: "Commander handles invalid final actor" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "__wait_for_abort__" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "error", text: "retry failed" }]);
    _setScript("gworker-*", [{ type: "final", text: "anonymous success" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "do not hand floor to anonymous" });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect((await state.readState(TEST_UID, cid)).active_recipient).toBeUndefined();
    expect(handoffResult()).toMatchObject({
      content: JSON.stringify({ ok: false, error: "Handoff final delivery requires a named Agent." }),
      isError: true,
    });
    expect(handoffResult()?.endTurn).toBeUndefined();
    expect(terminalCalls).toBe(0);
  });

  it("rolls back a failed post-reply state commit and logs restoration failures without private data", async () => {
    const cid = newCid();
    const secret = "SECRET task /private/path RecoveryGuide raw error";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await setAgentInteractive(AGENT_ID, true);
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => { terminalCalls += 1; });
    (bus as any)._setHandoffStateHooksForTest?.({
      commitHandoffState: async (...args: Parameters<typeof state.commitHandoffState>) => {
        const committed = await state.commitHandoffState(...args);
        throw Object.assign(new Error(secret), {
          rollbackToken: committed.rollbackToken,
        });
      },
      rollbackHandoffState: async (...args: Parameters<typeof state.rollbackHandoffState>) => {
        await state.rollbackHandoffState(...args);
        throw new Error(secret);
      },
    });
    _setScript(state.buildGconvSessionId(cid), [{
      type: "__call_tool__",
      name: "hand_off_to",
      input: { to: AGENT_NAME, message: secret, resume: "private resume" },
    }, { type: "final", text: "Commander recovered state failure" }]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{ type: "final", text: "successful Agent reply" }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: "user", text: "state transaction" });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBeUndefined();
    expect(persisted.orchestration_ledger).toBeUndefined();
    expect(handoffResult()).toMatchObject({
      content: JSON.stringify({ ok: false, error: "Handoff state could not be finalized safely." }),
      isError: true,
    });
    expect(handoffResult()?.endTurn).toBeUndefined();
    expect(terminalCalls).toBe(0);
    const handoffWarnings = loggerMocks.warn.mock.calls.filter(
      ([message]) => String(message).startsWith("handoff finalization"),
    );
    expect(handoffWarnings.map(([message]) => message)).toEqual([
      "handoff finalization state commit failed",
      "handoff finalization rollback failed",
    ]);
    expect(handoffWarnings[0]?.[1]).toMatchObject({
      cid: `${cid.slice(0, 4)}...${cid.slice(-4)}`,
      actor_id: `${AGENT_ID.slice(0, 4)}...${AGENT_ID.slice(-4)}`,
      error: {
        name: "Error",
        message: "Handoff durable finalization failed.",
      },
    });
    expect(handoffWarnings[1]?.[1]).toMatchObject({
      error: {
        name: "Error",
        message: "Handoff state rollback failed.",
      },
    });
    const warningText = JSON.stringify(handoffWarnings);
    expect(warningText).not.toContain(secret);
    expect(warningText).not.toContain("private resume");
    expect(warningText).not.toContain(AGENT_NAME);
    expect(warningText).not.toContain(AGENT_ID);
    expect(warningText).not.toContain(cid);
  });
});

describe("group_chat bus integration › Task 10 handoff finalization races", () => {
  async function makeInteractive(): Promise<void> {
    const paths = await import("../../../../src/main/paths");
    const file = path.join(paths.agentDir(TEST_UID, AGENT_ID), "agent.json");
    const agent = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...agent, interactive: true }), "utf8");
  }

  function resultForHandoff() {
    return _recordedToolResults.find((result) => result.name === "hand_off_to");
  }

  async function expectFailedFinalization(cid: string) {
    const state = await import("../../../../src/main/features/group_chat/state");
    const collaboration = await import("../../../../src/main/features/group_chat/collaboration");
    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBeUndefined();
    expect(persisted.orchestration_ledger).toBeUndefined();
    const run = await collaboration.readActiveWorkflowRun(TEST_UID, cid);
    const handoff = run?.steps.find((step) => step.source_tool === "hand_off_to");
    expect(handoff).toMatchObject({
      status: "failed",
      result_summary: "Handoff finalization failed.",
      attempts: [expect.objectContaining({ status: "completed" })],
    });
    expect(resultForHandoff()?.endTurn).toBeUndefined();
  }

  it.each(["before_commit", "during_write", "after_commit"] as const)(
    "rolls back and fails workflow when parent abort arrives $s",
    async (phase) => {
      const cid = newCid();
      const state = await import("../../../../src/main/features/group_chat/state");
      const bus = await import("../../../../src/main/features/group_chat/bus");
      await makeInteractive();
      let hookRan = false;
      let terminalCalls = 0;
      (bus as any)._setTerminalHandoffObserverForTest?.(() => {
        terminalCalls += 1;
      });
      const abortParent = () => {
        hookRan = true;
        abortRaceProbe.parentController?.abort({ kind: "parent_abort" });
      };
      if (phase === "before_commit") {
        (bus as any)._setBeforeHandoffStateCommitForTest?.(abortParent);
      } else if (phase === "during_write") {
        (state as any)._setHandoffStateWriteBoundaryHookForTest?.(
          async (boundary: string) => {
            if (boundary === "after_write") abortParent();
          },
        );
      } else {
        (bus as any)._setAfterHandoffStateCommitForTest?.(abortParent);
      }
      _setScript(state.buildGconvSessionId(cid), [
        {
          type: "__call_tool_parent_abort_controlled__",
          name: "hand_off_to",
          input: {
            to: AGENT_NAME,
            message: "finish before abort",
            resume: "resume after final Agent",
          },
        },
        { type: "final", text: "Commander retained control" },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: "final", text: "successful Agent result" },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "race finalization",
      });
      await waitForQuiescent(TEST_UID, cid, 5000);

      expect(hookRan).toBe(true);
      expect(terminalCalls).toBe(0);
      await expectFailedFinalization(cid);
    },
  );

  it("rolls back after drop begins between commit and terminal callback", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    await makeInteractive();
    let hookRan = false;
    let terminalCalls = 0;
    let dropPromise: Promise<void> | undefined;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => {
      terminalCalls += 1;
    });
    (bus as any)._setAfterHandoffStateCommitForTest?.(async () => {
      hookRan = true;
      dropPromise = bus.dropConv(TEST_UID, cid);
      expect(
        await waitUntil(
          () => (bus._cidStateForTest(TEST_UID, cid) as any)?.terminating === true,
          2000,
        ),
      ).toBe(true);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: AGENT_NAME,
          message: "finish before drop",
          resume: "resume after final Agent",
        },
      },
      { type: "final", text: "must not claim terminal delivery" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "successful Agent result" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "drop race",
    });
    expect(await waitUntil(() => hookRan, 5000)).toBe(true);
    await dropPromise;

    expect(hookRan).toBe(true);
    expect(terminalCalls).toBe(0);
    await expectFailedFinalization(cid);
  });

  it("keeps a form owner without inventing a Commander resume ledger when resume is omitted", async () => {
    const cid = newCid();
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => {
      terminalCalls += 1;
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: { to: AGENT_NAME, message: "collect direct form input" },
      },
      { type: "final", text: "paused" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: "final",
        text: `Need input.\n<agent-input-form>\n${JSON.stringify({
          fields: [
            { id: "topic", label: "Topic", type: "text", required: true },
          ],
        })}\n</agent-input-form>`,
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "ask directly",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const persisted = await state.readState(TEST_UID, cid);
    expect(persisted.active_recipient).toBe(AGENT_ID);
    expect(persisted.orchestration_ledger).toBeUndefined();
    expect(resultForHandoff()?.content).toContain("<blocked-on-form");
    expect(resultForHandoff()?.endTurn).toBeUndefined();
    expect(terminalCalls).toBe(0);
  });

  it("rolls back an atomic commit and fails workflow when resume enqueue fails", async () => {
    const cid = newCid();
    const secret = "RAW_ENQUEUE_FAILURE /private/path token=secret";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    let terminalCalls = 0;
    (bus as any)._setTerminalHandoffObserverForTest?.(() => {
      terminalCalls += 1;
    });
    (bus as any)._setBeforeHandoffResumeEnqueueForTest?.(() => {
      throw new Error(secret);
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: AGENT_NAME,
          message: "noninteractive final",
          resume: "continue Commander work",
        },
      },
      { type: "final", text: "Commander reports finalization failure" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "successful Agent result" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "enqueue failure",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(terminalCalls).toBe(0);
    await expectFailedFinalization(cid);
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(secret);
  });

  it("settles workflow failure even when CAS rollback cleanup fails", async () => {
    const cid = newCid();
    const secret = "RAW_ROLLBACK_FAILURE /private/path token=secret";
    const state = await import("../../../../src/main/features/group_chat/state");
    const bus = await import("../../../../src/main/features/group_chat/bus");
    (bus as any)._setHandoffStateHooksForTest?.({
      commitHandoffState: state.commitHandoffState,
      rollbackHandoffState: async () => {
        throw new Error(secret);
      },
    });
    (bus as any)._setBeforeHandoffResumeEnqueueForTest?.(() => {
      throw new Error("stable enqueue failure");
    });
    _setScript(state.buildGconvSessionId(cid), [
      {
        type: "__call_tool__",
        name: "hand_off_to",
        input: {
          to: AGENT_NAME,
          message: "rollback cleanup",
          resume: "continue Commander work",
        },
      },
      { type: "final", text: "Commander reports cleanup failure" },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: "final", text: "successful Agent result" },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "rollback cleanup failure",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const run = await (
      await import("../../../../src/main/features/group_chat/collaboration")
    ).readActiveWorkflowRun(TEST_UID, cid);
    expect(
      run?.steps.find((step) => step.source_tool === "hand_off_to"),
    ).toMatchObject({ status: "failed" });
    const handoffLogs = loggerMocks.warn.mock.calls.filter(([message]) =>
      String(message).startsWith("handoff finalization"),
    );
    expect(handoffLogs.map(([message]) => message)).toContain(
      "handoff finalization rollback failed",
    );
    expect(JSON.stringify(handoffLogs)).not.toContain(secret);
  });
});

describe("group_chat bus › desktop message broadcaster", () => {
  it("notifies the registered broadcaster for every persisted message and survives listener errors", async () => {
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const state = await import("../../../../src/main/features/group_chat/state");
    const cid = newCid();
    const seen: Array<Record<string, unknown>> = [];
    let first = true;
    bus.setGroupChatMessageBroadcaster((info) => {
      seen.push(info);
      if (first) {
        first = false;
        throw new Error("listener explosion must not break the bus");
      }
    });
    try {
      bus.subscribe(TEST_UID, cid, () => {});
      const msg = await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: "user",
        text: "广播探针",
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      // The first call threw; the same enqueue must still have delivered its
      // broadcast (fire-and-forget per call) and the turn must complete.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const info = seen.find((row) => row.msgId === msg.id);
      expect(info).toMatchObject({
        uid: TEST_UID,
        cid,
        from: state.USER_ID,
      });
    } finally {
      bus.setGroupChatMessageBroadcaster(null);
    }
  });

  it("stays silent when no broadcaster is registered", async () => {
    const bus = await import("../../../../src/main/features/group_chat/bus");
    const cid = newCid();
    bus.setGroupChatMessageBroadcaster(null);
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: "user",
      text: "静默探针",
    });
    await waitForQuiescent(TEST_UID, cid, 4000);
    // Reaching here without a throw is the assertion: an unset broadcaster
    // is the pre-fix steady state for external inbound paths.
  });
});

