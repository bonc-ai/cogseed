import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const PLAN = '../../../../src/main/features/workbench/action-plan';
const TASK_RUN = '../../../../src/main/features/workbench/task-run';
const BASELINE = '../../../../src/main/features/workbench/main-skill-baseline';
const PROJECTS = '../../../../src/main/features/projects';
const PROJECT_TASKS = '../../../../src/main/features/project_tasks';
const PATHS = '../../../../src/main/paths';

let uid = '';
beforeEach(() => { uid = `plan-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

async function makeProject(): Promise<string> {
  const projects = await import(PROJECTS);
  const created = await projects.createProject(uid, `Delivery ${randomUUID().slice(0, 8)}`);
  if (!created.ok) throw new Error('project fixture failed');
  return created.project.project_id;
}

async function addTask(
  projectId: string,
  title: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const projectTasks = await import(PROJECT_TASKS);
  const created = await projectTasks.createTask(uid, projectId, { title, ...over });
  if (!created.ok) throw new Error(`task fixture failed: ${created.error}`);
  return created.task.id;
}

/** Freeze a baseline so runs can legally start. */
async function makeBaseline(): Promise<{ baselineId: string; skillDir: string }> {
  const { userLocalRoot } = await import(PATHS);
  const baselineMod = await import(BASELINE);
  const skillDir = path.join(userLocalRoot(uid), 'main-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: continuity\n---\nBody.\n');
  const baseline = await baselineMod.freezeBaseline(uid, {
    assetId: 'asset-cross-agent-continuity',
    version: '1.0',
    skillDir,
    allowedRoots: [skillDir],
    source: 'workspace-builtin',
  });
  return { baselineId: baseline.baseline_id, skillDir };
}

async function startRun(projectId: string, taskId: string) {
  const mod = await import(TASK_RUN);
  const { baselineId, skillDir } = await makeBaseline().catch(async () => {
    // A baseline already exists for this uid; reuse the frozen one.
    const baselineMod = await import(BASELINE);
    const { userLocalRoot } = await import(PATHS);
    const rows = await baselineMod.listBaselines(uid);
    return { baselineId: rows[0].baseline_id, skillDir: path.join(userLocalRoot(uid), 'main-skill') };
  });
  const started = await mod.startTaskRun(uid, {
    projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    role: 'agent-b', kind: 'core-agent', boundary: 'test-double',
    permissionMode: 'ask', sessionId: 'session-1', conversationId: 'conversation-1',
  });
  if (!started.ok) throw new Error(`run should have started: ${started.reason}`);
  return started;
}

describe('action plan — projection', () => {
  it('returns an honest empty plan for a project with no tasks', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();

    const plan = await mod.projectActionPlan(uid, projectId);

    expect(plan.steps).toEqual([]);
    expect(plan.totals.steps).toBe(0);
    expect(plan.hasRuns).toBe(false);
  });

  it('projects tasks as steps in deterministic backlog order', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const first = await addTask(projectId, 'Collect source material');
    const second = await addTask(projectId, 'Draft deliverable');

    const plan = await mod.projectActionPlan(uid, projectId);

    // listTasks orders by created_at then id; same-millisecond creations
    // tie-break by id, so assert the set and the stability of the ordering
    // rather than a creation-order sequence.
    expect(plan.steps.map((step: { taskId: string }) => step.taskId).sort())
      .toEqual([first, second].sort());
    const again = await mod.projectActionPlan(uid, projectId);
    expect(again.steps.map((step: { taskId: string }) => step.taskId))
      .toEqual(plan.steps.map((step: { taskId: string }) => step.taskId));
    expect(plan.steps.every((step: { state: string }) => step.state === 'not_started')).toBe(true);
  });

  it('marks a step blocked by an unfinished prerequisite', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const upstream = await addTask(projectId, 'Upstream');
    const downstream = await addTask(projectId, 'Downstream', { depends_on: [upstream] });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === downstream);

    expect(step.state).toBe('blocked_by_dependency');
    expect(step.unmetDependencies).toEqual([upstream]);
    expect(plan.totals.blocked).toBe(1);
  });

  it('clears a dependency block once the prerequisite is done', async () => {
    const mod = await import(PLAN);
    const projectTasks = await import(PROJECT_TASKS);
    const projectId = await makeProject();
    const upstream = await addTask(projectId, 'Upstream');
    const downstream = await addTask(projectId, 'Downstream', { depends_on: [upstream] });

    await projectTasks.updateTask(uid, projectId, upstream, { status: 'done' });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === downstream);
    expect(step.unmetDependencies).toEqual([]);
    expect(step.state).toBe('not_started');
  });

  it('ignores a dangling prerequisite instead of freezing the step forever', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const step = await addTask(projectId, 'Orphan dependency', {
      depends_on: ['t_ffffffffffff'],
    });

    const plan = await mod.projectActionPlan(uid, projectId);
    const row = plan.steps.find((s: { taskId: string }) => s.taskId === step);

    expect(row.dependsOn).toEqual(['t_ffffffffffff']);
    expect(row.unmetDependencies).toEqual([]);
    expect(row.state).toBe('not_started');
  });

  it('distinguishes a user-authored block from a dependency block', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Waiting on legal', { status: 'blocked' });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);

    expect(step.state).toBe('blocked_by_user');
    expect(step.unmetDependencies).toEqual([]);
  });
});

describe('action plan — run state', () => {
  it('reflects a live run as running and surfaces its id', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Execute delivery');
    const started = await startRun(projectId, taskId);

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);

    expect(step.state).toBe('running');
    expect(step.latestRunId).toBe(started.executionId);
    expect(step.runCount).toBe(1);
    expect(plan.hasRuns).toBe(true);
    expect(plan.totals.running).toBe(1);
  });

  it('reports a failed run without closing the task', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Execute delivery');
    const started = await startRun(projectId, taskId);

    await started.lifecycle.terminal({ status: 'failed', sessionId: 'session-1' });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);

    expect(step.state).toBe('failed');
    expect(step.latestRunStatus).toBe('failed');
    // The task itself is untouched — closing it stays the user's decision.
    expect(step.taskStatus).toBe('todo');
  });

  it('does not let an earlier failure mask a later successful run', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Retry delivery');

    const first = await startRun(projectId, taskId);
    await first.lifecycle.terminal({ status: 'failed', sessionId: 'session-1' });
    const second = await startRun(projectId, taskId);

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);

    expect(step.runCount).toBe(2);
    expect(step.latestRunId).toBe(second.executionId);
    expect(step.state).toBe('running');
  });

  it('keeps a completed run from silently marking the step done', async () => {
    const mod = await import(PLAN);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Execute delivery');
    const started = await startRun(projectId, taskId);

    await started.lifecycle.terminal({ status: 'completed', sessionId: 'session-1' });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);

    // Run succeeded, but the task is still open: `done` requires a user decision.
    expect(step.latestRunStatus).toBe('completed');
    expect(step.state).toBe('not_started');
    expect(plan.totals.done).toBe(0);
  });

  it('honours a user-marked done step over its run history', async () => {
    const mod = await import(PLAN);
    const projectTasks = await import(PROJECT_TASKS);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Execute delivery');
    const started = await startRun(projectId, taskId);
    await started.lifecycle.terminal({ status: 'failed', sessionId: 'session-1' });

    await projectTasks.updateTask(uid, projectId, taskId, { status: 'done' });

    const plan = await mod.projectActionPlan(uid, projectId);
    const step = plan.steps.find((row: { taskId: string }) => row.taskId === taskId);
    expect(step.state).toBe('done');
    expect(plan.totals.done).toBe(1);
  });
});

describe('action plan — purity', () => {
  it('writes nothing: repeated projections leave task state untouched', async () => {
    const mod = await import(PLAN);
    const projectTasks = await import(PROJECT_TASKS);
    const projectId = await makeProject();
    const taskId = await addTask(projectId, 'Execute delivery');
    const before = (await projectTasks.listTasks(uid, projectId))
      .find((task: { id: string }) => task.id === taskId);

    await mod.projectActionPlan(uid, projectId);
    await mod.projectActionPlan(uid, projectId);

    const after = (await projectTasks.listTasks(uid, projectId))
      .find((task: { id: string }) => task.id === taskId);
    expect(after).toEqual(before);
  });

  it('rejects a malformed project id', async () => {
    const mod = await import(PLAN);
    await expect(mod.projectActionPlan(uid, '../escape')).rejects.toThrow(/invalid project id/);
  });
});
