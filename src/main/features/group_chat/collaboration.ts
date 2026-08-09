import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { Mutex } from "async-mutex";
import { conversationLayout } from "../../util/project-layout";
import {
  appendJsonlAtomic,
  genId12,
  nowIso,
  readJson,
  readJsonl,
  safeId,
  writeJson,
} from "../../storage";

import { reconcileStepBlockers as reconcileControlPlaneStepBlockers } from '../collaboration_control/dependency-reconciler';
import type {
  WorkflowRunKind,
  WorkflowRunStatus,
  WorkflowStepType,
  WorkflowStepStatus,
  WorkflowAttemptStatus,
  WorkflowAttemptFailureCode,
  WorkflowAttemptActorKind,
  WorkflowAttempt,
  GateStatus,
  ContextItemSource,
  ContextConfidence,
  ContextProposalKind,
  ContextProposalStatus,
  ContextConflictType,
  ContextConflictStatus,
  ContextProposal,
  ContextConflictResolution,
  ContextConflict,
  OutputContract,
  WorkflowStep,
  WorkflowRun,
  ActiveWorkflowFile,
  ContextItem,
  DecisionItem,
  RiskItem,
  ArtifactRef,
  AgentOutputSummary,
  GateCheck,
  GateReviewDecision,
  GateResult,
  SharedTaskContext,
  CollaborationEventType,
  CollaborationEvent,
} from '../collaboration_control/types';
export type {
  WorkflowRunKind,
  WorkflowRunStatus,
  WorkflowStepType,
  WorkflowStepStatus,
  WorkflowAttemptStatus,
  WorkflowAttemptFailureCode,
  WorkflowAttemptActorKind,
  WorkflowAttempt,
  GateStatus,
  ContextItemSource,
  ContextConfidence,
  ContextProposalKind,
  ContextProposalStatus,
  ContextConflictType,
  ContextConflictStatus,
  ContextProposal,
  ContextConflictResolution,
  ContextConflict,
  OutputContract,
  WorkflowStep,
  WorkflowRun,
  ActiveWorkflowFile,
  ContextItem,
  DecisionItem,
  RiskItem,
  ArtifactRef,
  AgentOutputSummary,
  GateCheck,
  GateReviewDecision,
  GateResult,
  SharedTaskContext,
  CollaborationEventType,
  CollaborationEvent,
} from '../collaboration_control/types';

export interface CollaborationPaths {
  rootDir: string;
  runsDir: string;
  contextsDir: string;
  activeFile: string;
  eventsFile: string;
  runFile(runId: string): string;
  contextFile(contextId: string): string;
}

async function appendCollaborationEvent(
  uid: string,
  cid: string,
  event: Omit<CollaborationEvent, "version" | "id" | "cid" | "created_at">,
): Promise<CollaborationEvent> {
  const record: CollaborationEvent = {
    version: 1,
    id: `wevt-${genId12()}`,
    cid,
    created_at: nowIso(),
    ...event,
  };
  await appendJsonlAtomic(collaborationPaths(uid, cid).eventsFile, record);
  return record;
}

export async function readCollaborationEvents(
  uid: string,
  cid: string,
  limit = 50,
): Promise<CollaborationEvent[]> {
  const rows = await readJsonl<unknown>(
    collaborationPaths(uid, cid).eventsFile,
    limit,
  );
  return rows.filter((row): row is CollaborationEvent => {
    const item = row as Partial<CollaborationEvent>;
    return (
      item?.version === 1 &&
      safeId(item.id || "") &&
      typeof item.type === "string" &&
      typeof item.run_id === "string"
    );
  });
}

const _conversationLocks = new Map<string, Mutex>();

function conversationLock(uid: string, cid: string): Mutex {
  const key = `${uid}::${cid}`;
  let lock = _conversationLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    _conversationLocks.set(key, lock);
  }
  return lock;
}

export function collaborationPaths(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): CollaborationPaths {
  const groupDir = conversationLayout(uid, cid, projectIdHint).groupDir;
  const rootDir = path.join(groupDir, "collaboration");
  const runsDir = path.join(rootDir, "workflow_runs");
  const contextsDir = path.join(rootDir, "workflow_contexts");
  return {
    rootDir,
    runsDir,
    contextsDir,
    activeFile: path.join(rootDir, "active.json"),
    eventsFile: path.join(rootDir, "events.jsonl"),
    runFile(runId: string) {
      if (!safeId(runId)) throw new Error("invalid workflow run id");
      return path.join(runsDir, `${runId}.json`);
    },
    contextFile(contextId: string) {
      if (!safeId(contextId)) throw new Error("invalid workflow context id");
      return path.join(contextsDir, `${contextId}.json`);
    },
  };
}

function validActiveFile(value: unknown): value is ActiveWorkflowFile {
  const item = value as Partial<ActiveWorkflowFile>;
  return item?.version === 1 && safeId(item.run_id) && safeId(item.context_id);
}

function validRun(value: unknown): value is WorkflowRun {
  const item = value as Partial<WorkflowRun>;
  return (
    item?.version === 1 &&
    safeId(item.id) &&
    typeof item.cid === "string" &&
    safeId(item.context_id) &&
    Array.isArray(item.steps)
  );
}

function normalizeWorkflowActorId(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const actorId = value.trim();
  return safeId(actorId) ? actorId : undefined;
}

function normalizeWorkflowActorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const actorName = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return actorName || undefined;
}

function normalizeWorkflowAttemptStatus(
  value: unknown,
): WorkflowAttemptStatus | undefined {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function normalizeWorkflowAttemptFailureCode(
  value: unknown,
): WorkflowAttemptFailureCode | undefined {
  return value === "coordinator_tool_idle" ||
    value === "coordinator_agent_idle" ||
    value === "runtime_failed" ||
    value === "dependency_failed"
    ? value
    : undefined;
}

function normalizeWorkflowAttemptActorKind(
  value: unknown,
): WorkflowAttemptActorKind | undefined {
  return value === "agent" || value === "anonymous_worker"
    ? value
    : undefined;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      timestamp,
    )
  ) {
    return undefined;
  }
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function normalizeWorkflowAttempt(value: unknown): WorkflowAttempt | null {
  if (!isPlainRecord(value)) return null;
  const attempt = value.attempt;
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 4
  ) {
    return null;
  }
  const actorId = normalizeWorkflowActorId(value.actor_id);
  const actorKind = normalizeWorkflowAttemptActorKind(value.actor_kind);
  const status = normalizeWorkflowAttemptStatus(value.status);
  const startedAt = normalizeIsoTimestamp(value.started_at);
  if (
    actorId === undefined ||
    !actorKind ||
    !status ||
    !startedAt ||
    (actorKind === "agent" && actorId === null) ||
    (actorKind === "anonymous_worker" && actorId !== null)
  ) {
    return null;
  }
  const actorName = normalizeWorkflowActorName(value.actor_name);
  if (status === "running") {
    return {
      attempt,
      actor_id: actorId,
      actor_kind: actorKind,
      ...(actorName ? { actor_name: actorName } : {}),
      status,
      started_at: startedAt,
    };
  }
  const completedAt = normalizeIsoTimestamp(value.completed_at);
  if (!completedAt) return null;
  const failureCode = normalizeWorkflowAttemptFailureCode(value.failure_code);
  return {
    attempt,
    actor_id: actorId,
    actor_kind: actorKind,
    ...(actorName ? { actor_name: actorName } : {}),
    status,
    ...(failureCode ? { failure_code: failureCode } : {}),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

function normalizeWorkflowAttempts(value: unknown): WorkflowAttempt[] {
  if (!Array.isArray(value)) return [];
  const valid = value
    .map(normalizeWorkflowAttempt)
    .filter((attempt): attempt is WorkflowAttempt => !!attempt);
  const terminal = valid.filter((attempt) => attempt.status !== "running");
  const last = valid[valid.length - 1];
  const canonical = [
    ...terminal,
    ...(last?.status === "running" ? [last] : []),
  ].slice(-4);
  return canonical.map((attempt, index) => ({
    ...attempt,
    attempt: index + 1,
  }));
}

function normalizeWorkflowRun(value: unknown): WorkflowRun | null {
  if (!validRun(value)) return null;
  const run = value as WorkflowRun;
  if (run.steps.some((step) => !isPlainRecord(step))) return null;
  if (
    run.steps.some(
      (step) =>
        hasInvalidWorkflowDependencyIds(step.depends_on) ||
        hasInvalidStoredAccessMetadata(step),
    )
  ) {
    return null;
  }
  return {
    ...run,
    steps: run.steps.map((step) => {
      const normalized = { ...step };
      const workflowDependencies = normalizeWorkflowDependencyIds(
        step.depends_on,
      );
      const contextDependencies = normalizeContextDependencies(
        step.context_dependencies,
      );
      const conflictIds = normalizeConflictIdArray(
        step.blocked_by_conflict_ids,
      );
      const originalActorId = normalizeWorkflowActorId(
        step.original_actor_id,
      );
      const currentActorId = normalizeWorkflowActorId(step.current_actor_id);
      const requiredCapabilities = step.required_capabilities;
      const writeScopes = step.write_scopes;
      const attempts = normalizeWorkflowAttempts(step.attempts);
      normalized.depends_on = workflowDependencies;
      if (contextDependencies.length)
        normalized.context_dependencies = contextDependencies;
      else delete normalized.context_dependencies;
      if (conflictIds.length) normalized.blocked_by_conflict_ids = conflictIds;
      else delete normalized.blocked_by_conflict_ids;
      if (originalActorId !== undefined)
        normalized.original_actor_id = originalActorId;
      else delete normalized.original_actor_id;
      if (currentActorId !== undefined)
        normalized.current_actor_id = currentActorId;
      else delete normalized.current_actor_id;
      if (requiredCapabilities !== undefined)
        normalized.required_capabilities = [...requiredCapabilities];
      else delete normalized.required_capabilities;
      if (step.access_mode !== undefined)
        normalized.access_mode = step.access_mode;
      else delete normalized.access_mode;
      if (writeScopes !== undefined)
        normalized.write_scopes = [...writeScopes];
      else delete normalized.write_scopes;
      if (attempts.length) normalized.attempts = attempts;
      else delete normalized.attempts;
      return normalized;
    }),
  };
}

function validContext(value: unknown): value is SharedTaskContext {
  const item = value as Partial<SharedTaskContext>;
  return (
    item?.version === 1 &&
    safeId(item.id) &&
    typeof item.cid === "string" &&
    safeId(item.run_id) &&
    Array.isArray(item.facts)
  );
}

function normalizeSharedTaskContext(value: unknown): SharedTaskContext | null {
  if (!validContext(value)) return null;
  const context = value as SharedTaskContext;
  return {
    ...context,
    revision:
      Number.isSafeInteger(context.revision) && context.revision >= 0
        ? context.revision
        : 0,
    proposals: Array.isArray(context.proposals) ? context.proposals : [],
    conflicts: Array.isArray(context.conflicts) ? context.conflicts : [],
  };
}

export async function readWorkflowRun(
  uid: string,
  cid: string,
  runId: string,
  projectIdHint?: string | null,
): Promise<WorkflowRun | null> {
  if (!safeId(runId)) return null;
  const raw = await readJson<unknown>(
    collaborationPaths(uid, cid, projectIdHint).runFile(runId),
  );
  return normalizeWorkflowRun(raw);
}

export async function readSharedTaskContext(
  uid: string,
  cid: string,
  contextId: string,
  projectIdHint?: string | null,
): Promise<SharedTaskContext | null> {
  if (!safeId(contextId)) return null;
  const raw = await readJson<unknown>(
    collaborationPaths(uid, cid, projectIdHint).contextFile(contextId),
  );
  return normalizeSharedTaskContext(raw);
}

async function readActiveWorkflowRunUnlocked(
  uid: string,
  cid: string,
): Promise<WorkflowRun | null> {
  const active = await readJson<unknown>(
    collaborationPaths(uid, cid).activeFile,
  );
  if (!validActiveFile(active)) return null;
  return readWorkflowRun(uid, cid, active.run_id);
}

export async function readActiveWorkflowRun(
  uid: string,
  cid: string,
): Promise<WorkflowRun | null> {
  return conversationLock(uid, cid).runExclusive(() =>
    readActiveWorkflowRunUnlocked(uid, cid),
  );
}

async function readActiveSharedTaskContextUnlocked(
  uid: string,
  cid: string,
): Promise<SharedTaskContext | null> {
  return (await readActiveWorkflowStateUnlocked(uid, cid))?.context || null;
}

export async function readActiveSharedTaskContext(
  uid: string,
  cid: string,
): Promise<SharedTaskContext | null> {
  return conversationLock(uid, cid).runExclusive(() =>
    readActiveSharedTaskContextUnlocked(uid, cid),
  );
}

async function readActiveWorkflowStateUnlocked(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<{ run: WorkflowRun; context: SharedTaskContext } | null> {
  const active = await readJson<unknown>(
    collaborationPaths(uid, cid, projectIdHint).activeFile,
  );
  if (!validActiveFile(active)) return null;
  const run = await readWorkflowRun(uid, cid, active.run_id, projectIdHint);
  if (!run || run.context_id !== active.context_id) return null;
  const context = await readSharedTaskContext(uid, cid, active.context_id, projectIdHint);
  if (!context || context.run_id !== run.id) return null;
  return { run, context };
}

async function readActiveContextForResolutionUnlocked(
  uid: string,
  cid: string,
): Promise<SharedTaskContext> {
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  return active.context;
}

export interface CreateWorkflowRunInput {
  objective: string;
  kind?: WorkflowRunKind;
  created_by: string;
}

async function createWorkflowRunUnlocked(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const now = nowIso();
  const runId = `wf-${genId12()}`;
  const contextId = `wctx-${genId12()}`;
  const objective =
    String(input.objective || "").trim() || "Multi-agent collaboration";
  const run: WorkflowRun = {
    version: 1,
    id: runId,
    cid,
    objective,
    kind: input.kind || "custom",
    status: "running",
    phase: "created",
    steps: [],
    context_id: contextId,
    created_by: String(input.created_by || "commander"),
    created_at: now,
    updated_at: now,
  };
  const context: SharedTaskContext = {
    version: 1,
    id: contextId,
    cid,
    run_id: runId,
    objective,
    phase: run.phase,
    revision: 1,
    constraints: [],
    facts: [],
    decisions: [],
    open_questions: [],
    risks: [],
    artifacts: [],
    agent_outputs: {},
    gates: [],
    proposals: [],
    conflicts: [],
    updated_at: now,
  };
  const paths = collaborationPaths(uid, cid);
  await writeJson(paths.runFile(runId), run);
  await writeJson(paths.contextFile(contextId), context);
  await writeJson(paths.activeFile, {
    version: 1,
    run_id: runId,
    context_id: contextId,
    updated_at: now,
  } satisfies ActiveWorkflowFile);
  await appendCollaborationEvent(uid, cid, {
    type: "workflow_created",
    run_id: runId,
    context_id: contextId,
    actor_id: run.created_by,
    summary: objective,
    payload: { kind: run.kind },
  });
  return { run, context };
}

export async function createWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  return conversationLock(uid, cid).runExclusive(() =>
    createWorkflowRunUnlocked(uid, cid, input),
  );
}

async function ensureActiveWorkflowRunUnlocked(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const run = await readActiveWorkflowRunUnlocked(uid, cid);
  if (run && run.status === "running") {
    const context = await readSharedTaskContext(uid, cid, run.context_id);
    if (context) return { run, context };
  }
  return createWorkflowRunUnlocked(uid, cid, input);
}

export async function ensureActiveWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  return conversationLock(uid, cid).runExclusive(() =>
    ensureActiveWorkflowRunUnlocked(uid, cid, input),
  );
}

