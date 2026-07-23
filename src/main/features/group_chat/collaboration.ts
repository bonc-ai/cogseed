import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { conversationLayout } from '../../util/project-layout';
import { appendJsonlAtomic, genId12, nowIso, readJson, readJsonl, safeId, writeJson } from '../../storage';

export type WorkflowRunKind = 'discussion' | 'implementation' | 'review' | 'custom';
export type WorkflowRunStatus = 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type WorkflowStepType = 'prompt' | 'discussion_round' | 'implementation' | 'test' | 'review' | 'gate' | 'summary' | 'dispatch';
export type WorkflowStepStatus = 'pending' | 'running' | 'blocked' | 'failed' | 'completed' | 'skipped';
export type GateStatus = 'passed' | 'failed' | 'needs_review';
export type ContextItemSource = 'user' | 'agent' | 'code' | 'artifact' | 'system' | 'spec';
export type ContextConfidence = 'low' | 'medium' | 'high';

export interface CollaborationPaths {
  rootDir: string;
  runsDir: string;
  contextsDir: string;
  activeFile: string;
  eventsFile: string;
  runFile(runId: string): string;
  contextFile(contextId: string): string;
}

export interface OutputContract {
  kind: 'analysis' | 'plan' | 'implementation_result' | 'test_result' | 'review_result' | 'discussion_opinion' | 'dispatch_result';
  required_fields: string[];
  optional_fields?: string[];
  artifact_required?: boolean;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  title: string;
  actor_id: string | null;
  type: WorkflowStepType;
  status: WorkflowStepStatus;
  depends_on: string[];
  expected_output?: OutputContract;
  result_ref?: string;
  result_summary?: string;
  gate_result_id?: string;
  source_tool?: 'dispatch_to' | 'hand_off_to' | 'run_worker';
  started_at?: string;
  completed_at?: string;
}

