// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Two different things were both called `column`: the lifecycle bucket Main
 * publishes from status and archival, and the attention column the renderer
 * derives on top of it. `filteredTasks` read one on one line and the other on
 * the next, and the Overview fell back from the second to the first, so three
 * surfaces could disagree about where the same run belonged.
 *
 * They are now `baseColumn` and `displayColumn`, and every presentation
 * consumer reads the second.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadModules() {
  const context: any = {
    window: {}, document: {},
    Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number, JSON,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
  vm.runInContext(read('src/renderer/modules/run-center-overview.js'), context);
  return { board: context.window.CogSeedRunCenterBoard, overview: context.window.CogSeedRunCenterOverview };
}

const noActions = { retry: false, skip: false, resume: false, recoverResult: false, abort: false, archive: false };

interface Fixture {
  taskId: string;
  status: string;
  baseColumn: string;
  resultDeliveryState?: string;
}

function task(fixture: Fixture) {
  return {
    taskId: fixture.taskId,
    sessionId: `s-${fixture.taskId}`,
    executionId: `exec-${fixture.taskId}`,
    requestId: `req-${fixture.taskId}`,
    status: fixture.status,
    title: fixture.taskId,
    titleKey: 'run_center.task_kind_cogseed',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    sourceKind: 'cogseed',
    conversationMode: 'standard',
    participantCount: 0,
    resumable: false,
    resultDeliveryState: fixture.resultDeliveryState ?? 'not-applicable',
    baseColumn: fixture.baseColumn,
    column: fixture.baseColumn,
    sessionTitle: fixture.taskId,
    sessionTitleKey: 'run_center.task_kind_cogseed',
    actions: { ...noActions },
  };
}

// One task per lifecycle/presentation combination that Main can actually emit.
const FIXTURES: Array<Fixture & { expected: string }> = [
  { taskId: 'pending-run', status: 'queued', baseColumn: 'pending', expected: 'pending' },
  { taskId: 'running-run', status: 'running', baseColumn: 'running', expected: 'running' },
  { taskId: 'waiting-run', status: 'waiting_user', baseColumn: 'attention', expected: 'attention' },
  { taskId: 'recoverable-run', status: 'recoverable', baseColumn: 'attention', expected: 'attention' },
  { taskId: 'failed-run', status: 'failed', baseColumn: 'attention', expected: 'attention' },
  // Main calls this completed; the renderer raises it because the result still
  // has to be written back. The divergence the two names exist to express.
  { taskId: 'retained-run', status: 'completed', baseColumn: 'completed', resultDeliveryState: 'pending-recovery', expected: 'attention' },
  { taskId: 'failed-retained-run', status: 'failed', baseColumn: 'attention', resultDeliveryState: 'pending-recovery', expected: 'attention' },
  { taskId: 'completed-run', status: 'completed', baseColumn: 'completed', expected: 'completed' },
  { taskId: 'archived-run', status: 'failed', baseColumn: 'archived', expected: 'archived' },
];

const projection = { tasks: FIXTURES.map(task), groups: [] };

describe('baseColumn and displayColumn', () => {
  it('reads the lifecycle column from Main, and the alias as the same value', () => {
    const { board } = loadModules();

    for (const fixture of FIXTURES) {
      const projected = task(fixture);
      expect(board.baseColumnOf(projected), fixture.taskId).toBe(fixture.baseColumn);
      // The alias exists for one release and must never carry a second answer.
      expect(projected.column).toBe(projected.baseColumn);
      // Reading only the alias still resolves, so a projection written before
      // the rename behaves identically.
      const legacy = { ...projected, baseColumn: undefined };
      expect(board.baseColumnOf(legacy), fixture.taskId).toBe(fixture.baseColumn);
    }
  });

  it('derives the display column from the run state, not from a second table', () => {
    const { board } = loadModules();

    for (const fixture of FIXTURES) {
      const projected = task(fixture);
      expect(board.displayColumnForTask(projected), fixture.taskId).toBe(fixture.expected);
      // The only thing display adds over lifecycle is the attention decision,
      // and that comes from the state resolver.
      const state = board.userStateForTask(projected);
      expect(board.displayColumnForTask(projected), fixture.taskId)
        .toBe(state.attention ? 'attention' : fixture.baseColumn);
    }
  });

  it('keeps the lifecycle column untouched when presentation raises a run', () => {
    const { board } = loadModules();
    const retained = task(FIXTURES.find((item) => item.taskId === 'retained-run')!);

    expect(board.baseColumnOf(retained)).toBe('completed');
    expect(board.displayColumnForTask(retained)).toBe('attention');
    // A collaboration fact reaches the resolver only through context, and it
    // must not rewrite the lifecycle answer either.
    const running = task({ taskId: 'review-run', status: 'running', baseColumn: 'running' });
    expect(board.displayColumnForTask(running, { hasReview: true })).toBe('attention');
    expect(board.baseColumnOf(running)).toBe('running');
    expect(running.column).toBe('running');
  });
});

describe('Board, Queue and Overview agree', () => {
  it('places every task in the same column on all three surfaces', () => {
    const { board, overview } = loadModules();
    const runs = board.buildRunModels(projection);
    const model = overview.buildOverview(projection, [], new Date('2026-09-01T12:00:00.000Z'));

    const countFor = (column: string) => model.statusCounts.find((item: any) => item.column === column)?.count || 0;
    const expectedCounts = new Map<string, number>();
    for (const fixture of FIXTURES) {
      expectedCounts.set(fixture.expected, (expectedCounts.get(fixture.expected) || 0) + 1);
    }

    for (const fixture of FIXTURES) {
      const run = runs.find((item: any) => item.key === `execution:exec-${fixture.taskId}`);
      expect(run, fixture.taskId).toBeDefined();
      // Board: the column a card is filed under.
      expect(board.displayColumnForTask(run.aggregateTask), fixture.taskId).toBe(fixture.expected);
      // Queue: attention membership comes from the same resolver.
      const groups = board.queueGroups([run]);
      const queueGroup = groups.attention.length ? 'attention'
        : groups.active.length ? 'active' : 'completed';
      const expectedGroup = fixture.expected === 'attention' ? 'attention'
        : ['pending', 'running'].includes(fixture.expected) ? 'active' : 'completed';
      expect(queueGroup, fixture.taskId).toBe(expectedGroup);
    }

    // Overview: the same totals, counted from the same answer.
    for (const [column, count] of expectedCounts) {
      expect(countFor(column), column).toBe(count);
    }
    expect(model.counts.attention).toBe(expectedCounts.get('attention'));
  });

  it('agrees about a failed run whose result was retained', () => {
    const { board, overview } = loadModules();
    const fixture = FIXTURES.find((item) => item.taskId === 'failed-retained-run')!;
    const single = { tasks: [task(fixture)], groups: [] };
    const [run] = board.buildRunModels(single);

    expect(board.displayColumnForTask(run.aggregateTask)).toBe('attention');
    expect(board.queueGroups([run]).attention).toHaveLength(1);

    const model = overview.buildOverview(single, [], new Date('2026-09-01T12:00:00.000Z'));
    expect(model.counts.attention).toBe(1);
    expect(model.counts.active).toBe(0);
    expect(model.statusCounts.find((item: any) => item.column === 'attention')?.count).toBe(1);
  });

  it('does not let a lifecycle-completed run be counted as completed once it needs attention', () => {
    // The fallback this task removed: the Overview used to drop back to the
    // lifecycle column, so a retained result was counted as completed there
    // while the board showed it under attention.
    const { board, overview } = loadModules();
    const fixture = FIXTURES.find((item) => item.taskId === 'retained-run')!;
    const single = { tasks: [task(fixture)], groups: [] };
    const [run] = board.buildRunModels(single);

    expect(board.baseColumnOf(run.aggregateTask)).toBe('completed');
    expect(board.displayColumnForTask(run.aggregateTask)).toBe('attention');

    const model = overview.buildOverview(single, [], new Date('2026-09-01T12:00:00.000Z'));
    expect(model.statusCounts.find((item: any) => item.column === 'completed')?.count || 0).toBe(0);
    expect(model.statusCounts.find((item: any) => item.column === 'attention')?.count).toBe(1);
  });
});

describe('archival stays domain truth', () => {
  const archivedNeedingAttention = task({
    taskId: 'archived-failed', status: 'failed', baseColumn: 'archived', resultDeliveryState: 'pending-recovery',
  });
  const live = task({ taskId: 'live-failed', status: 'failed', baseColumn: 'attention' });
  const both = { tasks: [archivedNeedingAttention, live], groups: [] };

  it('hides archived runs by default and shows them on request', () => {
    const { board } = loadModules();
    const runs = board.buildRunModels(both);

    const visible = board.filterRuns(runs, { filter: 'all', includeArchived: false });
    expect(visible.map((run: any) => run.aggregateTask.taskId)).toEqual(['live-failed']);

    const withArchive = board.filterRuns(runs, { filter: 'all', includeArchived: true });
    expect(withArchive.map((run: any) => run.aggregateTask.taskId).sort())
      .toEqual(['archived-failed', 'live-failed']);
  });

  it('never lets attention pull an archived run back into the list', () => {
    const { board } = loadModules();
    // This task would be attention on every other axis: it failed and its
    // result is still retained. Archival outranks all of it.
    const state = board.userStateForTask(archivedNeedingAttention);
    expect(state.kind).toBe('archived');
    expect(state.attention).toBe(false);
    expect(board.displayColumnForTask(archivedNeedingAttention)).toBe('archived');

    const runs = board.buildRunModels(both);
    const visible = board.filterRuns(runs, { filter: 'attention', includeArchived: false });
    expect(visible.map((run: any) => run.aggregateTask.taskId)).toEqual(['live-failed']);

    const filtered = board.filteredTasks(both, '', 'all', false);
    expect(filtered.map((item: any) => item.taskId)).toEqual(['live-failed']);
  });
});

describe('identity is unaffected by the rename', () => {
  it('keeps Run count, keys and membership', () => {
    const { board } = loadModules();
    const runs = board.buildRunModels(projection);

    expect(runs).toHaveLength(FIXTURES.length);
    expect(runs.map((run: any) => run.key).sort())
      .toEqual(FIXTURES.map((fixture) => `execution:exec-${fixture.taskId}`).sort());
    for (const fixture of FIXTURES) {
      expect(board.logicalRunKey(task(fixture))).toBe(`execution:exec-${fixture.taskId}`);
      const run = runs.find((item: any) => item.key === `execution:exec-${fixture.taskId}`);
      expect(run.members.map((member: any) => member.taskId)).toEqual([fixture.taskId]);
    }
  });
});

describe('no presentation consumer reads the legacy field', () => {
  it('leaves task.column out of the renderer outside alias resolution', () => {
    const strip = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // The board resolves the alias in exactly one place, by design. Remove
    // that expression, then nothing else may name the legacy field.
    const boardCode = strip(read('src/renderer/modules/run-center-board.js'));
    const aliasReads = boardCode.match(/task\?\.baseColumn \|\| task\?\.column/g) || [];
    expect(aliasReads).toHaveLength(1);
    const withoutAlias = boardCode.replace(/task\?\.baseColumn \|\| task\?\.column/g, '');
    expect(withoutAlias.match(/task\?\.column|task\.column|aggregateTask\.column/g) || []).toHaveLength(0);

    // Overview and the controller never read the projected field. `item.column`
    // on a `statusCounts` row is the renderer's own shape and is not it.
    for (const file of ['run-center-overview.js', 'run-center.js']) {
      const code = strip(read(`src/renderer/modules/${file}`));
      const projectedReads = code.match(/\b(?:task|aggregateTask|member|candidate)\??\.column\b/g) || [];
      expect(projectedReads, file).toHaveLength(0);
      expect(code, file).not.toContain('|| task.column');
      expect(code, file).not.toContain('displayColumnForTask?.(task) ||');
    }
  });
});