async function writeRun(
  uid: string,
  cid: string,
  run: WorkflowRun,
): Promise<WorkflowRun> {
  await writeJson(collaborationPaths(uid, cid).runFile(run.id), run);
  return run;
}

async function writeContext(
  uid: string,
  cid: string,
  context: SharedTaskContext,
): Promise<SharedTaskContext> {
  const previousRevision =
    Number.isSafeInteger(context.revision) && context.revision >= 0
      ? context.revision
      : 0;
  context.revision = previousRevision + 1;
  try {
    await writeJson(
      collaborationPaths(uid, cid).contextFile(context.id),
      context,
    );
    return context;
  } catch (err) {
    context.revision = previousRevision;
    throw err;
  }
}

export interface PlanWorkflowStepInput {
  title: string;
  actor_id: string | null;
  type?: WorkflowStepType;
  depends_on?: string[];
  context_dependencies?: string[];
  blocked_by_conflict_ids?: string[];
  expected_output?: OutputContract;
  source_tool?: "dispatch_to" | "hand_off_to" | "run_worker";
  required_capabilities?: string[];
  access_mode?: "read" | "write";
  write_scopes?: string[];
}

async function planWorkflowStepsUnlocked(
  uid: string,
  cid: string,
  runId: string,
  steps: PlanWorkflowStepInput[],
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  if (run.status === "blocked")
    throw new Error("workflow run is blocked by gate");
  const now = nowIso();
  const planned: WorkflowStep[] = [];
  for (const input of steps || []) {
    const title = String(input.title || "").trim();
    if (!title) continue;
    const contextDependencies = normalizeContextDependencies(
      input.context_dependencies,
    );
    const conflictIds = normalizeConflictIdArray(input.blocked_by_conflict_ids);
    const dependsOn = normalizeWorkflowDependencyInput(input.depends_on);
    const requiredCapabilities = normalizeBoundedStringArray(
      input.required_capabilities,
    );
    const accessMode = normalizeWorkflowAccessMode(input.access_mode);
    const writeScopes = normalizeBoundedStringArray(input.write_scopes);
    planned.push({
      id: `wstep-${genId12()}`,
      run_id: run.id,
      title,
      actor_id: input.actor_id || null,
      type: input.type || "dispatch",
      status: "pending",
      depends_on: dependsOn,
      ...(contextDependencies.length
        ? { context_dependencies: contextDependencies }
        : {}),
      ...(conflictIds.length ? { blocked_by_conflict_ids: conflictIds } : {}),
      expected_output: input.expected_output,
      source_tool: input.source_tool,
      ...(requiredCapabilities.length
        ? { required_capabilities: requiredCapabilities }
        : {}),
      access_mode: accessMode,
      ...(writeScopes.length ? { write_scopes: writeScopes } : {}),
    });
  }
  if (!planned.length) return run;
  run.steps.push(...planned);
  run.phase = "planned";
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    reconcileWorkflowStepBlockers(run, context);
    context.phase = run.phase;
    context.updated_at = now;
  }
  await writeRun(uid, cid, run);
  if (context) await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "workflow_planned",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: run.created_by,
    summary: `Planned ${planned.length} workflow step(s).`,
    payload: {
      step_ids: planned.map((step) => step.id),
      step_count: planned.length,
    },
  });
  return run;
}

function incompleteWorkflowStepDependencies(
  run: WorkflowRun,
  step: WorkflowStep,
): string[] {
  const terminal = new Set(
    run.steps
      .filter(
        (candidate) =>
          candidate.status === "completed" || candidate.status === "skipped",
      )
      .map((candidate) => candidate.id),
  );
  return (step.depends_on || []).filter(
    (dependency) => !terminal.has(dependency),
  );
}

function assertWorkflowStepDependenciesComplete(
  run: WorkflowRun,
  step: WorkflowStep,
): void {
  const missing = incompleteWorkflowStepDependencies(run, step);
  if (!missing.length) return;
  throw new Error(
    `workflow step dependencies incomplete: ${missing.join(", ")}`,
  );
}

async function startPlannedWorkflowStepUnlocked(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  const reconciliation = context
    ? reconcileWorkflowStepBlockers(run, context)
    : { runChanged: false, contextChanged: false };
  const persistReconciliation = async (): Promise<void> => {
    const now = nowIso();
    if (reconciliation.runChanged) {
      run.updated_at = now;
      await writeRun(uid, cid, run);
    }
    if (context && reconciliation.contextChanged) {
      context.updated_at = now;
      await writeContext(uid, cid, context);
    }
  };
  if (run.status === "blocked") {
    await persistReconciliation();
    throw new Error("workflow run is blocked by gate");
  }
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "completed"
  ) {
    await persistReconciliation();
    throw new Error(`workflow run is not active: ${run.status}`);
  }
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) {
    await persistReconciliation();
    throw new Error("workflow step not found");
  }
  if (step.status !== "pending") {
    await persistReconciliation();
    throw new Error(`workflow step is not pending: ${step.status}`);
  }
  try {
    assertWorkflowStepDependenciesComplete(run, step);
  } catch (error) {
    await persistReconciliation();
    throw error;
  }
  const now = nowIso();
  step.status = "running";
  step.started_at = now;
  run.phase = step.type;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: "step_started",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
    payload: {
      step_type: step.type,
      source_tool: step.source_tool,
      planned: true,
    },
  });
  return step;
}

export interface StartWorkflowStepInput {
  title: string;
  actor_id: string | null;
  type?: WorkflowStepType;
  depends_on?: string[];
  expected_output?: OutputContract;
  source_tool?: "dispatch_to" | "hand_off_to" | "run_worker";
}

async function startWorkflowStepUnlocked(
  uid: string,
  cid: string,
  runId: string,
  input: StartWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  if (run.status === "blocked")
    throw new Error("workflow run is blocked by gate");
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "completed"
  ) {
    throw new Error(`workflow run is not active: ${run.status}`);
  }
  const now = nowIso();
  const step: WorkflowStep = {
    id: `wstep-${genId12()}`,
    run_id: run.id,
    title: String(input.title || "Agent step"),
    actor_id: input.actor_id || null,
    type: input.type || "dispatch",
    status: "running",
    depends_on: input.depends_on || [],
    expected_output: input.expected_output,
    source_tool: input.source_tool,
    started_at: now,
  };
  run.steps.push(step);
  run.phase = step.type;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: "step_started",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
    payload: { step_type: step.type, source_tool: step.source_tool },
  });
  return step;
}

export interface CompleteWorkflowStepInput {
  status: Extract<
    WorkflowStepStatus,
    "completed" | "blocked" | "failed" | "skipped"
  >;
  result_summary?: string;
  result_ref?: string;
}

async function completeWorkflowStepUnlocked(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: CompleteWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const now = nowIso();
  step.status = input.status;
  step.result_summary = input.result_summary;
  step.result_ref = input.result_ref;
  step.completed_at = now;
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    reconcileWorkflowStepBlockers(run, context);
    if (input.result_summary && step.actor_id) {
      context.agent_outputs[step.id] = {
        actor_id: step.actor_id,
        step_id: step.id,
        summary: input.result_summary,
        created_at: now,
      };
    }
    context.updated_at = now;
  }
  await writeRun(uid, cid, run);
  if (context) await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "step_completed",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: input.result_summary,
    payload: { status: step.status },
  });
  return step;
}

function workflowAttemptEvent(
  events: CollaborationEvent[],
  type: "step_attempt_started" | "step_attempt_finished",
  runId: string,
  stepId: string,
  attemptNumber: number,
): CollaborationEvent | undefined {
  return events.find(
    (event) =>
      event.type === type &&
      event.run_id === runId &&
      event.step_id === stepId &&
      event.payload?.attempt === attemptNumber,
  );
}

type WorkflowAttemptAuditType =
  | "step_attempt_started"
  | "step_attempt_finished";

type WorkflowAttemptAuditBeforeAppendForTest = (
  type: WorkflowAttemptAuditType,
) => void | Promise<void>;

let _workflowAttemptAuditBeforeAppendForTest:
  | WorkflowAttemptAuditBeforeAppendForTest
  | null = null;

/** Main-process test seam for simulating an audit append failure after durability. */
export function _setWorkflowAttemptAuditBeforeAppendForTest(
  hook: WorkflowAttemptAuditBeforeAppendForTest | null,
): void {
  _workflowAttemptAuditBeforeAppendForTest = hook;
}

async function beforeWorkflowAttemptAuditAppendForTest(
  type: WorkflowAttemptAuditType,
): Promise<void> {
  await _workflowAttemptAuditBeforeAppendForTest?.(type);
}

async function appendWorkflowAttemptStartedEventIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  contextId: string,
  step: WorkflowStep,
  attempt: WorkflowAttempt,
): Promise<boolean> {
  const existing = workflowAttemptEvent(
    await readCollaborationEvents(uid, cid, 0),
    "step_attempt_started",
    run.id,
    step.id,
    attempt.attempt,
  );
  if (existing) {
    if (
      existing.actor_id !== attempt.actor_id ||
      existing.payload?.actor_kind !== attempt.actor_kind
    ) {
      throw new Error("workflow step attempt start event conflict");
    }
    return true;
  }
  await beforeWorkflowAttemptAuditAppendForTest("step_attempt_started");
  await appendCollaborationEvent(uid, cid, {
    type: "step_attempt_started",
    run_id: run.id,
    context_id: contextId,
    actor_id: attempt.actor_id,
    step_id: step.id,
    payload: { attempt: attempt.attempt, actor_kind: attempt.actor_kind },
  });
  return false;
}

async function appendWorkflowAttemptFinishedEventIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  contextId: string,
  step: WorkflowStep,
  attempt: WorkflowAttempt,
): Promise<void> {
  const existing = workflowAttemptEvent(
    await readCollaborationEvents(uid, cid, 0),
    "step_attempt_finished",
    run.id,
    step.id,
    attempt.attempt,
  );
  if (existing) {
    if (
      existing.actor_id !== attempt.actor_id ||
      existing.payload?.status !== attempt.status ||
      existing.payload?.failure_code !== attempt.failure_code
    ) {
      throw new Error("workflow step attempt finish event conflict");
    }
    return;
  }
  await beforeWorkflowAttemptAuditAppendForTest("step_attempt_finished");
  await appendCollaborationEvent(uid, cid, {
    type: "step_attempt_finished",
    run_id: run.id,
    context_id: contextId,
    actor_id: attempt.actor_id,
    step_id: step.id,
    payload: {
      attempt: attempt.attempt,
      status: attempt.status,
      ...(attempt.failure_code
        ? { failure_code: attempt.failure_code }
        : {}),
    },
  });
}

export type BeginWorkflowStepAttemptInput =
  | {
      actor_id: string;
      actor_kind: "agent";
      actor_name?: string;
    }
  | {
      actor_id: null;
      actor_kind: "anonymous_worker";
      actor_name?: string;
    };

async function beginWorkflowStepAttemptUnlocked(
  uid: string,
  cid: string,
  stepId: string,
  input: BeginWorkflowStepAttemptInput,
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const actorKind = normalizeWorkflowAttemptActorKind(input.actor_kind);
  if (!actorKind) throw new Error("invalid workflow step attempt actor kind");
  if (
    (actorKind === "agent" && input.actor_id === null) ||
    (actorKind === "anonymous_worker" && input.actor_id !== null)
  ) {
    throw new Error("workflow step attempt actor kind/id mismatch");
  }
  const actorId = normalizeWorkflowActorId(input.actor_id);
  if (actorId === undefined)
    throw new Error("invalid workflow step attempt actor id");
  const actorName = normalizeWorkflowActorName(input.actor_name);
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const step = active.run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const attempts = step.attempts || [];
  const latest = attempts[attempts.length - 1];
  if (latest?.status === "running") {
    if (latest.actor_id !== actorId || latest.actor_kind !== actorKind) {
      throw new Error("workflow step already has a running attempt");
    }
    const eventAlreadyExists =
      await appendWorkflowAttemptStartedEventIfMissing(
        uid,
        cid,
        active.run,
        active.context.id,
        step,
        latest,
      );
    if (eventAlreadyExists) {
      throw new Error("workflow step attempt already started");
    }
    return step;
  }
  if (attempts.length >= 4)
    throw new Error("workflow step attempt limit reached");
  const now = nowIso();
  if (step.original_actor_id === undefined)
    step.original_actor_id = normalizeWorkflowActorId(step.actor_id) ?? null;
  step.current_actor_id = actorId;
  step.actor_id = actorId;
  step.actor_kind = actorKind;
  if (actorName) step.actor_name = actorName;
  else delete step.actor_name;
  const attempt: WorkflowAttempt = {
    attempt: attempts.length + 1,
    actor_id: actorId,
    actor_kind: actorKind,
    ...(actorName ? { actor_name: actorName } : {}),
    status: "running",
    started_at: now,
  };
  step.attempts = [...attempts, attempt];
  active.run.updated_at = now;
  await writeRun(uid, cid, active.run);
  await appendWorkflowAttemptStartedEventIfMissing(
    uid,
    cid,
    active.run,
    active.context.id,
    step,
    attempt,
  );
  return step;
}

