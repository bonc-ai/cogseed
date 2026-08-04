import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

let invokeHandler: any = null;
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: any) => { if (c === 'orkas.invoke') invokeHandler = f; }, on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

let root = '';
const UID = 'workbenchIpcUser';
const ASSET_ID = 'asset-continuity';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ipc-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  invokeHandler = null;
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => {
  delete process.env.ORKAS_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

const call = (channel: string, payload: any = {}) =>
  invokeHandler({ sender: trustedIpcSender() }, { channel, payload });

/** Install a skill tree at the marketplace path the handlers resolve to. */
async function installSkill(body = 'Baseline body.\n'): Promise<string> {
  const paths = await import('../../../src/main/paths');
  const dir = paths.userMarketplaceSkillDir(UID, ASSET_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: continuity\ndescription: delivery\n---\n${body}`);
  return dir;
}

describe('IPC workbench baseline', () => {
  it('freezes a baseline from the installed skill and lists it', async () => {
    await installSkill();

    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });

    expect(frozen.ok).toBe(true);
    expect(frozen.baseline.skill_ref.asset_id).toBe(ASSET_ID);
    expect(frozen.baseline.skill_ref.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.baseline.frozen_by).toBe('user');

    const listed = await call('workbench.baseline.list');
    expect(listed.baselines.map((row: any) => row.baseline_id))
      .toEqual([frozen.baseline.baseline_id]);
  });

  it('verifies a baseline and reports drift after the skill changes', async () => {
    const dir = await installSkill();
    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });

    await expect(call('workbench.baseline.verify', { baselineId: frozen.baseline.baseline_id }))
      .resolves.toMatchObject({ result: { ok: true } });

    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: continuity\n---\nMutated.\n');

    await expect(call('workbench.baseline.verify', { baselineId: frozen.baseline.baseline_id }))
      .resolves.toMatchObject({ result: { ok: false, reason: 'drift' } });
  });

  it('rejects a malformed asset id at the boundary', async () => {
    const result = await call('workbench.baseline.freeze', {
      assetId: '../escape', version: '1.0', source: 'workspace-builtin',
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/invalid asset id/);
  });
});

describe('IPC workbench gate', () => {
  it('blocks the workspace and reports the receipt gap', async () => {
    await installSkill();
    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });

    const gated = await call('workbench.gate.evaluate', {
      baselineId: frozen.baseline.baseline_id,
      receiptExecutionId: 'run-absent',
    });

    expect(gated.decision.status).toBe('blocked');
    expect(gated.decision.reasons).toContain('receipt_missing');
  });

  it('opens the workspace once a real completed receipt exists', async () => {
    await installSkill();
    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });

    const receipt = await import('../../../src/main/features/p3394/context-reuse-receipt');
    const executionId = 'run-gate-ipc';
    await receipt.prepareReceipt(UID, {
      executionId,
      targetSessionId: 'session-target',
      reusedRefs: ['rule/format'],
      omittedRefs: [],
      permissionMode: 'ask',
      allowedScopes: ['workspace:delivery'],
      boundary: 'real',
    }, { sessionId: 'session-target' });
    await receipt.completeReceipt(UID, executionId, { status: 'completed' });

    const gated = await call('workbench.gate.evaluate', {
      baselineId: frozen.baseline.baseline_id,
      receiptExecutionId: executionId,
    });

    expect(gated.decision.status).toBe('ready');
    expect(gated.decision.reasons).toEqual([]);
  });
});

describe('IPC workbench action plan', () => {
  it('projects an empty plan honestly for a fresh project', async () => {
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(UID, 'Delivery');
    if (!created.ok) throw new Error('project fixture failed');

    const planned = await call('workbench.actionPlan.read', { projectId: created.project.project_id });

    expect(planned.ok).toBe(true);
    expect(planned.plan.steps).toEqual([]);
    expect(planned.plan.hasRuns).toBe(false);
  });

  it('projects tasks with their dependency blocks', async () => {
    const projects = await import('../../../src/main/features/projects');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const created = await projects.createProject(UID, 'Delivery');
    if (!created.ok) throw new Error('project fixture failed');
    const pid = created.project.project_id;

    const upstream = await projectTasks.createTask(UID, pid, { title: 'Upstream' });
    if (!upstream.ok) throw new Error('task fixture failed');
    const downstream = await projectTasks.createTask(UID, pid, {
      title: 'Downstream', depends_on: [upstream.task.id],
    });
    if (!downstream.ok) throw new Error('task fixture failed');

    const planned = await call('workbench.actionPlan.read', { projectId: pid });

    expect(planned.plan.steps).toHaveLength(2);
    // Same-millisecond creations tie-break by id, so locate the step by id
    // rather than by position.
    const blocked = planned.plan.steps.find((step: any) => step.taskId === downstream.task.id);
    expect(blocked.state).toBe('blocked_by_dependency');
    expect(blocked.unmetDependencies).toEqual([upstream.task.id]);
    expect(planned.plan.totals.blocked).toBe(1);
  });

  it('rejects a malformed project id at the boundary', async () => {
    const result = await call('workbench.actionPlan.read', { projectId: '../escape' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/invalid project id/);
  });
});

describe('IPC workbench task run', () => {
  it('starts a run for a task under a frozen baseline', async () => {
    await installSkill();
    const projects = await import('../../../src/main/features/projects');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const created = await projects.createProject(UID, 'Delivery');
    if (!created.ok) throw new Error('project fixture failed');
    const pid = created.project.project_id;
    const task = await projectTasks.createTask(UID, pid, { title: 'Execute' });
    if (!task.ok) throw new Error('task fixture failed');

    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });

    const started = await call('workbench.taskRun.start', {
      projectId: pid, taskId: task.task.id, baselineId: frozen.baseline.baseline_id, role: 'agent-b',
    });

    expect(started.ok).toBe(true);
    expect(started.role).toBe('agent-b');

    const runs = await call('workbench.taskRuns.list', { projectId: pid, taskId: task.task.id });
    expect(runs.runs.map((run: any) => run.executionId)).toEqual([started.executionId]);
  });

  it('reports a drift refusal instead of starting', async () => {
    const dir = await installSkill();
    const projects = await import('../../../src/main/features/projects');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const created = await projects.createProject(UID, 'Delivery');
    if (!created.ok) throw new Error('project fixture failed');
    const pid = created.project.project_id;
    const task = await projectTasks.createTask(UID, pid, { title: 'Execute' });
    if (!task.ok) throw new Error('task fixture failed');

    const frozen = await call('workbench.baseline.freeze', {
      assetId: ASSET_ID, version: '1.0', source: 'workspace-builtin',
    });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: continuity\n---\nMutated.\n');

    const refused = await call('workbench.taskRun.start', {
      projectId: pid, taskId: task.task.id, baselineId: frozen.baseline.baseline_id, role: 'agent-b',
    });

    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe('baseline_drift');
    // Nothing was recorded for the refused attempt.
    const runs = await call('workbench.taskRuns.list', { projectId: pid, taskId: task.task.id });
    expect(runs.runs).toEqual([]);
  });
});
