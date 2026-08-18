import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-lifecycle-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-lifecycle-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTask() {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  return tasks.createMateTask(USER, { requestId: 'req-lifecycle', task: 'Run lifecycle.' });
}

describe('CogSeed task lifecycle', () => {
  it('allows only legal state transitions and appends matching lifecycle events', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const queued = await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    const running = await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    const completed = await lifecycle.transitionMateTask(USER, created.taskId, 'completed');

    expect([queued.status, running.status, completed.status]).toEqual(['queued', 'running', 'completed']);
    await expect(lifecycle.transitionMateTask(USER, created.taskId, 'running')).rejects.toThrow(/terminal|transition/i);
    await expect(events.readMateTaskEvents(USER, created.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created', sequence: 1 }),
      expect.objectContaining({ type: 'task.queued', sequence: 2 }),
      expect.objectContaining({ type: 'task.started', sequence: 3 }),
      expect.objectContaining({ type: 'task.completed', sequence: 4 }),
    ]);
  });

  it('makes repeated start idempotent, supports cancellation, recoverability, and explicit retry', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');

    await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    const firstStart = await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    const duplicateStart = await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    expect(duplicateStart).toEqual(firstStart);

    const recoverable = await lifecycle.markMateTaskRecoverable(USER, created.taskId, 'worker_exit');
    expect(recoverable.status).toBe('recoverable');
    const retried = await lifecycle.retryMateTask(USER, created.taskId, 'req-lifecycle-retry');
    expect(retried).toMatchObject({ status: 'created', retryOfTaskId: created.taskId, requestId: 'req-lifecycle-retry' });

    await lifecycle.transitionMateTask(USER, retried.taskId, 'cancelled');
    await expect(lifecycle.transitionMateTask(USER, retried.taskId, 'queued')).rejects.toThrow(/terminal|transition/i);
  });

  it('keeps the original Skill version pins when retrying a task', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const versions = await import('../../../../src/main/features/skills/version-store');
    const version = await versions.appendFullSkillVersion(USER, 'skill-a', {
      operation: 'install',
      files: [{
        path: 'SKILL.md',
        content: '---\nname: skill-a\ndescription: lifecycle fixture\n---\n',
      }],
      source: { kind: 'manual_edit' },
      security: { outcome: 'pass', findingCount: 0 },
    });
    const created = (await tasks.createMateTask(USER, {
      requestId: 'req-lifecycle-pinned',
      task: 'Run with the frozen Skill.',
      allowedSkillIds: ['skill-a'],
      skillVersionPins: [{
        skillId: 'skill-a',
        version: version.version,
        revisionId: version.revisionId,
        manifestHash: version.manifestHash!,
      }],
    })).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    await lifecycle.markMateTaskRecoverable(USER, created.taskId, 'worker_exit');

    // A retry must continue to use the frozen reference even if the legacy
    // version envelope is unavailable during migration/recovery.
    fs.rmSync(versions.skillVersionsPath(USER, 'skill-a'), { force: true });

    const retried = await lifecycle.retryMateTask(USER, created.taskId, 'req-lifecycle-pinned-retry');
    expect(retried.skillVersionPins).toEqual(created.skillVersionPins);
    expect(retried.skillVersionPinStatus).toBe('pinned');
  });
});
