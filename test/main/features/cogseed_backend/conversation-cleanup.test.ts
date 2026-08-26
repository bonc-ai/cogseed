// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-14 — cascade cleanup of the CogSeed shadow ledger when a conversation
// is deleted. Real filesystem, real store; nothing is mocked to a function name.
//
// Two things named "orphan" must not be confused here:
//   RC-P2-20  the parent record is missing but the child task still exists
//             → the UI must NOT swallow it.
//   RC-P1-14  the conversation was explicitly deleted
//             → its group-chat shadow records SHOULD be removed.
//
// And the scope boundary is load-bearing: `interactive-turn.ts` creates
// `local-cli` / `cogseed-native` tasks carrying the *same* `conversationId`.
// Those are independent agent-run history and must survive untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-cleanup-user';
const CONVERSATION_A = 'conv-aaaaaaaa1111';
const CONVERSATION_B = 'conv-bbbbbbbb2222';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cleanup-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const store = () => import('../../../../src/main/features/cogseed_backend/task-store');
const backendPaths = () => import('../../../../src/main/features/cogseed_backend/paths');
const events = () => import('../../../../src/main/features/cogseed_backend/event-store');

interface Made { taskId: string; requestId: string }

/** Create a real task, then give it a real events file. */
async function makeTask(input: {
  requestId: string;
  conversationId?: string;
  executionKind?: 'group-chat' | 'local-cli' | 'cogseed-native';
  parentTaskId?: string;
}): Promise<Made> {
  const { createCogSeedTask } = await store();
  const { appendCogSeedTaskEvent } = await events();
  const result = await createCogSeedTask(USER, {
    requestId: input.requestId,
    task: 'work',
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.executionKind ? { executionKind: input.executionKind } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    // The store requires these for the kinds that declare them, so the
    // fixtures match what the real writers produce.
    ...(input.executionKind === 'group-chat' ? { groupChatRunId: `gcrun-${input.requestId}` } : {}),
    ...(input.executionKind === 'local-cli' ? { localCli: { cli: 'claude' } } : {}),
  } as never);
  await appendCogSeedTaskEvent(USER, result.task.taskId, result.task.sessionId, 'task.started', {});
  return { taskId: result.task.taskId, requestId: input.requestId };
}

async function filesFor(made: Made) {
  const p = await backendPaths();
  return {
    task: p.cogseedTaskFile(USER, made.taskId),
    events: p.cogseedTaskEventsFile(USER, made.taskId),
    claim: p.cogseedRequestClaimFile(USER, made.requestId),
  };
}

async function allExist(made: Made): Promise<boolean> {
  const f = await filesFor(made);
  return fs.existsSync(f.task) && fs.existsSync(f.events) && fs.existsSync(f.claim);
}

async function noneExist(made: Made): Promise<boolean> {
  const f = await filesFor(made);
  return !fs.existsSync(f.task) && !fs.existsSync(f.events) && !fs.existsSync(f.claim);
}

describe('RC-P1-14 Case 1 — a deleted conversation takes its whole run with it', () => {
  it('removes task JSON, events JSONL and request claim for parent and children alike', async () => {
    const parent = await makeTask({ requestId: 'req-a-parent', conversationId: CONVERSATION_A, executionKind: 'group-chat' });
    const child1 = await makeTask({ requestId: 'req-a-child-1', conversationId: CONVERSATION_A, executionKind: 'group-chat', parentTaskId: parent.taskId });
    const child2 = await makeTask({ requestId: 'req-a-child-2', conversationId: CONVERSATION_A, executionKind: 'group-chat', parentTaskId: parent.taskId });

    for (const made of [parent, child1, child2]) expect(await allExist(made)).toBe(true);

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    const result = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(result.purgedTaskIds.sort()).toEqual([parent.taskId, child1.taskId, child2.taskId].sort());
    expect(result.failedTaskIds).toEqual([]);
    for (const made of [parent, child1, child2]) expect(await noneExist(made)).toBe(true);
  });
});

describe('RC-P1-14 Case 2 — another conversation is untouched', () => {
  it('leaves every record of the conversation that was not deleted', async () => {
    const keep = await makeTask({ requestId: 'req-b-parent', conversationId: CONVERSATION_B, executionKind: 'group-chat' });
    const keepChild = await makeTask({ requestId: 'req-b-child', conversationId: CONVERSATION_B, executionKind: 'group-chat', parentTaskId: keep.taskId });
    const drop = await makeTask({ requestId: 'req-a-parent', conversationId: CONVERSATION_A, executionKind: 'group-chat' });

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(await allExist(keep)).toBe(true);
    expect(await allExist(keepChild)).toBe(true);
    expect(await noneExist(drop)).toBe(true);
  });
});

