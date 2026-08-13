import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'mate-store-user-a';
const USER_B = 'mate-store-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-task-store-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function backend() {
  return import('../../../../src/main/features/cogseed_backend/task-store');
}

async function backendPaths() {
  return import('../../../../src/main/features/cogseed_backend/paths');
}

describe('CogSeed task and session store', () => {
  it('creates a CogSeed-owned cloud task/session mapping and reads it from the owner root', async () => {
    const store = await backend();
    const paths = await backendPaths();

    const result = await store.createMateTask(USER_A, {
      requestId: 'req-store-a',
      task: 'Summarize the selected file.',
      profileId: 'openai-compatible:mate',
    });

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({
      ownerId: USER_A,
      executionId: expect.stringMatching(/^mate-exec-/),
      requestId: 'req-store-a',
      task: 'Summarize the selected file.',
      profileId: 'openai-compatible:mate',
      status: 'created',
    });
    expect(result.task.taskId).toMatch(/^mate-task-/);
    expect(result.task.sessionId).toMatch(/^mate-session-/);
    expect(result.task.runtimeSessionId).toMatch(/^mruntime-/);
    expect(paths.mateTaskFile(USER_A, result.task.taskId)).toBe(
      path.join(tmpDir, USER_A, 'cloud', 'mate_agent', 'tasks', `${result.task.taskId}.json`),
    );
    await expect(store.readMateTask(USER_A, result.task.taskId)).resolves.toEqual(result.task);
    await expect(store.readMateTask(USER_B, result.task.taskId)).resolves.toBeNull();
    const events = await import("../../../../src/main/features/cogseed_backend/event-store");
    await expect(events.readMateTaskEvents(USER_A, result.task.taskId, 0, 10)).resolves.toEqual([expect.objectContaining({ type: "task.created", sequence: 1, payload: { requestId: "req-store-a" } })]);
  });

  it('claims each request exactly once and returns the existing task on repeat start', async () => {
    const store = await backend();

    const [first, second] = await Promise.all([
      store.createMateTask(USER_A, { requestId: 'req-idempotent', task: 'First payload.' }),
      store.createMateTask(USER_A, { requestId: 'req-idempotent', task: 'Second payload must not run.' }),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.task.taskId).toBe(second.task.taskId);
    expect(first.task.task).toBe(second.task.task);
  });

  it('persists formal Agent identity and maps a commander conversation alias to the durable member session', async () => {
    const store = await backend();
    const created = await store.createMateTask(USER_A, {
      requestId: 'req-formal-agent',
      task: 'Run the formal Agent.',
      sessionId: 'gconv-cid-formal',
      agentId: 'agent-formal',
    });

    expect(created.task).toMatchObject({
      sessionId: expect.stringMatching(/^mate-session-/),
      conversationId: 'cid-formal',
      agentId: 'agent-formal',
    });
    await expect(store.readMateSession(USER_A, created.task.sessionId)).resolves.toMatchObject({
      sessionKind: 'member',
      actorId: 'agent-formal',
      agentId: 'agent-formal',
      conversationId: 'cid-formal',
    });
  });

  it('reuses only a valid owner session mapping and rejects unsafe IDs before constructing paths', async () => {
    const store = await backend();
    const paths = await backendPaths();

    const session = await store.getOrCreateMateSession(USER_A);
    const reused = await store.getOrCreateMateSession(USER_A, session.sessionId);
    expect(reused).toEqual(session);

    await expect(store.getOrCreateMateSession(USER_B, session.sessionId)).rejects.toThrow(/session/i);
    expect(() => paths.mateTaskFile('../escape', 'mate-task-a')).toThrow(/user/i);
    expect(() => paths.mateTaskFile(USER_A, '../escape')).toThrow(/task/i);
  });
  it('lists only CogSeed sessions in the owner scope in stable order', async () => {
    const store = await backend();
    const first = await store.getOrCreateMateSession(USER_A);
    const second = await store.getOrCreateMateSession(USER_A);
    const sessions = await store.listMateSessions(USER_A);
    expect(sessions.map((row) => row.sessionId)).toEqual(expect.arrayContaining([first.sessionId, second.sessionId]));
    expect(await store.listMateSessions(USER_B)).toEqual([]);
  });

});
