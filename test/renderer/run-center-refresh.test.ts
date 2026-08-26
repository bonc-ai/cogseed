// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P0-01 — complete Refresh (board + sessions + detail + timeline + collaboration).
//
// Before this fix, `refresh()` guarded the detail read with
// `if (task && (!state.selectedTaskId || !state.selectedSessionId))`. Once
// anything was selected, both halves were false, so `select()` never ran: the
// detail / timeline / collaboration panes kept rendering whatever they had
// loaded the first time, and the Refresh button could not repair them. The
// runtime could move a task to `failed` and the pane would still read `running`
// forever.
//
// The first test here is the inverted RC-T01 baseline witness — it asserted
// `toHaveLength(1)` against the bug, and now asserts the read actually happens.
//
// Environment note: see `_run-center-harness.ts`. This runs in the default
// `node` environment with a per-test JSDOM built by the harness.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunCenterHarness,
  runCenterFixtures as fx,
  type RunCenterHarness,
} from './_run-center-harness';

let harness: RunCenterHarness | null = null;

afterEach(() => {
  harness?.destroy();
  harness = null;
});

const TASKS = () => [
  fx.boardTask({ taskId: 'task-a', column: 'running', status: 'running' }),
  fx.boardTask({ taskId: 'task-b', column: 'attention', status: 'failed', errorCode: 'model_error' }),
];

function detailFor(task: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return fx.detail(task, overrides);
}

