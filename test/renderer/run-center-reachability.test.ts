// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Phase 3A — interaction reachability.
//
//   RC-P0-07  the Open Conversation exit exists on the healthy path
//   RC-P1-08  waiting_user gets a real exit, not a fake resume
//   RC-P2-10  group-chat resume is never offered, in any state
//   RC-P2-11  the column filters only appear where they actually apply
//
// The distinction these tests exist to protect: opening the conversation is
// NOT retrying and NOT resuming the original run. It starts a new run. The UI
// must never blur the three, because Group Chat cannot resume a run at all and
// a restart-interrupted run has no retryable turn.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunCenterHarness,
  runCenterFixtures as fx,
  type RunCenterHarness,
} from './_run-center-harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Read the real locale tables, exactly as the harness does. */
const locale = (lang: 'en' | 'zh'): Record<string, string> => JSON.parse(
  fs.readFileSync(path.join(__dirname, '../..', 'src/renderer/locales', `${lang}.json`), 'utf8'),
) as Record<string, string>;
const en = locale('en');
const zh = locale('zh');

let harness: RunCenterHarness | null = null;

afterEach(() => {
  harness?.destroy();
  harness = null;
});

/**
 * Mirrors what `taskSummary()` now produces: the detail snapshot's task carries
 * `conversationId`. Before RC-P0-07 it did not, and `detailsHtml()` prefers the
 * snapshot over the board task — so the button vanished on the healthy path and
 * appeared only when the detail read failed.
 */
async function mount(overrides: Record<string, unknown> = {}) {
  const task = fx.boardTask({
    taskId: 'task-a',
    column: 'running',
    status: 'running',
    conversationId: 'conv-8fd6',
    ...overrides,
  });
  const h = await createRunCenterHarness({
    board: fx.board([task]),
    sessions: { sessions: [fx.session({ latestTaskId: 'task-a' })] },
    detail: () => fx.detail(task),
  });
  await h.render();
  return { harness: h, task };
}

describe('RC-P0-07 Open Conversation exit', () => {
  it('renders the exit on the healthy detail path', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    // The detail snapshot loaded successfully — the button must be here, which
    // is precisely the case that used to lose it.
    expect(harness.$('.run-center-detail')).not.toBeNull();
    const open = harness.$('[data-run-center-open]');
    expect(open).not.toBeNull();
    expect(open!.getAttribute('data-run-center-open')).toBe('conv-8fd6');
  });

  it('routes the click to the conversation view', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    await harness.click('[data-run-center-open]');

    expect(harness.setViewCalls).toEqual([['conversation', 'conv-8fd6']]);
    // Opening a conversation is navigation, not a task action. It must not
    // issue `cogseed.task.action` under any name.
    expect(harness.callsTo('cogseed.task.action')).toHaveLength(0);
  });

  it('omits the exit when the task genuinely has no conversation', async () => {
    const task = fx.boardTask({ taskId: 'task-native', column: 'running', executionKind: 'cogseed-native' });
    delete (task as Record<string, unknown>).conversationId;
    harness = await createRunCenterHarness({
      board: fx.board([task]),
      sessions: { sessions: [fx.session({ latestTaskId: 'task-native' })] },
      detail: () => fx.detail(task),
    });
    await harness.render();

    expect(harness.$('[data-run-center-open]')).toBeNull();
  });

  // Phase 2 linkage: the dead end is now genuinely exited.
  it('gives an app_restart task an exit without implying retry or resume', async () => {
    const mounted = await mount({
      status: 'failed',
      column: 'attention',
      errorCode: 'app_restart',
      actions: { retry: false, skip: false, resume: false, abort: false },
    });
    harness = mounted.harness;

    // No retry, no resume — the runtime cannot honour either.
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();
    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    // But the conversation is reachable, so this is no longer a dead end.
    expect(harness.$('[data-run-center-open]')).not.toBeNull();
    // ...and the copy says so, in those terms.
    const note = harness.$('[data-run-center-retry-unavailable]');
    expect(note).not.toBeNull();
    const copy = note!.textContent ?? '';
    expect(copy).toMatch(/cannot be resumed or retried/i);
    expect(copy).toMatch(/new run/i);
  });
});

