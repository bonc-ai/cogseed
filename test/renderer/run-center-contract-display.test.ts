// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-18 — the DISPLAY half.
//
// Six fields were computed by the backend and read by nobody: `reviews`,
// `conflicts`, `recovery`, `session.taskCount`, `session.activeTaskCount`,
// `session.hasRecovery` — plus `timeline.isError`, which this audit found on
// top of the original list. "Keep and display" is only true once the DOM
// actually shows them, so each is asserted against rendered output, and each
// is also asserted NOT to mislead when it is zero/empty/false.

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

const TASK = () => fx.boardTask({ taskId: 'cogseed-task-run-1', conversationId: 'conv-8fd6' });

async function mount(collaboration: Record<string, unknown> = {}, sessions?: Array<Record<string, unknown>>) {
  const task = TASK();
  const created = await createRunCenterHarness({
    board: fx.board([task]),
    sessions: { sessions: sessions ?? [fx.session({ latestTaskId: String(task.taskId) })] },
    detail: () => fx.detail(task, collaboration),
  });
  await created.render();
  await created.click(`[data-dashboard-board-task-id="${task.taskId}"]`);
  return created;
}

describe('RC-P1-18 DISPLAY — review gates', () => {
  const REVIEWS = [
    { gateId: 'gate-1', stepId: 'step-a', nameKey: 'run_center.review_gate', status: 'pending', createdAt: '2026-08-26T00:00:00.000Z' },
    { gateId: 'gate-2', stepId: 'step-b', nameKey: 'run_center.review_gate', status: 'approved', reviewDecision: 'approve', reviewedBy: 'commander-1', createdAt: '2026-08-26T00:00:00.000Z', reviewedAt: '2026-08-26T00:05:00.000Z' },
  ];

  it('renders each gate with its step, state and reviewer', async () => {
    harness = await mount({ reviews: REVIEWS });
    await harness.click('[data-run-center-view="collaboration"]');

    const gates = harness.$$('[data-run-center-review]');
    expect(gates.map((n) => n.getAttribute('data-run-center-review'))).toEqual(['gate-1', 'gate-2']);

    const approved = harness.$('[data-run-center-review="gate-2"]')!.textContent ?? '';
    expect(approved).toContain('Review gate');
    expect(approved).toContain('step-b');
    expect(approved).toContain('commander-1');
    // Enum states cross as i18n keys and must resolve to real copy.
    expect(approved).toContain('Approved');
    expect(approved).not.toContain('run_center.review_status_');
  });

  it('says there are none rather than rendering an empty list', async () => {
    harness = await mount({ reviews: [] });
    await harness.click('[data-run-center-view="collaboration"]');

    expect(harness.$('[data-run-center-reviews]')?.getAttribute('data-run-center-reviews')).toBe('0');
    expect(harness.$('[data-run-center-review]')).toBeNull();
    expect(harness.$('[data-run-center-reviews]')!.textContent).toContain('No review gates');
  });

  it('falls back to readable copy for an unknown gate state', async () => {
    harness = await mount({ reviews: [{ ...REVIEWS[0], status: 'some_future_state' }] });
    await harness.click('[data-run-center-view="collaboration"]');

    const text = harness.$('[data-run-center-review="gate-1"]')!.textContent ?? '';
    expect(text).toContain('Unknown');
    expect(text).not.toContain('run_center.review_status_some_future_state');
  });
});

describe('RC-P1-18 DISPLAY — conflicts', () => {
  it('renders each conflict with its state and affected steps', async () => {
    harness = await mount({
      conflicts: [{
        conflictId: 'conflict-1', type: 'concurrent_edit', status: 'open',
        affectedStepIds: ['step-a', 'step-b'],
        createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:02:00.000Z',
      }],
    });
    await harness.click('[data-run-center-view="collaboration"]');

    const node = harness.$('[data-run-center-conflict="conflict-1"]')!;
    expect(node.textContent).toContain('Open');
    expect(node.textContent).toContain('2 affected steps');
    expect(node.textContent).toContain('step-a, step-b');
  });

  it('does not imply a conflict when there is none', async () => {
    harness = await mount({ conflicts: [] });
    await harness.click('[data-run-center-view="collaboration"]');

    expect(harness.$('[data-run-center-conflicts]')?.getAttribute('data-run-center-conflicts')).toBe('0');
    expect(harness.$('[data-run-center-conflict]')).toBeNull();
    expect(harness.$('[data-run-center-conflicts]')!.textContent).toContain('No conflicts');
  });
});

