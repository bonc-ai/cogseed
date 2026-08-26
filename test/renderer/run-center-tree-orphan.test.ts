// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P2-20 — a turn whose parent run is missing must not vanish from the tree.
//
// `taskTree()` decided roots with `!byParent.has(task.parentTaskId)`. But
// `byParent` is keyed by parent id and populated by the *children*, so that
// lookup is true for every task that has a parent at all — the predicate
// collapsed to `!task.parentTaskId`. A turn whose parent run had aged out of
// the retention window matched neither the root branch nor any rendered
// parent, so `roots` came back empty and the whole view fell through to the
// "no tasks" empty state — over real, still-existing data that the board was
// happily showing at the same moment.
//
// The fix promotes such a turn to a root of its own. It does NOT invent a
// parent, guess a status, or touch the store.

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

const CONVERSATION_ID = 'conv-8fd6';

function run(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fx.boardTask({
    taskId: id,
    titleKey: 'run_center.task_kind_group_chat',
    runOrdinal: 1,
    conversationId: CONVERSATION_ID,
    conversationShortId: 'conv-8fd',
    ...overrides,
  });
}

function turn(id: string, parentTaskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fx.boardTask({
    taskId: id,
    parentTaskId,
    titleKey: 'run_center.task_kind_agent_turn',
    runOrdinal: 1,
    turnOrdinal: 1,
    agentId: 'planner',
    conversationId: CONVERSATION_ID,
    conversationShortId: 'conv-8fd',
    ...overrides,
  });
}

/** Render the Runs view over `tasks`, with `selected` chosen on the board. */
async function runsView(tasks: Array<Record<string, unknown>>, selected = tasks[0]) {
  const created = await createRunCenterHarness({
    board: fx.board(tasks),
    sessions: { sessions: [fx.session({ latestTaskId: String(selected.taskId) })] },
    detail: () => fx.detail(selected, { tasks }),
  });
  await created.render();
  await created.click(`[data-dashboard-board-task-id="${selected.taskId}"]`);
  await created.click('[data-run-center-view="runs"]');
  return created;
}

/** The Runs view has two sections — tasks, then timeline. Scope to the first. */
const tasksEmptyState = (h: RunCenterHarness) =>
  h.$('.run-center-runs > section:first-child .run-center-empty');
const treeIds = (h: RunCenterHarness) =>
  h.$$('.run-center-tree-task').map((n) => n.getAttribute('data-run-center-task'));
const rootIds = (h: RunCenterHarness) =>
  h.$$('.run-center-task-tree > li > .run-center-tree-task').map((n) => n.getAttribute('data-run-center-task'));

describe('RC-P2-20 Case 1 — normal parent/child tree is unchanged', () => {
  it('nests the turns under their run', async () => {
    const tasks = [
      run('cogseed-task-run-1'),
      turn('cogseed-task-turn-1', 'cogseed-task-run-1', { turnOrdinal: 1 }),
      turn('cogseed-task-turn-2', 'cogseed-task-run-1', { turnOrdinal: 2 }),
    ];
    harness = await runsView(tasks);

    expect(rootIds(harness)).toEqual(['cogseed-task-run-1']);
    expect(treeIds(harness)).toHaveLength(3);
    expect(harness.$$('.run-center-task-tree > li > ul > li > .run-center-tree-task')).toHaveLength(2);
    // No orphan marker anywhere on a healthy tree.
    expect(harness.$('[data-run-center-orphan]')).toBeNull();
  });
});

describe('RC-P2-20 Case 2 — an orphan turn is promoted to a root', () => {
  it('renders the turn instead of falling through to the empty state', async () => {
    // The exact shape that used to disappear: the parent is not in the
    // projection at all.
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', { turnOrdinal: 2 });
    harness = await runsView([orphan]);

    expect(tasksEmptyState(harness)).toBeNull();
    expect(rootIds(harness)).toEqual(['cogseed-task-turn-2']);
  });

  it('keeps its real status and identity, and names the missing parent only as a marker', async () => {
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', {
      status: 'failed',
      column: 'attention',
      turnOrdinal: 2,
    });
    harness = await runsView([orphan]);

    const node = harness.$('.run-center-tree-task')!;
    expect(node.querySelector('.run-center-status')?.textContent).toBe('Failed');
    expect(node.querySelector('[data-run-center-identity]')?.textContent).toContain('Turn 2');

    const marker = node.querySelector('[data-run-center-orphan]');
    expect(marker?.getAttribute('data-run-center-orphan')).toBe('cogseed-task-run-gone');
    expect(marker?.textContent).toBe('Parent run unavailable');
  });

  it('invents no parent row and prints no undefined placeholder', async () => {
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone');
    harness = await runsView([orphan]);

    // Exactly one node: the turn itself. No fabricated run above it.
    expect(treeIds(harness)).toEqual(['cogseed-task-turn-2']);
    expect(harness.$('[data-run-center-task="cogseed-task-run-gone"]')).toBeNull();
    expect(harness.$('.run-center-task-tree')!.textContent).not.toMatch(/undefined|null|NaN/);
  });
});

