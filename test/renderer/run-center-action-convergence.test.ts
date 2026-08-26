// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-03 — abort / retry convergence window.
//
// `cogseed.task.action` resolves with a snapshot taken before the runtime has
// settled: the terminal transition happens on bus.ts's asynchronous
// `trackBackgroundWrite` branch. So pressing Abort left the card in the running
// column until the user refreshed again by hand.
//
// The rule this file exists to enforce: the Run Center re-reads until the
// runtime agrees, and NEVER writes an optimistic status. Forging a status would
// make the view lie exactly when the action silently failed — the one case the
// user most needs to see. Two of the tests below assert that no such forgery
// happens on the timeout path.
//
// Timing: the window is 10 attempts at a 1s cadence. The harness drains
// `setTimeout` rather than waiting, so all ten iterations really execute but
// cost no wall time.

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

const running = () => fx.boardTask({
  taskId: 'task-a',
  column: 'running',
  status: 'running',
  actions: { retry: false, skip: false, resume: false, abort: true },
});

const failed = () => fx.boardTask({
  taskId: 'task-a',
  column: 'attention',
  status: 'failed',
  actions: { retry: true, skip: false, resume: false, abort: false },
});

async function mount(task: Record<string, unknown>) {
  const h = await createRunCenterHarness({
    board: fx.board([task]),
    sessions: { sessions: [fx.session({ latestTaskId: 'task-a' })] },
    detail: () => fx.detail(task),
    action: () => fx.detail(task),
  });
  await h.render();
  return h;
}

describe('RC-P1-03 abort convergence', () => {
  it('keeps re-reading until the runtime reports a terminal status', async () => {
    const task = running();
    harness = await mount(task);

    // The runtime only settles on the third board read after the action.
    let boardReads = 0;
    harness.setResponse('cogseed.task.list', () => {
      boardReads += 1;
      return boardReads >= 3
        ? fx.board([{ ...task, status: 'cancelled', column: 'archived' }])
        : fx.board([task]);
    });

    await harness.click('[data-run-center-action="abort"]');

    // It converged on the real status rather than guessing at it.
    expect(boardReads).toBeGreaterThanOrEqual(3);
    expect(harness.$('[data-run-center-unconfirmed]')).toBeNull();
    // busyAction released, so the buttons are live again.
    expect(harness.$('[data-run-center-action="abort"]')?.hasAttribute('disabled')).toBeFalsy();
  });

  it('stops immediately when the action already settled', async () => {
    const task = running();
    harness = await mount(task);

    harness.setResponse('cogseed.task.list', fx.board([{ ...task, status: 'cancelled', column: 'archived' }]));
    const before = harness.callsTo('cogseed.task.list').length;

    await harness.click('[data-run-center-action="abort"]');

    // One refresh from the action, and the window is satisfied on first check.
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 1);
  });

  it('gives up after a bounded number of attempts without forging a status', async () => {
    const task = running();
    harness = await mount(task);
    const before = harness.callsTo('cogseed.task.list').length;

    // The runtime never settles.
    await harness.click('[data-run-center-action="abort"]');

    // Bounded: 1 refresh from the action + 10 convergence attempts.
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 11);

    // The status on screen is still the last one the runtime actually
    // reported — NOT an invented "cancelled".
    const statuses = harness.$$('[data-dashboard-board-task-id="task-a"] .dashboard-status')
      .map((n) => n.textContent?.trim());
    expect(statuses.join()).not.toMatch(/cancel/i);
    const column = harness.$('[data-dashboard-board-task-id="task-a"]')
      ?.closest('[data-dashboard-board-column]')?.getAttribute('data-dashboard-board-column');
    expect(column).toBe('running');

    // ...and the user is told the action is unconfirmed.
    expect(harness.$('[data-run-center-unconfirmed]')?.getAttribute('data-run-center-unconfirmed')).toBe('abort');
  });

  it('releases busyAction even when the window times out', async () => {
    harness = await mount(running());
    await harness.click('[data-run-center-action="abort"]');
    // A stuck busyAction would disable the controls forever and also wedge the
    // RC-P0-02 poll, which gates on it.
    expect(harness.$('[data-run-center-action="abort"]')?.hasAttribute('disabled')).toBeFalsy();
  });
});

describe('RC-P1-03 retry convergence', () => {
  it('settles when a task linked back to the original appears', async () => {
    const task = failed();
    harness = await mount(task);

    let boardReads = 0;
    harness.setResponse('cogseed.task.list', () => {
      boardReads += 1;
      // RC-P1-09's `retryOfTaskId` is the only usable terminal condition here:
      // a retry produces a brand new run, so nothing about the old task changes.
      return boardReads >= 2
        ? fx.board([task, fx.boardTask({ taskId: 'task-retry', column: 'running', retryOfTaskId: 'task-a' })])
        : fx.board([task]);
    });

    await harness.click('[data-run-center-action="retry"]');

    expect(harness.$('[data-run-center-unconfirmed]')).toBeNull();
    expect(harness.$('[data-dashboard-board-task-id="task-retry"]')).not.toBeNull();
  });

  it('does not treat the unchanged original task as confirmation', async () => {
    const task = failed();
    harness = await mount(task);
    const before = harness.callsTo('cogseed.task.list').length;

    // Board never gains a linked task — the old failed one just sits there.
    await harness.click('[data-run-center-action="retry"]');

    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 11);
    expect(harness.$('[data-run-center-unconfirmed]')?.getAttribute('data-run-center-unconfirmed')).toBe('retry');
  });

  it('clears a previous unconfirmed notice when a new action starts', async () => {
    const task = failed();
    harness = await mount(task);

    await harness.click('[data-run-center-action="retry"]');
    expect(harness.$('[data-run-center-unconfirmed]')).not.toBeNull();

    harness.setResponse('cogseed.task.list', fx.board([
      task,
      fx.boardTask({ taskId: 'task-retry', column: 'running', retryOfTaskId: 'task-a' }),
    ]));
    await harness.click('[data-run-center-action="retry"]');

    expect(harness.$('[data-run-center-unconfirmed]')).toBeNull();
  });
});
