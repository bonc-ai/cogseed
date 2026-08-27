/**
 * Local group-chat collaboration overview projection (COGSEED-61 phase 1).
 *
 * 本地群聊（commander-in-the-loop）的协作过程可视化投影：任务拆解与依赖、
 * 各 Agent 状态与贡献、上下文交接与结果回收、失败/重试/取消/降级聚合，
 * 以及终态自动协作汇总。只读投影 + 幂等汇总生成，不改引擎行为——引擎侧
 * 稳定性增强属并行任务（COGSEED 平台优化线）。
 *
 * 数据源（全部已有事实存储，无新增写入路径）：
 *   - collaboration/active.json → workflow run（steps/attempts/depends_on）
 *   - collaboration/<ctx>.json  → SharedTaskContext（agent_outputs/gates/…）
 *   - collaboration/events.jsonl → CollaborationEvent（重试/中止/上下文补丁）
 *   - <cid>.jsonl               → GroupMessage（dispatch/handback/失败/产出）
 *   - members.json              → 参与者名单
 *
 * 汇总生成是惰性的：投影查询发现 run 已到有效终态（全部步骤 completed/
 * skipped，或 run failed/cancelled）且尚无汇总时，才生成并落两处——
 * collaboration/summary.json（幂等标记）+ 一条 system_kind='collab_summary'
 * 群消息（持久化进 <cid>.jsonl，重启可见；经可见性切片分发给各 Agent，
 * 模型回放也能看到协作结论）。
 */

import * as path from "node:path";

import { conversationLayout } from "../../util/project-layout";
import { appendJsonlAtomic, genId12, nowIso, readJson, readJsonl, writeJson, safeId } from "../../storage";
import { createLogger } from "../../logger";

import {
  collaborationPaths,
  readActiveSharedTaskContext,
  readCollaborationEvents,
  readWorkflowRun,
} from "./collaboration";
import { readMembers, type Actor } from "./state";
import {
  appendVisible,
  type CollabSummaryRecord,
  type GroupMessage,
} from "./visibility";
import type {
  CollaborationEvent,
  SharedTaskContext,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
} from "../collaboration_control/types";

const log = createLogger("group_chat.collab_overview");

/** 消息尾部窗口大小：交接时间线与异常扫描只需要近期消息。 */
const MESSAGE_TAIL = 400;
/** 汇总正文与摘要的截断长度。 */
const SUMMARY_TEXT_LIMIT = 400;

// ── 快照类型 ───────────────────────────────────────────────────────────────

export interface CollabOverviewStep {
  id: string;
  title: string;
  type: string;
  status: string;
  actor_id: string | null;
  actor_name?: string;
  depends_on: string[];
  attempts: number;
  result_summary?: string;
  started_at?: string;
  completed_at?: string;
}

export type CollabActorState = "working" | "waiting" | "idle";

export interface CollabOverviewActor {
  id: string;
  name: string;
  kind: "commander" | "agent";
  state: CollabActorState;
  active_step_title?: string;
  steps_done: number;
  steps_failed: number;
  retries: number;
  last_ts?: string;
}

export interface CollabHandoff {
  ts: string;
  from: string;
  from_name?: string;
  to: string;
  to_name?: string;
  kind: "dispatch" | "handback" | "context_update";
  step_id?: string;
  note?: string;
}

export interface CollabOverviewOutput {
  actor_id: string;
  actor_name?: string;
  step_id?: string;
  summary: string;
  created_at: string;
}

export type CollabAnomalyKind = "failure" | "retry" | "cancel" | "degraded";

export interface CollabOverviewAnomaly {
  ts: string;
  kind: CollabAnomalyKind;
  actor_id?: string;
  step_id?: string;
  detail: string;
  /** 受影响的下游步骤（标题），失败传播的影响面。 */
  impact?: string[];
}

