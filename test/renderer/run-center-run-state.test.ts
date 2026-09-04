// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Run state used to be decided by three tables that disagreed: the attention
 * queue sorted a retained result last, the card ranked it first, and the
 * attempt representative ranked failure first. They now read one ranking.
 *
 * PD-1 chose option A for the state where both are true at once — the run
 * failed and its result is still retrievable: recover first, retry second, and
 * show both facts rather than hiding one behind the other.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadBoard() {
  const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math, JSON, Number };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
  return context.window.CogSeedRunCenterBoard;
}

function loadAttemptsApi(board: any) {
  const context: any = {
    window: { CogSeedRunCenterBoard: board }, document: {},
    Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number, JSON,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center.js'), context);
  return context.window.CogSeedRunCenterAttempts;
}

const allActions = { retry: true, skip: true, resume: true, recoverResult: true, abort: true, archive: true };
const noActions = { retry: false, skip: false, resume: false, recoverResult: false, abort: false, archive: false };

const failedRetained = { status: 'failed', resultDeliveryState: 'pending-recovery' };

describe('Run state resolution', () => {
  it('keeps a plain failure on the retry path', () => {
    const board = loadBoard();
    const state = board.userStateForTask({ status: 'failed', resultDeliveryState: 'delivered' });

    expect(state.kind).toBe('failed');
    expect(state.stateKeys).toEqual(['run_center.user_state_failed']);
    expect(board.recommendedAction(allActions, state, {})).toMatchObject({ action: 'retry' });
    expect(board.secondaryActions(allActions, state, {})).toEqual([]);
  });

  it('keeps a plain retained result on the recovery path', () => {
    const board = loadBoard();
    const state = board.userStateForTask({ status: 'completed', resultDeliveryState: 'pending-recovery' });

    expect(state.kind).toBe('pending_recovery');
    expect(state.stateKeys).toEqual(['run_center.user_state_pending_recovery']);
    expect(state.reasonKey).toBe('run_center.user_reason_pending_recovery');
    expect(board.recommendedAction(allActions, state, {})).toMatchObject({ action: 'recover-result' });
  });

  describe('PD-1: a failed run whose result was retained', () => {
    it('keeps both facts instead of choosing one', () => {
      const board = loadBoard();
      const state = board.userStateForTask(failedRetained);

      // The execution outcome and the delivery outcome are both true and both
      // reach the surface.
      expect(state.execution).toMatchObject({ kind: 'failed' });
      expect(state.delivery).toMatchObject({ kind: 'pending-recovery' });
      expect(state.stateKeys).toEqual([
        'run_center.user_state_failed',
        'run_center.user_state_pending_recovery',
      ]);
      // The plain retained-result copy claims the run completed, which would be
      // a lie here, so this state has its own reason.
      expect(state.reasonKey).toBe('run_center.user_reason_failed_pending_recovery');
      expect(state.reasonKey).not.toBe('run_center.user_reason_pending_recovery');
    });

    it('recovers first and retries second', () => {
      const board = loadBoard();
      const state = board.userStateForTask(failedRetained);

      expect(state.actionCandidates.map((candidate: any) => candidate.action))
        .toEqual(['recover-result', 'retry']);
      expect(board.recommendedAction(allActions, state, {})).toMatchObject({ action: 'recover-result' });
      expect(board.secondaryActions(allActions, state, {}).map((candidate: any) => candidate.action))
        .toEqual(['retry']);
    });

    it('no longer sorts below a plain failure', () => {
      const board = loadBoard();
      const combined = board.userStateForTask(failedRetained);
      const failed = board.userStateForTask({ status: 'failed' });
      const waiting = board.userStateForTask({ status: 'waiting_user' });

      expect(combined.priority).toBeLessThan(failed.priority);
      // ...without overtaking the states that genuinely block a person.
      expect(combined.priority).toBeGreaterThan(waiting.priority);
      expect(combined.priority).toBe(board.RUN_STATE_PRIORITY.pending_recovery);
    });
  });

  describe('action authority stays with Main', () => {
    it('falls through to retry when recovery is not permitted', () => {
      const board = loadBoard();
      const state = board.userStateForTask(failedRetained);

      const actions = { ...noActions, retry: true, recoverResult: false };
      expect(board.recommendedAction(actions, state, {})).toMatchObject({ action: 'retry' });
      expect(board.secondaryActions(actions, state, {})).toEqual([]);
    });

    it('offers only recovery when retry is not permitted', () => {
      const board = loadBoard();
      const state = board.userStateForTask(failedRetained);

      const actions = { ...noActions, retry: false, recoverResult: true };
      expect(board.recommendedAction(actions, state, {})).toMatchObject({ action: 'recover-result' });
      expect(board.secondaryActions(actions, state, {})).toEqual([]);
    });

    it('recommends nothing when Main permits neither', () => {
      const board = loadBoard();
      const state = board.userStateForTask(failedRetained);

      expect(board.recommendedAction(noActions, state, {})).toBeNull();
      expect(board.secondaryActions(noActions, state, {})).toEqual([]);
    });

    it('never invents an action the resolver did not propose', () => {
      const board = loadBoard();
      // Everything is permitted, but a waiting run only ever asks to be opened.
      const state = board.userStateForTask({ status: 'waiting_user' });
      expect(board.recommendedAction(allActions, state, { conversationId: 'conv-1' }))
        .toMatchObject({ action: 'open-task' });
      expect(board.secondaryActions(allActions, state, { conversationId: 'conv-1' })).toEqual([]);
    });
  });

  it('preserves the relative order of the other attention states', () => {
    const board = loadBoard();
    const order = [
      board.userStateForTask({ status: 'waiting_user' }),
      board.userStateForTask({ status: 'running' }, { hasReview: true }),
      board.userStateForTask({ status: 'recoverable' }),
      board.userStateForTask(failedRetained),
      board.userStateForTask({ status: 'failed' }),
    ];

    expect(order.map((state: any) => state.kind))
      .toEqual(['waiting_user', 'review', 'recoverable', 'pending_recovery', 'failed']);
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index].priority, order[index].kind).toBeGreaterThan(order[index - 1].priority);
    }
    for (const state of order) expect(state.attention).toBe(true);
    // Non-attention states rank after every attention state.
    for (const state of [board.userStateForTask({ status: 'running' }), board.userStateForTask({ status: 'completed' })]) {
      expect(state.attention).toBe(false);
      expect(state.priority).toBeGreaterThan(order.at(-1)!.priority);
    }
  });
});

