import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-event-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-event-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupTask() {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  return tasks.createCogSeedTask(USER, { requestId: 'req-event-store', task: 'Track events.' });
}

describe('CogSeed task event store', () => {
  it('appends monotonic events and replays only records after a sequence', async () => {
    const task = (await setupTask()).task;
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const [first, second, third] = await Promise.all([
      events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.queued', { source: 'test' }),
      events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.started', {}),
      events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'model.delta', { text: 'hi' }),
    ]);

    expect([first.sequence, second.sequence, third.sequence].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 2, 10)).resolves.toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 4 }),
    ]);
  });

  it('rejects malformed stored JSONL instead of silently omitting it', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.cogseedTaskEventsFile(USER, task.taskId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json}\n', 'utf8');

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).rejects.toThrow(/malformed CogSeed event/i);
  });

  it('rejects a persisted event type outside the protocol schema', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.cogseedTaskEventsFile(USER, task.taskId);
    const [created] = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    created.type = 'task.paused';
    fs.writeFileSync(file, `${JSON.stringify(created)}\n`, 'utf8');

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).rejects.toThrow(/malformed CogSeed event/i);
  });

  it('truncates only an unterminated crash tail and continues the event sequence', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.cogseedTaskEventsFile(USER, task.taskId);
    fs.appendFileSync(file, '{"schemaVersion":1,"eventId":"cogseed-event-interrupted"', 'utf8');

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created', sequence: 1 }),
    ]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cogseed-event-interrupted');

    await expect(events.appendCogSeedTaskEvent(
      USER,
      task.taskId,
      task.sessionId,
      'task.queued',
      {},
    )).resolves.toMatchObject({ sequence: 2 });
  });

  it('preserves a complete final event whose trailing newline was interrupted', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.cogseedTaskEventsFile(USER, task.taskId);
    await events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.queued', {});
    const stored = fs.readFileSync(file);
    fs.writeFileSync(file, stored.subarray(0, stored.length - 1));

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created', sequence: 1 }),
      expect.objectContaining({ type: 'task.queued', sequence: 2 }),
    ]);
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    await expect(events.appendCogSeedTaskEvent(
      USER,
      task.taskId,
      task.sessionId,
      'task.started',
      {},
    )).resolves.toMatchObject({ sequence: 3 });
  });

  it('does not discard malformed rows in the middle of an event stream', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.cogseedTaskEventsFile(USER, task.taskId);
    await events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.queued', {});
    const [created, queued] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(file, `${created}\n{not-json}\n${queued}\n`, 'utf8');

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).rejects.toThrow(/line 2/i);
    expect(fs.readFileSync(file, 'utf8')).toContain('{not-json}\n');
  });

  it('publishes user-isolated Dashboard invalidations without event payload data', async () => {
    const task = (await setupTask()).task;
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const received: unknown[] = [];
    const otherUserReceived: unknown[] = [];
    const unsubscribe = events.subscribeCogSeedDashboardChanges(USER, (change) => received.push(change));
    const unsubscribeOther = events.subscribeCogSeedDashboardChanges('cogseed-event-other', (change) => otherUserReceived.push(change));

    await events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'tool.started', {
      toolName: 'read_file',
      secret: 'must-not-cross-dashboard-stream',
    });

    expect(received).toEqual([{
      schemaVersion: 1,
      revision: expect.any(Number),
      changeKind: 'task',
      taskId: task.taskId,
      sessionId: task.sessionId,
      occurredAt: expect.any(String),
      domains: ['tasks', 'sessions', 'agents', 'collaboration'],
    }]);
    expect(JSON.stringify(received)).not.toContain('secret');
    expect(JSON.stringify(received)).not.toContain('read_file');
    expect(otherUserReceived).toEqual([]);

    unsubscribe();
    unsubscribeOther();
    await events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.completed', {});
    expect(received).toHaveLength(1);
  });

  it('isolates a failing Dashboard subscriber from durable event persistence', async () => {
    const task = (await setupTask()).task;
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const healthyListener = vi.fn();
    const unsubscribeBroken = events.subscribeCogSeedDashboardChanges(USER, () => { throw new Error('renderer listener failed'); });
    const unsubscribeHealthy = events.subscribeCogSeedDashboardChanges(USER, healthyListener);

    await expect(events.appendCogSeedTaskEvent(USER, task.taskId, task.sessionId, 'task.queued', {})).resolves.toMatchObject({
      type: 'task.queued',
    });

    await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 10)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created' }),
      expect.objectContaining({ type: 'task.queued' }),
    ]);
    expect(healthyListener).toHaveBeenCalledTimes(1);
    unsubscribeBroken();
    unsubscribeHealthy();
  });
});
