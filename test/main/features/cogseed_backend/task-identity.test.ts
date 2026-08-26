// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P0-13 — card identity.
//
// Every Group Chat turn projects with the same title ("Agent turn"), so a
// session with six turns produced six identical cards. DECISION-01 settled
// what may be used to tell them apart: candidate B — run ordinal, relative
// time, the first 8 characters of `conversationId`, `agentId`, turn ordinal.
// Candidate C (conversation title / first message) was rejected outright,
// because Group Chat titles are generated from the user's own first message
// and the Run Center deliberately carries no user-readable content.
//
// Two things therefore have to hold, and both are asserted here:
//   1. identity is *stable* — the same run is "Run 2" on every screen, which
//      is why ordinals are computed from a sort and never from an array index;
//   2. identity is *narrow* — nothing user-authored crosses the projection.

import { describe, expect, it } from 'vitest';

import {
  cogSeedTaskIdentity,
  createCogSeedIpcService,
} from '../../../../src/main/features/cogseed_backend/ipc-service';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

function task(overrides: Partial<CogSeedTaskRecord> & { taskId: string }): CogSeedTaskRecord {
  const createdAt = overrides.createdAt ?? '2026-08-26T00:00:00.000Z';
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    sessionId: 'cogseed-session-1',
    requestId: `req-${overrides.taskId}`,
    ownerId: 'u-1',
    status: 'running',
    task: 'objective text that must never be projected',
    executionKind: 'group-chat',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as CogSeedTaskRecord;
}

/**
 * Two runs, two turns each — the shape that produced six identical cards.
 * Every task carries `conversationId`, matching what the Group Chat bridge
 * actually writes (`group-chat-task-bridge.ts` sets it on both `startRun` and
 * `startTurn`).
 */
function session(): CogSeedTaskRecord[] {
  const conversationId = 'conv-abcdef123456';
  return [
    task({ taskId: 'cogseed-task-run-a', createdAt: '2026-08-26T00:00:00.000Z', conversationId }),
    task({ taskId: 'cogseed-task-run-a-turn-1', parentTaskId: 'cogseed-task-run-a', groupChatTurnId: 't1', conversationId, createdAt: '2026-08-26T00:00:10.000Z' }),
    task({ taskId: 'cogseed-task-run-a-turn-2', parentTaskId: 'cogseed-task-run-a', groupChatTurnId: 't2', conversationId, createdAt: '2026-08-26T00:00:20.000Z' }),
    task({ taskId: 'cogseed-task-run-b', createdAt: '2026-08-26T01:00:00.000Z', conversationId }),
    task({ taskId: 'cogseed-task-run-b-turn-1', parentTaskId: 'cogseed-task-run-b', groupChatTurnId: 't3', conversationId, createdAt: '2026-08-26T01:00:10.000Z' }),
    task({ taskId: 'cogseed-task-run-b-turn-2', parentTaskId: 'cogseed-task-run-b', groupChatTurnId: 't4', conversationId, createdAt: '2026-08-26T01:00:20.000Z' }),
  ];
}

