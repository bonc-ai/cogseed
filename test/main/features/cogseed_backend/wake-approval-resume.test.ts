import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A wake approval grants permission to dispatch a new execution. It must
 * never resurrect an earlier waiting task merely because the conversation
 * or agent matches: that produces a running task with no live executor. */
const USER = 'cogseed-wake-resume-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wake-resume-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function store() {
  return import('../../../../src/main/features/cogseed_backend/task-store');
}

// Approval records permission; the dispatcher owns execution and task identity.
describe('wake approval does not invent execution', () => {
  it('leaves old commander and agent tasks unchanged on repeated approval', async () => {
    const tasks = await store();
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const ids: string[] = [];
    for (const agentId of [undefined, 'agent-1']) {
      const { task } = await tasks.createCogSeedTask(USER, {
        requestId: agentId ? 'req-old-agent' : 'req-old-commander',
        task: 'Earlier turn awaiting a different answer',
        conversationId: 'conv-1', agentId,
        executionKind: 'group-chat', groupChatRunId: 'old-run',
      });
      await tasks.updateCogSeedTaskWithEvent(USER, task.taskId,
        current => ({ ...current, status: 'waiting_user' }),
        { type: 'task.waiting_user', payload: {} });
      ids.push(task.taskId);
    }
    const evaluated = await wake.evaluateWake(USER, {
      conversationId: 'conv-1', agentId: 'agent-new', agentName: 'Worker',
      source: 'hand_off_to', sourceActorId: 'commander', objective: 'New work',
      dispatchPayload: { text: 'New work' },
    });
    await wake.approveWakeRequest(USER, evaluated.request.id);
    await wake.approveWakeRequest(USER, evaluated.request.id);
    // Flush the old fire-and-forget task-store mutation as well.
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const id of ids) expect((await tasks.readCogSeedTask(USER, id))?.status).toBe('waiting_user');
  });
});
