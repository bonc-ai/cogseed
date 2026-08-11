import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-recovery-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-recovery-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed worker recovery', () => {
  it('marks queued/running CogSeed tasks recoverable without replaying their original prompts', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const queued = (await tasks.createMateTask(USER, { requestId: 'req-recovery-queued', task: 'Must not auto replay queued.' })).task;
    await lifecycle.transitionMateTask(USER, queued.taskId, 'queued');
    const running = (await tasks.createMateTask(USER, { requestId: 'req-recovery-running', task: 'Must not auto replay running.' })).task;
    await lifecycle.transitionMateTask(USER, running.taskId, 'queued');
    await lifecycle.transitionMateTask(USER, running.taskId, 'running');

    const report = await recovery.recoverMateTasks(USER);

    expect(report).toMatchObject({ recoveredCount: 2, dispatchedCount: 0 });
    await expect(tasks.readMateTask(USER, queued.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(tasks.readMateTask(USER, running.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(events.readMateTaskEvents(USER, running.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.recoverable', payload: { errorCode: 'worker_restart' } }),
    ]));
  });
});