describe('RC-P1-08 waiting_user exit', () => {
  async function waiting(extra: Record<string, unknown> = {}) {
    return mount({
      status: 'waiting_user',
      column: 'attention',
      actions: { retry: false, skip: false, resume: false, abort: false },
      ...extra,
    });
  }

  it('emphasises the conversation exit and explains why', async () => {
    const mounted = await waiting();
    harness = mounted.harness;

    const open = harness.$('[data-run-center-open]');
    expect(open).not.toBeNull();
    // Emphasised, because here the exit *is* the action.
    expect(open!.hasAttribute('data-run-center-open-primary')).toBe(true);

    const hint = harness.$('[data-run-center-waiting-user]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent ?? '').toMatch(/waiting for you/i);
  });

  it('never dresses waiting_user up as a resume', async () => {
    const mounted = await waiting();
    harness = mounted.harness;

    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();
    // No backend action is introduced for this state at all.
    expect(harness.callsTo('cogseed.task.action')).toHaveLength(0);
  });

  it('reaches the real conversation on click', async () => {
    const mounted = await waiting();
    harness = mounted.harness;

    await harness.click('[data-run-center-open]');

    expect(harness.setViewCalls).toEqual([['conversation', 'conv-8fd6']]);
  });

  it('stays reachable for a waiting_user task that survived a restart', async () => {
    // Phase 2 deliberately leaves these untouched — the run had already ended
    // normally, so a restart must not relabel it. It still needs an exit.
    const mounted = await waiting({ updatedAt: '2026-08-20T00:00:00.000Z' });
    harness = mounted.harness;

    expect(harness.$('[data-run-center-open]')).not.toBeNull();
    expect(harness.$('[data-run-center-waiting-user]')).not.toBeNull();
  });

  it('does not emphasise the exit for ordinary running tasks', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    expect(harness.$('[data-run-center-open]')!.hasAttribute('data-run-center-open-primary')).toBe(false);
    expect(harness.$('[data-run-center-waiting-user]')).toBeNull();
  });
});

describe('RC-P2-10 group-chat resume invariant', () => {
  // Group Chat has no run resume: `taskActions()` hardcodes `resume: false` and
  // `retryCogSeedTask` throws for group-chat. Offering it anywhere would be a
  // promise nothing can keep, so this is locked across every reachable state.
  const STATES = [
    { status: 'created', column: 'pending' },
    { status: 'queued', column: 'pending' },
    { status: 'running', column: 'running' },
    { status: 'waiting_user', column: 'attention' },
    { status: 'failed', column: 'attention' },
    { status: 'failed', column: 'attention', errorCode: 'app_restart' },
    { status: 'recoverable', column: 'attention' },
    { status: 'completed', column: 'completed' },
    { status: 'cancelled', column: 'archived' },
  ] as const;

  // The projection is the single source of action truth and the renderer
  // faithfully renders it; the invariant itself is asserted against the real
  // `taskActions()` in
  // test/main/features/cogseed_backend/group-chat-resume-invariant.test.ts.
  // Here we only confirm the renderer draws no resume affordance for the
  // action sets group-chat actually produces.
  it.each(STATES)('offers no resume for a group-chat task in %o', async (state) => {
    const mounted = await mount({
      ...state,
      executionKind: 'group-chat',
      actions: { retry: state.status === 'failed', skip: false, resume: false, abort: false },
    });
    harness = mounted.harness;

    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
  });
});

