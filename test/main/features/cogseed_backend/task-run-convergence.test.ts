import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Run → task convergence (R-01/R-02 write side). Evidence: a group-chat task
 * created 17:14:22 was still `waiting_user` at 17:17:23 although its turn had
 * ended (turn_end=1), so the sidebar kept reporting it as executing.
 */
const USER = 'cogseed-run-converge-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-converge-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function store() {
  return import('../../../../src/main/features/cogseed_backend/task-store');
}
async function events() {
  return import('../../../../src/main/features/cogseed_backend/event-store');
}

async function runningRunTask(requestId: string, runId: string) {
  const tasks = await store();
  const created = await tasks.createCogSeedTask(USER, {
    requestId,
    task: 'Group-chat run task.',
    executionKind: 'group-chat',
    groupChatRunId: runId,
  });
  await tasks.updateCogSeedTaskWithEvent(
    USER,
    created.task.taskId,
    (current) => ({ ...current, status: 'running' as const, updatedAt: new Date().toISOString() }),
    { type: 'task.started', payload: { source: 'group-chat' } },
  );
  return created.task.taskId;
}

describe('run → task convergence', () => {
  it('completes the task when its run completed, and records the event', async () => {
    const taskId = await runningRunTask('req-converge-ok', 'run-converge-ok');
    const tasks = await store();

    const converged = await tasks.convergeCogSeedTaskForRun(USER, {
      runId: 'run-converge-ok',
      outcome: 'completed',
    });

    expect(converged).toMatchObject({ taskId, status: 'completed' });
    const types = (await (await events()).readCogSeedTaskEvents(USER, taskId, 0, 20)).map((event) => event.type);
    expect(types).toContain('task.completed');
  });

  it('fails the task with the run status as errorCode', async () => {
    const taskId = await runningRunTask('req-converge-fail', 'run-converge-fail');
    const tasks = await store();

    await tasks.convergeCogSeedTaskForRun(USER, {
      runId: 'run-converge-fail',
      outcome: 'failed',
      errorCode: 'run_blocked',
    });

    await expect(tasks.readCogSeedTask(USER, taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'run_blocked',
    });
  });

  it('leaves a task that waits for the user alone', async () => {
    const taskId = await runningRunTask('req-converge-wait', 'run-converge-wait');
    const tasks = await store();

    const converged = await tasks.convergeCogSeedTaskForRun(USER, {
      runId: 'run-converge-wait',
      outcome: 'failed',
      waitingForUser: true,
      errorCode: 'run_blocked',
    });

    expect(converged).toBeNull();
    await expect(tasks.readCogSeedTask(USER, taskId)).resolves.toMatchObject({ status: 'running' });
  });

  it('is idempotent: an already terminal task is not touched again', async () => {
    await runningRunTask('req-converge-twice', 'run-converge-twice');
    const tasks = await store();

    await expect(tasks.convergeCogSeedTaskForRun(USER, { runId: 'run-converge-twice', outcome: 'completed' }))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(tasks.convergeCogSeedTaskForRun(USER, { runId: 'run-converge-twice', outcome: 'completed' }))
      .resolves.toBeNull();
  });

  it('ignores runs that own no task', async () => {
    const tasks = await store();
    await expect(tasks.convergeCogSeedTaskForRun(USER, { runId: 'run-without-task', outcome: 'completed' }))
      .resolves.toBeNull();
  });
});