export interface WorkflowRun {
  version: 1;
  id: string;
  cid: string;
  objective: string;
  kind: WorkflowRunKind;
  status: WorkflowRunStatus;
  phase: string;
  steps: WorkflowStep[];
  context_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveWorkflowFile {
  version: 1;
  run_id: string;
  context_id: string;
  updated_at: string;
}

export interface ContextItem {
  id: string;
  text: string;
  source: ContextItemSource;
  source_ref?: string;
  confidence: ContextConfidence;
  added_by: string;
  created_at: string;
}

export interface DecisionItem extends ContextItem {
  reason?: string;
}

export interface RiskItem extends ContextItem {
  severity: 'low' | 'medium' | 'high';
}

export interface ArtifactRef {
  id: string;
  type: string;
  path?: string;
  summary?: string;
  added_by: string;
  created_at: string;
}

export interface AgentOutputSummary {
  actor_id: string;
  step_id: string;
  summary: string;
  created_at: string;
}

export interface GateCheck {
  name: string;
  status: GateStatus;
  reason?: string;
}

export type GateReviewDecision = 'approved' | 'rejected';

export interface GateResult {
  id: string;
  run_id: string;
  step_id: string;
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  reason?: string;
  blocks_workflow?: boolean;
  review_decision?: GateReviewDecision;
  reviewed_by?: string;
  reviewed_at?: string;
  review_reason?: string;
  created_at: string;
}

export interface SharedTaskContext {
  version: 1;
  id: string;
  cid: string;
  run_id: string;
  objective: string;
  phase: string;
  constraints: ContextItem[];
  facts: ContextItem[];
  decisions: DecisionItem[];
  open_questions: ContextItem[];
  risks: RiskItem[];
  artifacts: ArtifactRef[];
  agent_outputs: Record<string, AgentOutputSummary>;
  gates: GateResult[];
  updated_at: string;
}

export type CollaborationEventType =
  | 'workflow_created'
  | 'workflow_planned'
  | 'workflow_resumed'
  | 'workflow_aborted'
  | 'step_retried'
  | 'step_skipped'
  | 'step_started'
  | 'step_completed'
  | 'gate_recorded'
  | 'gate_reviewed'
  | 'context_patch_applied'
  | 'conflict_resolved'
  | 'events_replayed'
  | 'discussion_recorded';

export interface CollaborationEvent {
  version: 1;
  id: string;
  cid: string;
  run_id: string;
  context_id?: string;
  type: CollaborationEventType;
  actor_id?: string | null;
  step_id?: string;
  gate_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

async function appendCollaborationEvent(
  uid: string,
  cid: string,
  event: Omit<CollaborationEvent, 'version' | 'id' | 'cid' | 'created_at'>,
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

export async function readCollaborationEvents(uid: string, cid: string, limit = 50): Promise<CollaborationEvent[]> {
  const rows = await readJsonl<unknown>(collaborationPaths(uid, cid).eventsFile, limit);
  return rows.filter((row): row is CollaborationEvent => {
    const item = row as Partial<CollaborationEvent>;
    return item?.version === 1 && safeId(item.id || '') && typeof item.type === 'string' && typeof item.run_id === 'string';
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

export function collaborationPaths(uid: string, cid: string): CollaborationPaths {
  const groupDir = conversationLayout(uid, cid).groupDir;
  const rootDir = path.join(groupDir, 'collaboration');
  const runsDir = path.join(rootDir, 'workflow_runs');
  const contextsDir = path.join(rootDir, 'workflow_contexts');
  return {
    rootDir,
    runsDir,
    contextsDir,
    activeFile: path.join(rootDir, 'active.json'),
    eventsFile: path.join(rootDir, 'events.jsonl'),
    runFile(runId: string) {
      if (!safeId(runId)) throw new Error('invalid workflow run id');
      return path.join(runsDir, `${runId}.json`);
    },
    contextFile(contextId: string) {
      if (!safeId(contextId)) throw new Error('invalid workflow context id');
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
  return item?.version === 1 && safeId(item.id) && typeof item.cid === 'string' && safeId(item.context_id) && Array.isArray(item.steps);
}

function validContext(value: unknown): value is SharedTaskContext {
  const item = value as Partial<SharedTaskContext>;
  return item?.version === 1 && safeId(item.id) && typeof item.cid === 'string' && safeId(item.run_id) && Array.isArray(item.facts);
}

export async function readWorkflowRun(uid: string, cid: string, runId: string): Promise<WorkflowRun | null> {
  if (!safeId(runId)) return null;
  const raw = await readJson<unknown>(collaborationPaths(uid, cid).runFile(runId));
  return validRun(raw) ? raw : null;
}

export async function readSharedTaskContext(uid: string, cid: string, contextId: string): Promise<SharedTaskContext | null> {
  if (!safeId(contextId)) return null;
  const raw = await readJson<unknown>(collaborationPaths(uid, cid).contextFile(contextId));
  return validContext(raw) ? raw : null;
}

export async function readActiveWorkflowRun(uid: string, cid: string): Promise<WorkflowRun | null> {
  const active = await readJson<unknown>(collaborationPaths(uid, cid).activeFile);
  if (!validActiveFile(active)) return null;
  return readWorkflowRun(uid, cid, active.run_id);
}

export async function readActiveSharedTaskContext(uid: string, cid: string): Promise<SharedTaskContext | null> {
  const active = await readJson<unknown>(collaborationPaths(uid, cid).activeFile);
  if (!validActiveFile(active)) return null;
  return readSharedTaskContext(uid, cid, active.context_id);
}

export interface CreateWorkflowRunInput {
  objective: string;
  kind?: WorkflowRunKind;
  created_by: string;
}

export async function createWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const now = nowIso();
  const runId = `wf-${genId12()}`;
  const contextId = `wctx-${genId12()}`;
  const objective = String(input.objective || '').trim() || 'Multi-agent collaboration';
  const run: WorkflowRun = {
    version: 1,
    id: runId,
    cid,
    objective,
    kind: input.kind || 'custom',
    status: 'running',
    phase: 'created',
    steps: [],
    context_id: contextId,
    created_by: String(input.created_by || 'commander'),
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
    constraints: [],
    facts: [],
    decisions: [],
    open_questions: [],
    risks: [],
    artifacts: [],
    agent_outputs: {},
    gates: [],
    updated_at: now,
  };
  const paths = collaborationPaths(uid, cid);
  await writeJson(paths.runFile(runId), run);
  await writeJson(paths.contextFile(contextId), context);
  await writeJson(paths.activeFile, { version: 1, run_id: runId, context_id: contextId, updated_at: now } satisfies ActiveWorkflowFile);
  await appendCollaborationEvent(uid, cid, {
    type: 'workflow_created',
    run_id: runId,
    context_id: contextId,
    actor_id: run.created_by,
    summary: objective,
    payload: { kind: run.kind },
  });
  return { run, context };
}

export async function ensureActiveWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const run = await readActiveWorkflowRun(uid, cid);
  if (run && run.status === 'running') {
    const context = await readSharedTaskContext(uid, cid, run.context_id);
    if (context) return { run, context };
  }
  return createWorkflowRun(uid, cid, input);
}

async function writeRun(uid: string, cid: string, run: WorkflowRun): Promise<WorkflowRun> {
  await writeJson(collaborationPaths(uid, cid).runFile(run.id), run);
  return run;
}

async function writeContext(uid: string, cid: string, context: SharedTaskContext): Promise<SharedTaskContext> {
  await writeJson(collaborationPaths(uid, cid).contextFile(context.id), context);
  return context;
}

export interface PlanWorkflowStepInput {
  title: string;
  actor_id: string | null;
  type?: WorkflowStepType;
  depends_on?: string[];
  expected_output?: OutputContract;
  source_tool?: 'dispatch_to' | 'hand_off_to' | 'run_worker';
}

export async function planWorkflowSteps(
  uid: string,
  cid: string,
  runId: string,
  steps: PlanWorkflowStepInput[],
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  if (run.status === 'blocked') throw new Error('workflow run is blocked by gate');
  const now = nowIso();
  const planned: WorkflowStep[] = [];
  for (const input of steps || []) {
    const title = String(input.title || '').trim();
    if (!title) continue;
    planned.push({
      id: `wstep-${genId12()}`,
      run_id: run.id,
      title,
      actor_id: input.actor_id || null,
      type: input.type || 'dispatch',
      status: 'pending',
      depends_on: input.depends_on || [],
      expected_output: input.expected_output,
      source_tool: input.source_tool,
    });
  }
  if (!planned.length) return run;
  run.steps.push(...planned);
  run.phase = 'planned';
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'workflow_planned',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: run.created_by,
    summary: `Planned ${planned.length} workflow step(s).`,
    payload: { step_ids: planned.map((step) => step.id), step_count: planned.length },
  });
  return run;
}

export async function startPlannedWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  if (run.status === 'blocked') throw new Error('workflow run is blocked by gate');
  if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'completed') {
    throw new Error(`workflow run is not active: ${run.status}`);
  }
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  if (step.status !== 'pending') throw new Error(`workflow step is not pending: ${step.status}`);
  const completed = new Set(run.steps.filter((item) => item.status === 'completed' || item.status === 'skipped').map((item) => item.id));
  const missing = (step.depends_on || []).filter((id) => !completed.has(id));
  if (missing.length) throw new Error(`workflow step dependencies are not completed: ${missing.join(',')}`);
  const now = nowIso();
  step.status = 'running';
  step.started_at = now;
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
    type: 'step_started',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
    payload: { step_type: step.type, source_tool: step.source_tool, planned: true },
  });
  return step;
}