describe('RC-P0-13 cogSeedTaskIdentity', () => {
  it('numbers runs by creation order, not by position in the array', () => {
    const tasks = session();
    const identity = (id: string) => cogSeedTaskIdentity(tasks.find((t) => t.taskId === id)!, tasks);

    expect(identity('cogseed-task-run-a').runOrdinal).toBe(1);
    expect(identity('cogseed-task-run-b').runOrdinal).toBe(2);
  });

  it('gives a turn the ordinal of its own run, not of the whole session', () => {
    const tasks = session();
    const identity = (id: string) => cogSeedTaskIdentity(tasks.find((t) => t.taskId === id)!, tasks);

    // run-b's turns belong to run 2 and are numbered 1 and 2 within it — a
    // session-wide turn counter would have called them 3 and 4.
    expect(identity('cogseed-task-run-b-turn-1')).toMatchObject({ runOrdinal: 2, turnOrdinal: 1 });
    expect(identity('cogseed-task-run-b-turn-2')).toMatchObject({ runOrdinal: 2, turnOrdinal: 2 });
  });

  // The regression this guards is the whole reason ordinals are server-side:
  // the board scans newest-first and the session projection walks the tree, so
  // an index-derived ordinal would disagree between the two screens.
  it('is invariant under the order the caller happens to supply', () => {
    const ordered = session();
    const reversed = [...ordered].reverse();
    const shuffled = [ordered[3], ordered[1], ordered[5], ordered[0], ordered[4], ordered[2]];

    for (const record of ordered) {
      const baseline = cogSeedTaskIdentity(record, ordered);
      expect(cogSeedTaskIdentity(record, reversed)).toEqual(baseline);
      expect(cogSeedTaskIdentity(record, shuffled)).toEqual(baseline);
    }
  });

  // `createdAt` is second-precision in this store, so same-second siblings are
  // routine. Without a tiebreak their order would depend on sort stability.
  it('breaks a same-timestamp tie deterministically', () => {
    const tasks = [
      task({ taskId: 'cogseed-task-run-z', createdAt: '2026-08-26T00:00:00.000Z' }),
      task({ taskId: 'cogseed-task-run-a', createdAt: '2026-08-26T00:00:00.000Z' }),
    ];
    const forward = tasks.map((t) => cogSeedTaskIdentity(t, tasks).runOrdinal);
    const backward = tasks.map((t) => cogSeedTaskIdentity(t, [...tasks].reverse()).runOrdinal);

    expect(forward).toEqual(backward);
    expect(cogSeedTaskIdentity(tasks[1], tasks).runOrdinal).toBe(1); // 'run-a' < 'run-z'
  });

  it('shortens the conversation id instead of widening what is exposed', () => {
    const tasks = session();
    const identity = cogSeedTaskIdentity(tasks[0], tasks);

    expect(identity.conversationShortId).toBe('conv-abc');
    expect(identity.conversationShortId!.length).toBe(8);
  });

  it('rejects a conversation id that is not a safe identifier', () => {
    const tasks = [task({ taskId: 'cogseed-task-run-a', conversationId: 'conv <script>' })];
    expect(cogSeedTaskIdentity(tasks[0], tasks).conversationShortId).toBeUndefined();
  });

  it('omits ordinals when there is no session context to order against', () => {
    const solo = task({ taskId: 'cogseed-task-run-a' });
    expect(cogSeedTaskIdentity(solo, [])).toEqual({});
  });

  it('treats an orphaned turn as a run of its own rather than dropping it', () => {
    // The parent aged out of the retention window; the turn must still get an
    // identity instead of rendering as a nameless card.
    const tasks = [task({ taskId: 'cogseed-task-orphan-turn', parentTaskId: 'cogseed-task-gone', createdAt: '2026-08-26T00:00:00.000Z' })];
    expect(cogSeedTaskIdentity(tasks[0], tasks)).toMatchObject({ runOrdinal: 1 });
  });

  it('survives a parent cycle without hanging', () => {
    const tasks = [
      task({ taskId: 'cogseed-task-a', parentTaskId: 'cogseed-task-b' }),
      task({ taskId: 'cogseed-task-b', parentTaskId: 'cogseed-task-a' }),
    ];
    expect(() => cogSeedTaskIdentity(tasks[0], tasks)).not.toThrow();
  });
});

function serviceFor(records: CogSeedTaskRecord[]) {
  const sessionRecord = {
    schemaVersion: 1,
    sessionId: 'cogseed-session-1',
    ownerId: 'u-1',
    conversationId: 'conv-abcdef123456',
    createdAt: records[0].createdAt,
    updatedAt: records.at(-1)!.updatedAt,
  };
  return createCogSeedIpcService({
    listTasks: async () => records,
    listSessions: async () => [sessionRecord] as never,
    readSession: async () => sessionRecord as never,
    readTask: async (_userId: string, taskId: string) => records.find((r) => r.taskId === taskId) ?? null,
    readEvents: async () => [],
    isConversationAvailable: async () => true,
  } as never);
}

