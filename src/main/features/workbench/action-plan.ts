/**
 * Action Plan — a READ-ONLY projection of a project's tasks and their runs.
 *
 * This is deliberately not a plan engine. G8b replaced the static plan DAG with
 * the commander-in-the-loop model (`dispatch_to` / `run_worker` + handback in
 * `group_chat/bus.ts`); `group_chat/plan_executor.ts` survives only as inert
 * no-ops so its callers keep compiling. Reintroducing a second dispatch
 * authority is explicitly out of bounds, so this module:
 *   - owns NO state and writes NOTHING,
 *   - derives every step from `project_tasks` (`depends_on`) plus live
 *     execution records read through `workbench/task-run`,
 *   - never triggers, retries or reorders work — those actions belong to the
 *     existing group-chat path.
 *
 * Step status is computed on every call rather than stored, mirroring
 * `project_tasks.computeProgress`: a cached plan would drift from the execution
 * layer the moment a run advanced, and a stale plan is worse than no plan when
 * it is being used as delivery evidence.
 */

import { safeId } from '../../storage';
import type { ExecutionRecord, ExecutionStatus } from '../execution-records';
import * as projectTasks from '../project_tasks';
import type { ProjectTask, TaskStatus } from '../project_tasks';
import { decodeRunRefs, listTaskRuns } from './task-run';

/**
 * What a step is doing right now, as the plan sees it.
 *
 * `blocked_by_dependency` is derived from unfinished prerequisites and is
 * distinct from the task's own authored `blocked` status: one is a structural
 * consequence, the other a human judgement, and collapsing them would hide why
 * a step cannot proceed.
 */
export type ActionPlanStepState =
  | 'not_started'
  | 'blocked_by_dependency'
  | 'blocked_by_user'
  | 'running'
  | 'failed'
  | 'done'
  | 'cancelled';

export interface ActionPlanStep {
  taskId: string;
  title: string;
  taskStatus: TaskStatus;
  state: ActionPlanStepState;
  dependsOn: string[];
  /** Prerequisites that are not yet done — the reason for a dependency block. */
  unmetDependencies: string[];
  ownerAgent?: string;
  runCount: number;
  latestRunId?: string;
  latestRunStatus?: ExecutionStatus;
  /** Artifact ids produced across all runs of this step, de-duplicated. */
  artifactIds: string[];
}

export interface ActionPlan {
  projectId: string;
  steps: ActionPlanStep[];
  totals: {
    steps: number;
    done: number;
    running: number;
    blocked: number;
    notStarted: number;
    failed: number;
    cancelled: number;
  };
  /** True when at least one step has a real execution behind it. */
  hasRuns: boolean;
  projectedAt: string;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid ${field}`);
  return value;
}

const TERMINAL_RUN_FAILURES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  'failed', 'cancelled', 'timed_out',
]);

/**
 * Latest run wins. Runs accumulate in start order, so the last reference is the
 * most recent attempt and an earlier failure must not mask a later success.
 */
function latestRun(runs: readonly ExecutionRecord[]): ExecutionRecord | undefined {
  return runs.length ? runs[runs.length - 1] : undefined;
}

function deriveState(
  task: ProjectTask,
  unmetDependencies: readonly string[],
  latest: ExecutionRecord | undefined,
): ActionPlanStepState {
  // The user's own decision outranks anything derived: an explicitly done or
  // cancelled task is not reopened by run history.
  if (task.status === 'done') return 'done';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'blocked') return 'blocked_by_user';
  if (unmetDependencies.length) return 'blocked_by_dependency';
  if (latest) {
    if (latest.status === 'queued' || latest.status === 'running') return 'running';
    if (TERMINAL_RUN_FAILURES.has(latest.status)) return 'failed';
    // A completed run does not close the task — completion is the user's call
    // (see task-run: run status is never mirrored onto the task).
  }
  return 'not_started';
}

/**
 * Project a project's Action Plan.
 *
 * Steps keep `project_tasks.listTasks` ordering (created_at asc, id
 * tie-broken), which is already deterministic across reloads — the plan must
 * not reshuffle between renders.
 */
export async function projectActionPlan(
  userId: string,
  projectId: string,
): Promise<ActionPlan> {
  const pid = requireId(projectId, 'project id');
  const tasks = await projectTasks.listTasks(userId, pid);

  // Resolve which tasks count as finished before deriving dependency blocks, so
  // a step's prerequisites are judged against the whole backlog rather than
  // only the steps ahead of it.
  const doneTaskIds = new Set(
    tasks.filter((task) => task.status === 'done').map((task) => task.id),
  );
  const knownTaskIds = new Set(tasks.map((task) => task.id));

  const steps: ActionPlanStep[] = [];
  for (const task of tasks) {
    const dependsOn = [...(task.depends_on || [])];
    // Dangling prerequisites (referent deleted) are dropped rather than treated
    // as permanently unmet — otherwise deleting a task would silently freeze
    // every step that once depended on it.
    const unmetDependencies = dependsOn
      .filter((dependency) => knownTaskIds.has(dependency))
      .filter((dependency) => !doneTaskIds.has(dependency));

    const runs = await listTaskRuns(userId, pid, task.id);
    const latest = latestRun(runs);
    const artifactIds = Array.from(new Set(runs.flatMap((run) => run.artifactIds)));

    steps.push({
      taskId: task.id,
      title: task.title,
      taskStatus: task.status,
      state: deriveState(task, unmetDependencies, latest),
      dependsOn,
      unmetDependencies,
      ...(task.owner_agent ? { ownerAgent: task.owner_agent } : {}),
      // Count declared references, not resolved records: a run whose record is
      // unreadable still happened, and hiding it would understate the history.
      runCount: decodeRunRefs(task.result_ref).length,
      ...(latest ? { latestRunId: latest.executionId, latestRunStatus: latest.status } : {}),
      artifactIds,
    });
  }

  const totals = {
    steps: steps.length,
    done: steps.filter((step) => step.state === 'done').length,
    running: steps.filter((step) => step.state === 'running').length,
    blocked: steps.filter((step) => (
      step.state === 'blocked_by_dependency' || step.state === 'blocked_by_user'
    )).length,
    notStarted: steps.filter((step) => step.state === 'not_started').length,
    failed: steps.filter((step) => step.state === 'failed').length,
    cancelled: steps.filter((step) => step.state === 'cancelled').length,
  };

  return {
    projectId: pid,
    steps,
    totals,
    hasRuns: steps.some((step) => step.runCount > 0),
    projectedAt: new Date().toISOString(),
  };
}