export interface FinishWorkflowStepAttemptInput {
  status: Exclude<WorkflowAttemptStatus, "running">;
  failure_code?: WorkflowAttemptFailureCode;
}

async function finishWorkflowStepAttemptUnlocked(
  uid: string,
  cid: string,
  stepId: string,
  input: FinishWorkflowStepAttemptInput,
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const status = normalizeWorkflowAttemptStatus(input.status);
  if (!status || status === "running")
    throw new Error("invalid workflow step attempt status");
  const failureCode = normalizeWorkflowAttemptFailureCode(input.failure_code);
  if (input.failure_code !== undefined && !failureCode) {
    throw new Error("invalid workflow step attempt failure code");
  }
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const step = active.run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const attempts = step.attempts || [];
  const latest = attempts[attempts.length - 1];
  if (!latest) throw new Error("workflow step has no running attempt");
  if (latest.status !== "running") {
    if (latest.status !== status || latest.failure_code !== failureCode) {
      throw new Error(`workflow step attempt already finished as ${latest.status}`);
    }
    await appendWorkflowAttemptFinishedEventIfMissing(
      uid,
      cid,
      active.run,
      active.context.id,
      step,
      latest,
    );
    return step;
  }
  const now = nowIso();
  latest.status = status;
  latest.completed_at = now;
  if (failureCode) latest.failure_code = failureCode;
  else delete latest.failure_code;
  active.run.updated_at = now;
  await writeRun(uid, cid, active.run);
  await appendWorkflowAttemptFinishedEventIfMissing(
    uid,
    cid,
    active.run,
    active.context.id,
    step,
    latest,
  );
  return step;
}

type RetryPreparationBoundary = "run" | "context" | "audit";
type RetryPreparationBoundaryHookForTest = (
  boundary: RetryPreparationBoundary,
) => void | Promise<void>;

let _retryPreparationBoundaryHookForTest:
  | RetryPreparationBoundaryHookForTest
  | null = null;

/** Main-process test seam for partial retry-preparation durability. */
export function _setRetryPreparationBoundaryHookForTest(
  hook: RetryPreparationBoundaryHookForTest | null,
): void {
  _retryPreparationBoundaryHookForTest = hook;
}

async function beforeRetryPreparationBoundaryForTest(
  boundary: RetryPreparationBoundary,
): Promise<void> {
  await _retryPreparationBoundaryHookForTest?.(boundary);
}

function retryEventAttempt(step: WorkflowStep): number {
  return (step.attempts || []).length + 1;
}

async function appendStepRetriedEventIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  step: WorkflowStep,
): Promise<void> {
  const attempt = retryEventAttempt(step);
  const existing = (await readCollaborationEvents(uid, cid, 0)).find(
    (event) =>
      event.type === "step_retried" &&
      event.run_id === run.id &&
      event.step_id === step.id &&
      event.payload?.attempt === attempt,
  );
  if (existing) return;
  await appendCollaborationEvent(uid, cid, {
    type: "step_retried",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
    payload: { attempt },
  });
}

async function retryWorkflowStepUnlocked(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("workflow step not found");
  if (
    step.status !== "failed" &&
    step.status !== "blocked" &&
    step.status !== "skipped"
  ) {
    throw new Error(
      `workflow step cannot be retried from status: ${step.status}`,
    );
  }
  const now = nowIso();
  step.status = "pending";
  delete step.started_at;
  delete step.completed_at;
  delete step.result_summary;
  delete step.result_ref;
  delete step.gate_result_id;
  run.status = "running";
  run.phase = "step_retry";
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    reconcileWorkflowStepBlockers(run, context);
    context.phase = run.phase;
    context.updated_at = now;
  }
  await beforeRetryPreparationBoundaryForTest("run");
  await writeRun(uid, cid, run);
  if (context) {
    await beforeRetryPreparationBoundaryForTest("context");
    await writeContext(uid, cid, context);
  }
  await beforeRetryPreparationBoundaryForTest("audit");
  await appendStepRetriedEventIfMissing(uid, cid, run, step);
  return step;
}

async function skipWorkflowStepUnlocked(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  reason?: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const now = nowIso();
  step.status = "skipped";
  step.completed_at = now;
  step.result_summary = reason || "Skipped.";
  run.status = run.status === "cancelled" ? run.status : "running";
  run.phase = "step_skipped";
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    reconcileWorkflowStepBlockers(run, context);
    context.phase = run.phase;
    context.updated_at = now;
  }
  await writeRun(uid, cid, run);
  if (context) await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "step_skipped",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: reason || step.title,
  });
  return step;
}

async function resumeWorkflowRunUnlocked(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const now = nowIso();
  run.status = "running";
  run.phase = "resumed";
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    reconcileWorkflowStepBlockers(run, context);
    context.phase = run.phase;
    context.updated_at = now;
  }
  await writeRun(uid, cid, run);
  if (context) await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "workflow_resumed",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: "user",
    summary: reason || "Workflow resumed.",
  });
  return run;
}

async function abortWorkflowRunUnlocked(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const now = nowIso();
  run.status = "cancelled";
  run.phase = "aborted";
  for (const step of run.steps) {
    if (
      step.status === "pending" ||
      step.status === "running" ||
      step.status === "blocked"
    ) {
      step.status = "skipped";
      step.completed_at = now;
      step.result_summary = reason || "Workflow aborted.";
    }
  }
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: "workflow_aborted",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: "user",
    summary: reason || "Workflow aborted.",
  });
  return run;
}

export interface RecordGateResultInput {
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  reason?: string;
  blocks_workflow?: boolean;
}

async function recordGateResultUnlocked(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: RecordGateResultInput,
): Promise<GateResult> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error("workflow run not found");
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const now = nowIso();
  const gate: GateResult = {
    id: `wgate-${genId12()}`,
    run_id: run.id,
    step_id: step.id,
    name: String(input.name || "gate"),
    status: input.status,
    checks: input.checks || [],
    reason: input.reason,
    blocks_workflow: input.blocks_workflow !== false,
    created_at: now,
  };
  step.gate_result_id = gate.id;
  if (
    gate.blocks_workflow !== false &&
    (gate.status === "needs_review" || gate.status === "failed")
  ) {
    run.status = "blocked";
    run.phase =
      gate.status === "needs_review" ? "gate_needs_review" : "gate_failed";
  }
  run.updated_at = now;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.gates.push(gate);
    reconcileWorkflowStepBlockers(run, context);
    context.updated_at = now;
  }
  await writeRun(uid, cid, run);
  if (context) await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "gate_recorded",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    gate_id: gate.id,
    summary: gate.reason || gate.name,
    payload: { status: gate.status, checks_count: gate.checks.length },
  });
  return gate;
}

export interface ReviewCollaborationGateInput {
  decision: "approve" | "reject";
  reviewed_by: string;
  reason?: string;
}

async function reviewCollaborationGateUnlocked(
  uid: string,
  cid: string,
  gateId: string,
  input: ReviewCollaborationGateInput,
): Promise<{
  run: WorkflowRun;
  context: SharedTaskContext;
  gate: GateResult;
  collaboration: CollaborationSnapshot | null;
}> {
  if (!safeId(gateId)) throw new Error("invalid gate id");
  const run = await readActiveWorkflowRunUnlocked(uid, cid);
  if (!run) throw new Error("workflow run not found");
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (!context) throw new Error("shared task context not found");
  const gate = context.gates.find((item) => item.id === gateId);
  if (!gate) throw new Error("collaboration gate not found");
  const step = run.steps.find((item) => item.id === gate.step_id);
  const now = nowIso();
  const decision = input.decision;
  gate.review_decision = decision === "approve" ? "approved" : "rejected";
  gate.reviewed_by = String(input.reviewed_by || "user");
  gate.reviewed_at = now;
  gate.review_reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim()
      : undefined;
  if (decision === "approve") {
    gate.status = "passed";
    run.status = "running";
    run.phase = "gate_approved";
  } else {
    gate.status = "failed";
    run.status = "blocked";
    run.phase = "gate_rejected";
    if (gate.review_reason) gate.reason = gate.review_reason;
  }
  reconcileWorkflowStepBlockers(run, context);
  run.updated_at = now;
  context.updated_at = now;
  await writeRun(uid, cid, run);
  await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "gate_reviewed",
    run_id: run.id,
    context_id: context.id,
    actor_id: gate.reviewed_by,
    step_id: step?.id || gate.step_id,
    gate_id: gate.id,
    summary: gate.review_reason || gate.name,
    payload: { decision: gate.review_decision, status: gate.status },
  });
  return {
    run,
    context,
    gate,
    collaboration: await readActiveCollaborationSnapshotUnlocked(uid, cid),
  };
}

export async function planWorkflowSteps(
  uid: string,
  cid: string,
  runId: string,
  steps: PlanWorkflowStepInput[],
): Promise<WorkflowRun> {
  return conversationLock(uid, cid).runExclusive(() =>
    planWorkflowStepsUnlocked(uid, cid, runId, steps),
  );
}

export async function startPlannedWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    startPlannedWorkflowStepUnlocked(uid, cid, runId, stepId),
  );
}

export async function startWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  input: StartWorkflowStepInput,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    startWorkflowStepUnlocked(uid, cid, runId, input),
  );
}

export async function completeWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: CompleteWorkflowStepInput,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    completeWorkflowStepUnlocked(uid, cid, runId, stepId, input),
  );
}

export async function beginWorkflowStepAttempt(
  uid: string,
  cid: string,
  stepId: string,
  input: BeginWorkflowStepAttemptInput,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    beginWorkflowStepAttemptUnlocked(uid, cid, stepId, input),
  );
}

export async function finishWorkflowStepAttempt(
  uid: string,
  cid: string,
  stepId: string,
  input: FinishWorkflowStepAttemptInput,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    finishWorkflowStepAttemptUnlocked(uid, cid, stepId, input),
  );
}

export async function retryWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    retryWorkflowStepUnlocked(uid, cid, runId, stepId),
  );
}

export async function prepareWorkflowStepForRetry(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(async () => {
    const invariant = () =>
      new Error("workflow step retry lifecycle invariant");
    const active = await readActiveWorkflowRunUnlocked(uid, cid);
    const run = active
      ? await readWorkflowRun(uid, cid, active.id)
      : null;
    const step = run?.steps.find((candidate) => candidate.id === stepId);
    if (!run || !step) throw invariant();
    if (
      step.status === "failed" ||
      step.status === "blocked" ||
      step.status === "skipped"
    ) {
      try {
        await retryWorkflowStepUnlocked(uid, cid, run.id, step.id);
      } catch {
        // Reconcile from disk below. The run write may already be durable even
        // when the following context or audit boundary threw.
      }
    }

    try {
      const authoritative = await readWorkflowRun(uid, cid, run.id);
      const pending = authoritative?.steps.find(
        (candidate) => candidate.id === step.id,
      );
      if (!authoritative || !pending || pending.status !== "pending") {
        throw invariant();
      }
      const context = await readSharedTaskContext(
        uid,
        cid,
        authoritative.context_id,
      );
      if (!context) throw invariant();
      const reconciliation = reconcileWorkflowStepBlockers(
        authoritative,
        context,
      );
      if (reconciliation.runChanged || pending.status !== "pending") {
        throw invariant();
      }
      const contextPhaseChanged = context.phase !== authoritative.phase;
      if (contextPhaseChanged) context.phase = authoritative.phase;
      if (reconciliation.contextChanged || contextPhaseChanged) {
        context.updated_at = authoritative.updated_at;
        await writeContext(uid, cid, context);
      }
      await appendStepRetriedEventIfMissing(
        uid,
        cid,
        authoritative,
        pending,
      );
      const confirmed = await readWorkflowRun(uid, cid, authoritative.id);
      const confirmedStep = confirmed?.steps.find(
        (candidate) => candidate.id === pending.id,
      );
      const confirmedContext = await readSharedTaskContext(
        uid,
        cid,
        authoritative.context_id,
      );
      const retryEvent = (await readCollaborationEvents(uid, cid, 0)).find(
        (event) =>
          event.type === "step_retried" &&
          event.run_id === authoritative.id &&
          event.step_id === pending.id &&
          event.payload?.attempt === retryEventAttempt(pending),
      );
      if (
        !confirmedStep ||
        confirmedStep.status !== "pending" ||
        confirmedContext?.phase !== authoritative.phase ||
        !retryEvent
      ) {
        throw invariant();
      }
      return confirmedStep;
    } catch {
      throw invariant();
    }
  });
}

export async function skipWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  reason?: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    skipWorkflowStepUnlocked(uid, cid, runId, stepId, reason),
  );
}

export async function resumeWorkflowRun(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  return conversationLock(uid, cid).runExclusive(() =>
    resumeWorkflowRunUnlocked(uid, cid, runId, reason),
  );
}

export async function abortWorkflowRun(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  return conversationLock(uid, cid).runExclusive(() =>
    abortWorkflowRunUnlocked(uid, cid, runId, reason),
  );
}

export async function recordGateResult(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: RecordGateResultInput,
): Promise<GateResult> {
  return conversationLock(uid, cid).runExclusive(() =>
    recordGateResultUnlocked(uid, cid, runId, stepId, input),
  );
}

export async function reviewCollaborationGate(
  uid: string,
  cid: string,
  gateId: string,
  input: ReviewCollaborationGateInput,
): Promise<{
  run: WorkflowRun;
  context: SharedTaskContext;
  gate: GateResult;
  collaboration: CollaborationSnapshot | null;
}> {
  return conversationLock(uid, cid).runExclusive(() =>
    reviewCollaborationGateUnlocked(uid, cid, gateId, input),
  );
}

export interface ContextItemDraft {
  text: string;
  source?: ContextItemSource;
  source_ref?: string;
  confidence?: ContextConfidence;
}

