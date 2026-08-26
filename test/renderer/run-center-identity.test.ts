// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P0-13 — the rendered half of card identity.
//
// The backend half (ordinal derivation, truncation, privacy) is proven in
// test/main/features/cogseed_backend/task-identity.test.ts against the real
// projection. What has to hold here is that the projection's identity reaches
// the screen on every surface where cards are otherwise indistinguishable:
// the board, the run tree, and the detail pane.
//
// Fixtures mirror the real projection shape — a parent run task plus its child
// turn tasks — because `taskTree()` builds its hierarchy from `parentTaskId`
// and renders nothing at all for a child whose parent is absent. Handing it a
// bag of orphaned children would test the empty state, not the tree.

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

/** Minutes ago, so the relative-time component is deterministic. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const CONVERSATION_SHORT_ID = 'conv-abc';

function run(ordinal: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fx.boardTask({
    taskId: `cogseed-task-run-${ordinal}`,
    titleKey: 'run_center.task_kind_group_chat',
    runOrdinal: ordinal,
    conversationShortId: CONVERSATION_SHORT_ID,
    conversationId: 'conv-abcdef123456',
    agentId: undefined,
    createdAt: minutesAgo(60 - ordinal * 10),
    updatedAt: minutesAgo(60 - ordinal * 10),
    ...overrides,
  });
}

function turn(
  runOrdinal: number,
  turnOrdinal: number,
  agentId: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return fx.boardTask({
    taskId: `cogseed-task-run-${runOrdinal}-turn-${turnOrdinal}`,
    parentTaskId: `cogseed-task-run-${runOrdinal}`,
    titleKey: 'run_center.task_kind_agent_turn',
    runOrdinal,
    turnOrdinal,
    agentId,
    conversationShortId: CONVERSATION_SHORT_ID,
    conversationId: 'conv-abcdef123456',
    createdAt: minutesAgo(50 - turnOrdinal),
    updatedAt: minutesAgo(50 - turnOrdinal),
    ...overrides,
  });
}

/**
 * Three runs in one session; the first has three turns, two of them driven by
 * the *same* agent — the case where only the turn ordinal separates them.
 * The third turn carries no `agentId`, which is the projection's own fallback
 * (the field is omitted when `rendererSafeIdentifier()` rejects it).
 *
 *   run 1 ├─ turn 1 (planner)
 *         ├─ turn 2 (planner)   ← same agent as turn 1
 *         └─ turn 3 (no agentId)
 *   run 2
 *   run 3
 */
function sessionTree(): Array<Record<string, unknown>> {
  return [
    run(1),
    turn(1, 1, 'planner'),
    turn(1, 2, 'planner'),
    turn(1, 3, undefined),
    run(2),
    run(3),
  ];
}