export interface StartWorkflowStepInput {
  title: string;
  actor_id: string | null;
  type?: WorkflowStepType;
  depends_on?: string[];
  expected_output?: OutputContract;
  source_tool?: 'dispatch_to' | 'hand_off_to' | 'run_worker';
}

export async function startWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  input: StartWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  if (run.status === 'blocked') throw new Error('workflow run is blocked by gate');
  if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'completed') {
    throw new Error(`workflow run is not active: ${run.status}`);
  }
  const now = nowIso();
  const step: WorkflowStep = {
    id: `wstep-${genId12()}`,
    run_id: run.id,
    title: String(input.title || 'Agent step'),
    actor_id: input.actor_id || null,
    type: input.type || 'dispatch',
    status: 'running',
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
    type: 'step_started',
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
  status: Extract<WorkflowStepStatus, 'completed' | 'blocked' | 'failed' | 'skipped'>;
  result_summary?: string;
  result_ref?: string;
}

export async function completeWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: CompleteWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  const now = nowIso();
  step.status = input.status;
  step.result_summary = input.result_summary;
  step.result_ref = input.result_ref;
  step.completed_at = now;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context && input.result_summary && step.actor_id) {
    context.agent_outputs[step.id] = {
      actor_id: step.actor_id,
      step_id: step.id,
      summary: input.result_summary,
      created_at: now,
    };
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'step_completed',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: input.result_summary,
    payload: { status: step.status },
  });
  return step;
}

