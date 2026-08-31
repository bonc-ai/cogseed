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
    const waiting = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-waiting',
      task: 'Must not remain attached to a missing worker.',
      conversationId: 'cid-recovery',
      agentId: 'agent-recovery',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'waiting_user');

    const projected: any[] = [];
    const report = await recovery.recoverCogSeedTasks(USER, {
      projectTaskEvent: vi.fn(async (input) => { projected.push(input); }),
    } as any);

    expect(report).toMatchObject({ recoveredCount: 3, dispatchedCount: 0 });
    await expect(tasks.readCogSeedTask(USER, queued.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(tasks.readCogSeedTask(USER, running.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(tasks.readCogSeedTask(USER, waiting.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(events.readCogSeedTaskEvents(USER, running.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.recoverable', payload: { errorCode: 'worker_restart' } }),
    ]));
    expect(projected.map((input) => input.event.type)).toEqual(['task.recoverable', 'task.recoverable', 'task.recoverable']);
    expect(projected.every((input) => input.event.payload.errorCode === 'worker_restart')).toBe(true);
  });

  it('skips tasks whose executors are still active and reports only recovered task ids', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');

    const active = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-active',
      task: 'This executor is still alive.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, active.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, active.taskId, 'running');
    const orphaned = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-orphaned',
      task: 'This executor disappeared.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, orphaned.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, orphaned.taskId, 'running');

    const report = await recovery.recoverCogSeedTasks(USER, {
      activeTaskIds: new Set([active.taskId]),
    });

    expect(report).toMatchObject({ recoveredCount: 1, taskIds: [orphaned.taskId] });
    await expect(tasks.readCogSeedTask(USER, active.taskId)).resolves.toMatchObject({ status: 'running' });
    await expect(tasks.readCogSeedTask(USER, orphaned.taskId)).resolves.toMatchObject({ status: 'recoverable' });
  });

  it('shares concurrent recovery calls per user and emits one recovery event', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-single-flight',
      task: 'Recover once.',
      conversationId: 'cid-recovery-single-flight',
      agentId: 'agent-recovery-single-flight',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'running');
    const projectTaskEvent = vi.fn(async () => undefined);

    const first = recovery.recoverCogSeedTasks(USER, { projectTaskEvent });
    const second = recovery.recoverCogSeedTasks(USER, { projectTaskEvent });
    expect(second).toBe(first);
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(firstReport).toEqual(secondReport);
    expect(firstReport).toMatchObject({ recoveredCount: 1, taskIds: [task.taskId] });
    expect(projectTaskEvent).toHaveBeenCalledTimes(1);
    const storedEvents = await events.readCogSeedTaskEvents(USER, task.taskId, 0, 20);
    expect(storedEvents.filter((event) => event.type === 'task.recoverable')).toHaveLength(1);
  });

  it('continues when a listed task becomes terminal before its recovery transition', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const finishing = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-finishing',
      task: 'Finish during recovery.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, finishing.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, finishing.taskId, 'running');
    const orphaned = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-recovery-after-finish',
      task: 'Still needs recovery.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, orphaned.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, orphaned.taskId, 'running');

    const report = await recovery.recoverCogSeedTasks(USER, {
      isTaskActive: async (task) => {
        if (task.taskId === finishing.taskId) {
          await lifecycle.transitionCogSeedTask(USER, finishing.taskId, 'completed');
        }
        return false;
      },
    });

    expect(report).toMatchObject({ recoveredCount: 1, taskIds: [orphaned.taskId] });
    await expect(tasks.readCogSeedTask(USER, finishing.taskId)).resolves.toMatchObject({ status: 'completed' });
    await expect(tasks.readCogSeedTask(USER, orphaned.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    const finishingEvents = await events.readCogSeedTaskEvents(USER, finishing.taskId, 0, 20);
    expect(finishingEvents.some((event) => event.type === 'task.recoverable')).toBe(false);
  });
});
