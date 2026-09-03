// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * A Group Chat run that is mid-flight when the process dies comes back as
 * `recoverable`. Group Chat cannot resume such a run, and the turn never
 * reached `finishTask`, so `groupChatMessageId` is absent and retry is
 * impossible too. Without an abort that actually settles the task, the card
 * has no exit at all and sits in the attention column forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-restart-exit-user';
const CID = 'conv-restart-exit';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-restart-exit-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function orphanedGroupChatRun(requestId: string) {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
  const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
  const created = await tasks.createCogSeedTask(USER, {
    requestId,
    task: 'group chat run interrupted by a restart',
    executionKind: 'group-chat',
    conversationId: CID,
    agentId: 'agent-reviewer',
    groupChatRunId: `gcrun-${requestId}`,
  });
  const taskId = created.task.taskId;
  await lifecycle.transitionCogSeedTask(USER, taskId, 'queued');
  await lifecycle.transitionCogSeedTask(USER, taskId, 'running');
  await boot.recoverCogSeedTasksAtBoot(USER);
  return { taskId, tasks };
}

function service(ipc: typeof import('../../../../src/main/features/cogseed_backend/ipc-service'), overrides = {}) {
  return ipc.createCogSeedIpcService({
    isConversationAvailable: async () => true,
    countConversationAgents: async () => 2,
    abortGroupChat: async () => {},
    ...overrides,
  });
}

describe('Group Chat runs orphaned by an app restart', () => {
  it('offers abort as the exit and actually settles the task when it is taken', async () => {
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const { taskId, tasks } = await orphanedGroupChatRun('req-restart-exit-1');

    const orphaned = (await tasks.readCogSeedTask(USER, taskId))!;
    expect(orphaned.status).toBe('recoverable');
    // The precondition that makes retry impossible: the turn never finished.
    expect(orphaned.groupChatMessageId).toBeUndefined();

    const svc = service(ipc);
    const before = (await svc.boardProjection(USER)).tasks.find((task) => task.taskId === taskId);
    expect(before?.column).toBe('attention');
    expect(before?.actions.abort).toBe(true);

    await svc.action(USER, { taskId, action: 'abort' });

    const settled = (await tasks.readCogSeedTask(USER, taskId))!;
    expect(settled.status).toBe('cancelled');
    const after = (await svc.boardProjection(USER)).tasks.find((task) => task.taskId === taskId);
    expect(after?.column).toBe('archived');
    expect(after?.column).not.toBe('attention');
  });

  it('still delegates to Group Chat so a live turn is stopped before the task is settled', async () => {
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const { taskId } = await orphanedGroupChatRun('req-restart-exit-2');

    const delegated: string[] = [];
    const svc = service(ipc, { abortGroupChat: async (_userId: string, cid: string) => { delegated.push(cid); } });
    await svc.action(USER, { taskId, action: 'abort' });

    expect(delegated).toEqual([CID]);
  });

  it('leaves a live Group Chat run for Group Chat to terminate instead of forcing it cancelled', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');

    const created = await tasks.createCogSeedTask(USER, {
      requestId: 'req-restart-exit-3',
      task: 'live group chat run',
      executionKind: 'group-chat',
      conversationId: CID,
      agentId: 'agent-reviewer',
      groupChatRunId: 'gcrun-live',
    });
    const taskId = created.task.taskId;
    await lifecycle.transitionCogSeedTask(USER, taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, taskId, 'running');

    await service(ipc).action(USER, { taskId, action: 'abort' });

    // Group Chat owns the terminal transition for a run it is still driving.
    expect((await tasks.readCogSeedTask(USER, taskId))!.status).toBe('running');
  });

  it('records the abort as an ordinary cancellation, keeping the restart on the event log', async () => {
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const { taskId } = await orphanedGroupChatRun('req-restart-exit-6');

    await service(ipc).action(USER, { taskId, action: 'abort' });

    const log = await events.readCogSeedTaskEvents(USER, taskId);
    const types = log.map((event) => event.type);

    // The terminal event is the same one a user-initiated cancel writes, so the
    // timeline has no bespoke shape for this path.
    expect(types.at(-1)).toBe('task.cancelled');
    expect(types).not.toContain('task.failed');
    // The cancel clears `errorCode` from the record, so the event log is the
    // only place that still says the run was cut short by a restart.
    const recoverable = log.find((event) => event.type === 'task.recoverable');
    expect(recoverable?.payload).toMatchObject({ errorCode: 'worker_restart' });
  });

  it('never offers resume for a Group Chat task, in any status', async () => {
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const { taskId } = await orphanedGroupChatRun('req-restart-exit-4');
    const svc = service(ipc);

    const card = (await svc.boardProjection(USER)).tasks.find((task) => task.taskId === taskId);
    expect(card?.actions.resume).toBe(false);
    expect(card?.resumable).toBe(false);
    await expect(svc.action(USER, { taskId, action: 'resume', requestId: 'req-resume-attempt' }))
      .rejects.toThrow(/cannot be resumed/i);
  });

  it('keeps abort closed for terminal Group Chat tasks', async () => {
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const { taskId, tasks } = await orphanedGroupChatRun('req-restart-exit-5');
    const svc = service(ipc);
    await svc.action(USER, { taskId, action: 'abort' });
    expect((await tasks.readCogSeedTask(USER, taskId))!.status).toBe('cancelled');

    const card = (await svc.boardProjection(USER)).tasks.find((task) => task.taskId === taskId);
    expect(card?.actions.abort).toBe(false);
  });
});