export async function retryWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  if (step.status !== 'failed' && step.status !== 'blocked' && step.status !== 'skipped') {
    throw new Error(`workflow step cannot be retried from status: ${step.status}`);
  }
  const now = nowIso();
  step.status = 'pending';
  delete step.started_at;
  delete step.completed_at;
  delete step.result_summary;
  delete step.result_ref;
  delete step.gate_result_id;
  run.status = 'running';
  run.phase = 'step_retry';
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'step_retried',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: step.title,
  });
  return step;
}

export async function skipWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  reason?: string,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  const now = nowIso();
  step.status = 'skipped';
  step.completed_at = now;
  step.result_summary = reason || 'Skipped.';
  run.status = run.status === 'cancelled' ? run.status : 'running';
  run.phase = 'step_skipped';
  run.updated_at = now;
  for (const candidate of run.steps) {
    if (candidate.status === 'blocked' && (candidate.depends_on || []).includes(step.id)) {
      candidate.status = 'pending';
    }
  }
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'step_skipped',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: step.actor_id,
    step_id: step.id,
    summary: reason || step.title,
  });
  return step;
}

export async function resumeWorkflowRun(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const now = nowIso();
  run.status = 'running';
  run.phase = 'resumed';
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'workflow_resumed',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: 'user',
    summary: reason || 'Workflow resumed.',
  });
  return run;
}

