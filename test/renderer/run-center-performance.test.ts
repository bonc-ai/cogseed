// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const PERF_ENABLED = process.env.RUN_CENTER_PERF === '1';
const WARM_UP_ROUNDS = PERF_ENABLED ? 5 : 2;
const SAMPLE_ROUNDS = PERF_ENABLED ? 25 : 3;

type Sample = { name: string; samples: number; p50Ms: number; p95Ms: number; maxMs: number };

function percentile(values: number[], ratio: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] || 0;
}

function benchmark(name: string, operation: () => unknown): Sample {
  for (let index = 0; index < WARM_UP_ROUNDS; index += 1) operation();
  const durations: number[] = [];
  for (let index = 0; index < SAMPLE_ROUNDS; index += 1) {
    const startedAt = performance.now();
    const result = operation();
    // Observe each result so engines cannot treat the benchmark as dead work.
    if (result === undefined) throw new Error(`${name} returned no observable result`);
    durations.push(performance.now() - startedAt);
  }
  return {
    name,
    samples: durations.length,
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3)),
  };
}

function loadProjectionModules() {
  const context: any = {
    window: {
      uiButton: () => '',
      uiIconButton: () => '',
    },
    Date,
    Intl,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-model.js'), context, { filename: 'run-center-model.js' });
  vm.runInContext(read('src/renderer/modules/run-center-board.js'), context, { filename: 'run-center-board.js' });
  return {
    model: context.window.CogSeedRunCenterModel,
    board: context.window.CogSeedRunCenterBoard,
  };
}

function safeProjection(size = 1_000) {
  const statuses = [
    { status: 'planned', column: 'pending' },
    { status: 'running', column: 'running' },
    { status: 'waiting_user', column: 'attention' },
    { status: 'completed', column: 'completed' },
    { status: 'failed', column: 'attention' },
  ];
  const sourceKinds = ['cogseed', 'agent', 'local-cli', 'group-chat'];
  const baseTime = Date.parse('2026-09-04T12:00:00.000Z');
  const tasks = Array.from({ length: size }, (_, index) => {
    const state = statuses[index % statuses.length];
    const archived = index % 20 === 0;
    return {
      taskId: `task-${index}`,
      executionId: `run-${index}`,
      sessionId: `session-${Math.floor(index / 10)}`,
      conversationId: `conversation-${index}`,
      title: `Safe task ${index}`,
      agentId: `agent-${index % 8}`,
      sourceKind: sourceKinds[index % sourceKinds.length],
      worktreeName: `worktree-${index % 12}`,
      participantCount: index % 11 === 0 ? 2 : 1,
      status: state.status,
      column: archived ? 'archived' : state.column,
      createdAt: new Date(baseTime - (size - index) * 2_000).toISOString(),
      updatedAt: new Date(baseTime - (size - index) * 1_000).toISOString(),
      actions: {
        retry: state.status === 'failed',
        resume: false,
        recoverResult: false,
        abort: state.status === 'running',
        archive: ['completed', 'failed'].includes(state.status),
      },
    };
  });
  return {
    schemaVersion: 1,
    tasks,
    groups: [],
    counts: {
      pending: 150,
      running: 200,
      attention: 400,
      completed: 200,
      archived: 50,
    },
  };
}

function attemptFixture() {
  const members = Array.from({ length: 40 }, (_, index) => {
    const attempt = Math.floor(index / 2);
    const isParent = index % 2 === 0;
    return {
      taskId: `attempt-${attempt}-${isParent ? 'parent' : 'child'}`,
      parentTaskId: isParent ? '' : `attempt-${attempt}-parent`,
      executionId: `attempt-execution-${attempt}`,
      sessionId: 'attempt-session',
      status: attempt % 4 === 0 ? 'failed' : 'completed',
      column: attempt % 4 === 0 ? 'attention' : 'completed',
      agentId: `agent-${attempt % 4}`,
      createdAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + attempt * 1_000).toISOString(),
      updatedAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + attempt * 2_000 + Number(!isParent)).toISOString(),
      actions: {},
    };
  });
  return { key: 'session:attempt-session', members };
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

function renderOptions(runs: any[], sequenceByKey: Map<string, unknown>) {
  return {
    text: (key: string, variables?: Record<string, unknown>) => variables ? `${key}:${JSON.stringify(variables)}` : key,
    esc: escapeHtml,
    icon: () => '',
    statusKey: (status: string) => `run_center.status_${status}`,
    statusClass: (status: string) => `status-${status}`,
    formatDate: (value: string) => value,
    stateView: (key: string, detail?: string) => `<div>${escapeHtml(key)}${escapeHtml(detail || '')}</div>`,
    loading: false,
    error: '',
    search: '',
    filter: 'all',
    sourceFilter: 'all',
    agentFilter: 'all',
    timeFilter: 'all',
    conversationId: '',
    selectedTaskId: '',
    selectedRunKey: '',
    focusedRunKey: '',
    showArchived: true,
    busyAction: '',
    busyTaskId: '',
    agentName: (agentId: string) => agentId,
    conversationTitle: (conversationId: string) => `Conversation ${conversationId}`,
    now: '2026-09-04T12:00:00.000Z',
    runModels: runs,
    sequenceByKey,
  };
}

function openingTagCount(html: string) {
  return html.match(/<[a-z][a-z0-9-]*(?:\s|>)/gi)?.length || 0;
}

