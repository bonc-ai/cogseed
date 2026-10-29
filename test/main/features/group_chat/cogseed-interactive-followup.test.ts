import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const USER = 'interactive-turn-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-interactive-turn-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed interactive follow-up admission', () => {
  it('creates continuation requests in the same Agent session without replaying the handoff task', async () => {
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const { startCogSeedInteractiveFollowup } = await import('../../../../src/main/features/cogseed_backend/interactive-turn');
    const startCogSeedTask = vi.fn(async (userId: string, input: any) => (
      await taskStore.createCogSeedTask(userId, input)
    ).task);
    const runtimeController = { startCogSeedTask } as any;
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

    const handoff = await taskStore.createCogSeedTask(USER, {
      requestId: 'req-original-handoff',
      task: 'Original handoff task that must not be replayed.',
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
    });
    const first = await startCogSeedInteractiveFollowup(USER, {
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
      requestId: 'req-followup-one',
      task: 'First follow-up only.',
      visibleContext: 'Prior visible context.',
    }, { runtimeController, resolveExecutionContext });
    const second = await startCogSeedInteractiveFollowup(USER, {
      conversationId: 'cid-interactive-turn',
      agentId: 'agent-interactive',
      requestId: 'req-followup-two',
      task: 'Second follow-up only.',
    }, { runtimeController, resolveExecutionContext });

    expect(first.sessionId).toBe(handoff.task.sessionId);
    expect(second.sessionId).toBe(handoff.task.sessionId);
    expect(startCogSeedTask).toHaveBeenNthCalledWith(1, USER, expect.objectContaining({
      requestId: 'req-followup-one',
      task: 'First follow-up only.',
      sessionId: handoff.task.sessionId,
      parentTaskId: handoff.task.taskId,
    }));
    expect(startCogSeedTask).toHaveBeenNthCalledWith(2, USER, expect.objectContaining({
      requestId: 'req-followup-two',
      task: 'Second follow-up only.',
      sessionId: handoff.task.sessionId,
      parentTaskId: first.taskId,
    }));
    expect(startCogSeedTask.mock.calls.flatMap((call) => [call[1].task])).not.toContain(handoff.task.task);
  });
  it('refuses a Group Chat-owned task and asks the caller to dispatch there', async () => {
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const { startCogSeedInteractiveFollowup } = await import('../../../../src/main/features/cogseed_backend/interactive-turn');
    const groupTask = await taskStore.createCogSeedTask(USER, {
      requestId: 'req-group-chat-form',
      task: 'Ask the user for the preflight directory.',
      conversationId: 'cid-group-chat-form',
      agentId: 'agent-group-chat',
      executionKind: 'group-chat',
      groupChatRunId: 'run-group-chat-form',
      groupChatTurnId: 'turn-group-chat-form',
      groupChatSourceMessageId: 'msg-group-chat-form',
    });
    const startCogSeedTask = vi.fn();
    const resolveExecutionContext = vi.fn();

    await expect(startCogSeedInteractiveFollowup(USER, {
      conversationId: 'cid-group-chat-form',
      agentId: 'agent-group-chat',
      requestId: 'req-followup-group-chat',
      task: '待检查目录：/tmp/package',
    }, { runtimeController: { startCogSeedTask } as any, resolveExecutionContext }))
      .rejects.toMatchObject({
        code: 'cogseed_followup_not_runtime_owned',
        reason: 'group-chat-owned',
        taskId: groupTask.task.taskId,
      });

    // The refusal happens before any executor is touched: no new task, no
    // context resolution, so the caller can safely fall back to Group Chat.
    expect(startCogSeedTask).not.toHaveBeenCalled();
    expect(resolveExecutionContext).not.toHaveBeenCalled();
  });

  it('resumes a runtime-owned task that is waiting for user input', async () => {
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const { startCogSeedInteractiveFollowup } = await import('../../../../src/main/features/cogseed_backend/interactive-turn');
    const created = await taskStore.createCogSeedTask(USER, {
      requestId: 'req-native-question',
      task: 'Ask the user for the delivery date.',
      conversationId: 'cid-native-question',
      agentId: 'agent-native-question',
    });
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'waiting_user');
    const resumed = { ...created.task, status: 'queued' };
    const resumeCogSeedTask = vi.fn(async () => resumed);
    const startCogSeedTask = vi.fn();

    const result = await startCogSeedInteractiveFollowup(USER, {
      conversationId: 'cid-native-question',
      agentId: 'agent-native-question',
      requestId: 'req-followup-native',
      task: '周五之前。',
    }, {
      runtimeController: { startCogSeedTask, resumeCogSeedTask } as any,
      resolveExecutionContext: async () => ({
        agentId: 'agent-native-question',
        agentName: 'Native Question Agent',
        workflow: 'Continue the open question.',
        skillList: [],
        interactive: true as const,
        runtime: { kind: 'in_process' as const },
        knowhow: [],
        standards: [],
      }),
    });

    expect(resumeCogSeedTask).toHaveBeenCalledWith(USER, created.task.taskId, expect.objectContaining({
      requestId: 'req-followup-native',
      continuation: '周五之前。',
    }));
    expect(startCogSeedTask).not.toHaveBeenCalled();
    expect(result).toBe(resumed);
  });

  it('translates a late Runtime admission refusal into the same dispatch signal', async () => {
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const { startCogSeedInteractiveFollowup } = await import('../../../../src/main/features/cogseed_backend/interactive-turn');
    const { CogSeedGroupChatTaskAdmissionError } = await import('../../../../src/main/features/cogseed_backend/followup-errors');
    const created = await taskStore.createCogSeedTask(USER, {
      requestId: 'req-native-race',
      task: 'Ask the user for the date.',
      conversationId: 'cid-native-race',
      agentId: 'agent-native-race',
    });
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'waiting_user');

    await expect(startCogSeedInteractiveFollowup(USER, {
      conversationId: 'cid-native-race',
      agentId: 'agent-native-race',
      requestId: 'req-followup-race',
      task: '下周一。',
    }, {
      runtimeController: {
        startCogSeedTask: vi.fn(),
        resumeCogSeedTask: async () => { throw new CogSeedGroupChatTaskAdmissionError(created.task.taskId); },
      } as any,
      resolveExecutionContext: async () => ({
        agentId: 'agent-native-race',
        agentName: 'Race Agent',
        workflow: 'Continue.',
        skillList: [],
        interactive: true as const,
        runtime: { kind: 'in_process' as const },
        knowhow: [],
        standards: [],
      }),
    })).rejects.toMatchObject({
      code: 'cogseed_followup_not_runtime_owned',
      taskId: created.task.taskId,
    });
  });
});
