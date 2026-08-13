import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const USER = 'interactive-turn-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-interactive-turn-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed interactive follow-up admission', () => {
  it('creates continuation requests in the same Agent session without replaying the handoff task', async () => {
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const { startMateInteractiveFollowup } = await import('../../../../src/main/features/cogseed_backend/interactive-turn');
    const startMateTask = vi.fn(async (userId: string, input: any) => (
      await taskStore.createMateTask(userId, input)
    ).task);
    const runtimeController = { startMateTask } as any;
    const resolveExecutionContext = vi.fn(async () => ({
      agentId: 'agent-interactive',
      agentName: 'Interactive Agent',
      workflow: 'Continue the current user interaction.',
      skillList: [],
      interactive: true as const,
      runtime: { kind: 'in_process' as const },
      knowhow: [],
      standards: [],
    }));

    const handoff = await taskStore.createMateTask(USER, {
      requestId: 'req-original-handoff',
      task: 'Original handoff task that must not be replayed.',
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
    });
    const first = await startMateInteractiveFollowup(USER, {
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
      requestId: 'req-followup-one',
      task: 'First follow-up only.',
      visibleContext: 'Prior visible context.',
    }, { runtimeController, resolveExecutionContext });
    const second = await startMateInteractiveFollowup(USER, {
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
      requestId: 'req-followup-two',
      task: 'Second follow-up only.',
    }, { runtimeController, resolveExecutionContext });

    expect(first.sessionId).toBe(handoff.task.sessionId);
    expect(second.sessionId).toBe(handoff.task.sessionId);
    expect(startMateTask).toHaveBeenNthCalledWith(1, USER, expect.objectContaining({
      requestId: 'req-followup-one',
      task: 'First follow-up only.',
      sessionId: handoff.task.sessionId,
      parentTaskId: handoff.task.taskId,
    }));
    expect(startMateTask).toHaveBeenNthCalledWith(2, USER, expect.objectContaining({
      requestId: 'req-followup-two',
      task: 'Second follow-up only.',
      sessionId: handoff.task.sessionId,
      parentTaskId: first.taskId,
    }));
    expect(startMateTask.mock.calls.flatMap((call) => [call[1].task])).not.toContain(handoff.task.task);
  });
});