describe('RC-P1-18 DISPLAY — recovery', () => {
  it('tells the user the session has resumable work', async () => {
    harness = await mount({ recovery: { recoverable: true, taskIds: ['cogseed-task-a', 'cogseed-task-b'], lastEventAt: '2026-08-26T00:03:00.000Z' } });

    const note = harness.$('[data-run-center-recovery]');
    expect(note?.getAttribute('data-run-center-recovery')).toBe('2');
    expect(note?.textContent).toContain('2 tasks');
  });

  it('stays silent when nothing is recoverable', async () => {
    harness = await mount({ recovery: { recoverable: false, taskIds: [] } });
    expect(harness.$('[data-run-center-recovery]')).toBeNull();
  });

  it('stays silent when the flag is set but no task backs it', async () => {
    // A truthy flag with an empty list would otherwise render "0 tasks".
    harness = await mount({ recovery: { recoverable: true, taskIds: [] } });
    expect(harness.$('[data-run-center-recovery]')).toBeNull();
  });
});

describe('RC-P1-18 DISPLAY — session counts', () => {
  it('shows the task and active counts on the session row', async () => {
    harness = await mount({}, [fx.session({ sessionId: 'cogseed-session-1', latestTaskId: 'cogseed-task-run-1', taskCount: 4, activeTaskCount: 2 })]);

    const meta = harness.$('[data-run-center-session-meta]')!.textContent ?? '';
    expect(meta).toContain('4 tasks');
    expect(meta).toContain('2 active');
  });

  it('omits the active clause instead of claiming "0 active"', async () => {
    harness = await mount({}, [fx.session({ sessionId: 'cogseed-session-1', taskCount: 4, activeTaskCount: 0 })]);

    const meta = harness.$('[data-run-center-session-meta]')!.textContent ?? '';
    expect(meta).toContain('4 tasks');
    expect(meta).not.toContain('0 active');
  });

  it('renders no meta line at all for a session with no tasks', async () => {
    harness = await mount({}, [fx.session({ sessionId: 'cogseed-session-1', taskCount: 0, activeTaskCount: 0 })]);
    expect(harness.$('[data-run-center-session-meta]')).toBeNull();
  });

  it('marks a session that has recoverable work, and only that one', async () => {
    harness = await mount({}, [
      fx.session({ sessionId: 'cogseed-session-1', latestTaskId: 'cogseed-task-run-1', taskCount: 1, hasRecovery: true }),
      fx.session({ sessionId: 'cogseed-session-2', taskCount: 1, hasRecovery: false }),
    ]);

    const marked = harness.$$('[data-run-center-session-recovery]')
      .map((n) => n.getAttribute('data-run-center-session-recovery'));
    expect(marked).toEqual(['cogseed-session-1']);
    expect(harness.$('[data-run-center-session-recovery]')!.textContent).toBe('Recoverable');
  });
});

describe('RC-P1-18 DISPLAY — timeline error marker', () => {
  const event = (overrides: Record<string, unknown>) => ({
    eventId: 'e1', taskId: 'cogseed-task-run-1', sequence: 1,
    type: 'task.started', createdAt: '2026-08-26T00:00:00.000Z',
    summary: 'started', summaryKey: 'run_center.event_task_started',
    ...overrides,
  });

  it('marks a failed event and carries its error code', async () => {
    harness = await mount({ timeline: [event({ eventId: 'e-bad', isError: true, errorCode: 'tool_timeout' })] });
    await harness.click('[data-run-center-view="runs"]');

    const marker = harness.$('[data-run-center-event-error]');
    expect(marker?.getAttribute('data-run-center-event-error')).toBe('tool_timeout');
    expect(marker?.textContent).toBe('Failed');
  });

  it('leaves ordinary events unmarked', async () => {
    harness = await mount({ timeline: [event({ eventId: 'e-ok' })] });
    await harness.click('[data-run-center-view="runs"]');

    expect(harness.$('[data-run-center-event-error]')).toBeNull();
  });
});