export async function abortWorkflowRun(
  uid: string,
  cid: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRun> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const now = nowIso();
  run.status = 'cancelled';
  run.phase = 'aborted';
  for (const step of run.steps) {
    if (step.status === 'pending' || step.status === 'running' || step.status === 'blocked') {
      step.status = 'skipped';
      step.completed_at = now;
      step.result_summary = reason || 'Workflow aborted.';
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
    type: 'workflow_aborted',
    run_id: run.id,
    context_id: run.context_id,
    actor_id: 'user',
    summary: reason || 'Workflow aborted.',
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

export async function recordGateResult(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: RecordGateResultInput,
): Promise<GateResult> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  const now = nowIso();
  const gate: GateResult = {
    id: `wgate-${genId12()}`,
    run_id: run.id,
    step_id: step.id,
    name: String(input.name || 'gate'),
    status: input.status,
    checks: input.checks || [],
    reason: input.reason,
    blocks_workflow: input.blocks_workflow !== false,
    created_at: now,
  };
  step.gate_result_id = gate.id;
  if (gate.blocks_workflow !== false && (gate.status === 'needs_review' || gate.status === 'failed')) {
    run.status = 'blocked';
    run.phase = gate.status === 'needs_review' ? 'gate_needs_review' : 'gate_failed';
    for (const candidate of run.steps) {
      if (candidate.status === 'pending' && (candidate.depends_on || []).includes(step.id)) {
        candidate.status = 'blocked';
      }
    }
  }
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.gates.push(gate);
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'gate_recorded',
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
  decision: 'approve' | 'reject';
  reviewed_by: string;
  reason?: string;
}

export async function reviewCollaborationGate(
  uid: string,
  cid: string,
  gateId: string,
  input: ReviewCollaborationGateInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext; gate: GateResult }> {
  if (!safeId(gateId)) throw new Error('invalid gate id');
  return conversationLock(uid, cid).runExclusive(async () => {
    const run = await readActiveWorkflowRun(uid, cid);
    if (!run) throw new Error('workflow run not found');
    const context = await readSharedTaskContext(uid, cid, run.context_id);
    if (!context) throw new Error('shared task context not found');
    const gate = context.gates.find((item) => item.id === gateId);
    if (!gate) throw new Error('collaboration gate not found');
    const step = run.steps.find((item) => item.id === gate.step_id);
    const now = nowIso();
    const decision = input.decision;
    gate.review_decision = decision === 'approve' ? 'approved' : 'rejected';
    gate.reviewed_by = String(input.reviewed_by || 'user');
    gate.reviewed_at = now;
    gate.review_reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
    if (decision === 'approve') {
      gate.status = 'passed';
      run.status = 'running';
      run.phase = 'gate_approved';
      if (step) {
        for (const candidate of run.steps) {
          if (candidate.status === 'blocked' && (candidate.depends_on || []).includes(step.id)) {
            candidate.status = 'pending';
          }
        }
      }
    } else {
      gate.status = 'failed';
      run.status = 'blocked';
      run.phase = 'gate_rejected';
      if (gate.review_reason) gate.reason = gate.review_reason;
    }
    run.updated_at = now;
    context.updated_at = now;
    await writeRun(uid, cid, run);
    await writeContext(uid, cid, context);
    await appendCollaborationEvent(uid, cid, {
      type: 'gate_reviewed',
      run_id: run.id,
      context_id: context.id,
      actor_id: gate.reviewed_by,
      step_id: step?.id || gate.step_id,
      gate_id: gate.id,
      summary: gate.review_reason || gate.name,
      payload: { decision: gate.review_decision, status: gate.status },
    });
    return { run, context, gate };
  });
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
}

export interface RiskDraft extends ContextItemDraft {
  severity?: 'low' | 'medium' | 'high';
}

export interface ArtifactRefDraft {
  id?: string;
  type: string;
  path?: string;
  summary?: string;
}

export interface ResolveContextConflictInput {
  decision: 'accept' | 'reject' | 'merge';
  text: string;
  resolved_by: string;
  reason?: string;
  obsolete_item_ids?: string[];
}

export async function resolveContextConflict(
  uid: string,
  cid: string,
  contextId: string,
  input: ResolveContextConflictInput,
): Promise<SharedTaskContext> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error('shared task context not found');
  const text = String(input.text || '').trim();
  if (!text) throw new Error('conflict resolution text is required');
  const now = nowIso();
  const resolvedBy = String(input.resolved_by || 'user');
  if (input.decision === 'accept' || input.decision === 'merge') {
    if (!hasText(context.decisions, text)) {
      context.decisions.push({
        id: `witem-${genId12()}`,
        text,
        source: 'user',
        confidence: 'high',
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
    if (item.text.startsWith('Conflicting decision proposed:') && input.decision !== 'reject') return false;
    return true;
  });
  if (obsolete.size) {
    context.facts = context.facts.filter((item) => !obsolete.has(item.id));
    context.decisions = context.decisions.filter((item) => !obsolete.has(item.id) || item.text === text);
    context.risks = context.risks.filter((item) => !obsolete.has(item.id));
  }
  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: 'conflict_resolved',
    run_id: context.run_id,
    context_id: context.id,
    actor_id: resolvedBy,
    summary: text,
    payload: { decision: input.decision, obsolete_count: obsolete.size },
  });
  return written;
}

export interface CollaborationEventReplay {
  total_events: number;
  by_type: Record<string, number>;
  latest_run_id?: string;
  latest_context_id?: string;
  blocking_gate_id?: string;
}

export async function replayCollaborationEvents(uid: string, cid: string): Promise<CollaborationEventReplay> {
  const events = await readCollaborationEvents(uid, cid, 0);
  const byType: Record<string, number> = {};
  const replay: CollaborationEventReplay = { total_events: events.length, by_type: byType };
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (event.run_id) replay.latest_run_id = event.run_id;
    if (event.context_id) replay.latest_context_id = event.context_id;
    if (event.type === 'gate_recorded' && event.gate_id) replay.blocking_gate_id = event.gate_id;
    if (event.type === 'gate_reviewed' && event.gate_id && event.gate_id === replay.blocking_gate_id) {
      replay.blocking_gate_id = undefined;
    }
  }
  await appendCollaborationEvent(uid, cid, {
    type: 'events_replayed',
    run_id: replay.latest_run_id || 'none',
    context_id: replay.latest_context_id,
    actor_id: 'system',
    summary: `Replayed ${events.length} collaboration event(s).`,
    payload: { by_type: byType },
  }).catch(() => undefined);
  return replay;
}

export interface ContextPatch {
  added_by: string;
  summary?: string;
  facts_add?: ContextItemDraft[];
  decisions_proposed?: DecisionDraft[];
  risks_add?: RiskDraft[];
  open_questions_add?: ContextItemDraft[];
  artifacts_add?: ArtifactRefDraft[];
  obsolete_item_ids?: string[];
}

function contextItemFromDraft(draft: ContextItemDraft, addedBy: string): ContextItem {
  return {
    id: `witem-${genId12()}`,
    text: String(draft.text || '').trim(),
    source: draft.source || 'agent',
    source_ref: draft.source_ref,
    confidence: draft.confidence || 'medium',
    added_by: addedBy,
    created_at: nowIso(),
  };
}