describe('RC-P2-11 filter scope', () => {
  it('offers the filters on the board, where they apply', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    const filters = harness.$$('[data-run-center-filter]');
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((node) => !node.hasAttribute('disabled'))).toBe(true);
    expect(harness.$('.run-center-filters')!.hasAttribute('hidden')).toBe(false);
  });

  it.each(['runs', 'collaboration'] as const)('disables and hides them in the %s view', async (view) => {
    const mounted = await mount();
    harness = mounted.harness;

    await harness.click(`[data-run-center-view="${view}"]`);

    // These views render the selected session's detail and never consult
    // `state.filter`, so a live-looking filter promised a scope it never had.
    const container = harness.$('.run-center-filters')!;
    expect(container.hasAttribute('hidden')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    for (const node of harness.$$('[data-run-center-filter]')) {
      expect(node.hasAttribute('disabled')).toBe(true);
      expect(node.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('restores them on returning to the board', async () => {
    const mounted = await mount();
    harness = mounted.harness;

    await harness.click('[data-run-center-view="runs"]');
    await harness.click('[data-run-center-view="board"]');

    expect(harness.$('.run-center-filters')!.hasAttribute('hidden')).toBe(false);
    expect(harness.$$('[data-run-center-filter]').every((n) => !n.hasAttribute('disabled'))).toBe(true);
  });
});

// Phase 2 → Phase 3 linkage. Once an app_restart run is `failed` and offers no
// retry or resume, the only remaining move is "open the conversation and start
// a new run". Three distinct meanings, so three distinct strings: conflating
// them is how a user ends up believing the old run resumed.
describe('Phase 2 → 3 — retry / resume / open are never conflated', () => {
  const t = (key: string) => en[key] ?? '';

  it('labels the exit as opening the conversation, not acting on the task', async () => {
    const mounted = await mount({
      status: 'failed',
      errorCode: 'app_restart',
      column: 'attention',
      actions: { retry: false, skip: false, resume: false, abort: false },
    });
    harness = mounted.harness;

    const label = harness.$('[data-run-center-open]')!.textContent?.trim() ?? '';

    expect(label).toBe(t('run_center.open_task'));
    expect(label).toMatch(/conversation/i);
    // The button navigates; it does not re-run anything.
    expect(label).not.toMatch(/retry|resume|restart|continue/i);
  });

  it('keeps the three action words distinct in both locales', () => {
    for (const table of [en, zh]) {
      const retry = table['run_center.retry'];
      const resume = table['run_center.resume'];
      const open = table['run_center.open_task'];

      expect(new Set([retry, resume, open]).size).toBe(3);
      // And the exit must not be phrased as either of the other two.
      expect(open).not.toContain(retry);
      expect(open).not.toContain(resume);
    }
  });

  it('tells an app_restart run it cannot be resumed or retried, and what to do instead', async () => {
    const mounted = await mount({
      status: 'failed',
      errorCode: 'app_restart',
      column: 'attention',
      actions: { retry: false, skip: false, resume: false, abort: false },
    });
    harness = mounted.harness;

    const copy = harness.$('[data-run-center-retry-unavailable]')!.textContent ?? '';

    expect(copy).toMatch(/cannot be resumed or retried/i);
    expect(copy).toMatch(/start a new run/i);
    // Crucially it does not claim the runtime is still working on it.
    expect(copy).not.toMatch(/still running|in progress|in the background/i);
  });

  it('tells a waiting_user run the user is the blocker, not the runtime', async () => {
    const mounted = await mount({
      status: 'waiting_user',
      column: 'attention',
      actions: { retry: false, skip: false, resume: false, abort: false },
    });
    harness = mounted.harness;

    const hint = harness.$('[data-run-center-waiting-user]')!.textContent ?? '';

    expect(hint).toMatch(/waiting for you/i);
    // D-9's stopgap: no implication that a process is still alive behind it.
    expect(hint).not.toMatch(/still running|in the background|processing/i);
    expect(hint).not.toMatch(/resume/i);
  });
});