/** Two timeline events, so a refresh can observably grow the list. */
function timeline(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt-${i + 1}`,
    taskId: 'task-a',
    sequence: i + 1,
    type: 'task.started',
    createdAt: `2026-08-26T00:0${i}:00.000Z`,
    summary: '',
    summaryKey: 'run_center.event_task_started',
  }));
}

async function mount(overrides: Partial<Parameters<typeof createRunCenterHarness>[0]> = {}) {
  const tasks = TASKS();
  const board = fx.board(tasks);
  const h = await createRunCenterHarness({
    board,
    sessions: { sessions: [fx.session({ sessionId: 'session-1', latestTaskId: 'task-a' })] },
    detail: (payload: Record<string, unknown>) => {
      const task = tasks.find((t) => t.taskId === payload.taskId) || tasks[0];
      return detailFor(task);
    },
    ...overrides,
  });
  await h.render();
  return { harness: h, board, tasks };
}

describe('RC-P0-01 complete refresh', () => {
  it('re-reads the detail on Refresh even when a task is already selected', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    // One read from the auto-select on first load.
    expect(harness.callsTo('cogseed.session.read')).toHaveLength(1);

    await harness.click('[data-run-center-refresh]');

    expect(harness.callsTo('cogseed.task.list')).toHaveLength(2);
    expect(harness.callsTo('cogseed.session.list')).toHaveLength(2);
    // The inverted witness: this was stuck at 1 before RC-P0-01.
    expect(harness.callsTo('cogseed.session.read')).toHaveLength(2);
    // ...and it re-read the selection that is actually on screen.
    expect(harness.callsTo('cogseed.session.read').at(-1)!.payload)
      .toMatchObject({ sessionId: 'session-1', taskId: 'task-a' });
  });

  it('propagates changed runtime state into the detail pane', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    const statusText = () => harness!.$('.run-center-detail .run-center-status')?.textContent?.trim();
    const detailValues = () => harness!.$$('.run-center-detail dd').map((n) => n.textContent?.trim());

    expect(detailValues()).not.toContain('app_restart');

    // The runtime moves the task to failed between refreshes.
    const failed = { ...mounted.tasks[0], status: 'failed', errorCode: 'app_restart' };
    harness.setResponse('cogseed.session.read', () => detailFor(failed));
    await harness.click('[data-run-center-refresh]');

    expect(detailValues()).toContain('app_restart');
    expect(statusText()).toBeTruthy();
  });

  it('propagates changed runtime state into the timeline', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    harness.setResponse('cogseed.session.read', () => detailFor(mounted.tasks[0], { timeline: timeline(1) }));
    await harness.click('[data-run-center-refresh]');
    await harness.click('[data-run-center-view="runs"]');
    expect(harness.$$('.run-center-timeline li')).toHaveLength(1);

    harness.setResponse('cogseed.session.read', () => detailFor(mounted.tasks[0], { timeline: timeline(3) }));
    await harness.click('[data-run-center-refresh]');
    expect(harness.$$('.run-center-timeline li')).toHaveLength(3);
  });

  it('propagates changed runtime state into the collaboration view', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    const actors = [
      { actorId: 'agent-reviewer', role: 'member_agent', sessionId: 'session-1', status: 'running' },
    ];
    harness.setResponse('cogseed.session.read', () => detailFor(mounted.tasks[0], { actors }));
    await harness.click('[data-run-center-refresh]');
    await harness.click('[data-run-center-view="collaboration"]');

    const names = harness.$$('.run-center-actors li strong').map((n) => n.textContent?.trim());
    expect(names).toEqual(['agent-reviewer']);
  });

  it('keeps the previous detail on screen while the re-read is in flight', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    const shownTaskId = () => harness!.$$('.run-center-detail dd').map((n) => n.textContent?.trim());
    expect(shownTaskId()).toContain('task-a');

    // Hold the detail read open so we can observe the in-flight render.
    let release: ((value: unknown) => void) | null = null;
    harness.setResponse('cogseed.session.read', () => new Promise((resolve) => { release = resolve; }));

    await harness.click('[data-run-center-refresh]');

    // Mid-flight: the pane must still show the old content, not a blank/spinner.
    // A poll every 5s (RC-P0-02) would otherwise strobe the whole right column.
    expect(harness.$('.run-center-detail')).not.toBeNull();
    expect(shownTaskId()).toContain('task-a');
    // The board must not have been replaced by its loading placeholder either.
    expect(harness.$$('[data-dashboard-board-task-id]').length).toBeGreaterThan(0);

    release!(detailFor(mounted.tasks[0]));
    await harness.flush();
    expect(shownTaskId()).toContain('task-a');
  });

  it('falls back to the first board card when the selected task disappears', async () => {
    const mounted = await mount();
    harness = mounted.harness;
    expect(harness.callsTo('cogseed.session.read').at(-1)!.payload).toMatchObject({ taskId: 'task-a' });

    // task-a is gone from the board; task-b remains.
    const remaining = [mounted.tasks[1]];
    harness.setResponse('cogseed.task.list', fx.board(remaining));
    harness.setResponse('cogseed.session.read', (payload: Record<string, unknown>) => {
      const task = remaining.find((t) => t.taskId === payload.taskId) || remaining[0];
      return detailFor(task);
    });
    await harness.click('[data-run-center-refresh]');

    expect(harness.callsTo('cogseed.session.read').at(-1)!.payload).toMatchObject({ taskId: 'task-b' });
    // No error surfaced — a vanished task is a normal outcome, not a failure.
    expect(harness.$('.run-center-details .run-center-empty small')).toBeNull();
    expect(harness.$$('.run-center-detail dd').map((n) => n.textContent?.trim())).toContain('task-b');
  });

  it('clears the selection and shows an empty state when the session is deleted', async () => {
    const mounted = await mount();
    harness = mounted.harness;
    const readsBefore = harness.callsTo('cogseed.session.read').length;

    // The whole session vanished underneath the user.
    harness.setResponse('cogseed.session.list', { sessions: [] });
    harness.setResponse('cogseed.task.list', fx.board([]));
    await harness.click('[data-run-center-refresh]');

    // Selection dropped, so there is nothing left to read.
    expect(harness.callsTo('cogseed.session.read')).toHaveLength(readsBefore);
    // Empty state, not a stale detail pane...
    expect(harness.$('.run-center-detail')).toBeNull();
    expect(harness.$('.run-center-details .run-center-empty')).not.toBeNull();
    // ...and not an error the user has to dismiss. `stateView` only renders a
    // <small> when it was handed an error detail string.
    expect(harness.$('.run-center-details .run-center-empty small')).toBeNull();
  });

  it('does not double-read the detail after a task action', async () => {
    const failed = fx.boardTask({
      taskId: 'task-a',
      column: 'attention',
      status: 'failed',
      actions: { retry: true, skip: false, resume: false, abort: false },
    });
    harness = await createRunCenterHarness({
      board: fx.board([failed]),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-a' })] },
      detail: () => detailFor(failed),
      action: () => detailFor(failed),
    });
    await harness.render();
    const readsBefore = harness.callsTo('cogseed.session.read').length;

    // The retry lands straight away, so RC-P1-03's convergence window is
    // satisfied on its first check and adds no further reads.
    harness.setResponse('cogseed.task.list', fx.board([
      failed,
      fx.boardTask({ taskId: 'task-retry', column: 'running', status: 'running', retryOfTaskId: 'task-a' }),
    ]));

    await harness.click('[data-run-center-action="retry"]');

    expect(harness.callsTo('cogseed.task.action')).toHaveLength(1);
    // `action()` used to call `refresh()` and then `select()`, issuing two
    // reads for one user action. Exactly one now.
    expect(harness.callsTo('cogseed.session.read')).toHaveLength(readsBefore + 1);
  });
});

// -----------------------------------------------------------------------------
// RC-P1-09 — the retry link, as the user sees it.
// -----------------------------------------------------------------------------
describe('RC-P1-09 retry relation in the UI', () => {
  it('annotates both the card and the detail pane with the task being retried', async () => {
    const tasks = [fx.boardTask({
      taskId: 'task-new',
      column: 'running',
      status: 'running',
      retryOfTaskId: 'cogseed-task-old1',
    })];
    harness = await createRunCenterHarness({
      board: fx.board(tasks),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-new' })] },
      detail: () => fx.detail(tasks[0]),
    });
    await harness.render();

    const card = harness.$('[data-dashboard-board-task-id="task-new"] [data-run-center-retry-of]');
    expect(card?.getAttribute('data-run-center-retry-of')).toBe('cogseed-task-old1');

    const detail = harness.$('.run-center-detail [data-run-center-retry-of]');
    expect(detail?.getAttribute('data-run-center-retry-of')).toBe('cogseed-task-old1');
    expect(detail?.textContent?.trim()).toBe('cogseed-task-old1');
  });

  it('shows no annotation for a task that is not a retry', async () => {
    const tasks = [fx.boardTask({ taskId: 'task-plain', column: 'running', status: 'running' })];
    harness = await createRunCenterHarness({
      board: fx.board(tasks),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-plain' })] },
      detail: () => fx.detail(tasks[0]),
    });
    await harness.render();

    expect(harness.$('[data-run-center-retry-of]')).toBeNull();
  });
});
