// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-T01 (spec §8) — the five scaffolding smoke cases.
//
// This file runs in the repo's default `node` environment. The harness builds
// its own JSDOM instance rather than opting the file into a jsdom environment
// via the per-file docblock, because the shared `test/setup-env.ts` imports
// `tsx/cjs` → esbuild, whose load-time `TextEncoder`/`Uint8Array` realm
// invariant fails under jsdom globals. See the rationale block in
// `_run-center-harness.ts`.
//
// NB: do not name that docblock pragma literally anywhere in this file —
// Vitest matches it against the whole file content, prose included, and would
// switch this suite back into the broken environment.
//
// Every assertion below targets a runtime artefact — an IPC channel that was
// invoked, a DOM node that was rendered, or a spy that was called. No test in
// this file reads renderer source and matches strings against it; that is the
// anti-pattern (F-23) this harness exists to replace.

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

/** A board wide enough to populate every column, plus one archived card. */
function fullBoard() {
  return fx.board([
    fx.boardTask({ taskId: 'task-pending', column: 'pending', status: 'queued' }),
    fx.boardTask({ taskId: 'task-running', column: 'running', status: 'running' }),
    fx.boardTask({ taskId: 'task-attention', column: 'attention', status: 'failed', errorCode: 'model_error' }),
    fx.boardTask({ taskId: 'task-done-1', column: 'completed', status: 'completed' }),
    fx.boardTask({ taskId: 'task-done-2', column: 'completed', status: 'completed' }),
    fx.boardTask({ taskId: 'task-done-3', column: 'completed', status: 'completed' }),
    fx.boardTask({ taskId: 'task-archived', column: 'archived', status: 'cancelled' }),
  ]);
}

/** Serves a detail snapshot for whichever taskId the controller asks about. */
function detailForRequestedTask(board: ReturnType<typeof fullBoard>) {
  return (payload: Record<string, unknown>) => {
    const tasks = board.tasks as Array<Record<string, unknown>>;
    const task = tasks.find((candidate) => candidate.taskId === payload.taskId) || tasks[0];
    return fx.detail(task);
  };
}

