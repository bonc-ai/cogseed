import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-recovery-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recovery-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed worker recovery', () => {
  it('marks queued/running CogSeed tasks recoverable without replaying their original prompts', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const queued = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-queued',
      task: 'Must not auto replay queued.',
      conversationId: 'cid-recovery',
      agentId: 'agent-recovery',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, queued.taskId, 'queued');
    const running = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-running',
      task: 'Must not auto replay running.',
      conversationId: 'cid-recovery',
      agentId: 'agent-recovery',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, running.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, running.taskId, 'running');

    const projected: any[] = [];
    const report = await recovery.recoverCogSeedTasks(USER, {
      projectTaskEvent: vi.fn(async (input) => { projected.push(input); }),
    } as any);

    expect(report).toMatchObject({ recoveredCount: 2, dispatchedCount: 0 });
    await expect(tasks.readCogSeedTask(USER, queued.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(tasks.readCogSeedTask(USER, running.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(events.readCogSeedTaskEvents(USER, running.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.recoverable', payload: { errorCode: 'worker_restart' } }),
    ]));
    expect(projected.map((input) => input.event.type)).toEqual(['task.recoverable', 'task.recoverable']);
    expect(projected.every((input) => input.event.payload.errorCode === 'worker_restart')).toBe(true);
  });
});