function hasText(items: Array<{ text: string }>, text: string): boolean {
  return items.some((item) => item.text.trim().toLowerCase() === text.trim().toLowerCase());
}

export async function applyContextPatch(
  uid: string,
  cid: string,
  contextId: string,
  patch: ContextPatch,
): Promise<SharedTaskContext> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error('shared task context not found');
  const addedBy = String(patch.added_by || 'agent');
  const now = nowIso();
  const before = {
    facts: context.facts.length,
    decisions: context.decisions.length,
    risks: context.risks.length,
    open_questions: context.open_questions.length,
    artifacts: context.artifacts.length,
  };

  for (const draft of patch.facts_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.facts, item.text)) context.facts.push(item);
  }

  for (const draft of patch.decisions_proposed || []) {
    const text = String(draft.text || '').trim();
    if (!text) continue;
    const conflicts = (draft.conflicts_with || []).filter((value) => hasText(context.decisions, value));
    if (conflicts.length > 0) {
      context.open_questions.push({
        id: `witem-${genId12()}`,
        text: `Conflicting decision proposed: ${text}`,
        source: draft.source || 'agent',
        source_ref: draft.source_ref,
        confidence: draft.confidence || 'medium',
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
      context.risks.push({ ...base, severity: draft.severity || 'medium' });
    }
  }

  for (const draft of patch.open_questions_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.open_questions, item.text)) context.open_questions.push(item);
  }

  for (const draft of patch.artifacts_add || []) {
    const id = String(draft.id || `wartifact-${genId12()}`).trim();
    if (!id || context.artifacts.some((item) => item.id === id)) continue;
    context.artifacts.push({
      id,
      type: String(draft.type || 'artifact'),
      path: draft.path,
      summary: draft.summary,
      added_by: addedBy,
      created_at: now,
    });
  }

  if (patch.obsolete_item_ids && patch.obsolete_item_ids.length > 0) {
    const obsolete = new Set(patch.obsolete_item_ids);
    context.facts = context.facts.filter((item) => !obsolete.has(item.id));
    context.decisions = context.decisions.filter((item) => !obsolete.has(item.id));
    context.risks = context.risks.filter((item) => !obsolete.has(item.id));
    context.open_questions = context.open_questions.filter((item) => !obsolete.has(item.id));
  }

  context.updated_at = now;
  const written = await writeContext(uid, cid, context);
  await appendCollaborationEvent(uid, cid, {
    type: 'context_patch_applied',
    run_id: context.run_id,
    context_id: context.id,
    actor_id: addedBy,
    summary: patch.summary,
    payload: {
      facts_added: Math.max(0, context.facts.length - before.facts),
      decisions_added: Math.max(0, context.decisions.length - before.decisions),
      risks_added: Math.max(0, context.risks.length - before.risks),
      open_questions_added: Math.max(0, context.open_questions.length - before.open_questions),
      artifacts_added: Math.max(0, context.artifacts.length - before.artifacts),
      obsolete_count: Array.isArray(patch.obsolete_item_ids) ? patch.obsolete_item_ids.length : 0,
    },
  });
  return written;
}


