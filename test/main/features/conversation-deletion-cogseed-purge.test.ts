// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * The CogSeed task purge is only worth anything if the real conversation
 * deletion path reaches it. A previous attempt at this cleanup was hung off a
 * function with no callers, so it never ran in production while its unit tests
 * stayed green — these drive `chats.deleteConversation()` itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TEST_UID = 'u-purge-hook';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-purge-hook-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  vi.doUnmock('../../../src/main/features/cogseed_backend/task-store');
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A Group Chat shadow task pointing at a real conversation. */
async function shadowTask(cid: string, requestId: string) {
  const tasks = await import('../../../src/main/features/cogseed_backend/task-store');
  const lifecycle = await import('../../../src/main/features/cogseed_backend/lifecycle');
  const paths = await import('../../../src/main/features/cogseed_backend/paths');
  const created = await tasks.createCogSeedTask(TEST_UID, {
    requestId,
    task: 'group chat turn',
    executionKind: 'group-chat',
    conversationId: cid,
    agentId: 'agent-reviewer',
    groupChatRunId: `gcrun-${requestId}`,
  });
  const taskId = created.task.taskId;
  await lifecycle.transitionCogSeedTask(TEST_UID, taskId, 'queued');
  await lifecycle.transitionCogSeedTask(TEST_UID, taskId, 'running');
  await lifecycle.transitionCogSeedTask(TEST_UID, taskId, 'completed');
  return {
    taskId,
    files: {
      task: paths.cogseedTaskFile(TEST_UID, taskId),
      events: paths.cogseedTaskEventsFile(TEST_UID, taskId),
      claim: paths.cogseedRequestClaimFile(TEST_UID, requestId),
    },
  };
}

describe('conversation deletion reaches the CogSeed task purge', () => {
  it('removes the shadow task through the real deleteConversation path', async () => {
    const chats = await import('../../../src/main/features/chats');
    const created = await chats.createConversation(TEST_UID, 'purge hook target');
    const cid = created.conversation_id;
    const { taskId, files } = await shadowTask(cid, 'req-hook-1');

    expect(fs.existsSync(files.task)).toBe(true);
    expect(fs.existsSync(files.events)).toBe(true);
    expect(fs.existsSync(files.claim)).toBe(true);

    expect(await chats.deleteConversation(TEST_UID, cid)).toBe(true);

    // No mocking anywhere above: if the purge were hung off an uncalled
    // function these would all still exist.
    expect(fs.existsSync(files.task)).toBe(false);
    expect(fs.existsSync(files.events)).toBe(false);
    expect(fs.existsSync(files.claim)).toBe(false);
    const tasks = await import('../../../src/main/features/cogseed_backend/task-store');
    expect(await tasks.readCogSeedTask(TEST_UID, taskId)).toBeNull();
  });

  it('leaves another conversation untouched when one is deleted', async () => {
    const chats = await import('../../../src/main/features/chats');
    const doomed = (await chats.createConversation(TEST_UID, 'doomed')).conversation_id;
    const kept = (await chats.createConversation(TEST_UID, 'kept')).conversation_id;
    const doomedTask = await shadowTask(doomed, 'req-hook-2');
    const keptTask = await shadowTask(kept, 'req-hook-3');

    expect(await chats.deleteConversation(TEST_UID, doomed)).toBe(true);

    expect(fs.existsSync(doomedTask.files.task)).toBe(false);
    expect(fs.existsSync(keptTask.files.task)).toBe(true);
    expect(fs.existsSync(keptTask.files.events)).toBe(true);
    expect(fs.existsSync(keptTask.files.claim)).toBe(true);
  });

  it('still deletes the conversation when the purge throws', async () => {
    let attempted = 0;
    vi.doMock('../../../src/main/features/cogseed_backend/task-store', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/main/features/cogseed_backend/task-store')>();
      return {
        ...actual,
        purgeCogSeedGroupChatTasksByConversation: async () => {
          attempted += 1;
          throw new Error('purge blew up');
        },
      };
    });

    const chats = await import('../../../src/main/features/chats');
    const cid = (await chats.createConversation(TEST_UID, 'purge throws')).conversation_id;
    await shadowTask(cid, 'req-hook-4');

    // best-effort: the failure is swallowed and logged, the deletion still
    // reports success and the conversation is gone from the index.
    expect(await chats.deleteConversation(TEST_UID, cid)).toBe(true);
    expect(attempted).toBe(1);
    expect(await chats.getConversation(TEST_UID, cid)).toBeFalsy();
  });
});