describe('RC-P0-13 projected card identity', () => {
  it('makes every card in a session pairwise distinguishable', async () => {
    const records = session();
    const board = await serviceFor(records).boardProjection('u-1');

    const identities = board.tasks.map((t) => [t.runOrdinal, t.turnOrdinal, t.conversationShortId, t.agentId].join('|'));

    expect(identities).toHaveLength(6);
    expect(new Set(identities).size).toBe(6);
  });

  it('agrees with the session projection on which run is which', async () => {
    const records = session();
    const service = serviceFor(records);
    const board = await service.boardProjection('u-1');
    const detail = await service.collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-b-turn-2' });

    const fromBoard = board.tasks.find((t) => t.taskId === 'cogseed-task-run-b-turn-2')!;
    const fromDetail = detail.tasks.find((t) => t.taskId === 'cogseed-task-run-b-turn-2')!;

    // The detail view reads only the selected run's subtree. Ordering against
    // that subtree would have made every run "Run 1".
    expect(fromDetail.runOrdinal).toBe(2);
    expect(fromDetail.runOrdinal).toBe(fromBoard.runOrdinal);
    expect(fromDetail.turnOrdinal).toBe(fromBoard.turnOrdinal);
    expect(detail.task.runOrdinal).toBe(fromBoard.runOrdinal);
  });

  // DECISION-01's hard constraint, asserted against the serialized projection
  // rather than field-by-field, so a future field cannot smuggle it back in.
  // Regression: identity used to read `task.conversationId` directly while the
  // summary resolved it as `task.conversationId || session.conversationId`, so
  // a task inheriting its conversation from the session got an Open Task exit
  // but no short id in its identity.
  it('resolves the conversation the same way the Open Task exit does', async () => {
    const records = session().map((record) => {
      const { conversationId: _dropped, ...rest } = record;
      return rest as CogSeedTaskRecord;
    });
    const board = await serviceFor(records).boardProjection('u-1');

    for (const projected of board.tasks) {
      expect(projected.conversationId).toBe('conv-abcdef123456');
      expect(projected.conversationShortId).toBe('conv-abc');
    }
  });

  it('projects no user-authored text alongside the identity', async () => {
    const secret = 'ship the quarterly revenue deck to legal';
    const records = session().map((record) => ({ ...record, task: secret }));
    const service = serviceFor(records);

    const board = JSON.stringify(await service.boardProjection('u-1'));
    const detail = JSON.stringify(await service.collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-b' }));

    expect(board).not.toContain(secret);
    expect(detail).not.toContain(secret);
    // And the full conversation id is the only long id present — the identity
    // itself carries the truncated form.
    expect(board).toContain('"conversationShortId":"conv-abc"');
  });
});


// DECISION-01's standing constraint, re-verified against a real projection
// object rather than by reading the source. The board is built from records
// whose every free-text-capable field carries a distinct sentinel; none of
// them may appear anywhere in the serialized projection.
describe('RC-P0-13 privacy re-review (DECISION-01 candidate B)', () => {
  const SENTINELS = {
    objective: 'OBJECTIVE-SENTINEL negotiate the vendor contract',
    displayName: 'DISPLAYNAME-SENTINEL Chloe personal workspace',
    workingDir: '/Users/SENTINEL-PATH/secret-project',
  };

  function loadedService() {
    const records = session().map((record) => ({
      ...record,
      task: SENTINELS.objective,
      workingDir: SENTINELS.workingDir,
    }));
    const sessionRecord = {
      schemaVersion: 1,
      sessionId: 'cogseed-session-1',
      ownerId: 'u-1',
      conversationId: 'conv-abcdef123456',
      displayName: SENTINELS.displayName,
      createdAt: records[0].createdAt,
      updatedAt: records.at(-1)!.updatedAt,
    };
    return createCogSeedIpcService({
      listTasks: async () => records,
      listSessions: async () => [sessionRecord] as never,
      readSession: async () => sessionRecord as never,
      readTask: async (_userId: string, taskId: string) => records.find((r) => r.taskId === taskId) ?? null,
      readEvents: async () => [],
      isConversationAvailable: async () => true,
    } as never);
  }

  it('leaks none of prompt, objective, display name or working directory', async () => {
    const service = loadedService();
    const projections = [
      JSON.stringify(await service.boardProjection('u-1')),
      JSON.stringify(await service.collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-b' })),
      JSON.stringify(await service.sessionListProjection('u-1')),
    ];

    for (const projection of projections) {
      for (const sentinel of Object.values(SENTINELS)) {
        expect(projection).not.toContain(sentinel);
      }
      // Fragments too — a truncated leak is still a leak.
      expect(projection).not.toContain('SENTINEL');
      expect(projection).not.toContain('negotiate the vendor');
    }
  });

  // The load-bearing assertion: identity added exactly three structured
  // fields. Anything else appearing here is a field nobody reviewed.
  it('adds only structured metadata to the task summary', async () => {
    const board = await loadedService().boardProjection('u-1');
    const turn = board.tasks.find((t) => t.taskId === 'cogseed-task-run-b-turn-1')!;

    const ALLOWED = new Set([
      // Pre-existing, unchanged by RC-P0-13.
      'taskId', 'sessionId', 'requestId', 'parentTaskId', 'coordinationId',
      'status', 'title', 'titleKey', 'createdAt', 'updatedAt', 'errorCode',
      'executionKind', 'conversationId', 'retryOfTaskId', 'agentId',
      'skillVersionPinStatus', 'actions',
      // Board-only decoration.
      'column', 'sessionTitle', 'sessionTitleKey', 'groupId',
      // Added by RC-P0-13.
      'runOrdinal', 'turnOrdinal', 'conversationShortId',
    ]);

    expect(Object.keys(turn).filter((key) => !ALLOWED.has(key))).toEqual([]);

    // And the three new ones are structured values, not prose.
    expect(typeof turn.runOrdinal).toBe('number');
    expect(typeof turn.turnOrdinal).toBe('number');
    expect(turn.conversationShortId).toMatch(/^[A-Za-z0-9_.:-]{1,8}$/);
  });

  it('passes agentId through the renderer-safe identifier whitelist', async () => {
    const records = session().map((record, index) => ({
      ...record,
      // Only the first is a safe identifier; the rest must be dropped, not
      // sanitized into something that still carries the text.
      agentId: index === 0 ? 'planner-1' : 'Agent <script>alert(1)</script>',
    }));
    const service = createCogSeedIpcService({
      listTasks: async () => records,
      listSessions: async () => [{
        schemaVersion: 1, sessionId: 'cogseed-session-1', ownerId: 'u-1',
        createdAt: records[0].createdAt, updatedAt: records.at(-1)!.updatedAt,
      }] as never,
      isConversationAvailable: async () => true,
    } as never);

    const board = await service.boardProjection('u-1');
    const agentIds = board.tasks.map((t) => t.agentId);

    expect(agentIds.filter(Boolean)).toEqual(['planner-1']);
    expect(JSON.stringify(board)).not.toContain('script');
  });

  it('does not require the backend to produce any user-facing text', async () => {
    const board = await loadedService().boardProjection('u-1');
    const turn = board.tasks.find((t) => t.taskId === 'cogseed-task-run-b-turn-1')!;

    // Relative time is a renderer concern; the projection ships timestamps.
    expect(JSON.stringify(turn)).not.toMatch(/ago|前/);
    expect(turn.createdAt).toBe(new Date(turn.createdAt).toISOString());
    // Titles cross as i18n keys, never as localized prose.
    expect(turn.titleKey).toMatch(/^run_center\./);
  });
});