describe('RC-P1-14 Case 3 — non-group-chat records are never deleted', () => {
  it.each(['local-cli', 'cogseed-native'] as const)(
    'keeps a %s task that shares the deleted conversation id',
    async (executionKind) => {
      // This is the real shape `interactive-turn.ts` writes.
      const native = await makeTask({ requestId: `req-native-${executionKind}`, conversationId: CONVERSATION_A, executionKind });
      const shadow = await makeTask({ requestId: 'req-a-shadow', conversationId: CONVERSATION_A, executionKind: 'group-chat' });

      const { purgeCogSeedGroupChatTasksByConversation } = await store();
      const result = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

      expect(result.purgedTaskIds).toEqual([shadow.taskId]);
      expect(await allExist(native)).toBe(true);
    },
  );

  it('keeps a group-chat task belonging to a different conversation', async () => {
    const other = await makeTask({ requestId: 'req-b-only', conversationId: CONVERSATION_B, executionKind: 'group-chat' });

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(await allExist(other)).toBe(true);
  });

  it('keeps a task with no conversation at all', async () => {
    const detached = await makeTask({ requestId: 'req-detached' });

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(await allExist(detached)).toBe(true);
  });
});

describe('RC-P1-14 Case 5 — a child whose parent is already gone', () => {
  it('cleans it on its own conversationId, without walking the tree', async () => {
    // RC-P2-20's shape: the parent record no longer exists. Membership must be
    // decided per record — a tree walk would miss exactly this one.
    const child = await makeTask({
      requestId: 'req-a-lonely-child',
      conversationId: CONVERSATION_A,
      executionKind: 'group-chat',
      parentTaskId: 'cogseed-task-longgone',
    });

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    const result = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(result.purgedTaskIds).toEqual([child.taskId]);
    expect(await noneExist(child)).toBe(true);
  });
});

describe('RC-P1-14 Case 7 — idempotent', () => {
  it('is safe to run twice and reports nothing the second time', async () => {
    const made = await makeTask({ requestId: 'req-a-once', conversationId: CONVERSATION_A, executionKind: 'group-chat' });
    const { purgeCogSeedGroupChatTasksByConversation } = await store();

    const first = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);
    const second = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    expect(first.purgedTaskIds).toEqual([made.taskId]);
    expect(second).toEqual({ purgedTaskIds: [], failedTaskIds: [] });
  });

  it('does not fail on a conversation that never had any task', async () => {
    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    await expect(purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_B))
      .resolves.toEqual({ purgedTaskIds: [], failedTaskIds: [] });
  });
});

describe('RC-P1-14 Case 8 — the claim dies with its task', () => {
  it('leaves no claim that would later throw "references a missing task"', async () => {
    const made = await makeTask({ requestId: 'req-a-claim', conversationId: CONVERSATION_A, executionKind: 'group-chat' });
    const { purgeCogSeedGroupChatTasksByConversation, readCogSeedTaskByRequestId, createCogSeedTask } = await store();

    await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    // A dangling claim makes both of these throw; both must be clean.
    await expect(readCogSeedTaskByRequestId(USER, 'req-a-claim')).resolves.toBeNull();
    await expect(createCogSeedTask(USER, { requestId: 'req-a-claim', task: 'a fresh run' } as never))
      .resolves.toMatchObject({ created: true });
  });
});