describe('identity is not affected by state resolution', () => {
  const tasks = [
    { taskId: 't-a1', executionId: 'exec-a', sessionId: 's-a', status: 'failed', resultDeliveryState: 'pending-recovery', column: 'attention', updatedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-09-01T09:00:00.000Z' },
    { taskId: 't-a2', executionId: 'exec-a', sessionId: 's-a', status: 'completed', column: 'completed', updatedAt: '2026-09-01T10:00:05.000Z', createdAt: '2026-09-01T09:00:05.000Z' },
    { taskId: 't-b1', executionId: 'exec-b', sessionId: 's-a', status: 'running', column: 'running', updatedAt: '2026-09-01T10:00:10.000Z', createdAt: '2026-09-01T09:00:10.000Z' },
    { taskId: 't-c1', executionId: 'exec-c', sessionId: 's-b', status: 'waiting_user', column: 'attention', updatedAt: '2026-09-01T10:00:15.000Z', createdAt: '2026-09-01T09:00:15.000Z' },
  ];

  it('keeps Run count, keys and membership', () => {
    const board = loadBoard();
    const runs = board.buildRunModels({ tasks, groups: [] });

    // Runs are keyed by execution, one per executionId, exactly as before.
    expect(runs).toHaveLength(3);
    expect(runs.map((run: any) => run.key).sort())
      .toEqual(['execution:exec-a', 'execution:exec-b', 'execution:exec-c']);
    const byKey = new Map(runs.map((run: any) => [run.key, run]));
    expect(byKey.get('execution:exec-a').members.map((task: any) => task.taskId).sort()).toEqual(['t-a1', 't-a2']);
    expect(byKey.get('execution:exec-b').members.map((task: any) => task.taskId)).toEqual(['t-b1']);
    expect(byKey.get('execution:exec-c').members.map((task: any) => task.taskId)).toEqual(['t-c1']);
    for (const task of tasks) {
      expect(board.logicalRunKey(task)).toBe(`execution:${task.executionId}`);
    }
  });

  it('keeps Attempt membership while ranking its representative', () => {
    const board = loadBoard();
    const attemptsApi = loadAttemptsApi(board);
    const members = [
      { taskId: 'child-done', executionId: 'exec-a', sessionId: 's-a', status: 'completed', updatedAt: '2026-09-01T10:00:05.000Z' },
      { taskId: 'child-failed', executionId: 'exec-a', sessionId: 's-a', status: 'failed', updatedAt: '2026-09-01T10:00:01.000Z' },
      { taskId: 'other', executionId: 'exec-b', sessionId: 's-a', status: 'running', updatedAt: '2026-09-01T10:00:10.000Z' },
    ];
    const attempts = attemptsApi.buildAttemptModels({ members });

    expect(attempts.map((attempt: any) => attempt.key)).toEqual(['execution:exec-b', 'execution:exec-a']);
    expect(attempts[1].members.map((task: any) => task.taskId).sort()).toEqual(['child-done', 'child-failed']);
    // Ranked by the shared execution table: a failure represents the attempt
    // even though the completed task is the more recent one.
    expect(attempts[1].status).toBe('failed');
  });
});

describe('states that no task can hold', () => {
  it('does not rank statuses outside the real value domain', () => {
    const board = loadBoard();
    const real = ['created', 'queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled', 'recoverable'];

    expect(Object.keys(board.EXECUTION_STATE_PRIORITY).sort()).toEqual([...real].sort());
    for (const phantom of ['needs_review', 'blocked', 'pending', 'skipped']) {
      expect(board.EXECUTION_STATE_PRIORITY[phantom], phantom).toBeUndefined();
      // ...and none of them can produce an attention state on its own.
      expect(board.userStateForTask({ status: phantom }).attention, phantom).toBe(false);
    }
  });

  it('marks an attempt recovered only from observable delivery values', () => {
    const board = loadBoard();
    // Strip comments: the invariant is about executable code, and the fix is
    // deliberately documented in prose that names the values it removed.
    const code = read('src/renderer/modules/run-center.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // R9: these were tested for but never written by any producer, so the
    // condition was constantly false. Check the delivery domain specifically —
    // 'recovered' on its own is also a legitimate CSS badge kind.
    expect(code).not.toContain('delivered_after_recovery');
    const deliveryDomain = ['not-applicable', 'pending', 'delivered', 'pending-recovery', 'unknown'];
    for (const [, literal] of code.matchAll(/resultDeliveryState[^;\n]{0,80}?'([a-z-]+)'/g)) {
      expect(deliveryDomain, `resultDeliveryState compared against '${literal}'`).toContain(literal);
    }

    const attemptsApi = loadAttemptsApi(board);
    const attempts = attemptsApi.buildAttemptModels({
      members: [
        { taskId: 'first', executionId: 'exec-1', status: 'completed', resultDeliveryState: 'delivered', updatedAt: '2026-09-01T10:00:00.000Z' },
        { taskId: 'second', executionId: 'exec-2', status: 'failed', updatedAt: '2026-09-01T10:00:05.000Z' },
      ],
    });
    expect(attempts.map((attempt: any) => attempt.status)).toEqual(['failed', 'completed']);
  });
});