describe('RC-T01 Run Center harness', () => {
  it('injects a frozen window.cogseed before run-center.js loads', async () => {
    const board = fullBoard();
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: detailForRequestedTask(board),
    });

    // The production bridge is `{writable:false, configurable:false}` on a
    // frozen object. If the harness installed a plain assignable property, a
    // test could "work" in a way the real preload would never allow.
    const win = harness.window;
    const descriptor = Object.getOwnPropertyDescriptor(win, 'cogseed');
    expect(descriptor).toMatchObject({ writable: false, configurable: false });
    expect(Object.isFrozen(win.cogseed)).toBe(true);

    // ...and it really is unreplaceable, which is the whole point.
    expect(() => { (win as Record<string, unknown>).cogseed = { invoke: () => Promise.resolve() }; })
      .toThrow(TypeError);

    // The module loaded and published its entry point through that window.
    expect(typeof win.renderRunCenter).toBe('function');
    expect(win.CogSeedRunCenterBoard).toBeTruthy();
  });

  // --- Case 1 ---------------------------------------------------------------
  it('drives the full refresh IPC chain and reaches cogseed.session.read', async () => {
    const board = fullBoard();
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: detailForRequestedTask(board),
    });

    await harness.render();

    expect(harness.channels()).toEqual(
      expect.arrayContaining(['cogseed.task.list', 'cogseed.session.list', 'cogseed.session.read']),
    );
    // The detail fetch is scoped to the auto-selected first board task.
    expect(harness.callsTo('cogseed.session.read')[0].payload).toMatchObject({
      sessionId: 'session-1',
      taskId: 'task-pending',
    });
  });

  // --- Case 2 ---------------------------------------------------------------
  it('renders the selected task id into the detail pane', async () => {
    const board = fullBoard();
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: detailForRequestedTask(board),
    });
    await harness.render();

    await harness.click('[data-dashboard-board-task-id="task-attention"]');

    const readCalls = harness.callsTo('cogseed.session.read');
    expect(readCalls.at(-1)!.payload).toMatchObject({ taskId: 'task-attention' });

    const values = harness.$$('.run-center-detail dd').map((node) => node.textContent?.trim());
    expect(values).toContain('task-attention');
    // The projection's renderer-safe errorCode reaches the pane too.
    expect(values).toContain('model_error');
  });

  // --- Case 3 ---------------------------------------------------------------
  it('moves a card between columns when the backing projection flips', async () => {
    const board = fullBoard();
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: detailForRequestedTask(board),
    });
    await harness.render();

    const columnOf = (taskId: string) => harness!
      .$(`[data-dashboard-board-task-id="${taskId}"]`)
      ?.closest('[data-dashboard-board-column]')
      ?.getAttribute('data-dashboard-board-column');

    expect(columnOf('task-running')).toBe('running');

    // Simulate the runtime finishing that task between two refreshes.
    const flipped = fx.board(
      (board.tasks as Array<Record<string, unknown>>).map((task) => (task.taskId === 'task-running'
        ? { ...task, column: 'completed', status: 'completed' }
        : task)),
    );
    harness.setResponse('cogseed.task.list', flipped);
    await harness.click('[data-run-center-refresh]');

    expect(columnOf('task-running')).toBe('completed');
  });

  // --- Case 4 ---------------------------------------------------------------
  // Rewritten from the original "the completed column is actually visible".
  // jsdom performs no layout, so `getBoundingClientRect()` is permanently zero
  // and a visibility assertion would pass unconditionally — worse than no test.
  // Real visibility is RC-T05's Electron/CDP smoke. What this locks down is
  // structure: the columns exist and hold the cards the projection says.
  it('renders all four board columns with the expected card membership', async () => {
    const board = fullBoard();
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: detailForRequestedTask(board),
    });
    await harness.render();

    const columns = harness.$$('[data-dashboard-board-column]')
      .map((node) => node.getAttribute('data-dashboard-board-column'));
    expect(columns).toEqual(['pending', 'running', 'attention', 'completed']);

    const cardsIn = (column: string) => harness!
      .$$(`[data-dashboard-board-column="${column}"] [data-dashboard-board-task-id]`)
      .map((node) => node.getAttribute('data-dashboard-board-task-id'));

    expect(cardsIn('completed')).toEqual(['task-done-1', 'task-done-2', 'task-done-3']);
    expect(cardsIn('pending')).toEqual(['task-pending']);
    expect(cardsIn('running')).toEqual(['task-running']);
    expect(cardsIn('attention')).toEqual(['task-attention']);
    // Archived stays out of the columns; it lives behind its own toggle.
    expect(harness.$('[data-dashboard-board-task-id="task-archived"]')).toBeNull();
    expect(harness.$('[data-dashboard-archive-toggle]')).not.toBeNull();
  });

  // --- Case 5 ---------------------------------------------------------------
  it('reaches the Open Task button and routes through setView when the projection carries conversationId', async () => {
    const board = fullBoard();
    const task = { ...(board.tasks as Array<Record<string, unknown>>)[0], conversationId: 'conv-8fd6' };
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: () => fx.detail(task),
    });
    await harness.render();

    const openButton = harness.$('[data-run-center-open]');
    expect(openButton).not.toBeNull();
    expect(openButton!.getAttribute('data-run-center-open')).toBe('conv-8fd6');

    await harness.click('[data-run-center-open]');
    expect(harness.setViewCalls).toEqual([['conversation', 'conv-8fd6']]);
  });
});

// -----------------------------------------------------------------------------
// Baseline witnesses for defects Phase 1 / Phase 3 will fix.
//
// The RC-P0-01 witness that used to head this block is gone: the fix landed, so
// the assertion was inverted and moved to `run-center-refresh.test.ts`.
//
// These assert what the code does TODAY, not what it should do. Each one is
// expected to be inverted by the ticket named in its title — that inversion is
// the proof the fix landed. They are kept apart from the smoke cases above so
// nobody mistakes them for desired behaviour.
// -----------------------------------------------------------------------------
describe('RC-T01 baseline witnesses (to be inverted by Phase 1 / Phase 3)', () => {
  it('RC-P0-07: no Open Task button on the healthy path, because taskSummary() omits conversationId', async () => {
    const board = fullBoard();
    // `taskSummary()` in ipc-service.ts builds detail.collaboration.task without
    // conversationId, and `detailsHtml()` prefers that object over the board task.
    const detailTask = (board.tasks as Array<Record<string, unknown>>)[0];
    expect(detailTask.conversationId).toBeUndefined();

    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: () => fx.detail(detailTask),
    });
    await harness.render();

    // The detail pane renders, and has zero buttons pointing anywhere.
    expect(harness.$('.run-center-detail')).not.toBeNull();
    expect(harness.$('[data-run-center-open]')).toBeNull();
    // RC-P0-07 must make this button present on exactly this path.
  });

  it('RC-P2-10: resume is never offered for a group-chat task', async () => {
    const board = fx.board([
      fx.boardTask({
        taskId: 'task-failed',
        column: 'attention',
        status: 'failed',
        actions: { retry: true, skip: false, resume: false, abort: false },
      }),
    ]);
    harness = await createRunCenterHarness({
      board,
      sessions: { sessions: [fx.session()] },
      detail: () => fx.detail((board.tasks as Array<Record<string, unknown>>)[0]),
    });
    await harness.render();

    expect(harness.$('[data-run-center-action="retry"]')).not.toBeNull();
    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
  });
});
