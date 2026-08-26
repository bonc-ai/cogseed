// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Phase 3B — visual reachability, to the extent it can honestly be tested here.
//
//   RC-P0-06  the board must not clip a whole column off-screen
//   RC-P2-12  the sidebar icon must not fall back to a generic glyph
//   RC-P2-19  an empty board must say *why* it is empty
//
// Scope boundary, stated plainly: jsdom performs no layout, so nothing in this
// file proves the completed column is visible. `getBoundingClientRect()` is
// permanently zero here, and an assertion like `column.right <= main.right`
// would pass unconditionally — a test that can never fail is worse than none.
// Real visibility is proven by the Electron/CDP smoke at four viewport widths;
// see docs/run-center/evidence/phase-3/.
//
// What is testable here is structure and copy: the columns all exist in the
// DOM, the board carries no hardcoded width that forces overflow, and the
// empty state distinguishes "nothing exists" from "nothing recent".

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

const ROOT = path.join(__dirname, '../..');

describe('RC-P0-06 board column structure', () => {
  it('keeps all four columns in the DOM even when only one has cards', async () => {
    // The reported failure looked like "the board is empty" while the completed
    // column held eight cards off-screen.
    const tasks = Array.from({ length: 8 }, (_, i) => fx.boardTask({
      taskId: `task-done-${i}`,
      column: 'completed',
      status: 'completed',
    }));
    harness = await createRunCenterHarness({
      board: fx.board(tasks),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-done-0' })] },
      detail: () => fx.detail(tasks[0]),
    });
    await harness.render();

    const columns = harness.$$('[data-dashboard-board-column]')
      .map((n) => n.getAttribute('data-dashboard-board-column'));
    expect(columns).toEqual(['pending', 'running', 'attention', 'completed']);

    const completedCards = harness.$$('[data-dashboard-board-column="completed"] [data-dashboard-board-task-id]');
    expect(completedCards).toHaveLength(8);
  });

  it('no longer pins the grid to a width wider than the pane it sits in', () => {
    // The clip had one cause: `.dashboard-board-columns` demanded `min-width:
    // 820px` inside a pane that is ~608px at a 1456px viewport, and the
    // viewport breakpoints (1050/720) could not see a *container* problem.
    //
    // This reads CSS rather than computing layout, and is a guard against
    // reintroducing the fixed track/width pair — not a proof of visibility.
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
    const rule = css.split('\n').find((line) => line.includes('.dashboard-board-columns {'));
    expect(rule).toBeTruthy();
    expect(rule).not.toMatch(/min-width:\s*\d+px/);
    // Tracks must be able to wrap rather than being fixed at four.
    expect(rule).toMatch(/repeat\(\s*auto-fit/);
    // The horizontal scroller stays as a last-resort safety net.
    expect(css).toMatch(/\.dashboard-board-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });
});

describe('RC-P2-12 activity icon', () => {
  it('defines the icon the Run Center sidebar entry asks for', () => {
    const icons = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/icons.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

    // index.html requests `activity`; without a definition the loader silently
    // substituted the generic `info` glyph, so the entry read as a help link.
    expect(html).toContain('data-ui-icon="activity"');
    expect(icons).toMatch(/\bactivity:\s*'/);
  });
});

describe('RC-P2-19 empty board copy', () => {
  async function mountEmpty(retentionHiddenCount: number) {
    const h = await createRunCenterHarness({
      board: fx.board([], { retentionHiddenCount }),
      sessions: { sessions: [] },
      detail: () => ({ session: null, collaboration: null }),
    });
    await h.render();
    return h;
  }

  it('says there is nothing when the store really is empty', async () => {
    harness = await mountEmpty(0);
    const empty = harness.$('.run-center-main .run-center-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent ?? '').toMatch(/no tasks to show/i);
  });

  it('explains the time window when history exists but is out of range', async () => {
    harness = await mountEmpty(12);
    const empty = harness.$('.run-center-main .run-center-empty');
    expect(empty).not.toBeNull();
    const copy = empty!.textContent ?? '';
    // Must not claim there are no tasks — there are twelve.
    expect(copy).not.toMatch(/^no tasks to show/i);
    expect(copy).toMatch(/time window/i);
    // ...and must point at where the history actually is.
    expect(copy).toMatch(/session/i);
  });

  it('keeps the ordinary empty copy when the board simply has no cards yet', async () => {
    harness = await mountEmpty(0);
    expect(harness.$('.run-center-main .run-center-empty')!.textContent ?? '')
      .not.toMatch(/time window/i);
  });
});
