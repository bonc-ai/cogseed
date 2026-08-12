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
  readEvents as readExecutionEvents,
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

/** 为什么一个 run 被拒绝。每个值都是阻塞条件，绝不是警告。 */
export type StartTaskRunRefusal =
  | { reason: 'baseline_missing' }
  | { reason: 'baseline_drift' }
  | { reason: 'baseline_unreadable' }
  | { reason: 'task_not_found' }
  | { reason: 'space_gate_not_passed' };

/**
 * 启动时的空间上下文（服务层从 spaces 读取后传入，task-run 不直接 import
 * spaces——避免 features 层耦合；字段名与 spaces.ts 的类型结构兼容）。
 * P0：只校验上架 Gate + 冻结版本引用；角色组合/跨空间等后续迭代再扩展。
 */
export interface TaskRunSpaceContext {
  spaceId: string;
  gateStatus: 'not_checked' | 'passed' | 'failed';
  /** 空间对正式资产的版本引用（TaskRun 启动时全部冻结）。 */
  assetBindings: Array<{ asset_id: string; version: string; content_hash?: string; policy?: string }>;
  /** 空间绑定的 Main Skill（一并冻结）。 */
  mainSkillRef?: { asset_id: string; version: string; content_hash?: string };
}

/** 冻结的资产版本引用（从执行事件流读取，append-only 天然不可变）。 */
export interface FrozenAssetVersionRef {
  asset_id: string;
  version: string;
  content_hash?: string;
}

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
  /** 可选：空间上下文。提供时校验上架 Gate 并冻结资产版本引用。 */
  space?: TaskRunSpaceContext;
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

  // 空间上架 Gate 校验（提供空间上下文时）：仅显式评估失败（failed）的空间
  // 不得启动正式 TaskRun。not_checked 表示"尚未评估"而非"评估未通过"——
  // 目前系统没有自动评估写入路径（evaluateWorkspaceGate 是纯判断不落盘，
  // gate_status 仅作缓存/标记），旧空间与新建空间默认均为 not_checked；
  // 若把 not_checked 当作拒绝理由，接线后所有未评估空间会被整体误伤。
  if (input.space && input.space.gateStatus === 'failed') {
    log.warn('refused task run: space gate failed', {
      user_id: maskId(userId),
      space_id: maskId(input.space.spaceId),
      gate_status: input.space.gateStatus,
    });
    return { ok: false, reason: 'space_gate_not_passed' };
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

  // 资产版本冻结（PRD §3.4.2 规则 1）：TaskRun 启动时快照空间引用的全部
  // 正式资产版本 + Main Skill；运行中不静默切换。事件流 append-only，
  // 冻结集天然不可变，历史 run 可复现。
  if (input.space) {
    const frozenRefs: FrozenAssetVersionRef[] = [
      ...(input.space.mainSkillRef ? [input.space.mainSkillRef] : []),
      ...input.space.assetBindings.map((b) => ({ asset_id: b.asset_id, version: b.version, ...(b.content_hash ? { content_hash: b.content_hash } : {}) })),
    ].filter((ref, idx, arr) => arr.findIndex((r) => r.asset_id === ref.asset_id && r.version === ref.version) === idx);
    if (frozenRefs.length) {
      await lifecycle.event('asset_versions_frozen', { refs: frozenRefs, spaceId: input.space.spaceId });
    }
  }

  await attachRunToTask(userId, projectId, taskId, executionId);

  log.info('started task run', {
    user_id: maskId(userId),
    project_id: maskId(projectId),
    task_id: maskId(taskId),
    execution_id: maskId(executionId),
    baseline_id: maskId(baselineId),
    role,
    ...(input.space ? { space_id: maskId(input.space.spaceId) } : {}),
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
 * 读取某次 TaskRun 启动时冻结的资产版本引用（PRD §3.4.2）。
 *
 * 从执行事件流的 `asset_versions_frozen` 事件读取——事件 append-only，
 * 因此返回的冻结集对该 run 永久不可变；无事件 → 空数组（该 run 未绑定空间）。
 * 历史 run 的复现与审计依赖此函数，不读空间的当前绑定（空间引用可变，
 * 运行冻结不可变）。
 */
export async function readFrozenAssetVersions(
  userId: string,
  executionId: string,
): Promise<FrozenAssetVersionRef[]> {
  const events = await readExecutionEvents(userId, executionId);
  const frozen = events.find((e) => e.type === 'asset_versions_frozen');
  if (!frozen) return [];
  const refs = frozen.metadata?.refs;
  return Array.isArray(refs) ? (refs as FrozenAssetVersionRef[]) : [];
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
