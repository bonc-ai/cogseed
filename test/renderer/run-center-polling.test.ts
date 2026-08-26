// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P0-02 — visible-period polling.
//
// The Run Center had no polling, no push, and no subscription: once rendered it
// was a static snapshot, so a task that moved to `failed` in the runtime showed
// as `running` indefinitely. There is no push channel to subscribe to yet — the
// preload's PUSH_EVENT_PREFIXES carries no `cogseed:` prefix, and
// `cogseed.task.events`, despite being registered as a stream handler, is a
// one-shot paged read with zero renderer consumers. A bounded poll is the
// interim cap on staleness.
//
// The poll deliberately gates on four conditions; each has a test here:
//   panel is active, document is visible, no refresh in flight, no pending action.
//
// Timers: the harness swaps the jsdom window's setInterval/clearInterval before
// the module is evaluated, so `harness.tick()` fires the registered callback
// directly. Vitest's fake timers patch the Node global and would never be seen
// by code running inside the jsdom realm.

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

async function mount() {
  const tasks = [fx.boardTask({ taskId: 'task-a', column: 'running', status: 'running' })];
  const h = await createRunCenterHarness({
    board: fx.board(tasks),
    sessions: { sessions: [fx.session({ latestTaskId: 'task-a' })] },
    detail: () => fx.detail(tasks[0]),
    action: () => fx.detail(tasks[0]),
  });
  await h.render();
  return h;
}

describe('RC-P0-02 visible-period polling', () => {
  it('establishes exactly one interval on entering the view', async () => {
    harness = await mount();
    expect(harness.activeIntervals()).toBe(1);
  });

  it('does not stack a second interval when the view is re-entered', async () => {
    harness = await mount();
    // The router calls renderRunCenter() again on every visit.
    await harness.render();
    await harness.render();
    expect(harness.activeIntervals()).toBe(1);
  });

  it('refreshes on each tick while visible and active', async () => {
    harness = await mount();
    const before = harness.callsTo('cogseed.task.list').length;

    await harness.tick();
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 1);

    await harness.tick();
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 2);
  });

  it('retires its own timer once the view is left', async () => {
    harness = await mount();
    const before = harness.callsTo('cogseed.task.list').length;

    // Leaving only drops the panel's `active` class; there is no teardown hook.
    harness.setPanelActive(false);
    await harness.tick();

    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before);
    // ...and the timer is gone, not merely skipping.
    expect(harness.activeIntervals()).toBe(0);
  });

  it('stops polling while the document is hidden', async () => {
    harness = await mount();
    const before = harness.callsTo('cogseed.task.list').length;

    await harness.setHidden(true);
    expect(harness.activeIntervals()).toBe(0);

    await harness.tick();
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before);
  });

  it('catches up immediately when the document becomes visible again', async () => {
    harness = await mount();
    await harness.setHidden(true);
    const whileHidden = harness.callsTo('cogseed.task.list').length;

    await harness.setHidden(false);

    // One catch-up refresh right away, rather than waiting a full interval.
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(whileHidden + 1);
    // ...and polling resumes, without duplicating the interval.
    expect(harness.activeIntervals()).toBe(1);
  });

  it('does not resume polling on visibility change when the view is not active', async () => {
    harness = await mount();
    harness.setPanelActive(false);
    await harness.setHidden(true);
    const before = harness.callsTo('cogseed.task.list').length;

    await harness.setHidden(false);

    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before);
    expect(harness.activeIntervals()).toBe(0);
  });

  it('never runs a poll on top of an in-flight refresh', async () => {
    harness = await mount();
    const before = harness.callsTo('cogseed.task.list').length;

    // Hold the board read open so `state.loading` stays true.
    let release: ((value: unknown) => void) | null = null;
    harness.setResponse('cogseed.task.list', () => new Promise((resolve) => { release = resolve; }));

    await harness.tick();                       // starts a refresh (call +1)
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 1);

    await harness.tick();                       // must be skipped
    await harness.tick();
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 1);

    release!(fx.board([fx.boardTask({ taskId: 'task-a', column: 'running' })]));
    await harness.flush();

    // Once settled, polling resumes normally.
    await harness.tick();
    expect(harness.callsTo('cogseed.task.list')).toHaveLength(before + 2);
  });

  it('does not poll while a task action is still settling', async () => {
    const tasks = [fx.boardTask({
      taskId: 'task-a',
      column: 'attention',
      status: 'failed',
      actions: { retry: true, skip: false, resume: false, abort: false },
    })];
    harness = await createRunCenterHarness({
      board: fx.board(tasks),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-a' })] },
      detail: () => fx.detail(tasks[0]),
      // Hold the action open so `busyAction` stays set.
      action: () => new Promise(() => {}),
    });
    await harness.render();

    void harness.click('[data-run-center-action="retry"]');
    await harness.flush();
    const duringAction = harness.callsTo('cogseed.task.list').length;

    await harness.tick();
    await harness.tick();

    expect(harness.callsTo('cogseed.task.list')).toHaveLength(duringAction);
  });

  it('leaves no timer behind after teardown', async () => {
    harness = await mount();
    expect(harness.activeIntervals()).toBe(1);
    harness.destroy();
    expect(harness.activeIntervals()).toBe(0);
    harness = null;
  });
});