function identitiesIn(scope: RunCenterHarness, selector: string): string[] {
  return scope.$$(selector).map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

async function boardWith(
  tasks: Array<Record<string, unknown>>,
  options: { lang?: 'en' | 'zh'; selected?: number } = {},
): Promise<RunCenterHarness> {
  const selected = tasks[options.selected ?? 0];
  const created = await createRunCenterHarness({
    ...(options.lang ? { lang: options.lang } : {}),
    board: fx.board(tasks),
    sessions: { sessions: [fx.session({ latestTaskId: String(selected.taskId) })] },
    detail: () => fx.detail(selected, { tasks }),
  });
  await created.render();
  return created;
}

describe('RC-P0-13 parent run identity', () => {
  it('distinguishes three runs of one session that share a title', async () => {
    harness = await boardWith(sessionTree());

    const cards = harness.$$('.dashboard-board-card[data-dashboard-board-task-id]');
    expect(cards.length).toBe(6);

    // The bug this closes: every card in the session rendered the same label.
    const titles = harness.$$('.dashboard-board-card strong').map((n) => n.textContent?.trim());
    expect(new Set(titles).size).toBeLessThan(titles.length);

    const runIdentities = ['1', '2', '3'].map((n) =>
      harness!.$(`[data-run-center-identity="cogseed-task-run-${n}"]`)?.textContent?.trim() ?? '');

    expect(runIdentities.every(Boolean)).toBe(true);
    expect(new Set(runIdentities).size).toBe(3);
    for (const [index, identity] of runIdentities.entries()) {
      expect(identity).toContain(`Run ${index + 1}`);
    }
  });

  it('keeps every card in the session pairwise distinguishable', async () => {
    harness = await boardWith(sessionTree());

    const identities = identitiesIn(harness, '.dashboard-board-card [data-run-center-identity]');

    expect(identities).toHaveLength(6);
    expect(new Set(identities).size).toBe(6);
  });

  it('does not depend on the order the board happens to list tasks in', async () => {
    const ordered = sessionTree();
    const shuffled = [ordered[4], ordered[1], ordered[5], ordered[3], ordered[0], ordered[2]];

    // Scoped to the board: the detail pane renders the *selected* task's
    // identity too, and the two runs select different tasks by construction.
    const BOARD = '.dashboard-board-card [data-run-center-identity]';

    harness = await boardWith(ordered);
    const fromOrdered = identitiesIn(harness, BOARD).sort();
    harness.destroy();

    harness = await boardWith(shuffled);
    const fromShuffled = identitiesIn(harness, BOARD).sort();

    expect(fromShuffled).toEqual(fromOrdered);
  });
});

describe('RC-P0-13 actor turn identity', () => {
  it('separates two turns of the same agent by their ordinal', async () => {
    harness = await boardWith(sessionTree());

    const first = harness.$('[data-run-center-identity="cogseed-task-run-1-turn-1"]')?.textContent ?? '';
    const second = harness.$('[data-run-center-identity="cogseed-task-run-1-turn-2"]')?.textContent ?? '';

    expect(first).toContain('planner');
    expect(second).toContain('planner');
    expect(first).toContain('Turn 1');
    expect(second).toContain('Turn 2');
    expect(first).not.toEqual(second);
  });

  it('anchors every turn to its own run', async () => {
    harness = await boardWith(sessionTree());

    for (const ordinal of [1, 2, 3]) {
      const identity = harness.$(`[data-run-center-identity="cogseed-task-run-1-turn-${ordinal}"]`)?.textContent ?? '';
      expect(identity).toContain('Run 1');
      expect(identity).toContain(`Turn ${ordinal}`);
    }
  });

  it('stays intact and renders no placeholder when agentId is absent', async () => {
    harness = await boardWith(sessionTree());

    const identity = harness.$('[data-run-center-identity="cogseed-task-run-1-turn-3"]')?.textContent ?? '';

    // The turn is still identifiable without an agent — ordinals carry it.
    expect(identity).toContain('Run 1');
    expect(identity).toContain('Turn 3');
    expect(identity).toContain(CONVERSATION_SHORT_ID);
    // And the gap must not surface as a literal.
    expect(identity).not.toMatch(/undefined|null|NaN/);
    expect(identity).not.toMatch(/·\s*·/);
    expect(identity.trim()).not.toMatch(/·\s*$/);
  });

  it('renders no identity at all when the projection carries none', async () => {
    // A legacy record, or a single-task reply with no session context: the
    // card already shows a timestamp, so relative time alone is not identity.
    harness = await boardWith([fx.boardTask({ taskId: 'cogseed-task-bare', agentId: undefined })]);

    expect(harness.$('[data-run-center-identity]')).toBeNull();
  });
});

describe('RC-P0-13 identity agrees across surfaces', () => {
  it('shows the same identity on the board and in the run tree', async () => {
    const tasks = sessionTree();
    harness = await boardWith(tasks, { selected: 1 });
    await harness.click('[data-dashboard-board-task-id="cogseed-task-run-1-turn-1"]');

    const onBoard = harness.$('.dashboard-board-card [data-run-center-identity="cogseed-task-run-1-turn-1"]')
      ?.textContent?.trim();

    await harness.click('[data-run-center-view="runs"]');
    const inTree = harness.$('.run-center-tree-task [data-run-center-identity="cogseed-task-run-1-turn-1"]')
      ?.textContent?.trim();

    expect(onBoard).toBeTruthy();
    expect(inTree).toBe(onBoard);
  });

  it('distinguishes the run tree entries from one another', async () => {
    const tasks = sessionTree();
    harness = await boardWith(tasks, { selected: 1 });
    await harness.click('[data-dashboard-board-task-id="cogseed-task-run-1-turn-1"]');
    await harness.click('[data-run-center-view="runs"]');

    // Real hierarchy, not a flat list: the parent run holds its three turns.
    const parents = harness.$$('.run-center-task-tree > li > .run-center-tree-task');
    expect(parents.length).toBe(3);

    const treeIdentities = identitiesIn(harness, '.run-center-tree-task [data-run-center-identity]');
    expect(treeIdentities).toHaveLength(6);
    expect(new Set(treeIdentities).size).toBe(6);
  });

  it('repeats the identity in the detail pane, where the actions are', async () => {
    const tasks = sessionTree();
    harness = await boardWith(tasks, { selected: 2 });
    await harness.click('[data-dashboard-board-task-id="cogseed-task-run-1-turn-2"]');

    const detail = harness.$('.run-center-detail [data-run-center-identity]')?.textContent ?? '';
    const card = harness.$('.dashboard-board-card [data-run-center-identity="cogseed-task-run-1-turn-2"]')
      ?.textContent ?? '';

    for (const part of ['Run 1', 'Turn 2', 'planner', CONVERSATION_SHORT_ID]) {
      expect(detail).toContain(part);
      expect(card).toContain(part);
    }
  });
});

describe('RC-P0-13 privacy and stability', () => {
  it('carries no user-authored text into any identity', async () => {
    const secret = 'draft the acquisition memo for legal review';
    harness = await boardWith(sessionTree().map((task) => ({
      ...task,
      // Whatever a future projection might put in these, identity must not
      // pick it up. DECISION-01 rejected candidate C precisely here.
      title: secret,
      sessionTitle: secret,
    })));

    const identities = identitiesIn(harness, '[data-run-center-identity]');
    expect(identities.length).toBeGreaterThan(0);
    for (const identity of identities) {
      expect(identity).not.toContain(secret);
    }
  });

  it('never falls back to the conversation title when ordinals are present', async () => {
    harness = await boardWith(sessionTree().map((task) => ({
      ...task,
      sessionTitle: 'Q3 layoffs planning',
      sessionTitleKey: undefined,
    })));

    for (const identity of identitiesIn(harness, '[data-run-center-identity]')) {
      expect(identity).not.toContain('Q3 layoffs');
    }
  });

  it('shows only the short conversation id, never the full one', async () => {
    harness = await boardWith(sessionTree());

    for (const identity of identitiesIn(harness, '[data-run-center-identity]')) {
      expect(identity).not.toContain('conv-abcdef123456');
    }
    expect(identitiesIn(harness, '[data-run-center-identity]').every((i) => i.includes(CONVERSATION_SHORT_ID)))
      .toBe(true);
  });

  it('renders relative time rather than a second copy of the timestamp', async () => {
    harness = await boardWith(sessionTree());

    const identity = harness.$('[data-run-center-identity="cogseed-task-run-1-turn-1"]')?.textContent ?? '';
    expect(identity).toMatch(/\d+[mhd] ago/);
  });

  // Relative time and ordinals are rendered through `t()`. Switching language
  // must translate the identity without collapsing two cards into one label.
  it('stays pairwise distinct under a different locale', async () => {
    harness = await boardWith(sessionTree(), { lang: 'zh' });

    const identities = identitiesIn(harness, '.dashboard-board-card [data-run-center-identity]');
    expect(identities).toHaveLength(6);
    expect(new Set(identities).size).toBe(6);
    expect(identities.some((identity) => identity.includes('第 1 次运行'))).toBe(true);
    for (const identity of identities) {
      expect(identity).not.toMatch(/undefined|null|NaN/);
      expect(identity).not.toContain('run_center.identity_');
    }
  });
});
