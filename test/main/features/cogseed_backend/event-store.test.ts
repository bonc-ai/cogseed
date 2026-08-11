import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-event-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-event-store-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupTask() {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  return tasks.createMateTask(USER, { requestId: 'req-event-store', task: 'Track events.' });
}

describe('Mate task event store', () => {
  it('appends monotonic events and replays only records after a sequence', async () => {
    const task = (await setupTask()).task;
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');

    const [first, second, third] = await Promise.all([
      events.appendMateTaskEvent(USER, task.taskId, task.sessionId, 'task.queued', { source: 'test' }),
      events.appendMateTaskEvent(USER, task.taskId, task.sessionId, 'task.started', {}),
      events.appendMateTaskEvent(USER, task.taskId, task.sessionId, 'model.delta', { text: 'hi' }),
    ]);

    expect([first.sequence, second.sequence, third.sequence].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    await expect(events.readMateTaskEvents(USER, task.taskId, 2, 10)).resolves.toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 4 }),
    ]);
  });

  it('rejects malformed stored JSONL instead of silently omitting it', async () => {
    const task = (await setupTask()).task;
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const file = paths.mateTaskEventsFile(USER, task.taskId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json}\n', 'utf8');

    await expect(events.readMateTaskEvents(USER, task.taskId, 0, 10)).rejects.toThrow(/malformed Mate event/i);
  });
});