export interface DecisionDraft extends ContextItemDraft {
  reason?: string;
  conflicts_with?: string[];
  conflict_key?: string;
  proposal_kind?: "decision" | "recommendation";
  conflict_type?: ContextConflictType;
  evidence_refs?: string[];
}

export interface RiskDraft extends ContextItemDraft {
  severity?: "low" | "medium" | "high";
}

export interface ArtifactRefDraft {
  id?: string;
  type: string;
  path?: string;
  summary?: string;
}

export interface UpdateContextConflictStatusInput {
  status: Exclude<ContextConflictStatus, "resolved" | "dismissed">;
  updated_by: string;
  conflict_type?: ContextConflictType;
  reason?: string;
}

function validateOpenConflictStatus(
  value: unknown,
): value is UpdateContextConflictStatusInput["status"] {
  return (
    value === "detected" ||
    value === "gathering_evidence" ||
    value === "under_review" ||
    value === "awaiting_user"
  );
}

async function updateContextConflictStatusUnlocked(
  uid: string,
  cid: string,
  contextId: string,
  conflictId: string,
  input: UpdateContextConflictStatusInput,
): Promise<SharedTaskContext> {
  if (!safeId(contextId)) throw new Error("invalid workflow context id");
  if (!safeId(conflictId)) throw new Error("invalid conflict id");
  if (!validateOpenConflictStatus(input?.status))
    throw new Error("invalid context conflict status");
  const updatedBy = String(input.updated_by || "").trim();
  if (!updatedBy) throw new Error("conflict status updater is required");
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error("shared task context not found");
  const conflict = context.conflicts.find((item) => item.id === conflictId);
  if (!conflict) throw new Error("context conflict not found");
  if (!isActiveConflict(conflict))
    throw new Error("context conflict is already resolved or dismissed");
  const reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim()
      : undefined;
  const conflictType = input.conflict_type || conflict.type;
  const validConflictTypes = new Set<ContextConflictType>([
    "fact",
    "recommendation",
    "implementation",
    "quality",
    "preference",
    "safety",
  ]);
  if (!validConflictTypes.has(conflictType))
    throw new Error("invalid context conflict type");
  const now = nowIso();
  conflict.status = input.status;
  conflict.type = conflictType;
  conflict.updated_at = now;
  const run = await readWorkflowRun(uid, cid, context.run_id);
  let runChanged = false;
  if (run) {
    const reconciliation = reconcileWorkflowStepBlockers(run, context);
    runChanged = reconciliation.runChanged;
    if (runChanged) {
      run.updated_at = now;
      await writeRun(uid, cid, run);
    }
  }
  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "conflict_status_updated",
    run_id: context.run_id,
    context_id: context.id,
    actor_id: updatedBy,
    summary: reason,
    payload: {
      conflict_id: conflict.id,
      status: conflict.status,
      conflict_type: conflict.type,
      reason,
      run_changed: runChanged,
    },
  });
  return written;
}

export async function updateContextConflictStatus(
  uid: string,
  cid: string,
  contextId: string,
  conflictId: string,
  input: UpdateContextConflictStatusInput,
): Promise<SharedTaskContext> {
  return conversationLock(uid, cid).runExclusive(() =>
    updateContextConflictStatusUnlocked(uid, cid, contextId, conflictId, input),
  );
}

async function updateActiveContextConflictStatusForActorUnlocked(
  uid: string,
  cid: string,
  conflictId: string,
  input: Omit<UpdateContextConflictStatusInput, "updated_by">,
  updatedBy: string,
): Promise<{
  context: SharedTaskContext;
  collaboration: CollaborationSnapshot | null;
}> {
  const context = await readActiveContextForResolutionUnlocked(uid, cid);
  const updatedContext = await updateContextConflictStatusUnlocked(
    uid,
    cid,
    context.id,
    conflictId,
    { ...input, updated_by: updatedBy },
  );
  const active = await readActiveCollaborationStateUnlocked(uid, cid);
  return {
    context: updatedContext,
    collaboration: active?.snapshot || null,
  };
}

export async function updateActiveContextConflictStatusForActor(
  uid: string,
  cid: string,
  conflictId: string,
  input: Omit<UpdateContextConflictStatusInput, "updated_by">,
  updatedBy: string,
): Promise<{
  context: SharedTaskContext;
  collaboration: CollaborationSnapshot | null;
}> {
  return conversationLock(uid, cid).runExclusive(() =>
    updateActiveContextConflictStatusForActorUnlocked(
      uid,
      cid,
      conflictId,
      input,
      updatedBy,
    ),
  );
}

export interface ResolveContextConflictByIdInput {
  decision: "accept" | "reject" | "merge";
  selected_proposal_ids: string[];
  text: string;
  reason?: string;
  resolved_by: string;
}

export type ResolveContextConflictSelectionInput = Omit<
  ResolveContextConflictByIdInput,
  "resolved_by"
>;

export interface ResolveContextConflictInput {
  decision: "accept" | "reject" | "merge";
  text: string;
  resolved_by: string;
  reason?: string;
  obsolete_item_ids?: string[];
}

function normalizeResolutionSelection(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new Error("selected proposal ids are required");
  const selected = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (selected.some((item) => !item || !safeId(item)))
    throw new Error("invalid selected proposal id");
  if (new Set(selected).size !== selected.length)
    throw new Error("selected proposal ids must be unique");
  return selected;
}

function normalizeResolutionText(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) throw new Error("conflict resolution text is required");
  return text;
}

function validateResolutionDecision(
  value: unknown,
): value is ResolveContextConflictByIdInput["decision"] {
  return value === "accept" || value === "reject" || value === "merge";
}

async function resolveContextConflictByIdUnlocked(
  uid: string,
  cid: string,
  contextId: string,
  conflictId: string,
  input: ResolveContextConflictByIdInput,
): Promise<SharedTaskContext> {
  if (!safeId(contextId)) throw new Error("invalid workflow context id");
  if (!safeId(conflictId)) throw new Error("invalid conflict id");
  if (!isPlainRecord(input))
    throw new Error("invalid conflict resolution input");
  if (!validateResolutionDecision(input.decision))
    throw new Error("invalid conflict resolution decision");
  const selectedProposalIds = normalizeResolutionSelection(
    input.selected_proposal_ids,
  );
  const text = normalizeResolutionText(input.text);
  const resolvedBy = String(input.resolved_by || "").trim();
  if (!resolvedBy) throw new Error("conflict resolver is required");
  const reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim()
      : undefined;

  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error("shared task context not found");
  const conflict = context.conflicts.find((item) => item.id === conflictId);
  if (!conflict) throw new Error("context conflict not found");
  if (!isActiveConflict(conflict))
    throw new Error("context conflict is already resolved or dismissed");

  const conflictProposalIds = normalizeStringArray(conflict.proposal_ids);
  const conflictProposalIdSet = new Set(conflictProposalIds);
  if (
    selectedProposalIds.some(
      (proposalId) => !conflictProposalIdSet.has(proposalId),
    )
  ) {
    throw new Error("selected proposal does not belong to conflict");
  }
  const proposals = conflictProposalIds.map((proposalId) =>
    context.proposals.find((item) => item.id === proposalId),
  );
  if (proposals.some((proposal): proposal is undefined => !proposal)) {
    throw new Error("context conflict references a missing proposal");
  }
  if (proposals.some((proposal) => proposal.status !== "pending")) {
    throw new Error("context conflict proposals are not pending");
  }

  if (input.decision === "accept" && selectedProposalIds.length !== 1) {
    throw new Error("accept requires exactly one proposal");
  }
  if (input.decision === "merge" && selectedProposalIds.length < 2) {
    throw new Error("merge requires at least two proposals");
  }
  if (input.decision === "reject" && selectedProposalIds.length !== 0) {
    throw new Error("reject requires no selected proposals");
  }

  const now = nowIso();
  const selectedSet = new Set(selectedProposalIds);
  const selectedProposals = proposals.filter((proposal) =>
    selectedSet.has(proposal.id),
  );
  for (const proposal of proposals) {
    proposal.status = selectedSet.has(proposal.id)
      ? input.decision === "accept"
        ? "accepted"
        : "superseded"
      : "rejected";
    proposal.resolved_at = now;
  }

  if (input.decision !== "reject") {
    const decision: DecisionItem = {
      id: `witem-${genId12()}`,
      text,
      source: "user",
      source_ref: `conflict:${conflict.id};proposals:${selectedProposalIds.join(",")}`,
      confidence: selectedProposals.reduce<ContextConfidence>(
        (highest, proposal) => {
          if (proposal.confidence === "high" || highest === "high")
            return "high";
          if (proposal.confidence === "medium" || highest === "medium")
            return "medium";
          return "low";
        },
        "low",
      ),
      added_by: resolvedBy,
      created_at: now,
      ...(reason ? { reason } : {}),
    };
    context.decisions.push(decision);
  }

  conflict.status = input.decision === "reject" ? "dismissed" : "resolved";
  conflict.resolution = {
    decision: input.decision,
    selected_proposal_ids: [...selectedProposalIds],
    text,
    ...(reason ? { reason } : {}),
    resolved_by: resolvedBy,
    resolved_at: now,
  };
  conflict.updated_at = now;

  const run = await readWorkflowRun(uid, cid, context.run_id);
  let runChanged = false;
  if (run) {
    const reconciliation = reconcileWorkflowStepBlockers(run, context);
    runChanged = reconciliation.runChanged;
    if (runChanged) {
      run.updated_at = now;
      await writeRun(uid, cid, run);
    }
  }
  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "conflict_resolved",
    run_id: context.run_id,
    context_id: context.id,
    actor_id: resolvedBy,
    summary: text,
    payload: {
      conflict_id: conflict.id,
      decision: input.decision,
      selected_proposal_ids: [...selectedProposalIds],
      proposal_count: proposals.length,
      resolved_by: resolvedBy,
      resolved_at: now,
      status: conflict.status,
      run_changed: runChanged,
    },
  });
  return written;
}

export async function resolveContextConflictById(
  uid: string,
  cid: string,
  contextId: string,
  conflictId: string,
  input: ResolveContextConflictByIdInput,
): Promise<SharedTaskContext> {
  return conversationLock(uid, cid).runExclusive(() =>
    resolveContextConflictByIdUnlocked(uid, cid, contextId, conflictId, input),
  );
}

export async function resolveContextConflictForActor(
  uid: string,
  cid: string,
  contextId: string,
  conflictId: string,
  input: ResolveContextConflictSelectionInput,
  resolvedBy: string,
): Promise<SharedTaskContext> {
  return resolveContextConflictById(uid, cid, contextId, conflictId, {
    ...input,
    resolved_by: resolvedBy,
  });
}

async function resolveActiveContextConflictForActorUnlocked(
  uid: string,
  cid: string,
  conflictId: string,
  input: ResolveContextConflictSelectionInput,
  resolvedBy: string,
): Promise<{
  context: SharedTaskContext;
  collaboration: CollaborationSnapshot | null;
}> {
  const context = await readActiveContextForResolutionUnlocked(uid, cid);
  const resolvedContext = await resolveContextConflictByIdUnlocked(
    uid,
    cid,
    context.id,
    conflictId,
    {
      ...input,
      resolved_by: resolvedBy,
    },
  );
  const active = await readActiveCollaborationStateUnlocked(uid, cid);
  return {
    context: resolvedContext,
    collaboration: active?.snapshot || null,
  };
}

export async function resolveActiveContextConflictForActor(
  uid: string,
  cid: string,
  conflictId: string,
  input: ResolveContextConflictSelectionInput,
  resolvedBy: string,
): Promise<{
  context: SharedTaskContext;
  collaboration: CollaborationSnapshot | null;
}> {
  return conversationLock(uid, cid).runExclusive(() =>
    resolveActiveContextConflictForActorUnlocked(
      uid,
      cid,
      conflictId,
      input,
      resolvedBy,
    ),
  );
}

async function resolveContextConflictLegacyUnlocked(
  uid: string,
  cid: string,
  contextId: string,
  input: ResolveContextConflictInput,
): Promise<SharedTaskContext> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error("shared task context not found");
  const text = String(input.text || "").trim();
  if (!text) throw new Error("conflict resolution text is required");
  const now = nowIso();
  const resolvedBy = String(input.resolved_by || "user");
  if (input.decision === "accept" || input.decision === "merge") {
    if (!hasText(context.decisions, text)) {
      context.decisions.push({
        id: `witem-${genId12()}`,
        text,
        source: "user",
        confidence: "high",
        added_by: resolvedBy,
        created_at: now,
        reason: input.reason,
      });
    }
  }
  const obsolete = new Set(input.obsolete_item_ids || []);
  context.open_questions = context.open_questions.filter((item) => {
    if (obsolete.has(item.id)) return false;
    if (item.text.includes(text)) return false;
    if (
      item.text.startsWith("Conflicting decision proposed:") &&
      input.decision !== "reject"
    )
      return false;
    return true;
  });
  if (obsolete.size) {
    context.facts = context.facts.filter((item) => !obsolete.has(item.id));
    context.decisions = context.decisions.filter(
      (item) => !obsolete.has(item.id) || item.text === text,
    );
    context.risks = context.risks.filter((item) => !obsolete.has(item.id));
  }
  const run = await readWorkflowRun(uid, cid, context.run_id);
  if (run) {
    const reconciliation = reconcileWorkflowStepBlockers(run, context);
    if (reconciliation.runChanged) {
      run.updated_at = now;
      await writeRun(uid, cid, run);
    }
  }
  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: "conflict_resolved",
    run_id: context.run_id,
    context_id: context.id,
    actor_id: resolvedBy,
    summary: text,
    payload: { decision: input.decision, obsolete_count: obsolete.size },
  });
  return written;
}

export async function resolveContextConflict(
  uid: string,
  cid: string,
  contextId: string,
  input: ResolveContextConflictInput,
): Promise<SharedTaskContext> {
  return conversationLock(uid, cid).runExclusive(() =>
    resolveContextConflictLegacyUnlocked(uid, cid, contextId, input),
  );
}

export interface CollaborationEventReplay {
  total_events: number;
  by_type: Record<string, number>;
  latest_run_id?: string;
  latest_context_id?: string;
  blocking_gate_id?: string;
}

