import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const TASK_RUN = '../../../../src/main/features/workbench/task-run';
const BASELINE = '../../../../src/main/features/workbench/main-skill-baseline';
const PROJECTS = '../../../../src/main/features/projects';
const PROJECT_TASKS = '../../../../src/main/features/project_tasks';
const EXECUTIONS = '../../../../src/main/features/execution-records';
const PATHS = '../../../../src/main/paths';

let uid = '';
beforeEach(() => { uid = `taskrun-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

async function makeSkillDir(name = 'main-skill', body = 'Baseline body.\n'): Promise<string> {
  const { userLocalRoot } = await import(PATHS);
  const dir = path.join(userLocalRoot(uid), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}`);
  return dir;
}

/** Real project + task + frozen baseline — no stubbing of the layers under test. */
async function scaffold(): Promise<{ projectId: string; taskId: string; baselineId: string; skillDir: string }> {
  const projects = await import(PROJECTS);
  const projectTasks = await import(PROJECT_TASKS);
  const baselineMod = await import(BASELINE);

  const created = await projects.createProject(uid, `Delivery ${randomUUID().slice(0, 8)}`);
  if (!created.ok) throw new Error('project fixture failed');
  const projectId = created.project.project_id;

  const task = await projectTasks.createTask(uid, projectId, { title: 'Continue delivery' });
  if (!task.ok) throw new Error('task fixture failed');

  const skillDir = await makeSkillDir();
  const baseline = await baselineMod.freezeBaseline(uid, {
    assetId: 'asset-cross-agent-continuity',
    version: '1.0',
    skillDir,
    allowedRoots: [skillDir],
    source: 'workspace-builtin',
    evaluationContractRef: 'evaluation/contract-v1',
  });

  return { projectId, taskId: task.task.id, baselineId: baseline.baseline_id, skillDir };
}

const startInput = (over: Record<string, unknown>) => ({
  role: 'agent-b' as const,
  kind: 'core-agent' as const,
  boundary: 'test-double' as const,
  permissionMode: 'ask',
  sessionId: 'session-target-1',
  conversationId: 'conversation-1',
  ...over,
});

describe('task run — baseline gating', () => {
  it('starts a run and records the governing baseline and runtime role', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    const started = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    }));

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.role).toBe('agent-b');
    expect(started.baselineId).toBe(baselineId);

    // The baseline binding is auditable from the execution event stream.
    const executions = await import(EXECUTIONS);
    const events = await executions.readEvents(uid, started.executionId);
    const bound = events.find((event: { type: string }) => event.type === 'baseline_bound');
    expect(bound?.metadata).toMatchObject({ baselineId, role: 'agent-b' });
  });

  it('refuses to start when the baseline drifted, writing no execution at all', async () => {
    const mod = await import(TASK_RUN);
    const executions = await import(EXECUTIONS);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: main-skill\n---\nMutated.\n');

    const refused = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    }));

    expect(refused).toEqual({ ok: false, reason: 'baseline_drift' });
    // A blocked attempt must leave no evidence-shaped residue behind.
    await expect(executions.list(uid)).resolves.toEqual([]);
    await expect(mod.readRunIds(uid, projectId, taskId)).resolves.toEqual([]);
  });

  it('refuses when no baseline was ever frozen', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, skillDir } = await scaffold();

    const refused = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId: 'baseline-absent', skillDir, allowedRoots: [skillDir],
    }));

    expect(refused).toEqual({ ok: false, reason: 'baseline_missing' });
  });

  it('refuses when the pinned skill tree is unreadable', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    await fs.rm(skillDir, { recursive: true, force: true });

    const refused = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    }));

    expect(refused).toEqual({ ok: false, reason: 'baseline_unreadable' });
  });

  it('refuses an unknown task before touching the baseline', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, baselineId, skillDir } = await scaffold();

    const refused = await mod.startTaskRun(uid, startInput({
      projectId, taskId: 't_ffffffffffff', baselineId, skillDir, allowedRoots: [skillDir],
    }));

    expect(refused).toEqual({ ok: false, reason: 'task_not_found' });
  });

  it('rejects a vendor name passed as a runtime role', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    await expect(mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir], role: 'codex',
    }))).rejects.toThrow(/invalid task run role/);
  });
});

describe('task run — task references', () => {
  it('accumulates run ids across runs without losing earlier ones', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();
    const base = startInput({ projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir] });

    const first = await mod.startTaskRun(uid, base);
    const second = await mod.startTaskRun(uid, { ...base, role: 'agent-a' });
    if (!first.ok || !second.ok) throw new Error('runs should have started');

    await expect(mod.readRunIds(uid, projectId, taskId))
      .resolves.toEqual([first.executionId, second.executionId]);
    await expect(mod.readLatestRunId(uid, projectId, taskId))
      .resolves.toBe(second.executionId);
  });

  it('resolves runs to live execution records rather than a cached status', async () => {
    const mod = await import(TASK_RUN);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    const started = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    }));
    if (!started.ok) throw new Error('run should have started');

    let runs = await mod.listTaskRuns(uid, projectId, taskId);
    expect(runs.map((run: { status: string }) => run.status)).toEqual(['queued']);

    await started.lifecycle.terminal({ status: 'completed', sessionId: 'session-target-1' });

    // Same task, no task mutation — the new status comes from the execution layer.
    runs = await mod.listTaskRuns(uid, projectId, taskId);
    expect(runs.map((run: { status: string }) => run.status)).toEqual(['completed']);
  });

  it('does not mirror run status onto the task', async () => {
    const mod = await import(TASK_RUN);
    const projectTasks = await import(PROJECT_TASKS);
    const { projectId, taskId, baselineId, skillDir } = await scaffold();

    const started = await mod.startTaskRun(uid, startInput({
      projectId, taskId, baselineId, skillDir, allowedRoots: [skillDir],
    }));
    if (!started.ok) throw new Error('run should have started');
    await started.lifecycle.terminal({ status: 'completed', sessionId: 'session-target-1' });

    const tasks = await projectTasks.listTasks(uid, projectId);
    // Completing a run must not silently close the task — that decision is the
    // user's, and derived status would drift from the execution layer.
    expect(tasks.find((task: { id: string }) => task.id === taskId)?.status).toBe('todo');
  });

  it('treats a legacy free-form result_ref as having no runs', async () => {
    const mod = await import(TASK_RUN);
    expect(mod.decodeRunRefs(undefined)).toEqual([]);
    expect(mod.decodeRunRefs('artifacts/report.md')).toEqual([]);
    expect(mod.decodeRunRefs('runs:run-a,run-b')).toEqual(['run-a', 'run-b']);
    expect(mod.decodeRunRefs('runs:run-a, ,bad/id,run-b')).toEqual(['run-a', 'run-b']);
  });
});