describe('RC-P2-20 Case 3 — several orphans do not swallow one another', () => {
  it('gives each missing-parent turn its own root', async () => {
    const tasks = [
      turn('cogseed-task-turn-a', 'cogseed-task-run-gone-1', { agentId: 'planner' }),
      turn('cogseed-task-turn-b', 'cogseed-task-run-gone-2', { agentId: 'reviewer' }),
      turn('cogseed-task-turn-c', 'cogseed-task-run-gone-3', { agentId: 'worker' }),
    ];
    harness = await runsView(tasks);

    expect(rootIds(harness)).toEqual([
      'cogseed-task-turn-a', 'cogseed-task-turn-b', 'cogseed-task-turn-c',
    ]);
    // Three separate roots, not one synthetic run holding three children.
    expect(harness.$$('.run-center-task-tree > li')).toHaveLength(3);
    expect(harness.$$('[data-run-center-orphan]')).toHaveLength(3);
  });

  it('keeps two orphans that name the same missing parent side by side', async () => {
    const tasks = [
      turn('cogseed-task-turn-a', 'cogseed-task-run-gone', { turnOrdinal: 1 }),
      turn('cogseed-task-turn-b', 'cogseed-task-run-gone', { turnOrdinal: 2 }),
    ];
    harness = await runsView(tasks);

    expect(rootIds(harness)).toEqual(['cogseed-task-turn-a', 'cogseed-task-turn-b']);
  });
});

describe('RC-P2-20 Case 4 — a healthy tree and an orphan coexist', () => {
  it('renders both without either interfering with the other', async () => {
    const tasks = [
      run('cogseed-task-run-1'),
      turn('cogseed-task-turn-1', 'cogseed-task-run-1', { turnOrdinal: 1 }),
      turn('cogseed-task-turn-orphan', 'cogseed-task-run-gone', { turnOrdinal: 4, runOrdinal: 9 }),
    ];
    harness = await runsView(tasks);

    expect(rootIds(harness)).toEqual(['cogseed-task-run-1', 'cogseed-task-turn-orphan']);
    expect(treeIds(harness)).toHaveLength(3);
    // The healthy run keeps its nesting.
    expect(harness.$$('.run-center-task-tree > li:first-child > ul > li')).toHaveLength(1);
    // Only the orphan is marked.
    expect(harness.$$('[data-run-center-orphan]')).toHaveLength(1);
    expect(harness.$('[data-run-center-orphan]')!.getAttribute('data-run-center-orphan'))
      .toBe('cogseed-task-run-gone');
  });
});

describe('RC-P2-20 Case 5 — the orphan stays reachable', () => {
  it('opens its detail and keeps the conversation exit', async () => {
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', { turnOrdinal: 2 });
    harness = await runsView([orphan]);

    await harness.click('[data-run-center-task="cogseed-task-turn-2"]');

    expect(harness.$('.run-center-detail')).not.toBeNull();
    const open = harness.$('[data-run-center-open]');
    expect(open?.getAttribute('data-run-center-open')).toBe(CONVERSATION_ID);

    await harness.click('[data-run-center-open]');
    expect(harness.setViewCalls).toEqual([['conversation', CONVERSATION_ID]]);
  });

  it('offers no resume or retry it cannot honour', async () => {
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', {
      status: 'failed',
      column: 'attention',
      actions: { retry: false, skip: false, resume: false, abort: false },
    });
    harness = await runsView([orphan]);
    await harness.click('[data-run-center-task="cogseed-task-turn-2"]');

    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();
  });
});

describe('RC-P2-20 Case 6 — the fallback adds no new exposure', () => {
  it('carries only the parent task id, never user text', async () => {
    const secret = 'merge the payroll spreadsheet';
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', {
      title: secret,
      sessionTitle: secret,
      sessionTitleKey: undefined,
    });
    harness = await runsView([orphan]);

    const marker = harness.$('[data-run-center-orphan]')!;
    expect(marker.textContent).toBe('Parent run unavailable');
    expect(marker.textContent).not.toContain(secret);
    // The identity is untouched by the fallback.
    const identity = harness.$('[data-run-center-identity]')!.textContent ?? '';
    expect(identity).not.toContain(secret);
    expect(identity).toContain('Turn 1');
  });

  it('does not fabricate a run ordinal for the orphan', async () => {
    // `runOrdinal` is whatever the projection computed; the renderer must not
    // renumber it just because the parent row is absent.
    const orphan = turn('cogseed-task-turn-2', 'cogseed-task-run-gone', { runOrdinal: 7, turnOrdinal: 3 });
    harness = await runsView([orphan]);

    const identity = harness.$('[data-run-center-identity]')!.textContent ?? '';
    expect(identity).toContain('Run 7');
    expect(identity).toContain('Turn 3');
  });
});

describe('RC-P2-20 — no real task may disappear', () => {
  it('renders tasks flat rather than showing an empty state over a parent cycle', async () => {
    // Not reachable through normal writes, but the store is plain JSON and the
    // backend guards the same hazard. Hanging or blanking would both be worse
    // than a flat list.
    const tasks = [
      turn('cogseed-task-a', 'cogseed-task-b'),
      turn('cogseed-task-b', 'cogseed-task-a'),
    ];
    harness = await runsView(tasks);

    expect(tasksEmptyState(harness)).toBeNull();
    expect(treeIds(harness)).toEqual(['cogseed-task-a', 'cogseed-task-b']);
  });

  it('still shows the empty state when there genuinely are no tasks', async () => {
    const task = run('cogseed-task-run-1');
    const created = await createRunCenterHarness({
      board: fx.board([task]),
      sessions: { sessions: [fx.session({ latestTaskId: 'cogseed-task-run-1' })] },
      detail: () => fx.detail(task, { tasks: [] }),
    });
    harness = created;
    await harness.render();
    await harness.click('[data-dashboard-board-task-id="cogseed-task-run-1"]');
    await harness.click('[data-run-center-view="runs"]');

    expect(harness.$('.run-center-task-tree')).toBeNull();
    expect(tasksEmptyState(harness)).not.toBeNull();
  });
});
