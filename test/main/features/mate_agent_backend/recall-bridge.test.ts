import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-recall-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-recall-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Mate Recall execution bridge', () => {
  it('records terminal Mate task facts into execution records without prompts or task mutation', async () => {
    const tasks = await import('../../../../src/main/features/mate_agent_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/mate_agent_backend/lifecycle');
    const bridge = await import('../../../../src/main/features/mate_agent_backend/recall-bridge');
    const executionRecords = await import('../../../../src/main/features/mate_agent_backend/mate-execution-store');

    const created = (await tasks.createMateTask(USER, {
      requestId: 'req-recall',
      task: 'SECRET prompt text must not be copied to execution records',
    })).task;
    await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    await lifecycle.transitionMateTask(USER, created.taskId, 'completed', { outputChars: 9 });

    const latestTask = await tasks.readMateTask(USER, created.taskId);
    const fact = await bridge.recordMateTaskRunForRecall(USER, created.taskId);
    const record = await executionRecords.read(USER, fact.executionId);
    const events = await executionRecords.readEvents(USER, fact.executionId);

    expect(latestTask).toEqual(await tasks.readMateTask(USER, created.taskId));
    expect(fact).toMatchObject({ taskId: created.taskId, sessionId: created.sessionId, status: 'completed' });
    expect(record).toMatchObject({
      executionId: fact.executionId,
      kind: 'mate-agent',
      sessionId: created.sessionId,
      status: 'completed',
      boundary: 'real',
    });
    expect(JSON.stringify(record)).not.toContain('SECRET prompt text');
    expect(JSON.stringify(events)).not.toContain('SECRET prompt text');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'mate.task', payload: expect.objectContaining({ taskId: created.taskId, runtimeSessionId: created.runtimeSessionId }) }),
      expect.objectContaining({ type: 'terminal', payload: expect.objectContaining({ status: 'completed' }) }),
    ]));
  });
});
