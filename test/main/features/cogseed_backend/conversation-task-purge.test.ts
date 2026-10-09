// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Deleting a conversation used to hide its Group Chat shadow tasks without
 * removing them: the task JSON, its event log and its request claim stayed on
 * disk forever, kept being read by every dashboard scan, and the claim still
 * resolved to a task nobody could reach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-purge-user';
const CID = 'conv-purge-target';
const OTHER_CID = 'conv-purge-bystander';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-purge-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  return {
    tasks: await import('../../../../src/main/features/cogseed_backend/task-store'),
    lifecycle: await import('../../../../src/main/features/cogseed_backend/lifecycle'),
    paths: await import('../../../../src/main/features/cogseed_backend/paths'),
  };
}

async function groupChatTask(requestId: string, conversationId: string) {
  const { tasks, lifecycle } = await modules();
  const created = await tasks.createCogSeedTask(USER, {
    requestId,
    task: 'group chat turn',
    executionKind: 'group-chat',
    conversationId,
    agentId: 'agent-reviewer',
    groupChatRunId: `gcrun-${requestId}`,
  });
  const taskId = created.task.taskId;
  await lifecycle.transitionCogSeedTask(USER, taskId, 'queued');
  await lifecycle.transitionCogSeedTask(USER, taskId, 'running');
  await lifecycle.transitionCogSeedTask(USER, taskId, 'completed');
  return taskId;
}

function artifactsOf(paths: Awaited<ReturnType<typeof modules>>['paths'], taskId: string, requestId: string) {
  return {
    task: paths.cogseedTaskFile(USER, taskId),
    events: paths.cogseedTaskEventsFile(USER, taskId),
    projection: paths.cogseedTaskProjectionFile(USER, taskId),
    claim: paths.cogseedRequestClaimFile(USER, requestId),
  };
}

describe('purging CogSeed tasks for a deleted conversation', () => {
  it('removes every durable file of a matching Group Chat task', async () => {
    const { tasks, paths } = await modules();
    const taskId = await groupChatTask('req-purge-1', CID);
    const files = artifactsOf(paths, taskId, 'req-purge-1');

    expect(fs.existsSync(files.task)).toBe(true);
    expect(fs.existsSync(files.events)).toBe(true);
    expect(fs.existsSync(files.claim)).toBe(true);

    const report = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    expect(report.purgedTaskIds).toEqual([taskId]);
    expect(report.failedTaskIds).toEqual([]);
    expect(fs.existsSync(files.task)).toBe(false);
    expect(fs.existsSync(files.events)).toBe(false);
    expect(fs.existsSync(files.projection)).toBe(false);
    expect(fs.existsSync(files.claim)).toBe(false);
    expect(await tasks.readCogSeedTask(USER, taskId)).toBeNull();
    expect(await tasks.listCogSeedTasks(USER)).toEqual([]);
  });

  it('leaves the request claim resolvable for nothing rather than pointing at a missing task', async () => {
    const { tasks } = await modules();
    await groupChatTask('req-purge-2', CID);
    await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    // The dangling-claim failure mode: a claim outliving its task makes this
    // throw 'references a missing task'.
    await expect(tasks.readCogSeedTaskByRequestId(USER, 'req-purge-2')).resolves.toBeNull();
  });

  it('touches nothing that belongs to another conversation', async () => {
    const { tasks, paths } = await modules();
    const target = await groupChatTask('req-purge-3', CID);
    const bystander = await groupChatTask('req-purge-4', OTHER_CID);
    const bystanderFiles = artifactsOf(paths, bystander, 'req-purge-4');

    const report = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    expect(report.purgedTaskIds).toEqual([target]);
    expect(fs.existsSync(bystanderFiles.task)).toBe(true);
    expect(fs.existsSync(bystanderFiles.events)).toBe(true);
    expect(fs.existsSync(bystanderFiles.claim)).toBe(true);
    expect((await tasks.listCogSeedTasks(USER)).map((task) => task.taskId)).toEqual([bystander]);
  });

  it('keeps non Group Chat work that merely shares the conversation id', async () => {
    const { tasks, lifecycle, paths } = await modules();
    // A follow-up asked inside the conversation carries the same conversation
    // id but is the user's own run, not a projection of the conversation.
    const created = await tasks.createCogSeedTask(USER, {
      requestId: 'req-purge-5',
      task: 'follow-up asked inside the conversation',
      executionKind: 'cogseed-native',
      conversationId: CID,
      agentId: 'agent-reviewer',
    });
    const nativeId = created.task.taskId;
    await lifecycle.transitionCogSeedTask(USER, nativeId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, nativeId, 'running');
    await lifecycle.transitionCogSeedTask(USER, nativeId, 'completed');
    const shadow = await groupChatTask('req-purge-6', CID);

    const report = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    expect(report.purgedTaskIds).toEqual([shadow]);
    expect(fs.existsSync(paths.cogseedTaskFile(USER, nativeId))).toBe(true);
    expect(await tasks.readCogSeedTask(USER, nativeId)).toMatchObject({ taskId: nativeId });
  });

  it('retains a task whose terminal result has not been delivered', async () => {
    const { tasks, paths } = await modules();
    const taskId = await groupChatTask('req-purge-7', CID);
    await tasks.updateCogSeedTask(USER, taskId, (task) => ({ ...task, resultDeliveryState: 'pending-recovery' }));

    const report = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    expect(report.purgedTaskIds).toEqual([]);
    expect(report.retainedTaskIds).toEqual([taskId]);
    expect(fs.existsSync(paths.cogseedTaskFile(USER, taskId))).toBe(true);
  });

  it('is idempotent and safe on a conversation that never had tasks', async () => {
    const { tasks } = await modules();
    const taskId = await groupChatTask('req-purge-8', CID);

    const first = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);
    const second = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);
    const unknown = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, 'conv-never-existed');

    expect(first.purgedTaskIds).toEqual([taskId]);
    expect(second.purgedTaskIds).toEqual([]);
    expect(second.failedTaskIds).toEqual([]);
    expect(unknown).toEqual({ purgedTaskIds: [], retainedTaskIds: [], failedTaskIds: [] });
  });

  it('reports an unreadable record instead of deleting it blind', async () => {
    const { tasks, paths } = await modules();
    const taskId = await groupChatTask('req-purge-9', CID);
    const file = paths.cogseedTaskFile(USER, taskId);
    fs.writeFileSync(file, '{ not json');

    const report = await tasks.purgeCogSeedGroupChatTasksByConversation(USER, CID);

    expect(report.failedTaskIds).toEqual([taskId]);
    expect(report.purgedTaskIds).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});
