// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-15 — query bounds on the task list.
//
// `listCogSeedTasks()` was an unbounded readdir + serial read/validate of every
// task file, and one Run Center refresh triggered it twice (board projection +
// session-list projection). That is the hard prerequisite for RC-P0-02: a 5s
// poll would otherwise turn a latent O(n) scan into 24 full scans a minute.
//
// Two independent guarantees are asserted here:
//   1. the retention window never hides work the user still has to act on;
//   2. one refresh causes exactly one directory scan.

import { describe, expect, it, vi } from 'vitest';

import { applyCogSeedTaskWindow } from '../../../../src/main/features/cogseed_backend/task-store';
import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';
import type { CogSeedTaskRecord, CogSeedTaskStatus } from '../../../../src/main/features/cogseed_backend/types';

const DAY = 86_400_000;

function task(overrides: Partial<CogSeedTaskRecord> & { taskId: string }): CogSeedTaskRecord {
  const updatedAt = overrides.updatedAt ?? new Date(Date.now() - DAY).toISOString();
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    sessionId: 'session-1',
    requestId: `req-${overrides.taskId}`,
    userId: 'u-1',
    status: 'completed',
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  } as CogSeedTaskRecord;
}

/** Newest first, matching what `listCogSeedTasks` hands to the window. */
function sortedDesc(tasks: CogSeedTaskRecord[]): CogSeedTaskRecord[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

describe('RC-P1-15 applyCogSeedTaskWindow', () => {
  it('is a no-op when neither bound is supplied', () => {
    const tasks = sortedDesc([task({ taskId: 't-1' }), task({ taskId: 't-2' })]);
    expect(applyCogSeedTaskWindow(tasks)).toBe(tasks);
  });

  it('truncates to `limit`, keeping the most recently updated', () => {
    const tasks = sortedDesc(Array.from({ length: 10 }, (_, i) => task({
      taskId: `t-${i}`,
      updatedAt: new Date(Date.UTC(2026, 7, 10 + i)).toISOString(),
    })));

    const windowed = applyCogSeedTaskWindow(tasks, { limit: 3 });

    expect(windowed.map((t) => t.taskId)).toEqual(['t-9', 't-8', 't-7']);
    // Still descending by updatedAt.
    expect(windowed.map((t) => t.updatedAt)).toEqual([...windowed.map((t) => t.updatedAt)].sort().reverse());
  });

  it('drops completed tasks older than `since`', () => {
    const tasks = sortedDesc([
      task({ taskId: 'recent', updatedAt: new Date(Date.now() - DAY).toISOString() }),
      task({ taskId: 'ancient', updatedAt: new Date(Date.now() - 400 * DAY).toISOString() }),
    ]);

    const windowed = applyCogSeedTaskWindow(tasks, { since: new Date(Date.now() - 30 * DAY).toISOString() });

    expect(windowed.map((t) => t.taskId)).toEqual(['recent']);
  });

  // The load-bearing guarantee. A task the user still has to deal with must
  // never vanish because it got old or because history filled the budget.
  const ALWAYS_KEPT: CogSeedTaskStatus[] = ['created', 'queued', 'running', 'waiting_user', 'recoverable', 'failed'];

  it.each(ALWAYS_KEPT)('never ages out a %s task, however old', (status) => {
    const tasks = sortedDesc([
      task({ taskId: 'fresh-history', updatedAt: new Date(Date.now() - DAY).toISOString() }),
      task({ taskId: 'stale-active', status, updatedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() }),
    ]);

    const windowed = applyCogSeedTaskWindow(tasks, {
      limit: 1,
      since: new Date(Date.now() - 30 * DAY).toISOString(),
    });

    expect(windowed.map((t) => t.taskId)).toContain('stale-active');
  });

  it('does not let active tasks consume the history budget', () => {
    const tasks = sortedDesc([
      task({ taskId: 'run-1', status: 'running', updatedAt: new Date(Date.UTC(2026, 7, 20)).toISOString() }),
      task({ taskId: 'run-2', status: 'running', updatedAt: new Date(Date.UTC(2026, 7, 19)).toISOString() }),
      task({ taskId: 'done-1', updatedAt: new Date(Date.UTC(2026, 7, 18)).toISOString() }),
      task({ taskId: 'done-2', updatedAt: new Date(Date.UTC(2026, 7, 17)).toISOString() }),
    ]);

    const windowed = applyCogSeedTaskWindow(tasks, { limit: 2 });

    // Both running tasks plus the 2 newest completed ones — the limit bounds
    // history only, so the result is allowed to exceed it.
    expect(windowed.map((t) => t.taskId)).toEqual(['run-1', 'run-2', 'done-1', 'done-2']);
  });

  it('keeps ancestors of a kept task so board grouping cannot fracture', () => {
    const tasks = sortedDesc([
      task({ taskId: 'child', status: 'running', parentTaskId: 'parent', updatedAt: new Date().toISOString() }),
      // The parent is old, completed, and would otherwise be dropped.
      task({ taskId: 'parent', updatedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() }),
    ]);

    const windowed = applyCogSeedTaskWindow(tasks, {
      limit: 0,
      since: new Date(Date.now() - 30 * DAY).toISOString(),
    });

    expect(windowed.map((t) => t.taskId).sort()).toEqual(['child', 'parent']);
  });

  it('survives a parent cycle without hanging', () => {
    const tasks = sortedDesc([
      task({ taskId: 'a', status: 'running', parentTaskId: 'b' }),
      task({ taskId: 'b', status: 'running', parentTaskId: 'a' }),
    ]);
    expect(applyCogSeedTaskWindow(tasks, { limit: 1 }).map((t) => t.taskId).sort()).toEqual(['a', 'b']);
  });
});

describe('RC-P1-15 single scan per refresh', () => {
  it('collapses the board + session-list scans of one refresh into one', async () => {
    const records = [
      task({ taskId: 't-1', status: 'running', updatedAt: new Date().toISOString() }),
    ];
    const listTasks = vi.fn(async () => records);
    const service = createCogSeedIpcService({
      listTasks,
      listSessions: async () => [{
        schemaVersion: 1,
        sessionId: 'session-1',
        userId: 'u-1',
        createdAt: records[0].createdAt,
        updatedAt: records[0].updatedAt,
      }] as never,
      isConversationAvailable: async () => true,
    });

    // Exactly how the renderer issues them: concurrently, from one refresh.
    await Promise.all([
      service.boardProjection('u-1'),
      service.sessionListProjection('u-1'),
    ]);

    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it('does not serve a later refresh from a cache', async () => {
    const records = [task({ taskId: 't-1', status: 'running', updatedAt: new Date().toISOString() })];
    const listTasks = vi.fn(async () => records);
    const service = createCogSeedIpcService({
      listTasks,
      listSessions: async () => [] as never,
      isConversationAvailable: async () => true,
    });

    await service.boardProjection('u-1');
    await service.boardProjection('u-1');

    // Coalescing is in-flight only: sequential refreshes must each hit disk,
    // otherwise RC-P0-01's "Refresh actually refreshes" guarantee is a lie.
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight entry when a scan fails', async () => {
    const listTasks = vi.fn()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValue([]);
    const service = createCogSeedIpcService({
      listTasks: listTasks as never,
      listSessions: async () => [] as never,
      isConversationAvailable: async () => true,
    });

    await expect(service.boardProjection('u-1')).rejects.toThrow('disk gone');
    // A failed scan must not poison every later refresh.
    await expect(service.boardProjection('u-1')).resolves.toBeTruthy();
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});