export interface ExtractedContextPatchBlocks {
  cleanText: string;
  patches: ContextPatch[];
  errors: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeConfidence(value: unknown): ContextConfidence | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function normalizeSource(value: unknown): ContextItemSource | undefined {
  return value === 'user' || value === 'agent' || value === 'code' || value === 'artifact' || value === 'system' || value === 'spec'
    ? value
    : undefined;
}

function normalizeTextDraftArray(value: unknown): ContextItemDraft[] | undefined {
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

function normalizeDecisionDraftArray(value: unknown): DecisionDraft[] | undefined {
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
        ? raw.conflicts_with.map((item) => stringOrUndefined(item)).filter((item): item is string => !!item)
        : undefined,
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
    const severity = raw.severity === 'low' || raw.severity === 'medium' || raw.severity === 'high' ? raw.severity : undefined;
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

function normalizeArtifactDraftArray(value: unknown): ArtifactRefDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drafts: ArtifactRefDraft[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const type = stringOrUndefined(raw.type) || 'artifact';
    const id = stringOrUndefined(raw.id);
    const artifactPath = stringOrUndefined(raw.path);
    const summary = stringOrUndefined(raw.summary);
    if (!id && !artifactPath && !summary) continue;
    drafts.push({ id, type, path: artifactPath, summary });
  }
  return drafts.length ? drafts : undefined;
}

function normalizeContextPatch(value: unknown, addedBy: string): ContextPatch | null {
  if (!isPlainRecord(value)) return null;
  const patch: ContextPatch = { added_by: addedBy };
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
    const ids = value.obsolete_item_ids.map((item) => stringOrUndefined(item)).filter((item): item is string => !!item);
    if (ids.length) patch.obsolete_item_ids = ids;
  }
  const hasMutation = !!(
    patch.summary
    || patch.facts_add?.length
    || patch.decisions_proposed?.length
    || patch.risks_add?.length
    || patch.open_questions_add?.length
    || patch.artifacts_add?.length
    || patch.obsolete_item_ids?.length
  );
  return hasMutation ? patch : null;
}

export function extractContextPatchBlocks(text: string, addedBy: string): ExtractedContextPatchBlocks {
  const source = String(text || '');
  if (!source) return { cleanText: '', patches: [], errors: [] };
  const re = /<context-patch>\s*([\s\S]*?)\s*<\/context-patch>/gi;
  let lastIndex = 0;
  let changed = false;
  let clean = '';
  const patches: ContextPatch[] = [];
  const errors: string[] = [];
  for (const match of source.matchAll(re)) {
    const full = match[0];
    const body = match[1] || '';
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
    const patch = normalizeContextPatch(parsed, String(addedBy || 'agent'));
    if (!patch) {
      errors.push('invalid context-patch payload: no supported patch fields');
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
  if (changed) clean = clean.replace(/[ \t]*\n[ \t]*\n/g, '\n').trim();
  return { cleanText: changed ? clean : source, patches, errors };
}

export interface CollaborationSnapshotItem {
  id: string;
  text: string;
  added_by: string;
  confidence?: ContextConfidence;
  created_at: string;
  reason?: string;
  severity?: 'low' | 'medium' | 'high';
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
  steps: Array<Pick<WorkflowStep, 'id' | 'title' | 'actor_id' | 'type' | 'status' | 'source_tool' | 'started_at' | 'completed_at' | 'result_summary' | 'gate_result_id'>>;
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
  blocking_gate?: GateResult;
  recent_events: CollaborationEvent[];
  updated_at: string;
}

function contextItemPreview(item: ContextItem | DecisionItem | RiskItem): CollaborationSnapshotItem {
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

export async function readCollaborationSnapshot(uid: string, cid: string): Promise<CollaborationSnapshot | null> {
  const run = await readActiveWorkflowRun(uid, cid);
  if (!run) return null;
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (!context) return null;
  const recentEvents = await readCollaborationEvents(uid, cid, 20);
  const blockingGate = context.gates.find((gate) => gate.blocks_workflow !== false && (gate.status === 'needs_review' || gate.status === 'failed'));
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
    facts_count: context.facts.length,
    decisions_count: context.decisions.length,
    risks_count: context.risks.length,
    open_questions_count: context.open_questions.length,
    artifacts_count: context.artifacts.length,
    facts_preview: context.facts.slice(-5).map(contextItemPreview),
    decisions_preview: context.decisions.slice(-5).map(contextItemPreview),
    risks_preview: context.risks.slice(-5).map(contextItemPreview),
    open_questions_preview: context.open_questions.slice(-5).map(contextItemPreview),
    artifacts_preview: context.artifacts.slice(-5).map((item) => ({
      id: item.id,
      type: item.type,
      path: item.path,
      summary: item.summary,
      added_by: item.added_by,
      created_at: item.created_at,
    })),
    gates: context.gates,
    ...(blockingGate ? { blocking_gate: blockingGate } : {}),
    recent_events: recentEvents,
    updated_at: context.updated_at > run.updated_at ? context.updated_at : run.updated_at,
  };
}

function bulletList(items: Array<{ text: string }>, limit = 8): string[] {
  return items.slice(0, limit).map((item) => `- ${item.text}`);
}

export async function buildSharedContextSummary(uid: string, cid: string, contextId: string): Promise<string> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) return '';
  const parts: string[] = [
    '## Shared Task Context',
    `Objective: ${context.objective}`,
    `Phase: ${context.phase}`,
  ];
  if (context.constraints.length) parts.push('', '### Constraints', ...bulletList(context.constraints));
  if (context.facts.length) parts.push('', '### Facts', ...bulletList(context.facts));
  if (context.decisions.length) parts.push('', '### Decisions', ...bulletList(context.decisions));
  if (context.open_questions.length) parts.push('', '### Open Questions', ...bulletList(context.open_questions));
  if (context.risks.length) parts.push('', '### Risks', ...bulletList(context.risks));
  if (context.artifacts.length) {
    parts.push('', '### Artifacts', ...context.artifacts.slice(0, 8).map((item) => `- ${item.id}${item.summary ? `: ${item.summary}` : ''}`));
  }
  return parts.join('\n');
}

export interface RecordDiscussionRoundInput {
  title: string;
  actor_id: string;
  opinion: string;
  critiques?: string[];
  revision?: string;
}

export async function recordDiscussionRound(
  uid: string,
  cid: string,
  runId: string,
  input: RecordDiscussionRoundInput,
): Promise<WorkflowStep> {
  const step = await startWorkflowStep(uid, cid, runId, {
    title: input.title || 'Discussion round',
    actor_id: input.actor_id,
    type: 'discussion_round',
    expected_output: {
      kind: 'discussion_opinion',
      required_fields: ['opinion'],
      optional_fields: ['critiques', 'revision'],
    },
  });
  const summary = [input.opinion, ...(input.critiques || []), input.revision || '']
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
  const completed = await completeWorkflowStep(uid, cid, runId, step.id, {
    status: 'completed',
    result_summary: summary || 'Discussion round completed.',
  });
  const run = await readWorkflowRun(uid, cid, runId);
  await appendCollaborationEvent(uid, cid, {
    type: 'discussion_recorded',
    run_id: runId,
    context_id: run?.context_id,
    actor_id: input.actor_id,
    step_id: step.id,
    summary: input.opinion,
    payload: { critiques_count: Array.isArray(input.critiques) ? input.critiques.length : 0, has_revision: !!input.revision },
  });
  return completed;
}

export interface RecordNestedDispatchStepInput {
  objective: string;
  actor_id: string | null;
  actor_name?: string;
  source_tool: 'dispatch_to' | 'hand_off_to' | 'run_worker';
  task: string;
  result?: string;
  error?: string;
}

export async function recordNestedDispatchStep(
  uid: string,
  cid: string,
  input: RecordNestedDispatchStepInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext; step: WorkflowStep; gate: GateResult }> {
  return conversationLock(uid, cid).runExclusive(async () => {
    const active = await ensureActiveWorkflowRun(uid, cid, {
      objective: input.objective,
      kind: 'custom',
      created_by: 'commander',
    });
    const step = await startWorkflowStep(uid, cid, active.run.id, {
      title: `${input.source_tool}: ${input.actor_name || input.actor_id || 'worker'}`,
      actor_id: input.actor_id,
      type: 'dispatch',
      source_tool: input.source_tool,
      expected_output: {
        kind: 'dispatch_result',
        required_fields: ['result_summary'],
      },
    });
    const resultText = String(input.result || '').trim();
    const errorText = String(input.error || '').trim();
    const completed = await completeWorkflowStep(uid, cid, active.run.id, step.id, {
      status: errorText ? 'failed' : 'completed',
      result_summary: errorText || resultText || '(empty result)',
    });
    const gate = await recordGateResult(uid, cid, active.run.id, completed.id, {
      name: 'dispatch_result_present',
      status: errorText ? 'failed' : (resultText ? 'passed' : 'needs_review'),
      reason: errorText || (!resultText ? 'Nested dispatch returned an empty result.' : undefined),
      checks: [
        { name: 'result_summary_present', status: resultText || errorText ? 'passed' : 'needs_review' },
      ],
      blocks_workflow: false,
    });
    const run = await readWorkflowRun(uid, cid, active.run.id);
    const context = await readSharedTaskContext(uid, cid, active.context.id);
    if (!run || !context) throw new Error('workflow record disappeared after nested dispatch recording');
    return { run, context, step: completed, gate };
  });
}

export const __collaborationInternals = { validActiveFile, validRun, validContext };
