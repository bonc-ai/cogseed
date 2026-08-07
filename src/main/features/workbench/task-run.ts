/**
 * Task Run — binds a project task to a real execution governed by a frozen
 * Main Skill Baseline.
 *
 * This is a BRIDGE, not a new store. Execution state lives in
 * `features/execution-records` (record + append-only events + artifacts);
 * the frozen method version lives in `workbench/main-skill-baseline`; the
 * task backlog lives in `features/project_tasks`. This module only:
 *   1. refuses to start without a verified baseline,
 *   2. creates the execution through the shared lifecycle sink,
 *   3. records the run id back onto the task as a reference.
 *
 * Ordering is the point (RG-S3-15, currently REWORK for timing
 * contamination): the baseline — and with it the Evaluation Contract it pins —
 * must be frozen and verified BEFORE the run exists. A run that starts against
 * a drifted or absent baseline cannot support any evolution claim, so it is
 * refused rather than annotated after the fact.
 *
 * Runtime roles (US-20 AC5): the two ends of a cross-agent reuse are
 * `agent-a` / `agent-b` RUNTIME ROLES. `ExecutionKind` in execution-records is
 * a vendor/adapter identity (`codex`, `openclaw`, …) and stays that way — it is
 * what the CLI runner dispatches on. The role is carried separately and bound
 * to a runtime at call time, so no product-level code names a vendor. Do not
 * collapse the two.
 *
 * Task status is deliberately NOT mirrored from run status. Progress is derived
 * on read (mirrors `project_tasks.computeProgress`, which never stores derived
 * counts) so a task and its runs cannot drift out of sync.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { maskId } from '../../util/log-redact';
import {
  createLifecycleSink,
  read as readExecution,
  type ExecutionBoundary,
  type ExecutionKind,
  type ExecutionLifecycleSink,
  type ExecutionRecord,
} from '../execution-records';
import * as projectTasks from '../project_tasks';
import { verifyBaseline, type VerifyBaselineFailure } from './main-skill-baseline';

const log = createLogger('task-run');

/**
 * The two ends of a cross-agent capability reuse, as runtime roles. Vendors are
 * bound to roles at dispatch time and never encoded here (US-20 AC5).
 */
export type TaskRunRole = 'agent-a' | 'agent-b';

const TASK_RUN_ROLES: readonly TaskRunRole[] = ['agent-a', 'agent-b'];

/** Why a run was refused. Every value is a blocking condition, never a warning. */
export type StartTaskRunRefusal =
  | { reason: 'baseline_missing' }
  | { reason: 'baseline_drift' }
  | { reason: 'baseline_unreadable' }
  | { reason: 'task_not_found' };

export interface StartTaskRunInput {
  projectId: string;
  taskId: string;
  /** Frozen baseline that governs this run. Required — no baseline, no run. */
  baselineId: string;
  /** Skill tree the baseline pinned; re-hashed for drift detection. */
  skillDir: string;
  allowedRoots: readonly string[];
  /** Runtime role, not a vendor. */
  role: TaskRunRole;
  /** Vendor/adapter identity consumed by the execution layer. */
  kind: ExecutionKind;
  boundary: ExecutionBoundary;
  permissionMode: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  /** Receipt this run participates in, when one is already prepared. */
  receiptId?: string;
  executionId?: string;
}

export interface StartedTaskRun {
  executionId: string;
  role: TaskRunRole;
  baselineId: string;
  lifecycle: ExecutionLifecycleSink;
}

export type StartTaskRunResult =
  | ({ ok: true } & StartedTaskRun)
  | ({ ok: false } & StartTaskRunRefusal);

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireRole(value: unknown): TaskRunRole {
  if (TASK_RUN_ROLES.includes(value as TaskRunRole)) return value as TaskRunRole;
  throw new Error('invalid task run role');
}

const REFUSAL_FOR_BASELINE: Record<VerifyBaselineFailure, StartTaskRunRefusal> = {
  not_found: { reason: 'baseline_missing' },
  drift: { reason: 'baseline_drift' },
  unreadable: { reason: 'baseline_unreadable' },
};

/**
 * Start a run for a task.
 *
 * Verification precedes creation: on refusal NOTHING is written — no execution
 * record, no event, no task mutation — so a blocked attempt leaves no artifact
 * that could later be mistaken for evidence.
 */