export async function replayCollaborationEvents(
  uid: string,
  cid: string,
): Promise<CollaborationEventReplay> {
  const events = await readCollaborationEvents(uid, cid, 0);
  const byType: Record<string, number> = {};
  const replay: CollaborationEventReplay = {
    total_events: events.length,
    by_type: byType,
  };
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (event.run_id) replay.latest_run_id = event.run_id;
    if (event.context_id) replay.latest_context_id = event.context_id;
    if (event.type === "gate_recorded" && event.gate_id)
      replay.blocking_gate_id = event.gate_id;
    if (
      event.type === "gate_reviewed" &&
      event.gate_id &&
      event.gate_id === replay.blocking_gate_id
    ) {
      replay.blocking_gate_id = undefined;
    }
  }
  await appendCollaborationEvent(uid, cid, {
    type: "events_replayed",
    run_id: replay.latest_run_id || "none",
    context_id: replay.latest_context_id,
    actor_id: "system",
    summary: `Replayed ${events.length} collaboration event(s).`,
    payload: { by_type: byType },
  }).catch(() => undefined);
  return replay;
}

export interface ContextPatch {
  added_by: string;
  base_context_revision?: number;
  summary?: string;
  facts_add?: ContextItemDraft[];
  decisions_proposed?: DecisionDraft[];
  risks_add?: RiskDraft[];
  open_questions_add?: ContextItemDraft[];
  artifacts_add?: ArtifactRefDraft[];
  obsolete_item_ids?: string[];
}

function contextItemFromDraft(
  draft: ContextItemDraft,
  addedBy: string,
): ContextItem {
  return {
    id: `witem-${genId12()}`,
    text: String(draft.text || "").trim(),
    source: draft.source || "agent",
    source_ref: draft.source_ref,
    confidence: draft.confidence || "medium",
    added_by: addedBy,
    created_at: nowIso(),
  };
}

function hasText(items: Array<{ text: string }>, text: string): boolean {
  return items.some(
    (item) => item.text.trim().toLowerCase() === text.trim().toLowerCase(),
  );
}

function normalizeConflictKey(value: unknown): string | undefined {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(key) ? key : undefined;
}

function normalizedProposalText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeProposalKind(value: unknown): "decision" | "recommendation" {
  return value === "recommendation" ? "recommendation" : "decision";
}

function normalizeConflictType(value: unknown): ContextConflictType {
  return value === "fact" ||
    value === "recommendation" ||
    value === "implementation" ||
    value === "quality" ||
    value === "preference" ||
    value === "safety"
    ? value
    : "recommendation";
}

const MAX_WORKFLOW_METADATA_ITEMS = 256;
const MAX_WORKFLOW_METADATA_STRING_LENGTH = 16_384;
const MAX_WORKFLOW_ID_LENGTH = 512;

function isCanonicalStoredStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKFLOW_METADATA_ITEMS)
    return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item ||
      item !== item.trim() ||
      item.length > MAX_WORKFLOW_METADATA_STRING_LENGTH ||
      seen.has(item)
    ) {
      return false;
    }
    seen.add(item);
  }
  return true;
}

function hasInvalidStoredAccessMetadata(step: WorkflowStep): boolean {
  if (
    step.required_capabilities !== undefined &&
    !isCanonicalStoredStringArray(step.required_capabilities)
  ) {
    return true;
  }
  if (
    step.write_scopes !== undefined &&
    !isCanonicalStoredStringArray(step.write_scopes)
  ) {
    return true;
  }
  return (
    step.access_mode !== undefined &&
    step.access_mode !== "read" &&
    step.access_mode !== "write"
  );
}

function normalizeBoundedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, MAX_WORKFLOW_METADATA_ITEMS)
        .map((item) =>
          typeof item === "string"
            ? item.trim().slice(0, MAX_WORKFLOW_METADATA_STRING_LENGTH)
            : "",
        )
        .filter(Boolean),
    ),
  );
}

function normalizeStringArray(value: unknown): string[] {
  return normalizeBoundedStringArray(value);
}

function normalizedWorkflowDependencyId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const dependency = value.trim();
  return dependency.length <= MAX_WORKFLOW_ID_LENGTH && safeId(dependency)
    ? dependency
    : null;
}

function hasInvalidWorkflowDependencyIds(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > MAX_WORKFLOW_METADATA_ITEMS ||
      value.some((item) => normalizedWorkflowDependencyId(item) === null))
  );
}

function normalizeWorkflowDependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, MAX_WORKFLOW_METADATA_ITEMS)
        .map(normalizedWorkflowDependencyId)
        .filter((item): item is string => item !== null),
    ),
  );
}

function normalizeWorkflowDependencyInput(value: unknown): string[] {
  if (hasInvalidWorkflowDependencyIds(value))
    throw new Error("invalid workflow step dependency id");
  return normalizeWorkflowDependencyIds(value);
}

function normalizeWorkflowAccessMode(value: unknown): "read" | "write" {
  return value === "read" ? "read" : "write";
}

function normalizeContextDependencies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.map(normalizeConflictKey).filter((item): item is string => !!item),
    ),
  );
}

function normalizeConflictIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((item): item is string => safeId(item))),
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function isActiveConflict(conflict: ContextConflict): boolean {
  return conflict.status !== "resolved" && conflict.status !== "dismissed";
}

interface WorkflowStepBlockerReconciliation {
  runChanged: boolean;
  contextChanged: boolean;
}

function reconcileWorkflowStepBlockers(
  run: WorkflowRun,
  context: SharedTaskContext,
): WorkflowStepBlockerReconciliation {
  const reconciled = reconcileControlPlaneStepBlockers(run, context);
  run.status = reconciled.run.status;
  run.phase = reconciled.run.phase;
  for (const nextStep of reconciled.run.steps) {
    const currentStep = run.steps.find((step) => step.id === nextStep.id);
    if (!currentStep) continue;
    for (const key of Object.keys(currentStep) as Array<keyof WorkflowStep>) {
      if (!(key in nextStep)) delete (currentStep as any)[key];
    }
    Object.assign(currentStep, nextStep);
  }
  for (const nextConflict of reconciled.context.conflicts) {
    const currentConflict = context.conflicts.find((conflict) => conflict.id === nextConflict.id);
    if (currentConflict) Object.assign(currentConflict, nextConflict);
  }
  return {
    runChanged: reconciled.runChanged,
    contextChanged: reconciled.contextChanged,
  };
}

function pendingLifecycleProposals(
  context: SharedTaskContext,
  conflictKey: string,
): ContextProposal[] {
  const terminalProposalIds = new Set(
    context.conflicts
      .filter((conflict) => !isActiveConflict(conflict))
      .flatMap((conflict) => conflict.proposal_ids),
  );
  const distinct = new Map<string, ContextProposal>();
  for (const proposal of context.proposals) {
    if (
      proposal.conflict_key !== conflictKey ||
      proposal.status !== "pending" ||
      terminalProposalIds.has(proposal.id)
    )
      continue;
    const normalizedText = normalizedProposalText(proposal.text);
    if (normalizedText && !distinct.has(normalizedText))
      distinct.set(normalizedText, proposal);
  }
  return Array.from(distinct.values());
}

async function applyContextPatchUnlocked(
  uid: string,
  cid: string,
  contextId: string,
  patch: ContextPatch,
): Promise<SharedTaskContext> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error("shared task context not found");
  const addedBy = String(patch.added_by || "agent");
  const now = nowIso();
  const currentRevision = context.revision;
  const hasBaseRevision =
    Number.isSafeInteger(patch.base_context_revision) &&
    (patch.base_context_revision as number) >= 0;
  const revisionMismatch =
    hasBaseRevision && patch.base_context_revision !== currentRevision;
  const proposalEvents: Array<{ proposal_id: string }> = [];
  const conflictDetectedEvents: Array<{
    conflict_id: string;
    proposal_ids: string[];
    proposal_count: number;
  }> = [];
  const before = {
    facts: context.facts.length,
    decisions: context.decisions.length,
    risks: context.risks.length,
    open_questions: context.open_questions.length,
    artifacts: context.artifacts.length,
  };

  for (const draft of patch.facts_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.facts, item.text))
      context.facts.push(item);
  }

  for (const draft of patch.decisions_proposed || []) {
    const text = String(draft.text || "").trim();
    if (!text) continue;
    const conflictKey = normalizeConflictKey(draft.conflict_key);
    if (conflictKey) {
      const currentProposals = pendingLifecycleProposals(context, conflictKey);
      const normalizedText = normalizedProposalText(text);
      if (
        currentProposals.some(
          (proposal) =>
            normalizedProposalText(proposal.text) === normalizedText,
        )
      )
        continue;
      const proposal: ContextProposal = {
        id: `wproposal-${genId12()}`,
        conflict_key: conflictKey,
        kind: normalizeProposalKind(draft.proposal_kind),
        text,
        reason:
          typeof draft.reason === "string" && draft.reason.trim()
            ? draft.reason.trim()
            : undefined,
        evidence_refs: normalizeStringArray(draft.evidence_refs),
        confidence: normalizeConfidence(draft.confidence) || "medium",
        proposed_by: addedBy,
        status: "pending",
        created_at: now,
      };
      context.proposals.push(proposal);
      proposalEvents.push({ proposal_id: proposal.id });

      const pending = pendingLifecycleProposals(context, conflictKey);
      if (pending.length >= 2) {
        const activeConflict = context.conflicts.find(
          (conflict) =>
            conflict.conflict_key === conflictKey && isActiveConflict(conflict),
        );
        if (activeConflict) {
          activeConflict.proposal_ids = pending.map((item) => item.id);
          activeConflict.updated_at = now;
        } else {
          const conflict: ContextConflict = {
            id: `wconflict-${genId12()}`,
            conflict_key: conflictKey,
            type: normalizeConflictType(draft.conflict_type),
            status: "detected",
            proposal_ids: pending.map((item) => item.id),
            affected_step_ids: [],
            created_at: now,
            updated_at: now,
          };
          context.conflicts.push(conflict);
          conflictDetectedEvents.push({
            conflict_id: conflict.id,
            proposal_ids: [...conflict.proposal_ids],
            proposal_count: conflict.proposal_ids.length,
          });
        }
      }
      continue;
    }

    const conflicts = (draft.conflicts_with || []).filter((value) =>
      hasText(context.decisions, value),
    );
    if (conflicts.length > 0) {
      context.open_questions.push({
        id: `witem-${genId12()}`,
        text: `Conflicting decision proposed: ${text}`,
        source: draft.source || "agent",
        source_ref: draft.source_ref,
        confidence: draft.confidence || "medium",
        added_by: addedBy,
        created_at: now,
      });
      continue;
    }
    if (!hasText(context.decisions, text)) {
      const base = contextItemFromDraft(draft, addedBy);
      context.decisions.push({ ...base, reason: draft.reason });
    }
  }

  for (const draft of patch.risks_add || []) {
    const base = contextItemFromDraft(draft, addedBy);
    if (base.text && !hasText(context.risks, base.text)) {
      context.risks.push({ ...base, severity: draft.severity || "medium" });
    }
  }

  for (const draft of patch.open_questions_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.open_questions, item.text))
      context.open_questions.push(item);
  }

  for (const draft of patch.artifacts_add || []) {
    const id = String(draft.id || `wartifact-${genId12()}`).trim();
    if (!id || context.artifacts.some((item) => item.id === id)) continue;
    context.artifacts.push({
      id,
      type: String(draft.type || "artifact"),
      path: draft.path,
      summary: draft.summary,
      added_by: addedBy,
      created_at: now,
    });
  }

  const obsoleteIds = revisionMismatch ? [] : patch.obsolete_item_ids || [];
  if (obsoleteIds.length > 0) {
    const obsolete = new Set(obsoleteIds);
    context.facts = context.facts.filter((item) => !obsolete.has(item.id));
    context.decisions = context.decisions.filter(
      (item) => !obsolete.has(item.id),
    );
    context.risks = context.risks.filter((item) => !obsolete.has(item.id));
    context.open_questions = context.open_questions.filter(
      (item) => !obsolete.has(item.id),
    );
  }

  const run = await readWorkflowRun(uid, cid, context.run_id);
  if (run) {
    const reconciliation = reconcileWorkflowStepBlockers(run, context);
    if (reconciliation.runChanged) {
      run.updated_at = now;
      await writeRun(uid, cid, run);
    }
  }
  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  if (revisionMismatch) {
    await appendCollaborationEvent(uid, cid, {
      type: "context_revision_mismatch",
      run_id: context.run_id,
      context_id: context.id,
      actor_id: addedBy,
      payload: {
        base_context_revision: patch.base_context_revision,
        current_context_revision: currentRevision,
        obsolete_count_ignored: Array.isArray(patch.obsolete_item_ids)
          ? patch.obsolete_item_ids.length
          : 0,
      },
    });
  }
  for (const event of proposalEvents) {
    await appendCollaborationEvent(uid, cid, {
      type: "proposal_recorded",
      run_id: context.run_id,
      context_id: context.id,
      actor_id: addedBy,
      payload: event,
    });
  }
  for (const event of conflictDetectedEvents) {
    await appendCollaborationEvent(uid, cid, {
      type: "conflict_detected",
      run_id: context.run_id,
      context_id: context.id,
      actor_id: addedBy,
      payload: event,
    });
  }
  await appendCollaborationEvent(uid, cid, {
    type: "context_patch_applied",
    run_id: context.run_id,
    context_id: context.id,
    actor_id: addedBy,
    summary: patch.summary,
    payload: {
      facts_added: Math.max(0, context.facts.length - before.facts),
      decisions_added: Math.max(0, context.decisions.length - before.decisions),
      risks_added: Math.max(0, context.risks.length - before.risks),
      open_questions_added: Math.max(
        0,
        context.open_questions.length - before.open_questions,
      ),
      artifacts_added: Math.max(0, context.artifacts.length - before.artifacts),
      obsolete_count: obsoleteIds.length,
    },
  });
  return written;
}

export async function applyContextPatch(
  uid: string,
  cid: string,
  contextId: string,
  patch: ContextPatch,
): Promise<SharedTaskContext> {
  return conversationLock(uid, cid).runExclusive(() =>
    applyContextPatchUnlocked(uid, cid, contextId, patch),
  );
}