describe('RC-P1-18 — nothing user-authored reached the new surfaces', () => {
  it('renders no free text from the projection into reviews, conflicts or session meta', async () => {
    const secret = 'terminate the vendor agreement';
    harness = await mount({
      reviews: [{ gateId: 'gate-1', stepId: 'step-a', nameKey: 'run_center.review_gate', status: 'pending', createdAt: '2026-08-26T00:00:00.000Z' }],
      conflicts: [{ conflictId: 'c-1', type: 'concurrent_edit', status: 'open', affectedStepIds: [], createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }],
    }, [fx.session({ sessionId: 'cogseed-session-1', latestTaskId: 'cogseed-task-run-1', title: secret, titleKey: undefined, taskCount: 2, activeTaskCount: 1 })]);

    expect(harness.$('[data-run-center-session-meta]')!.textContent).not.toContain(secret);

    await harness.click('[data-run-center-view="collaboration"]');
    for (const selector of ['[data-run-center-review]', '[data-run-center-conflict]']) {
      expect(harness.$(selector)!.textContent).not.toContain(secret);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RC-P1-14 decision (c) — the renderer half. The native task's history stays
// on screen; the exit into a deleted conversation does not.
// ─────────────────────────────────────────────────────────────────────────

describe('RC-P1-14 decision (c) — a task whose conversation was deleted', () => {
  async function mountUnavailable(overrides: Record<string, unknown> = {}) {
    const task = fx.boardTask({
      taskId: 'cogseed-task-native',
      executionKind: 'cogseed-native',
      status: 'completed',
      column: 'completed',
      agentId: 'planner',
      conversationId: undefined,
      conversationUnavailable: true,
      actions: { retry: false, resume: false, abort: false },
      ...overrides,
    });
    const created = await createRunCenterHarness({
      board: fx.board([task]),
      sessions: { sessions: [fx.session({ latestTaskId: String(task.taskId) })] },
      detail: () => fx.detail(task),
    });
    await created.render();
    await created.click(`[data-dashboard-board-task-id="${task.taskId}"]`);
    return created;
  }

  it('keeps the task itself visible — the history was deliberately not deleted', async () => {
    harness = await mountUnavailable();

    expect(harness.$('[data-dashboard-board-task-id="cogseed-task-native"]')).not.toBeNull();
    expect(harness.$('.run-center-detail')).not.toBeNull();
    expect(harness.$('.run-center-detail')!.textContent).toContain('planner');
  });

  it('offers no conversation exit', async () => {
    harness = await mountUnavailable();
    expect(harness.$('[data-run-center-open]')).toBeNull();
  });

  it('explains why, without implying the run can be restarted from here', async () => {
    harness = await mountUnavailable();

    const note = harness.$('[data-run-center-conversation-unavailable]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toMatch(/has been deleted/i);
    expect(note!.textContent).toMatch(/kept here/i);
    expect(note!.textContent).not.toMatch(/retry|resume/i);
  });

  it('offers no resume or retry it cannot honour', async () => {
    harness = await mountUnavailable({ status: 'failed', column: 'attention' });

    expect(harness.$('[data-run-center-action="resume"]')).toBeNull();
    expect(harness.$('[data-run-center-action="retry"]')).toBeNull();
  });

  it('says nothing of the sort for a task whose conversation is alive', async () => {
    const task = fx.boardTask({ taskId: 'cogseed-task-live', conversationId: 'conv-8fd6' });
    const created = await createRunCenterHarness({
      board: fx.board([task]),
      sessions: { sessions: [fx.session({ latestTaskId: 'cogseed-task-live' })] },
      detail: () => fx.detail(task),
    });
    harness = created;
    await harness.render();
    await harness.click('[data-dashboard-board-task-id="cogseed-task-live"]');

    expect(harness.$('[data-run-center-conversation-unavailable]')).toBeNull();
    expect(harness.$('[data-run-center-open]')).not.toBeNull();
  });
});