export async function startTaskRun(
  userId: string,
  input: StartTaskRunInput,
): Promise<StartTaskRunResult> {
  const projectId = requireId(input.projectId, 'project id');
  const taskId = requireId(input.taskId, 'task id');
  const baselineId = requireId(input.baselineId, 'baseline id');
  const role = requireRole(input.role);

  const tasks = await projectTasks.listTasks(userId, projectId);
  if (!tasks.some((task) => task.id === taskId)) {
    return { ok: false, reason: 'task_not_found' };
  }

  const verified = await verifyBaseline(userId, baselineId, input.skillDir, input.allowedRoots);
  if (verified.ok !== true) {
    const failure: VerifyBaselineFailure = verified.reason;
    log.warn('refused task run', {
      user_id: maskId(userId),
      project_id: maskId(projectId),
      task_id: maskId(taskId),
      baseline_id: maskId(baselineId),
      reason: failure,
    });
    return { ok: false, ...REFUSAL_FOR_BASELINE[failure] };
  }

  const executionId = input.executionId
    ? requireId(input.executionId, 'execution id')
    : `run-${randomUUID()}`;

  const lifecycle = createLifecycleSink(userId, {
    executionId,
    kind: input.kind,
    boundary: input.boundary,
    permissionMode: input.permissionMode,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
  });

  await lifecycle.queued();
  // The governing baseline and the runtime role belong in the event stream:
  // they are what makes the run auditable back to a frozen method version
  // without duplicating baseline fields onto the execution record.
  await lifecycle.event('baseline_bound', { baselineId, role });

  await attachRunToTask(userId, projectId, taskId, executionId);

  log.info('started task run', {
    user_id: maskId(userId),
    project_id: maskId(projectId),
    task_id: maskId(taskId),
    execution_id: maskId(executionId),
    baseline_id: maskId(baselineId),
    role,
  });

  return { ok: true, executionId, role, baselineId, lifecycle };
}

/**
 * Append a run reference to a task. Idempotent, and bounded by
 * `TASK_RESULT_REF_MAX` on the persisted field: run ids accumulate in
 * `result_ref` as a compact reference list rather than a parallel store.
 */
async function attachRunToTask(
  userId: string,
  projectId: string,
  taskId: string,
  executionId: string,
): Promise<void> {
  const refs = await readRunIds(userId, projectId, taskId);
  if (refs.includes(executionId)) return;
  const next = [...refs, executionId];
  const encoded = encodeRunRefs(next);
  const result = await projectTasks.updateTask(userId, projectId, taskId, { result_ref: encoded });
  if (result.ok !== true) {
    const failure = result.error;
    // The execution itself is already durable; a failed back-reference must not
    // erase it. Surface it loudly and let the caller decide.
    log.error('failed to attach run reference to task', {
      user_id: maskId(userId),
      project_id: maskId(projectId),
      task_id: maskId(taskId),
      execution_id: maskId(executionId),
      error: failure,
    });
    throw new Error(`failed to attach run to task: ${failure}`);
  }
}

const RUN_REF_PREFIX = 'runs:';

function encodeRunRefs(executionIds: readonly string[]): string {
  return `${RUN_REF_PREFIX}${executionIds.join(',')}`;
}

/**
 * Decode the run reference list off a task. Tolerates a `result_ref` written by
 * an older build or a human (it was a free-form pointer before runs existed):
 * anything that is not the run-list form yields no runs rather than throwing.
 */
export function decodeRunRefs(resultRef: string | undefined): string[] {
  if (!resultRef || !resultRef.startsWith(RUN_REF_PREFIX)) return [];
  return resultRef
    .slice(RUN_REF_PREFIX.length)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => safeId(value));
}

export async function readRunIds(
  userId: string,
  projectId: string,
  taskId: string,
): Promise<string[]> {
  const tasks = await projectTasks.listTasks(userId, projectId);
  const task = tasks.find((row) => row.id === taskId);
  return decodeRunRefs(task?.result_ref);
}

/** Newest run id for a task, or null when it has never run. */
export async function readLatestRunId(
  userId: string,
  projectId: string,
  taskId: string,
): Promise<string | null> {
  const refs = await readRunIds(userId, projectId, taskId);
  return refs.length ? refs[refs.length - 1] : null;
}

/**
 * Resolve a task's runs to their live execution records. Status is read from
 * the execution layer on every call and never cached onto the task, so the two
 * cannot disagree. Unreadable runs are skipped rather than failing the list.
 */
export async function listTaskRuns(
  userId: string,
  projectId: string,
  taskId: string,
): Promise<ExecutionRecord[]> {
  const refs = await readRunIds(userId, projectId, taskId);
  const records: ExecutionRecord[] = [];
  for (const executionId of refs) {
    try { records.push(await readExecution(userId, executionId)); }
    catch {
      log.warn('skipping unreadable task run', {
        user_id: maskId(userId),
        task_id: maskId(taskId),
        execution_id: maskId(executionId),
      });
    }
  }
  return records;
}
