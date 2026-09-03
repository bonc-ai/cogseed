// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * The queue's "recommended action" and the run detail pane's primary button
 * must agree. They are computed from different inputs — the queue from
 * `userStateForTask`, the detail pane from the projection's action set — so
 * without a shared gate a restart-orphaned card recommends "Resume" in the
 * list while the detail pane renders no button at all.
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

const renderOptions = {
  text: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
  esc: (value: unknown) => String(value ?? ''),
  icon: (name: string) => `[${name}]`,
  formatDate: (value: string) => String(value).slice(11, 16),
  stateView: (key: string) => `<p>${key}</p>`,
};

const noActions = { retry: false, skip: false, resume: false, recoverResult: false, abort: false, archive: false };

describe('Run Center recommended-action gate', () => {
  it('withholds an action the projection does not offer', () => {
    const board = loadBoard();

    // A Group Chat run left `recoverable` by a restart: the user state asks for
    // Resume, but Group Chat can never resume one.
    expect(board.recommendedActionAvailable(noActions, { action: 'resume' })).toBe(false);
    expect(board.recommendedActionAvailable({ ...noActions, resume: true }, { action: 'resume' })).toBe(true);

    expect(board.recommendedActionAvailable(noActions, { action: 'retry' })).toBe(false);
    expect(board.recommendedActionAvailable({ ...noActions, retry: true }, { action: 'retry' })).toBe(true);

    expect(board.recommendedActionAvailable(noActions, { action: 'recover-result' })).toBe(false);
    expect(board.recommendedActionAvailable({ ...noActions, recoverResult: true }, { action: 'recover-result' })).toBe(true);
  });

  it('treats navigation actions as available on their own terms, not on the action set', () => {
    const board = loadBoard();

    // Opening a conversation is not a task action; it needs a conversation.
    expect(board.recommendedActionAvailable(noActions, { action: 'open-task' }, { conversationId: 'conv-1' })).toBe(true);
    expect(board.recommendedActionAvailable(noActions, { action: 'open-task' }, {})).toBe(false);

    expect(board.recommendedActionAvailable(noActions, { action: 'open-handling' }, { hasCollaboration: true })).toBe(true);
    expect(board.recommendedActionAvailable(noActions, { action: 'open-handling' }, { conversationId: 'conv-1' })).toBe(true);
    expect(board.recommendedActionAvailable(noActions, { action: 'open-handling' }, {})).toBe(false);

    expect(board.recommendedActionAvailable(noActions, { action: 'configure-model' })).toBe(true);
  });

  it('returns false for an empty or unknown action instead of guessing', () => {
    const board = loadBoard();
    expect(board.recommendedActionAvailable(noActions, { action: '' })).toBe(false);
    expect(board.recommendedActionAvailable(noActions, {})).toBe(false);
    expect(board.recommendedActionAvailable(undefined, { action: 'resume' })).toBe(false);
    expect(board.recommendedActionAvailable(noActions, { action: 'teleport' })).toBe(false);
  });

  it('does not print a recommendation on a queue card whose action is unavailable', () => {
    const board = loadBoard();
    const orphaned = {
      taskId: 'task-orphan',
      sessionId: 'session-orphan',
      executionId: 'execution-orphan',
      conversationId: 'conv-orphan',
      column: 'attention',
      status: 'recoverable',
      updatedAt: '2026-08-27T09:00:00.000Z',
      actions: { ...noActions },
    };
    const runs = board.buildRunModels({ tasks: [orphaned] });
    // The card lands in the attention group and asks for Resume — the state
    // the queue would render from if it did not consult the action set.
    expect(board.queueGroups(runs).attention[0].userState.action).toBe('resume');

    const html = board.renderQueue(runs, renderOptions);
    expect(html).toContain('data-run-center-queue-task="task-orphan"');
    // The card still states what is going on…
    expect(html).toContain('run_center.user_state_recoverable');
    // …but does not promise an action the backend refuses.
    expect(html).not.toContain('run_center.recommended_action');
    expect(html).not.toContain('run_center.resume');
  });

  it('still prints a recommendation when the projection does offer the action', () => {
    const board = loadBoard();
    const resumable = {
      taskId: 'task-native',
      sessionId: 'session-native',
      executionId: 'execution-native',
      column: 'attention',
      status: 'recoverable',
      updatedAt: '2026-08-27T09:00:00.000Z',
      actions: { ...noActions, resume: true },
    };
    const html = board.renderQueue(board.buildRunModels({ tasks: [resumable] }), renderOptions);
    expect(html).toContain('run_center.recommended_action');
    expect(html).toContain('run_center.resume');
  });
});