describe('Run Center 1,000-item performance and scale contract', () => {
  it('keeps full-list semantics and emits an opt-in P50/P95 report', () => {
    const { model, board } = loadProjectionModules();
    const projection = safeProjection();
    const runs = model.buildRunModels(projection);
    const sequenceByKey = model.buildRunSequence(runs);
    const options = renderOptions(runs, sequenceByKey);

    expect(projection.tasks).toHaveLength(1_000);
    expect(runs).toHaveLength(1_000);
    expect(sequenceByKey.size).toBe(1_000);
    expect(sequenceByKey.get('execution:run-0')).toEqual({ index: 1, count: 10 });
    expect(sequenceByKey.get('execution:run-9')).toEqual({ index: 10, count: 10 });

    const running = board.filterRuns(runs, { filter: 'running', includeArchived: false });
    const attention = board.filterRuns(runs, { filter: 'attention', includeArchived: false });
    const byAgentAndSource = board.filterRuns(runs, {
      filter: 'all', includeArchived: true, sourceFilter: 'local-cli', agentFilter: 'agent-2',
    });
    const searched = board.filterRuns(runs, { filter: 'all', includeArchived: true, search: 'safe task 99' });
    expect(running).toHaveLength(200);
    expect(attention).toHaveLength(400);
    expect(byAgentAndSource).toHaveLength(125);
    expect(searched).toHaveLength(11);

    const boardHtml = board.render(projection, options);
    const queueHtml = board.renderQueue(runs, {
      ...options,
      filtered: false,
      allRuns: runs,
    });
    const snapshot = model.buildGlobalSnapshot(projection, { limit: 5 });
    const selection = board.reconcileAttemptSelection(
      attemptFixture(),
      'execution:attempt-execution-17',
      '',
    );

    expect(boardHtml.match(/data-dashboard-board-run-key=/g)).toHaveLength(1_000);
    expect(queueHtml.match(/data-run-center-queue-run-key=/g)).toHaveLength(1_000);
    expect(openingTagCount(boardHtml)).toBeGreaterThan(8_000);
    expect(openingTagCount(queueHtml)).toBeGreaterThan(8_000);
    expect({ ...snapshot.counts }).toEqual({ attention: 400, running: 200, recentCompleted: 200 });
    expect(Array.from(snapshot.attention)).toHaveLength(5);
    expect(Array.from(snapshot.running)).toHaveLength(5);
    expect(Array.from(snapshot.recentCompleted)).toHaveLength(5);
    expect(selection.attempts).toHaveLength(20);
    expect(selection.selected.key).toBe('execution:attempt-execution-17');

    const updatedProjection = {
      ...projection,
      tasks: projection.tasks.map((task, index) => index === 999
        ? { ...task, status: 'running', column: 'running', updatedAt: '2026-09-04T12:01:00.000Z' }
        : task),
    };
    const reports = [
      benchmark('runModelBuild', () => model.buildRunModels(projection).length),
      benchmark('runSequenceBuild', () => model.buildRunSequence(runs).size),
      benchmark('filterFeedback', () => board.filterRuns(runs, {
        filter: 'attention', includeArchived: true, search: 'task', agentFilter: 'agent-2',
      }).length),
      benchmark('fullTaskBoardHtml', () => board.render(projection, options).length),
      benchmark('fullTaskQueueHtml', () => board.renderQueue(runs, { ...options, filtered: false, allRuns: runs }).length),
      benchmark('globalQuickSnapshot', () => model.buildGlobalSnapshot(projection, { limit: 5 }).attention.length),
      benchmark('runAttemptSelection', () => board.reconcileAttemptSelection(
        attemptFixture(), 'execution:attempt-execution-17', '',
      ).index),
      benchmark('watchRefreshToVisibleHtml', () => {
        const updatedRuns = model.buildRunModels(updatedProjection);
        const updatedSequence = model.buildRunSequence(updatedRuns);
        return board.render(updatedProjection, renderOptions(updatedRuns, updatedSequence)).length;
      }),
      benchmark('backgroundProjectionWork', () => {
        const rebuilt = model.buildRunModels(updatedProjection);
        return board.filterRuns(rebuilt, { filter: 'all', includeArchived: true }).length;
      }),
    ];

    expect(reports.every((report) => report.samples === SAMPLE_ROUNDS && Number.isFinite(report.p95Ms))).toBe(true);
    if (PERF_ENABLED) {
      const report = {
        environment: {
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          cpu: os.cpus()[0]?.model || 'unknown',
          logicalCpus: os.cpus().length,
          totalMemoryGiB: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
        },
        fixture: {
          safeProjectionTasks: projection.tasks.length,
          logicalRuns: runs.length,
          warmUpRounds: WARM_UP_ROUNDS,
          sampleRounds: SAMPLE_ROUNDS,
          boardHtmlBytes: Buffer.byteLength(boardHtml),
          boardOpeningTags: openingTagCount(boardHtml),
          queueHtmlBytes: Buffer.byteLength(queueHtml),
          queueOpeningTags: openingTagCount(queueHtml),
        },
        referenceGoalsMs: {
          globalQuickPanel: { p50: 300, p95: 1_000 },
          fullTaskPage: { p50: 500, p95: 1_500 },
          filterP95: 100,
          watchRefreshP95: 1_000,
          backgroundLongTask: 50,
        },
        measurements: reports,
      };
      process.stdout.write(`\nRUN_CENTER_PERFORMANCE_REPORT ${JSON.stringify(report, null, 2)}\n`);
    }
  });
});