export async function applyActiveContextPatches(
  uid: string,
  cid: string,
  patches: ContextPatch[],
): Promise<SharedTaskContext | null> {
  return conversationLock(uid, cid).runExclusive(async () => {
    const active = await readActiveWorkflowStateUnlocked(uid, cid);
    if (!active) return null;
    let context = active.context;
    for (const patch of patches || []) {
      context = await applyContextPatchUnlocked(uid, cid, context.id, patch);
    }
    return context;
  });
}

export interface ExtractedContextPatchBlocks {
  cleanText: string;
  patches: ContextPatch[];
  errors: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeConfidence(value: unknown): ContextConfidence | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

function normalizeSource(value: unknown): ContextItemSource | undefined {
  return value === "user" ||
    value === "agent" ||
    value === "code" ||
    value === "artifact" ||
    value === "system" ||
    value === "spec"
    ? value
    : undefined;
}

function normalizeTextDraftArray(
  value: unknown,
): ContextItemDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drafts: ContextItemDraft[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const text = stringOrUndefined(raw.text);
    if (!text) continue;
    drafts.push({
      text,
      source: normalizeSource(raw.source),
      source_ref: stringOrUndefined(raw.source_ref),
      confidence: normalizeConfidence(raw.confidence),
    });
  }
  return drafts.length ? drafts : undefined;
}

function normalizeDecisionDraftArray(
  value: unknown,
): DecisionDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drafts: DecisionDraft[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const text = stringOrUndefined(raw.text);
    if (!text) continue;
    drafts.push({
      text,
      source: normalizeSource(raw.source),
      source_ref: stringOrUndefined(raw.source_ref),
      confidence: normalizeConfidence(raw.confidence),
      reason: stringOrUndefined(raw.reason),
      conflicts_with: Array.isArray(raw.conflicts_with)
        ? raw.conflicts_with
            .map((item) => stringOrUndefined(item))
            .filter((item): item is string => !!item)
        : undefined,
      conflict_key: normalizeConflictKey(raw.conflict_key),
      proposal_kind: normalizeProposalKind(raw.proposal_kind),
      conflict_type: normalizeConflictType(raw.conflict_type),
      evidence_refs: normalizeStringArray(raw.evidence_refs),
    });
  }
  return drafts.length ? drafts : undefined;
}

function normalizeRiskDraftArray(value: unknown): RiskDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drafts: RiskDraft[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const text = stringOrUndefined(raw.text);
    if (!text) continue;
    const severity =
      raw.severity === "low" ||
      raw.severity === "medium" ||
      raw.severity === "high"
        ? raw.severity
        : undefined;
    drafts.push({
      text,
      source: normalizeSource(raw.source),
      source_ref: stringOrUndefined(raw.source_ref),
      confidence: normalizeConfidence(raw.confidence),
      severity,
    });
  }
  return drafts.length ? drafts : undefined;
}

function normalizeArtifactDraftArray(
  value: unknown,
): ArtifactRefDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drafts: ArtifactRefDraft[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const type = stringOrUndefined(raw.type) || "artifact";
    const id = stringOrUndefined(raw.id);
    const artifactPath = stringOrUndefined(raw.path);
    const summary = stringOrUndefined(raw.summary);
    if (!id && !artifactPath && !summary) continue;
    drafts.push({ id, type, path: artifactPath, summary });
  }
  return drafts.length ? drafts : undefined;
}

function normalizeContextPatch(
  value: unknown,
  addedBy: string,
): ContextPatch | null {
  if (!isPlainRecord(value)) return null;
  const patch: ContextPatch = { added_by: addedBy };
  if (
    Number.isSafeInteger(value.base_context_revision) &&
    (value.base_context_revision as number) >= 0
  ) {
    patch.base_context_revision = value.base_context_revision as number;
  }
  const summary = stringOrUndefined(value.summary);
  if (summary) patch.summary = summary;
  const facts = normalizeTextDraftArray(value.facts_add);
  if (facts) patch.facts_add = facts;
  const decisions = normalizeDecisionDraftArray(value.decisions_proposed);
  if (decisions) patch.decisions_proposed = decisions;
  const risks = normalizeRiskDraftArray(value.risks_add);
  if (risks) patch.risks_add = risks;
  const questions = normalizeTextDraftArray(value.open_questions_add);
  if (questions) patch.open_questions_add = questions;
  const artifacts = normalizeArtifactDraftArray(value.artifacts_add);
  if (artifacts) patch.artifacts_add = artifacts;
  if (Array.isArray(value.obsolete_item_ids)) {
    const ids = value.obsolete_item_ids
      .map((item) => stringOrUndefined(item))
      .filter((item): item is string => !!item);
    if (ids.length) patch.obsolete_item_ids = ids;
  }
  const hasMutation = !!(
    patch.summary ||
    patch.facts_add?.length ||
    patch.decisions_proposed?.length ||
    patch.risks_add?.length ||
    patch.open_questions_add?.length ||
    patch.artifacts_add?.length ||
    patch.obsolete_item_ids?.length
  );
  return hasMutation ? patch : null;
}

export function extractContextPatchBlocks(
  text: string,
  addedBy: string,
): ExtractedContextPatchBlocks {
  const source = String(text || "");
  if (!source) return { cleanText: "", patches: [], errors: [] };
  const re = /<context-patch>\s*([\s\S]*?)\s*<\/context-patch>/gi;
  let lastIndex = 0;
  let changed = false;
  let clean = "";
  const patches: ContextPatch[] = [];
  const errors: string[] = [];
  for (const match of source.matchAll(re)) {
    const full = match[0];
    const body = match[1] || "";
    const index = match.index ?? 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      errors.push(`invalid context-patch JSON: ${(err as Error).message}`);
      clean += source.slice(lastIndex, index + full.length);
      lastIndex = index + full.length;
      continue;
    }
    const patch = normalizeContextPatch(parsed, String(addedBy || "agent"));
    if (!patch) {
      errors.push("invalid context-patch payload: no supported patch fields");
      clean += source.slice(lastIndex, index + full.length);
      lastIndex = index + full.length;
      continue;
    }
    clean += source.slice(lastIndex, index);
    lastIndex = index + full.length;
    patches.push(patch);
    changed = true;
  }
  clean += source.slice(lastIndex);
  if (changed) clean = clean.replace(/[ \t]*\n[ \t]*\n/g, "\n").trim();
  return { cleanText: changed ? clean : source, patches, errors };
}

export interface CollaborationSnapshotItem {
  id: string;
  text: string;
  added_by: string;
  confidence?: ContextConfidence;
  created_at: string;
  reason?: string;
  severity?: "low" | "medium" | "high";
}

export interface CollaborationSnapshotArtifact {
  id: string;
  type: string;
  path?: string;
  summary?: string;
  added_by: string;
  created_at: string;
}

export interface CollaborationSnapshot {
  run_id: string;
  context_id: string;
  objective: string;
  status: WorkflowRunStatus;
  phase: string;
  steps: Array<
    Pick<
      WorkflowStep,
      | "id"
      | "title"
      | "actor_id"
      | "type"
      | "status"
      | "source_tool"
      | "started_at"
      | "completed_at"
      | "result_summary"
      | "gate_result_id"
    >
  >;
  context_revision: number;
  facts_count: number;
  decisions_count: number;
  risks_count: number;
  open_questions_count: number;
  artifacts_count: number;
  facts_preview: CollaborationSnapshotItem[];
  decisions_preview: CollaborationSnapshotItem[];
  risks_preview: CollaborationSnapshotItem[];
  open_questions_preview: CollaborationSnapshotItem[];
  artifacts_preview: CollaborationSnapshotArtifact[];
  gates: GateResult[];
  active_conflicts: ContextConflict[];
  resolved_conflicts_count: number;
  blocking_gate?: GateResult;
  recent_events: CollaborationEvent[];
  updated_at: string;
}

function contextItemPreview(
  item: ContextItem | DecisionItem | RiskItem,
): CollaborationSnapshotItem {
  const decision = item as DecisionItem;
  const risk = item as RiskItem;
  return {
    id: item.id,
    text: item.text,
    added_by: item.added_by,
    confidence: item.confidence,
    created_at: item.created_at,
    reason: decision.reason,
    severity: risk.severity,
  };
}

async function buildCollaborationSnapshotUnlocked(
  uid: string,
  cid: string,
  run: WorkflowRun,
  context: SharedTaskContext,
): Promise<CollaborationSnapshot> {
  const recentEvents = await readCollaborationEvents(uid, cid, 20);
  const blockingGate = context.gates.find(
    (gate) =>
      gate.blocks_workflow !== false &&
      (gate.status === "needs_review" || gate.status === "failed"),
  );
  return {
    run_id: run.id,
    context_id: context.id,
    objective: run.objective,
    status: run.status,
    phase: run.phase,
    steps: run.steps.map((step) => ({
      id: step.id,
      title: step.title,
      actor_id: step.actor_id,
      type: step.type,
      status: step.status,
      source_tool: step.source_tool,
      started_at: step.started_at,
      completed_at: step.completed_at,
      result_summary: step.result_summary,
      gate_result_id: step.gate_result_id,
    })),
    context_revision: context.revision,
    facts_count: context.facts.length,
    decisions_count: context.decisions.length,
    risks_count: context.risks.length,
    open_questions_count: context.open_questions.length,
    artifacts_count: context.artifacts.length,
    facts_preview: context.facts.slice(-5).map(contextItemPreview),
    decisions_preview: context.decisions.slice(-5).map(contextItemPreview),
    risks_preview: context.risks.slice(-5).map(contextItemPreview),
    open_questions_preview: context.open_questions
      .slice(-5)
      .map(contextItemPreview),
    artifacts_preview: context.artifacts.slice(-5).map((item) => ({
      id: item.id,
      type: item.type,
      path: item.path,
      summary: item.summary,
      added_by: item.added_by,
      created_at: item.created_at,
    })),
    gates: context.gates,
    active_conflicts: context.conflicts.filter(isActiveConflict).slice(-5),
    resolved_conflicts_count: context.conflicts.filter((conflict) => !isActiveConflict(conflict)).length,
    ...(blockingGate ? { blocking_gate: blockingGate } : {}),
    recent_events: recentEvents,
    updated_at:
      context.updated_at > run.updated_at ? context.updated_at : run.updated_at,
  };
}

export interface ActiveCollaborationState {
  run: WorkflowRun;
  context: SharedTaskContext;
  snapshot: CollaborationSnapshot;
}