export interface CollabOverview {
  version: 1;
  cid: string;
  available: boolean;
  run: {
    id: string;
    objective: string;
    status: WorkflowRunStatus;
    phase: string;
    created_at: string;
    updated_at: string;
  };
  progress: {
    total: number;
    completed: number;
    running: number;
    pending: number;
    failed: number;
    skipped: number;
  };
  steps: CollabOverviewStep[];
  actors: CollabOverviewActor[];
  handoffs: CollabHandoff[];
  outputs: CollabOverviewOutput[];
  anomalies: CollabOverviewAnomaly[];
  summary: CollabSummaryRecord | null;
}

// ── 内部工具 ───────────────────────────────────────────────────────────────

function compact(value: unknown, limit = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function actorDisplayName(
  actorId: string | null | undefined,
  memberById: Map<string, Actor>,
  stepActorNames: Map<string, string>,
): string {
  const id = String(actorId || "").trim();
  if (!id) return "";
  if (id === "commander") return "Commander";
  if (id === "user") return "User";
  return stepActorNames.get(id) || memberById.get(id)?.name || id;
}

interface MessageTail {
  messages: GroupMessage[];
  memberById: Map<string, Actor>;
}

async function loadTail(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<MessageTail> {
  const layout = conversationLayout(uid, cid, projectIdHint);
  const [rows, members] = await Promise.all([
    readJsonl<GroupMessage>(layout.messageFile, MESSAGE_TAIL).catch(() => [] as GroupMessage[]),
    readMembers(uid, cid, projectIdHint).catch(() => ({ version: 1 as const, actors: [] as Actor[] })),
  ]);
  const messages = rows
    .filter((msg) => msg && typeof msg === "object" && !msg.deleted_at)
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  const memberById = new Map<string, Actor>();
  for (const actor of members.actors || []) {
    if (actor && actor.id) memberById.set(actor.id, actor);
  }
  return { messages, memberById };
}

/** 读活跃 run（active.json 指针 + run 文件）。终态 run 仍可读：active.json
 * 只在消息编辑失效场景被清除（clearActiveCollaborationState）。 */
async function readActiveRun(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<WorkflowRun | null> {
  const active = await readJson<unknown>(
    collaborationPaths(uid, cid, projectIdHint).activeFile,
  ).catch(() => null);
  const runId = (active as { version?: unknown; run_id?: unknown } | null)?.run_id;
  if (typeof runId !== "string" || !safeId(runId)) return null;
  return readWorkflowRun(uid, cid, runId, projectIdHint);
}

// ── 投影构建 ───────────────────────────────────────────────────────────────

function emptyOverview(cid: string): CollabOverview {
  return {
    version: 1,
    cid,
    available: false,
    run: { id: "", objective: "", status: "running", phase: "", created_at: "", updated_at: "" },
    progress: { total: 0, completed: 0, running: 0, pending: 0, failed: 0, skipped: 0 },
    steps: [],
    actors: [],
    handoffs: [],
    outputs: [],
    anomalies: [],
    summary: null,
  };
}

export async function buildCollabOverview(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<CollabOverview> {
  if (!safeId(cid)) return emptyOverview(cid);
  const run = await readActiveRun(uid, cid, projectIdHint).catch(() => null);
  if (!run) return emptyOverview(cid);

  const overview = emptyOverview(cid);
  overview.available = true;
  overview.run = {
    id: run.id,
    objective: run.objective,
    status: run.status,
    phase: run.phase,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };

  const [context, tail] = await Promise.all([
    readActiveSharedTaskContext(uid, cid).catch(() => null),
    loadTail(uid, cid, projectIdHint),
  ]);
  const stepActorNames = new Map<string, string>();
  for (const step of run.steps) {
    if (step.actor_id && step.actor_name) stepActorNames.set(step.actor_id, step.actor_name);
  }

  projectSteps(overview, run, stepActorNames, tail.memberById);
  projectActors(overview, run, tail, stepActorNames);
  projectHandoffs(overview, run, tail, stepActorNames);
  projectOutputs(overview, context, stepActorNames);
  await projectAnomalies(overview, uid, cid, run, tail, stepActorNames);

  overview.summary = await ensureCollabSummary(uid, cid, run, context, tail, overview, projectIdHint);
  return overview;
}

function projectSteps(
  overview: CollabOverview,
  run: WorkflowRun,
  stepActorNames: Map<string, string>,
  memberById: Map<string, Actor>,
): void {
  const counts = { completed: 0, running: 0, pending: 0, failed: 0, skipped: 0 } as Record<string, number>;
  overview.steps = run.steps.map((step) => {
    counts[step.status] = (counts[step.status] || 0) + 1;
    return {
      id: step.id,
      title: step.title,
      type: step.type,
      status: step.status,
      actor_id: step.actor_id,
      actor_name: step.actor_id
        ? actorDisplayName(step.actor_id, memberById, stepActorNames)
        : undefined,
      depends_on: step.depends_on || [],
      attempts: Array.isArray(step.attempts) ? step.attempts.length : 0,
      result_summary: step.result_summary ? compact(step.result_summary, 160) : undefined,
      started_at: step.started_at,
      completed_at: step.completed_at,
    };
  });
  overview.progress = {
    total: run.steps.length,
    completed: counts.completed || 0,
    running: counts.running || 0,
    pending: (counts.pending || 0) + (counts.blocked || 0),
    failed: counts.failed || 0,
    skipped: counts.skipped || 0,
  };
}

function projectActors(
  overview: CollabOverview,
  run: WorkflowRun,
  tail: MessageTail,
  stepActorNames: Map<string, string>,
): void {
  const ids = new Set<string>(["commander"]);
  for (const step of run.steps) if (step.actor_id) ids.add(step.actor_id);
  for (const member of tail.memberById.values()) {
    if (member.kind === "agent") ids.add(member.id);
  }
  const stepsByActor = new Map<string, WorkflowStep[]>();
  for (const step of run.steps) {
    if (!step.actor_id) continue;
    const list = stepsByActor.get(step.actor_id) || [];
    list.push(step);
    stepsByActor.set(step.actor_id, list);
  }
  const lastTsByActor = new Map<string, string>();
  for (const msg of tail.messages) {
    if (msg.from && msg.from !== "user") lastTsByActor.set(msg.from, msg.ts);
  }
  overview.actors = Array.from(ids)
    .filter((id) => id !== "user")
    .map((id) => {
      const steps = stepsByActor.get(id) || [];
      const runningStep = steps.find((step) => step.status === "running");
      const waiting = !runningStep
        && steps.some((step) => step.status === "pending" || step.status === "blocked");
      const member = tail.memberById.get(id);
      return {
        id,
        name: actorDisplayName(id, tail.memberById, stepActorNames),
        kind: id === "commander" || member?.kind === "commander" ? ("commander" as const) : ("agent" as const),
        state: runningStep ? ("working" as const) : waiting ? ("waiting" as const) : ("idle" as const),
        active_step_title: runningStep?.title,
        steps_done: steps.filter((step) => step.status === "completed").length,
        steps_failed: steps.filter((step) => step.status === "failed").length,
        retries: steps.reduce((sum, step) => sum + Math.max(0, (step.attempts?.length || 1) - 1), 0),
        last_ts: lastTsByActor.get(id),
      };
    })
    .sort((a, b) => (a.state === "working" ? -1 : b.state === "working" ? 1 : a.id.localeCompare(b.id)));
}

function projectHandoffs(
  overview: CollabOverview,
  run: WorkflowRun,
  tail: MessageTail,
  stepActorNames: Map<string, string>,
): void {
  const rows: CollabHandoff[] = [];
  const nameOf = (id: string) => actorDisplayName(id, tail.memberById, stepActorNames);
  const runStartedMs = Date.parse(run.created_at);
  for (const msg of tail.messages) {
    const tsMs = Date.parse(msg.ts);
    if (Number.isFinite(runStartedMs) && Number.isFinite(tsMs) && tsMs < runStartedMs - 60_000) continue;
    if (msg.from === "user") continue;
    if (msg.system_kind === "collab_summary") continue;
    if (msg.dispatch && msg.to.length) {
      const to = msg.to[0];
      rows.push({
        ts: msg.ts,
        from: msg.from,
        from_name: nameOf(msg.from),
        to,
        to_name: nameOf(to),
        kind: "dispatch",
        note: compact(msg.model_text || msg.text, 120),
      });
      continue;
    }
    if (msg.from !== "commander" && msg.from !== "user" && !msg.dispatch) {
      rows.push({
        ts: msg.ts,
        from: msg.from,
        from_name: nameOf(msg.from),
        to: "commander",
        to_name: nameOf("commander"),
        kind: "handback",
        note: compact(msg.text, 120),
      });
    }
  }
  overview.handoffs = rows.slice(-60);
}

function projectOutputs(
  overview: CollabOverview,
  context: SharedTaskContext | null,
  stepActorNames: Map<string, string>,
): void {
  const rows: CollabOverviewOutput[] = [];
  if (context) {
    for (const output of Object.values(context.agent_outputs || {})) {
      if (!output || typeof output !== "object") continue;
      rows.push({
        actor_id: output.actor_id,
        actor_name: actorDisplayName(output.actor_id, new Map(), stepActorNames) || output.actor_id,
        step_id: output.step_id,
        summary: compact(output.summary, 200),
        created_at: output.created_at,
      });
    }
  }
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  overview.outputs = rows.slice(-40);
}

async function projectAnomalies(
  overview: CollabOverview,
  uid: string,
  cid: string,
  run: WorkflowRun,
  tail: MessageTail,
  stepActorNames: Map<string, string>,
): Promise<void> {
  const rows: CollabOverviewAnomaly[] = [];
  const stepById = new Map(run.steps.map((step) => [step.id, step]));

  // 步骤级失败与重试（引擎 attempts 是权威来源）。
  for (const step of run.steps) {
    if (step.status === "failed") {
      rows.push({
        ts: step.completed_at || run.updated_at,
        kind: "failure",
        actor_id: step.actor_id || undefined,
        step_id: step.id,
        detail: step.result_summary || lastFailureText(step),
        impact: downstreamImpact(run, step.id, stepById),
      });
    }
    const attempts = step.attempts?.length || 0;
    if (attempts > 1) {
      rows.push({
        ts: step.completed_at || run.updated_at,
        kind: "retry",
        actor_id: step.actor_id || undefined,
        step_id: step.id,
        detail: `${step.title} ×${attempts}`,
      });
    }
  }

  // 事件流补充：中止与上下文补丁（重试事件在 attempts 里已覆盖）。
  const events = await readCollaborationEvents(uid, cid, 300).catch(() => [] as CollaborationEvent[]);
  for (const event of events) {
    if (event.run_id !== run.id) continue;
    if (event.type === "workflow_aborted") {
      rows.push({
        ts: event.created_at,
        kind: "cancel",
        actor_id: event.actor_id || undefined,
        detail: compact(event.summary, 160) || "workflow aborted",
      });
    }
    if (event.type === "handoff_finalization_failed") {
      rows.push({
        ts: event.created_at,
        kind: "failure",
        actor_id: event.actor_id || undefined,
        step_id: event.step_id,
        detail: compact(event.summary, 160) || "handoff finalization failed",
      });
    }
  }

  // 消息级失败/取消（模型错误气泡与应用中断标记）。
  for (const msg of tail.messages) {
    if (msg.failure_kind) {
      rows.push({
        ts: msg.ts,
        kind: "failure",
        actor_id: msg.from,
        detail: `${msg.failure_kind}${msg.failure_code ? `/${msg.failure_code}` : ""}：${compact(msg.text.replace(/<[^>]+>/g, ""), 100)}`,
      });
    }
    if (msg.system_kind === "reply_interrupted") {
      rows.push({ ts: msg.ts, kind: "cancel", actor_id: msg.from, detail: "interrupted" });
    }
  }

  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  overview.anomalies = rows.slice(-50);
  void stepActorNames;
}

function lastFailureText(step: WorkflowStep): string {
  const attempts = step.attempts || [];
  const failed = attempts.filter((attempt) => attempt.status === "failed");
  const last = failed[failed.length - 1];
  return last?.failure_code || "step failed";
}

/** 依赖反查：某步骤失败后，被它阻塞的下游步骤标题。 */
function downstreamImpact(
  run: WorkflowRun,
  stepId: string,
  stepById: Map<string, WorkflowStep>,
): string[] | undefined {
  const affected: string[] = [];
  const visit = (origin: string) => {
    for (const step of run.steps) {
      if (step.status === "completed" || step.status === "skipped") continue;
      if ((step.depends_on || []).includes(origin) && !affected.includes(step.title)) {
        affected.push(step.title);
        visit(step.id);
      }
    }
  };
  visit(stepId);
  void stepById;
  return affected.length ? affected : undefined;
}

// ── 终态自动汇总 ───────────────────────────────────────────────────────────

function summaryFile(uid: string, cid: string, projectIdHint?: string | null): string {
  return path.join(collaborationPaths(uid, cid, projectIdHint).rootDir, "summary.json");
}

export async function readCollabSummary(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<CollabSummaryRecord | null> {
  const raw = await readJson<unknown>(summaryFile(uid, cid, projectIdHint)).catch(() => null);
  const record = raw as Partial<CollabSummaryRecord> | null;
  if (!record || record.version !== 1 || typeof record.run_id !== "string") return null;
  return record as CollabSummaryRecord;
}

/** 有效终态判定：run 显式失败/取消，或全部步骤到终态。本地桥不会把 run
 * 自动标成 completed（无该转换路径），全步骤终态即「协作已结束」。 */
function effectiveConclusion(run: WorkflowRun): CollabSummaryRecord["conclusion"] | null {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (run.steps.length > 0 && run.steps.every((step) => step.status === "completed" || step.status === "skipped")) {
    return "all_steps_done";
  }
  return null;
}

async function ensureCollabSummary(
  uid: string,
  cid: string,
  run: WorkflowRun,
  context: SharedTaskContext | null,
  tail: MessageTail,
  overview: CollabOverview,
  projectIdHint?: string | null,
): Promise<CollabSummaryRecord | null> {
  const existing = await readCollabSummary(uid, cid, projectIdHint);
  if (existing && existing.run_id === run.id) return existing;
  const conclusion = effectiveConclusion(run);
  if (!conclusion) return existing && existing.run_id ? existing : null;

  const record = buildSummaryRecord(cid, run, context, tail, overview, conclusion);
  try {
    await writeJson(summaryFile(uid, cid, projectIdHint), record);
    await writeSummaryMessage(uid, cid, run, record, tail, projectIdHint);
  } catch (err) {
    log.warn(`collab summary persist failed uid=${uid} cid=${cid}: ${(err as Error).message}`);
    return record;
  }
  return record;
}

function buildSummaryRecord(
  cid: string,
  run: WorkflowRun,
  context: SharedTaskContext | null,
  tail: MessageTail,
  overview: CollabOverview,
  conclusion: CollabSummaryRecord["conclusion"],
): CollabSummaryRecord {
  const stepActorNames = new Map<string, string>();
  for (const step of run.steps) {
    if (step.actor_id && step.actor_name) stepActorNames.set(step.actor_id, step.actor_name);
  }
  const nameOf = (id: string) => actorDisplayName(id, tail.memberById, stepActorNames);

  const contributions: CollabSummaryRecord["contributions"] = [];
  for (const actor of overview.actors) {
    if (actor.kind !== "agent") continue;
    const produced = new Set<string>();
    for (const msg of tail.messages) {
      if (msg.from !== actor.id) continue;
      for (const file of msg.produced || []) produced.add(file);
    }
    const outputs = overview.outputs
      .filter((output) => output.actor_id === actor.id)
      .map((output) => compact(output.summary, 160));
    contributions.push({
      actor_id: actor.id,
      actor_name: nameOf(actor.id) || actor.name,
      steps_completed: actor.steps_done,
      steps_failed: actor.steps_failed,
      retries: actor.retries,
      produced_files: Array.from(produced).slice(0, 10),
      outputs: outputs.slice(0, 6),
    });
  }

  const lastHandback = [...tail.messages]
    .reverse()
    .find((msg) => msg.from !== "user" && msg.from !== "commander" && !msg.dispatch && (msg.text || "").trim());
  const artifacts = (context?.artifacts || []).map((item) => item.path || item.summary || item.id).filter(Boolean);

  const anomalyCount = (kind: CollabAnomalyKind) =>
    overview.anomalies.filter((item) => item.kind === kind).length;

  return {
    version: 1,
    run_id: run.id,
    cid,
    conclusion,
    objective: run.objective,
    started_at: run.created_at,
    ended_at: run.updated_at,
    step_totals: {
      total: overview.progress.total,
      completed: overview.progress.completed,
      skipped: overview.progress.skipped,
      failed: overview.progress.failed,
      pending: overview.progress.pending,
    },
    contributions,
    anomalies: overview.anomalies.slice(-20).map((item) => ({
      ts: item.ts,
      kind: item.kind,
      actor_id: item.actor_id,
      step_id: item.step_id,
      detail: compact(item.detail, 160),
    })),
    final_result: lastHandback ? compact(lastHandback.text, SUMMARY_TEXT_LIMIT) : "",
    artifacts: artifacts.slice(0, 10),
    generated_at: nowIso(),
  };
}

async function writeSummaryMessage(
  uid: string,
  cid: string,
  run: WorkflowRun,
  record: CollabSummaryRecord,
  tail: MessageTail,
  projectIdHint?: string | null,
): Promise<void> {
  const layout = conversationLayout(uid, cid, projectIdHint);
  // 幂等防重：同 run 的汇总消息已存在则跳过（summary.json 与消息两处存储
  // 可能被并发路径分别触发）。
  const recent = await readJsonl<GroupMessage>(layout.messageFile, 120).catch(() => [] as GroupMessage[]);
  const duplicate = recent.some(
    (msg) => msg.system_kind === "collab_summary" && msg.collab_summary?.run_id === run.id,
  );
  if (duplicate) return;

  const lines: string[] = [];
  lines.push(`## 协作汇总`);
  lines.push(record.objective);
  lines.push("");
  lines.push(
    `- 结论：${conclusionText(record.conclusion)}（步骤 ${record.step_totals.completed}/${record.step_totals.total} 完成）`,
  );
  for (const item of record.contributions) {
    const parts = [`完成 ${item.steps_completed} 步`];
    if (item.retries) parts.push(`重试 ${item.retries} 次`);
    if (item.produced_files.length) parts.push(`产出 ${item.produced_files.length} 个文件`);
    lines.push(`- ${item.actor_name || item.actor_id}：${parts.join("，")}`);
  }
  if (record.final_result) {
    lines.push("");
    lines.push(`最终结果：${record.final_result}`);
  }

  const msg: GroupMessage = {
    id: genId12(),
    ts: nowIso(),
    from: "commander",
    to: ["user"],
    system_kind: "collab_summary",
    collab_summary: record,
    text: lines.join("\n"),
    model_text: [
      "<collaboration-summary>",
      `Objective: ${record.objective}`,
      `Conclusion: ${record.conclusion}; steps completed ${record.step_totals.completed}/${record.step_totals.total}.`,
      `Agent contributions: ${record.contributions
        .map((item) => `${item.actor_name || item.actor_id}(${item.steps_completed} steps, ${item.retries} retries)`)
        .join("; ")}`,
      `Final result: ${record.final_result || "(none)"}`,
      "</collaboration-summary>",
    ].join("\n"),
  };
  await appendJsonlAtomic<GroupMessage>(layout.messageFile, msg);
  const memberIds = Array.from(tail.memberById.keys()).filter((id) => id !== "user");
  await appendVisible(uid, cid, msg, Array.from(new Set([...memberIds, "commander"])), projectIdHint);
}

function conclusionText(conclusion: CollabSummaryRecord["conclusion"]): string {
  if (conclusion === "all_steps_done") return "全部步骤完成";
  if (conclusion === "cancelled") return "已取消";
  return "失败";
}