describe('RC-P1-14 — the purge reports rather than throws', () => {
  it('returns a result even when the task directory does not exist yet', async () => {
    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    await expect(purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A))
      .resolves.toEqual({ purgedTaskIds: [], failedTaskIds: [] });
  });

  it('reports an unreadable record instead of deleting it blind', async () => {
    const made = await makeTask({ requestId: 'req-a-corrupt', conversationId: CONVERSATION_A, executionKind: 'group-chat' });
    const files = await filesFor(made);
    fs.writeFileSync(files.task, '{ not json');

    const { purgeCogSeedGroupChatTasksByConversation } = await store();
    const result = await purgeCogSeedGroupChatTasksByConversation(USER, CONVERSATION_A);

    // We cannot prove it matched, so we do not remove it.
    expect(result.purgedTaskIds).toEqual([]);
    expect(result.failedTaskIds).toEqual([made.taskId]);
    expect(fs.existsSync(files.task)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Case 4 — decision (c): the native task's data survives, its dead exit does
// not. Asserted against real projection objects, not by reading the source.
// ─────────────────────────────────────────────────────────────────────────

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

function record(overrides: Partial<CogSeedTaskRecord> & { taskId: string }): CogSeedTaskRecord {
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    sessionId: 'cogseed-session-1',
    requestId: `req-${overrides.taskId}`,
    ownerId: USER,
    status: 'completed',
    task: 'work',
    conversationId: CONVERSATION_A,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  } as CogSeedTaskRecord;
}

/** `isConversationAvailable` answers false for A — i.e. A has been deleted. */
function serviceWithDeletedConversationA(records: CogSeedTaskRecord[]) {
  const sessionRecord = {
    schemaVersion: 1,
    sessionId: 'cogseed-session-1',
    ownerId: USER,
    conversationId: CONVERSATION_A,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
  return createCogSeedIpcService({
    listTasks: async () => records,
    listSessions: async () => [sessionRecord] as never,
    readSession: async () => sessionRecord as never,
    readTask: async (_u: string, taskId: string) => records.find((r) => r.taskId === taskId) ?? null,
    readEvents: async () => [],
    isConversationAvailable: async (_u: string, conversationId: string) => conversationId !== CONVERSATION_A,
  } as never);
}

describe('RC-P1-14 Case 4 — decision (c) in the projection', () => {
  const NATIVE = record({ taskId: 'cogseed-task-native', executionKind: 'cogseed-native', agentId: 'planner' });
  const SHADOW = record({ taskId: 'cogseed-task-shadow', executionKind: 'group-chat' });

  it('still lists the native task — its history is not thrown away', async () => {
    const board = await serviceWithDeletedConversationA([NATIVE, SHADOW]).boardProjection(USER);

    // c2, not c1: the record we deliberately kept on disk stays reachable.
    expect(board.tasks.map((t) => t.taskId)).toEqual(['cogseed-task-native']);
    expect(board.tasks[0].agentId).toBe('planner');
    expect(board.tasks[0].status).toBe('completed');
  });

  it('offers no conversation exit for it, and says why', async () => {
    const board = await serviceWithDeletedConversationA([NATIVE]).boardProjection(USER);
    const task = board.tasks[0];

    expect(task).not.toHaveProperty('conversationId');
    expect(task.conversationUnavailable).toBe(true);
    // The short id is derived from conversationId, so it goes too.
    expect(task).not.toHaveProperty('conversationShortId');
  });

  it('does not resurrect the exit through the session fallback', async () => {
    // boardProjection falls back to the session's conversationId when the task
    // has none — which would hand back exactly the exit we just removed.
    const board = await serviceWithDeletedConversationA([NATIVE]).boardProjection(USER);

    expect(JSON.stringify(board)).not.toContain(CONVERSATION_A);
  });

  it('drops the group-chat shadow task instead — it has no meaning without its conversation', async () => {
    const board = await serviceWithDeletedConversationA([SHADOW]).boardProjection(USER);
    expect(board.tasks).toEqual([]);
  });

  it('leaves tasks of a live conversation completely alone', async () => {
    const live = record({ taskId: 'cogseed-task-live', executionKind: 'cogseed-native', conversationId: CONVERSATION_B });
    const board = await serviceWithDeletedConversationA([live]).boardProjection(USER);

    expect(board.tasks[0].conversationId).toBe(CONVERSATION_B);
    expect(board.tasks[0]).not.toHaveProperty('conversationUnavailable');
  });

  it('carries the same verdict into the session detail', async () => {
    const snapshot = await serviceWithDeletedConversationA([NATIVE])
      .collaborationSnapshot(USER, { taskId: 'cogseed-task-native' });

    expect(snapshot.task?.conversationUnavailable).toBe(true);
    expect(snapshot.task).not.toHaveProperty('conversationId');
  });
});

// The session-level gate has three distinct cases and they are easy to
// conflate — a first attempt at decision (c) collapsed them into
// "no visible tasks → null" and silently broke the empty-session contract
// (caught by `renderer-projection.test.ts`). All three are pinned here.
describe('RC-P1-14 — sessionProjection gate', () => {
  const nativeSurvivor = record({ taskId: 'cogseed-task-native', executionKind: 'cogseed-native', agentId: 'planner' });
  const shadowOnly = record({ taskId: 'cogseed-task-shadow', executionKind: 'group-chat' });

  it('still projects a session that simply has no tasks yet', async () => {
    // Live conversation, empty session: the summary must survive.
    const service = createCogSeedIpcService({
      listTasks: async () => [],
      listSessions: async () => [] as never,
      readSession: async () => ({
        schemaVersion: 1, sessionId: 'cogseed-session-1', ownerId: USER,
        conversationId: CONVERSATION_B,
        createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
      }) as never,
      readTask: async () => null,
      readEvents: async () => [],
      isConversationAvailable: async () => true,
    } as never);

    const projected = await service.sessionProjection(USER, { sessionId: 'cogseed-session-1' });

    expect(projected.session).toMatchObject({ sessionId: 'cogseed-session-1', taskCount: 0 });
    expect(projected.collaboration).toBeNull();
  });

  it('hides a session whose only records were group-chat shadows', async () => {
    const projected = await serviceWithDeletedConversationA([shadowOnly])
      .sessionProjection(USER, { sessionId: 'cogseed-session-1' });

    expect(projected).toEqual({ session: null, collaboration: null });
  });

  it('keeps the session reachable when a native task survived the deletion', async () => {
    const projected = await serviceWithDeletedConversationA([nativeSurvivor])
      .sessionProjection(USER, { taskId: 'cogseed-task-native' });

    expect(projected.session).not.toBeNull();
    expect(projected.collaboration?.task?.taskId).toBe('cogseed-task-native');
    expect(projected.collaboration?.task).not.toHaveProperty('conversationId');
    expect(projected.collaboration?.task?.conversationUnavailable).toBe(true);
  });
});