async function readActiveCollaborationStateUnlocked(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<ActiveCollaborationState | null> {
  const active = await readActiveWorkflowStateUnlocked(uid, cid, projectIdHint);
  if (!active) return null;
  return {
    ...active,
    snapshot: await buildCollaborationSnapshotUnlocked(
      uid,
      cid,
      active.run,
      active.context,
    ),
  };
}

export async function readActiveCollaborationState(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<ActiveCollaborationState | null> {
  return conversationLock(uid, cid).runExclusive(() =>
    readActiveCollaborationStateUnlocked(uid, cid, projectIdHint),
  );
}

async function readActiveCollaborationSnapshotUnlocked(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<CollaborationSnapshot | null> {
  return (
    (await readActiveCollaborationStateUnlocked(uid, cid, projectIdHint))?.snapshot || null
  );
}

export async function readCollaborationSnapshot(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<CollaborationSnapshot | null> {
  return conversationLock(uid, cid).runExclusive(() =>
    readActiveCollaborationSnapshotUnlocked(uid, cid, projectIdHint),
  );
}

export async function readActiveCollaborationSnapshot(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<CollaborationSnapshot | null> {
  return conversationLock(uid, cid).runExclusive(() =>
    readActiveCollaborationSnapshotUnlocked(uid, cid, projectIdHint),
  );
}

/** Remove only the active pointer when a message edit invalidates the current
 * workflow. Historical run/context files remain available for audit, while
 * subsequent turns cannot inherit an obsolete shared-task context. */
export async function clearActiveCollaborationState(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<void> {
  await conversationLock(uid, cid).runExclusive(async () => {
    const activeFile = collaborationPaths(uid, cid, projectIdHint).activeFile;
    try {
      await fsp.unlink(activeFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  });
}

function bulletList(items: Array<{ text: string }>, limit = 8): string[] {
  return items.slice(-limit).map((item) => `- ${item.text}`);
}

function compactSummary(value: unknown, limit = 240): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function displayActorId(value: string): string {
  const text = compactSummary(value, 80);
  return text
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Agent";
}

export function buildSharedContextSummaryFromContext(
  context: SharedTaskContext,
): string {
  const parts: string[] = [
    `Context Revision: ${context.revision}`,
    "## Shared Task Context",
    `Objective: ${context.objective}`,
    `Phase: ${context.phase}`,
  ];
  if (context.constraints.length)
    parts.push("", "### Constraints", ...bulletList(context.constraints));
  if (context.facts.length)
    parts.push("", "### Facts", ...bulletList(context.facts));
  if (context.decisions.length)
    parts.push("", "### Decisions", ...bulletList(context.decisions));
  if (context.open_questions.length)
    parts.push("", "### Open Questions", ...bulletList(context.open_questions));
  if (context.risks.length)
    parts.push("", "### Risks", ...bulletList(context.risks));
  if (context.artifacts.length) {
    parts.push(
      "",
      "### Artifacts",
      ...context.artifacts
        .slice(-5)
        .map(
          (item) => `- ${compactSummary(item.id, 100)}${item.summary ? `: ${compactSummary(item.summary)}` : ""}`,
        ),
    );
  }

  const outputs = Object.values(context.agent_outputs || {}).slice(-5);
  if (outputs.length) {
    parts.push(
      "",
      "### Agent Outputs",
      ...outputs.map(
        (output) => `- ${displayActorId(output.actor_id)}: ${compactSummary(output.summary)}`,
      ),
    );
  }

  const activeConflicts = (context.conflicts || []).filter(isActiveConflict).slice(-5);
  if (activeConflicts.length) {
    const proposalById = new Map((context.proposals || []).map((proposal) => [proposal.id, proposal]));
    parts.push(
      "",
      "### Active Conflicts",
      ...activeConflicts.map((conflict) => {
        const proposals = conflict.proposal_ids
          .map((id) => proposalById.get(id))
          .filter((proposal): proposal is ContextProposal => !!proposal)
          .slice(-5)
          .map((proposal) => compactSummary(proposal.text, 180));
        const proposalText = proposals.length ? proposals.join(" | ") : "pending proposals";
        return `- ${compactSummary(conflict.conflict_key, 120)} (${conflict.status}): ${proposalText}`;
      }),
      "Pending proposals are not accepted decisions.",
    );
  }
  return parts.join("\n");
}

export async function buildSharedContextSummary(
  uid: string,
  cid: string,
  contextId: string,
): Promise<string> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  return context ? buildSharedContextSummaryFromContext(context) : "";
}

export interface RecordDiscussionRoundInput {
  title: string;
  actor_id: string;
  opinion: string;
  critiques?: string[];
  revision?: string;
}

async function recordDiscussionRoundUnlocked(
  uid: string,
  cid: string,
  runId: string,
  input: RecordDiscussionRoundInput,
): Promise<WorkflowStep> {
  const step = await startWorkflowStepUnlocked(uid, cid, runId, {
    title: input.title || "Discussion round",
    actor_id: input.actor_id,
    type: "discussion_round",
    expected_output: {
      kind: "discussion_opinion",
      required_fields: ["opinion"],
      optional_fields: ["critiques", "revision"],
    },
  });
  const summary = [
    input.opinion,
    ...(input.critiques || []),
    input.revision || "",
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");
  const completed = await completeWorkflowStepUnlocked(
    uid,
    cid,
    runId,
    step.id,
    {
      status: "completed",
      result_summary: summary || "Discussion round completed.",
    },
  );
  const run = await readWorkflowRun(uid, cid, runId);
  await appendCollaborationEvent(uid, cid, {
    type: "discussion_recorded",
    run_id: runId,
    context_id: run?.context_id,
    actor_id: input.actor_id,
    step_id: step.id,
    summary: input.opinion,
    payload: {
      critiques_count: Array.isArray(input.critiques)
        ? input.critiques.length
        : 0,
      has_revision: !!input.revision,
    },
  });
  return completed;
}

export async function recordDiscussionRound(
  uid: string,
  cid: string,
  runId: string,
  input: RecordDiscussionRoundInput,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    recordDiscussionRoundUnlocked(uid, cid, runId, input),
  );
}

export interface PrepareNestedDispatchStepInput {
  objective: string;
  actor_id: string | null;
  actor_name?: string;
  actor_kind?: "agent" | "anonymous_worker";
  source_tool: "dispatch_to" | "hand_off_to" | "run_worker";
  task: string;
  depends_on?: string[];
  context_dependencies?: string[];
  required_capabilities?: string[];
  access_mode?: "read" | "write";
  write_scopes?: string[];
  resume_step_id?: string;
  resume_token?: string;
}

export interface PreparedNestedDispatchStep {
  run: WorkflowRun;
  context: SharedTaskContext;
  step: WorkflowStep;
  blocked: boolean;
}

function normalizeDispatchIntent(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nestedStepResultStatus(input: {
  result?: string;
  error?: string;
  aborted?: boolean;
}): WorkflowStepStatus {
  if (input.aborted) return "skipped";
  return String(input.error || "").trim() ? "failed" : "completed";
}

function nestedStepResultSummary(input: {
  result?: string;
  error?: string;
  aborted?: boolean;
}): string {
  if (input.aborted)
    return String(input.error || "").trim() || "Nested dispatch aborted.";
  return String(input.error || input.result || "").trim() || "(empty result)";
}

async function prepareNestedDispatchStepUnlocked(
  uid: string,
  cid: string,
  input: PrepareNestedDispatchStepInput,
): Promise<PreparedNestedDispatchStep> {
  const objective =
    normalizeDispatchIntent(input.objective) || "Multi-agent collaboration";
  const task = normalizeDispatchIntent(input.task);
  if (!task) throw new Error("nested dispatch task is required");
  const dependencies = normalizeContextDependencies(input.context_dependencies);
  const workflowDependencies = normalizeWorkflowDependencyInput(input.depends_on);
  const requiredCapabilities = normalizeBoundedStringArray(
    input.required_capabilities,
  );
  const accessMode = normalizeWorkflowAccessMode(input.access_mode);
  const writeScopes = normalizeBoundedStringArray(input.write_scopes);
  const active = await ensureActiveWorkflowRunUnlocked(uid, cid, {
    objective,
    kind: "custom",
    created_by: "commander",
  });
  const run = active.run;
  const context = active.context;
  let step: WorkflowStep | undefined;
  let changed = false;
  if (input.resume_step_id) {
    if (!safeId(input.resume_step_id))
      throw new Error("invalid resume workflow step id");
    if (!input.resume_token || !safeId(input.resume_token))
      throw new Error("resume workflow capability is required");
    step = run.steps.find((candidate) => candidate.id === input.resume_step_id);
    if (!step) throw new Error("resume workflow step not found");
    if (!step.resume_token || step.resume_token !== input.resume_token)
      throw new Error("resume workflow capability mismatch");
    if (step.run_id !== run.id)
      throw new Error("resume workflow step belongs to another run");
    const expectedActorKind =
      input.actor_kind || (input.actor_id ? "agent" : "anonymous_worker");
    const storedActorKind =
      step.actor_kind || (step.actor_id ? "agent" : "anonymous_worker");
    if (storedActorKind !== expectedActorKind)
      throw new Error("resume workflow step actor kind mismatch");
    if (
      expectedActorKind !== "anonymous_worker" &&
      (step.actor_id || null) !== (input.actor_id || null)
    )
      throw new Error("resume workflow step actor mismatch");
    if (step.source_tool !== input.source_tool)
      throw new Error("resume workflow step source tool mismatch");
    if (normalizeDispatchIntent(step.dispatch_intent) !== task)
      throw new Error("resume workflow step task mismatch");
    if (
      !sameStringArray(
        normalizeContextDependencies(step.context_dependencies),
        dependencies,
      )
    ) {
      throw new Error("resume workflow step context dependencies mismatch");
    }
    const contractMatches =
      sameStringArray(
        normalizeWorkflowDependencyIds(step.depends_on),
        workflowDependencies,
      ) &&
      sameStringArray(
        step.required_capabilities || [],
        requiredCapabilities,
      ) &&
      (step.access_mode || "write") === accessMode &&
      sameStringArray(step.write_scopes || [], writeScopes);
    if (!contractMatches)
      throw new Error("resume workflow step access contract mismatch");
    if (step.status !== "pending" && step.status !== "blocked") {
      throw new Error(
        `resume workflow step cannot be reused from ${step.status}`,
      );
    }
  } else {
    const now = nowIso();
    step = {
      id: `wstep-${genId12()}`,
      run_id: run.id,
      title: `${input.source_tool}: ${input.actor_name || input.actor_id || "worker"}`,
      actor_id: input.actor_id || null,
      ...(input.actor_name ? { actor_name: input.actor_name } : {}),
      actor_kind:
        input.actor_kind || (input.actor_id ? "agent" : "anonymous_worker"),
      resume_token: `wcap-${genId12()}`,
      type: "dispatch",
      status: "pending",
      depends_on: workflowDependencies,
      ...(dependencies.length ? { context_dependencies: dependencies } : {}),
      source_tool: input.source_tool,
      dispatch_intent: task,
      objective,
      ...(requiredCapabilities.length
        ? { required_capabilities: requiredCapabilities }
        : {}),
      access_mode: accessMode,
      ...(writeScopes.length ? { write_scopes: writeScopes } : {}),
    };
    run.steps.push(step);
    run.phase = "planned";
    run.updated_at = now;
    changed = true;
  }

  const reconciliation = reconcileWorkflowStepBlockers(run, context);
  changed =
    changed || reconciliation.runChanged || reconciliation.contextChanged;
  if (changed) {
    run.updated_at = nowIso();
    context.updated_at = run.updated_at;
    await writeRun(uid, cid, run);
    await writeContext(uid, cid, context);
  }
  return { run, context, step, blocked: step.status === "blocked" };
}

export async function prepareNestedDispatchStep(
  uid: string,
  cid: string,
  input: PrepareNestedDispatchStepInput,
): Promise<PreparedNestedDispatchStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    prepareNestedDispatchStepUnlocked(uid, cid, input),
  );
}

async function checkPreparedNestedDispatchStepDependenciesUnlocked(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const step = active.run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  assertWorkflowStepDependenciesComplete(active.run, step);
  return step;
}

export async function checkPreparedNestedDispatchStepDependencies(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    checkPreparedNestedDispatchStepDependenciesUnlocked(uid, cid, stepId),
  );
}

async function appendPreparedNestedStepStartedEventIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  step: WorkflowStep,
): Promise<void> {
  const existing = (await readCollaborationEvents(uid, cid, 0)).some(
    (event) => event.type === "step_started" && event.step_id === step.id,
  );
  if (existing) return;
  await appendCollaborationEvent(uid, cid, {
    type: "step_started",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
    payload: {
      step_type: step.type,
      source_tool: step.source_tool,
      prepared: true,
    },
  });
}

async function startPreparedNestedDispatchStepUnlocked(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const { run, context } = active;
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  if (step.status === "running") {
    await appendPreparedNestedStepStartedEventIfMissing(uid, cid, run, step);
    return step;
  }
  if (step.status !== "pending")
    throw new Error(`workflow step cannot start from ${step.status}`);
  assertWorkflowStepDependenciesComplete(run, step);
  const reconciliation = reconcileWorkflowStepBlockers(run, context);
  if (reconciliation.runChanged || reconciliation.contextChanged) {
    run.updated_at = nowIso();
    context.updated_at = run.updated_at;
    await writeRun(uid, cid, run);
    await writeContext(uid, cid, context);
  }
  if ((step.blocked_by_conflict_ids || []).length) {
    throw new Error("workflow step is blocked by conflict");
  }
  const now = nowIso();
  step.status = "running";
  step.started_at = now;
  run.phase = "dispatch";
  run.updated_at = now;
  context.phase = run.phase;
  context.updated_at = now;
  await writeRun(uid, cid, run);
  await writeContext(uid, cid, context);
  await appendPreparedNestedStepStartedEventIfMissing(uid, cid, run, step);
  return step;
}

export async function startPreparedNestedDispatchStep(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    startPreparedNestedDispatchStepUnlocked(uid, cid, stepId),
  );
}

function nestedDispatchGateId(stepId: string): string {
  return `wgate-${stepId}`;
}

async function appendNestedCompletionEventsIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  step: WorkflowStep,
  gate: GateResult,
  input: { aborted?: boolean },
): Promise<void> {
  const events = await readCollaborationEvents(uid, cid, 0);
  if (
    !events.some(
      (event) => event.type === "gate_recorded" && event.gate_id === gate.id,
    )
  ) {
    await appendCollaborationEvent(uid, cid, {
      type: "gate_recorded",
      run_id: run.id,
      context_id: run.context_id,
      actor_id: step.actor_id,
      step_id: step.id,
      gate_id: gate.id,
      summary: gate.reason || gate.name,
      payload: {
        status: gate.status,
        checks_count: gate.checks.length,
        nested: true,
      },
    });
  }
  if (
    !events.some(
      (event) => event.type === "step_completed" && event.step_id === step.id,
    )
  ) {
    await appendCollaborationEvent(uid, cid, {
      type: "step_completed",
      run_id: run.id,
      context_id: run.context_id,
      actor_id: step.actor_id,
      step_id: step.id,
      summary: step.result_summary,
      payload: {
        status: step.status,
        nested: true,
        aborted: input.aborted === true,
      },
    });
  }
}

async function finishNestedDispatchStepUnlocked(
  uid: string,
  cid: string,
  stepId: string,
  input: { result?: string; error?: string; aborted?: boolean },
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const { run, context } = active;
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  const status = nestedStepResultStatus(input);
  const summary = nestedStepResultSummary(input);
  const terminal =
    step.status === "completed" ||
    step.status === "failed" ||
    step.status === "skipped";
  if (terminal && (step.status !== status || step.result_summary !== summary)) {
    throw new Error(`workflow step already settled as ${step.status}`);
  }

  const now = step.completed_at || nowIso();
  step.status = status;
  step.result_summary = summary;
  step.completed_at = now;
  const resultText = String(input.result || "").trim();
  const errorText = String(input.error || "").trim();
  const gateStatus: GateStatus = errorText
    ? "failed"
    : resultText
      ? "passed"
      : "needs_review";
  const gateId = nestedDispatchGateId(step.id);
  const gate: GateResult = {
    id: gateId,
    run_id: run.id,
    step_id: step.id,
    name: "dispatch_result_present",
    status: gateStatus,
    checks: [
      {
        name: "result_summary_present",
        status: resultText || errorText ? "passed" : "needs_review",
      },
    ],
    ...(errorText ||
    (!resultText ? "Nested dispatch returned an empty result." : "")
      ? { reason: errorText || "Nested dispatch returned an empty result." }
      : {}),
    blocks_workflow: false,
    created_at: now,
  };
  step.gate_result_id = gateId;
  run.updated_at = nowIso();
  reconcileWorkflowStepBlockers(run, context);

  if (resultText && step.actor_id) {
    context.agent_outputs[step.id] = {
      actor_id: step.actor_id,
      step_id: step.id,
      summary: resultText,
      created_at: now,
    };
  }
  const gateIndex = context.gates.findIndex(
    (candidate) => candidate.id === gateId,
  );
  if (gateIndex >= 0) context.gates[gateIndex] = gate;
  else context.gates.push(gate);
  context.updated_at = run.updated_at;

  // Each retry rewrites both documents and then repairs append-only events.
  // A partial prior attempt therefore converges instead of early-returning.
  await writeRun(uid, cid, run);
  await writeContext(uid, cid, context);
  await appendNestedCompletionEventsIfMissing(uid, cid, run, step, gate, input);
  return step;
}

export async function finishNestedDispatchStep(
  uid: string,
  cid: string,
  stepId: string,
  input: { result?: string; error?: string; aborted?: boolean },
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    finishNestedDispatchStepUnlocked(uid, cid, stepId, input),
  );
}

const NESTED_INFRASTRUCTURE_FAILURE_REASON =
  "Nested dispatch infrastructure failed.";

async function settleNestedDispatchInfrastructureFailureUnlocked(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  const invariant = () =>
    new Error("nested dispatch infrastructure settlement invariant");
  if (!safeId(stepId)) throw invariant();

  for (let repair = 0; repair < 3; repair += 1) {
    let active = await readActiveWorkflowStateUnlocked(uid, cid);
    let step = active?.run.steps.find((candidate) => candidate.id === stepId);
    if (!active || !step) throw invariant();

    const latest = (step.attempts || []).at(-1);
    if (latest?.status === "running" || latest?.status === "failed") {
      try {
        await finishWorkflowStepAttemptUnlocked(uid, cid, stepId, {
          status: "failed",
          failure_code: latest.failure_code || "runtime_failed",
        });
      } catch {
        // Re-read and repair below; the attempt row or audit may be durable.
      }
    }

    active = await readActiveWorkflowStateUnlocked(uid, cid);
    step = active?.run.steps.find((candidate) => candidate.id === stepId);
    if (!active || !step) throw invariant();
    try {
      if (step.started_at) {
        await appendPreparedNestedStepStartedEventIfMissing(
          uid,
          cid,
          active.run,
          step,
        );
      }
      if (step.status === "completed") {
        await finishNestedDispatchStepUnlocked(uid, cid, stepId, {
          result: step.result_summary,
        });
      } else {
        await finishNestedDispatchStepUnlocked(uid, cid, stepId, {
          error:
            step.status === "failed"
              ? step.result_summary || NESTED_INFRASTRUCTURE_FAILURE_REASON
              : NESTED_INFRASTRUCTURE_FAILURE_REASON,
        });
      }
    } catch {
      // Re-read and retry: run/context/events may have partially committed.
    }

    active = await readActiveWorkflowStateUnlocked(uid, cid);
    step = active?.run.steps.find((candidate) => candidate.id === stepId);
    if (!active || !step) throw invariant();
    const events = await readCollaborationEvents(uid, cid, 0);
    const gate = active.context.gates.find(
      (candidate) => candidate.id === nestedDispatchGateId(stepId),
    );
    const startedEvent = events.find(
      (event) => event.type === "step_started" && event.step_id === stepId,
    );
    const completionEvent = events.find(
      (event) => event.type === "step_completed" && event.step_id === stepId,
    );
    const gateEvent = events.find(
      (event) => event.type === "gate_recorded" && event.step_id === stepId,
    );
    const repairedAttempt = (step.attempts || []).at(-1);
    const attemptEvent = repairedAttempt
      ? workflowAttemptEvent(
          events,
          "step_attempt_finished",
          active.run.id,
          stepId,
          repairedAttempt.attempt,
        )
      : undefined;
    const attemptTerminal =
      !repairedAttempt ||
      (repairedAttempt.status !== "running" &&
        (repairedAttempt.status !== "failed" || !!attemptEvent));
    if (
      (step.status === "failed" || step.status === "completed") &&
      !!step.completed_at &&
      !!gate &&
      !!completionEvent &&
      !!gateEvent &&
      (!step.started_at || !!startedEvent) &&
      attemptTerminal
    ) {
      return step;
    }
  }
  throw invariant();
}

export async function settleNestedDispatchInfrastructureFailure(
  userId: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(userId, cid).runExclusive(() =>
    settleNestedDispatchInfrastructureFailureUnlocked(userId, cid, stepId),
  );
}

const HANDOFF_FINALIZATION_FAILURE_REASON = "Handoff finalization failed.";

async function appendHandoffFinalizationFailedEventIfMissing(
  uid: string,
  cid: string,
  run: WorkflowRun,
  step: WorkflowStep,
): Promise<void> {
  const events = await readCollaborationEvents(uid, cid, 0);
  if (
    events.some(
      (event) =>
        event.type === "handoff_finalization_failed" &&
        event.step_id === step.id,
    )
  ) {
    return;
  }
  await appendCollaborationEvent(uid, cid, {
    type: "handoff_finalization_failed",
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: HANDOFF_FINALIZATION_FAILURE_REASON,
    payload: { failure_code: "handoff_finalization_failed" },
  });
}

async function settleHandoffFinalizationFailureUnlocked(
  uid: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  const invariant = () =>
    new Error("handoff finalization settlement invariant");
  if (!safeId(stepId)) throw invariant();

  for (let repair = 0; repair < 3; repair += 1) {
    let active = await readActiveWorkflowStateUnlocked(uid, cid);
    let step = active?.run.steps.find((candidate) => candidate.id === stepId);
    if (!active || !step || step.source_tool !== "hand_off_to") {
      throw invariant();
    }
    if (
      step.status !== "completed" &&
      !(
        step.status === "failed" &&
        step.result_summary === HANDOFF_FINALIZATION_FAILURE_REASON
      )
    ) {
      throw invariant();
    }

    const now = nowIso();
    step.status = "failed";
    step.result_summary = HANDOFF_FINALIZATION_FAILURE_REASON;
    step.completed_at = step.completed_at || now;
    delete step.result_ref;
    active.run.status = "failed";
    active.run.phase = "handoff_finalization_failed";
    active.run.updated_at = now;
    delete active.context.agent_outputs[step.id];
    const gateId = step.gate_result_id || nestedDispatchGateId(step.id);
    step.gate_result_id = gateId;
    const existingGate = active.context.gates.find(
      (candidate) => candidate.id === gateId,
    );
    const gate: GateResult = {
      id: gateId,
      run_id: active.run.id,
      step_id: step.id,
      name: existingGate?.name || "dispatch_result_present",
      status: "failed",
      checks: [
        {
          name: "handoff_finalization_committed",
          status: "failed",
          reason: HANDOFF_FINALIZATION_FAILURE_REASON,
        },
      ],
      reason: HANDOFF_FINALIZATION_FAILURE_REASON,
      blocks_workflow: false,
      created_at: existingGate?.created_at || step.completed_at,
    };
    const gateIndex = active.context.gates.findIndex(
      (candidate) => candidate.id === gateId,
    );
    if (gateIndex >= 0) active.context.gates[gateIndex] = gate;
    else active.context.gates.push(gate);
    active.context.phase = "handoff_finalization_failed";
    active.context.updated_at = now;

    try {
      await writeRun(uid, cid, active.run);
      await writeContext(uid, cid, active.context);
      await appendHandoffFinalizationFailedEventIfMissing(
        uid,
        cid,
        active.run,
        step,
      );
    } catch {
      // Re-read and converge run/context/audit after any partial write.
    }

    active = await readActiveWorkflowStateUnlocked(uid, cid);
    step = active?.run.steps.find((candidate) => candidate.id === stepId);
    if (!active || !step) throw invariant();
    const repairedGate = active.context.gates.find(
      (candidate) => candidate.id === step?.gate_result_id,
    );
    const events = await readCollaborationEvents(uid, cid, 0);
    const audit = events.find(
      (event) =>
        event.type === "handoff_finalization_failed" &&
        event.step_id === stepId,
    );
    if (
      step.status === "failed" &&
      step.result_summary === HANDOFF_FINALIZATION_FAILURE_REASON &&
      active.run.status === "failed" &&
      active.run.phase === "handoff_finalization_failed" &&
      active.context.phase === "handoff_finalization_failed" &&
      !active.context.agent_outputs[stepId] &&
      repairedGate?.status === "failed" &&
      repairedGate.reason === HANDOFF_FINALIZATION_FAILURE_REASON &&
      !!audit
    ) {
      return step;
    }
  }
  throw invariant();
}

/** Invalidate a successful Agent attempt whose user-facing hand-off state could
 * not be finalized. The attempt remains completed; the step/output does not. */
export async function settleHandoffFinalizationFailure(
  userId: string,
  cid: string,
  stepId: string,
): Promise<WorkflowStep> {
  return conversationLock(userId, cid).runExclusive(() =>
    settleHandoffFinalizationFailureUnlocked(userId, cid, stepId),
  );
}

async function settleNestedDispatchAbortUnlocked(
  uid: string,
  cid: string,
  stepId: string,
  reason: string,
): Promise<WorkflowStep> {
  const invariant = () =>
    new Error("nested dispatch abort settlement invariant");
  if (!safeId(stepId)) throw invariant();
  let active = await readActiveWorkflowStateUnlocked(uid, cid);
  let step = active?.run.steps.find((candidate) => candidate.id === stepId);
  if (!active || !step) throw invariant();

  const latest = (step.attempts || []).at(-1);
  if (latest?.status === "running" || latest?.status === "cancelled") {
    let attemptConfirmed = false;
    for (let repair = 0; repair < 2 && !attemptConfirmed; repair += 1) {
      try {
        await finishWorkflowStepAttemptUnlocked(uid, cid, stepId, {
          status: "cancelled",
        });
      } catch {
        // Re-read below: the attempt row or audit append may already be durable.
      }
      active = await readActiveWorkflowStateUnlocked(uid, cid);
      step = active?.run.steps.find((candidate) => candidate.id === stepId);
      const repairedAttempt = (step?.attempts || []).at(-1);
      const finishedEvent = active
        ? workflowAttemptEvent(
            await readCollaborationEvents(uid, cid, 0),
            "step_attempt_finished",
            active.run.id,
            stepId,
            repairedAttempt?.attempt || 0,
          )
        : undefined;
      attemptConfirmed =
        repairedAttempt?.status === "cancelled" && !!finishedEvent;
    }
    if (!attemptConfirmed) throw invariant();
  }

  active = await readActiveWorkflowStateUnlocked(uid, cid);
  step = active?.run.steps.find((candidate) => candidate.id === stepId);
  if (!active || !step) throw invariant();
  if (step.status === "completed" || step.status === "failed") return step;

  const stableReason = String(
    step.status === "skipped"
      ? step.result_summary || "Nested dispatch aborted."
      : reason || "Nested dispatch aborted.",
  ).trim();
  for (let repair = 0; repair < 2; repair += 1) {
    try {
      await finishNestedDispatchStepUnlocked(uid, cid, stepId, {
        aborted: true,
        error: stableReason,
      });
    } catch {
      // Re-read and retry: run/context/events may have partially committed.
    }
    active = await readActiveWorkflowStateUnlocked(uid, cid);
    step = active?.run.steps.find((candidate) => candidate.id === stepId);
    const events = active
      ? await readCollaborationEvents(uid, cid, 0)
      : [];
    const contextGate = active?.context.gates.find(
      (candidate) => candidate.id === nestedDispatchGateId(stepId),
    );
    const completionEvent = events.find(
      (event) => event.type === "step_completed" && event.step_id === stepId,
    );
    const gateEvent = events.find(
      (event) => event.type === "gate_recorded" && event.step_id === stepId,
    );
    if (
      step?.status === "skipped" &&
      !!step.completed_at &&
      !!contextGate &&
      !!completionEvent &&
      !!gateEvent
    ) {
      return step;
    }
  }
  throw invariant();
}

/** Settle an abort between preparation/begin and nested model execution. */
export async function settleNestedDispatchAbort(
  userId: string,
  cid: string,
  stepId: string,
  reason = "Nested dispatch aborted.",
): Promise<WorkflowStep> {
  return conversationLock(userId, cid).runExclusive(() =>
    settleNestedDispatchAbortUnlocked(userId, cid, stepId, reason),
  );
}

async function cancelPreparedNestedDispatchStepUnlocked(
  uid: string,
  cid: string,
  stepId: string,
  reason?: string,
): Promise<WorkflowStep> {
  if (!safeId(stepId)) throw new Error("invalid workflow step id");
  const active = await readActiveWorkflowStateUnlocked(uid, cid);
  if (!active) throw new Error("active workflow context not found");
  const step = active.run.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  if (
    step.status === "completed" ||
    step.status === "failed" ||
    step.status === "skipped"
  ) {
    return step;
  }
  if (step.status === "running")
    throw new Error(`workflow step cannot be cancelled from ${step.status}`);
  return finishNestedDispatchStepUnlocked(uid, cid, stepId, {
    aborted: true,
    error: String(reason || "Nested dispatch cancelled before start.").trim(),
  });
}

export async function cancelPreparedNestedDispatchStep(
  uid: string,
  cid: string,
  stepId: string,
  reason?: string,
): Promise<WorkflowStep> {
  return conversationLock(uid, cid).runExclusive(() =>
    cancelPreparedNestedDispatchStepUnlocked(uid, cid, stepId, reason),
  );
}

export interface RecordNestedDispatchStepInput {
  objective: string;
  actor_id: string | null;
  actor_name?: string;
  source_tool: "dispatch_to" | "hand_off_to" | "run_worker";
  task: string;
  context_dependencies?: string[];
  result?: string;
  error?: string;
}

async function recordNestedDispatchStepUnlocked(
  uid: string,
  cid: string,
  input: RecordNestedDispatchStepInput,
): Promise<{
  run: WorkflowRun;
  context: SharedTaskContext;
  step: WorkflowStep;
  gate: GateResult;
}> {
  const prepared = await prepareNestedDispatchStepUnlocked(uid, cid, input);
  if (prepared.blocked) throw new Error("workflow step is blocked by conflict");
  await startPreparedNestedDispatchStepUnlocked(uid, cid, prepared.step.id);
  const completed = await finishNestedDispatchStepUnlocked(
    uid,
    cid,
    prepared.step.id,
    input,
  );
  const repairedContext = await readSharedTaskContext(
    uid,
    cid,
    prepared.context.id,
  );
  const gate = repairedContext?.gates.find(
    (candidate) => candidate.id === completed.gate_result_id,
  );
  if (!gate) throw new Error("nested dispatch gate repair failed");
  const run = await readWorkflowRun(uid, cid, prepared.run.id);
  const context = await readSharedTaskContext(uid, cid, prepared.context.id);
  if (!run || !context)
    throw new Error(
      "workflow record disappeared after nested dispatch recording",
    );
  return { run, context, step: completed, gate };
}

export async function recordNestedDispatchStep(
  uid: string,
  cid: string,
  input: RecordNestedDispatchStepInput,
): Promise<{
  run: WorkflowRun;
  context: SharedTaskContext;
  step: WorkflowStep;
  gate: GateResult;
}> {
  return conversationLock(uid, cid).runExclusive(() =>
    recordNestedDispatchStepUnlocked(uid, cid, input),
  );
}

export const __collaborationInternals = {
  validActiveFile,
  validRun,
  validContext,
};
