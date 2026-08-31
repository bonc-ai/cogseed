import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-lifecycle-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-lifecycle-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTask() {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  return tasks.createCogSeedTask(USER, { requestId: 'req-lifecycle', task: 'Run lifecycle.' });
}

describe('CogSeed task lifecycle', () => {
  it('allows only legal state transitions and appends matching lifecycle events', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const queued = await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    const running = await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    const completed = await lifecycle.transitionCogSeedTask(USER, created.taskId, 'completed');

    expect([queued.status, running.status, completed.status]).toEqual(['queued', 'running', 'completed']);
    await expect(lifecycle.transitionCogSeedTask(USER, created.taskId, 'running')).rejects.toThrow(/terminal|transition/i);
    await expect(events.readCogSeedTaskEvents(USER, created.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created', sequence: 1 }),
      expect.objectContaining({ type: 'task.queued', sequence: 2 }),
      expect.objectContaining({ type: 'task.started', sequence: 3 }),
      expect.objectContaining({ type: 'task.completed', sequence: 4 }),
    ]);
  });

  it('rolls back the task record when its matching lifecycle event cannot be persisted', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const eventFile = paths.cogseedTaskEventsFile(USER, created.taskId);
    fs.rmSync(eventFile, { force: true });
    fs.mkdirSync(eventFile, { recursive: true });

    await expect(lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued')).rejects.toThrow();

    await expect(tasks.readCogSeedTask(USER, created.taskId)).resolves.toMatchObject({ status: 'created' });
  });

  it('makes repeated start idempotent, supports cancellation, recoverability, and explicit retry', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    const firstStart = await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    const duplicateStart = await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    expect(duplicateStart).toEqual(firstStart);
    expect((await events.readCogSeedTaskEvents(USER, created.taskId, 0, 10))
      .filter((event) => event.type === 'task.started')).toHaveLength(1);

    const recoverable = await lifecycle.markCogSeedTaskRecoverable(USER, created.taskId, 'worker_exit');
    expect(recoverable.status).toBe('recoverable');
    const retried = await lifecycle.retryCogSeedTask(USER, created.taskId, 'req-lifecycle-retry');
    expect(retried).toMatchObject({ status: 'created', retryOfTaskId: created.taskId, requestId: 'req-lifecycle-retry' });

    await lifecycle.transitionCogSeedTask(USER, retried.taskId, 'cancelled');
    await expect(lifecycle.transitionCogSeedTask(USER, retried.taskId, 'queued')).rejects.toThrow(/terminal|transition/i);
  });

  it('allows a recovered execution to be explicitly cancelled', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    await lifecycle.markCogSeedTaskRecoverable(USER, created.taskId, 'worker_restart');

    await expect(lifecycle.transitionCogSeedTask(USER, created.taskId, 'cancelled')).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect((await events.readCogSeedTaskEvents(USER, created.taskId, 0, 20)).map((event) => event.type)).toEqual([
      'task.created',
      'task.queued',
      'task.started',
      'task.recoverable',
      'task.cancelled',
    ]);
  });

  it('allows only one competing outcome when completion, cancellation, and recovery race', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');

    const outcomes = await Promise.allSettled([
      lifecycle.transitionCogSeedTask(USER, created.taskId, 'completed', { outputChars: 4 }),
      lifecycle.transitionCogSeedTask(USER, created.taskId, 'cancelled'),
      lifecycle.markCogSeedTaskRecoverable(USER, created.taskId, 'worker_restart'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(2);

    const stored = await tasks.readCogSeedTask(USER, created.taskId);
    expect(stored?.status).toMatch(/^(completed|cancelled|recoverable)$/);
    const terminalEvents = (await events.readCogSeedTaskEvents(USER, created.taskId, 0, 20))
      .filter((event) => ['task.completed', 'task.cancelled', 'task.recoverable'].includes(event.type));
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe({
      completed: 'task.completed',
      cancelled: 'task.cancelled',
      recoverable: 'task.recoverable',
    }[stored!.status]);
  });

  it('atomically finalizes a retained result without fabricating a second execution lifecycle', async () => {
    const created = (await createTask()).task;
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    await lifecycle.markCogSeedTaskRecoverable(USER, created.taskId, 'worker_restart');

    const [first, duplicate] = await Promise.all([
      lifecycle.finalizeCogSeedTaskFromRetainedResult(USER, created.taskId, 'completed', { outputChars: 12 }),
      lifecycle.finalizeCogSeedTaskFromRetainedResult(USER, created.taskId, 'completed', { outputChars: 12 }),
    ]);

    expect(first).toMatchObject({ status: 'completed', resultDeliveryState: 'pending-recovery' });
    expect(duplicate).toMatchObject({ status: 'completed', resultDeliveryState: 'pending-recovery' });
    await expect(lifecycle.finalizeCogSeedTaskFromRetainedResult(USER, created.taskId, 'failed', {
      errorCode: 'late_conflict',
    })).rejects.toThrow(/conflicting/i);
    const stored = await events.readCogSeedTaskEvents(USER, created.taskId, 0, 20);
    expect(stored.map((event) => event.type)).toEqual([
      'task.created',
      'task.queued',
      'task.started',
      'task.recoverable',
      'task.completed',
    ]);
    expect(stored.filter((event) => event.type === 'task.completed')).toHaveLength(1);
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
    const created = (await tasks.createCogSeedTask(USER, {
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
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.taskId, 'running');
    await lifecycle.markCogSeedTaskRecoverable(USER, created.taskId, 'worker_exit');

    // A retry must continue to use the frozen reference even if the legacy
    // version envelope is unavailable during migration/recovery.
    fs.rmSync(versions.skillVersionsPath(USER, 'skill-a'), { force: true });

    const retried = await lifecycle.retryCogSeedTask(USER, created.taskId, 'req-lifecycle-pinned-retry');
    expect(retried.skillVersionPins).toEqual(created.skillVersionPins);
    expect(retried.skillVersionPinStatus).toBe('pinned');
  });
});
