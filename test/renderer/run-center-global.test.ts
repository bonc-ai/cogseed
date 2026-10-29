// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function task(
  kind: 'attention' | 'running' | 'completed',
  index: number,
  overrides: Record<string, unknown> = {},
) {
  const status = kind === 'attention' ? 'waiting_user' : kind === 'running' ? 'running' : 'completed';
  return {
    taskId: `${kind}-task-${index}`,
    executionId: `${kind}-execution-${index}`,
    sessionId: `${kind}-session`,
    conversationId: `${kind}-conversation-${index}`,
    title: `${kind} task ${index}`,
    agentId: `agent-${kind}`,
    status,
    column: kind === 'attention' ? 'attention' : kind,
    createdAt: `2026-09-03T0${Math.min(index, 9)}:00:00.000Z`,
    updatedAt: `2026-09-03T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
    prompt: `PRIVATE_PROMPT_${kind}_${index}`,
    path: `/private/${kind}/${index}`,
    rawPayload: `PRIVATE_PAYLOAD_${kind}_${index}`,
    ...overrides,
  };
}

function loadGlobal(initialProjection: any) {
  let projection = initialProjection;
  let watchChange: ((event: any) => void) | null = null;
  const element = (id: string) => ({
    id,
    hidden: false,
    textContent: '',
    dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); },
    addEventListener: vi.fn(),
  });
  // The rail Run Center entry and its badge (rendered by ui-app-rail.js).
  const trigger: any = element('run-center-btn');
  const badge: any = element('run-center-global-badge');
  const document: any = {
    readyState: 'complete',
    hidden: false,
    getElementById(id: string) {
      if (id === trigger.id) return trigger;
      if (id === badge.id) return badge;
      return null;
    },
    addEventListener: vi.fn(),
  };
  const setView = vi.fn();
  const cancelWatch = vi.fn();
  const context: any = {
    window: {
      document,
      cogseed: {
        invoke: vi.fn(async (channel: string) => {
          expect(channel).toBe('cogseed.task.list');
          if (projection instanceof Error) throw projection;
          return projection;
        }),
        stream: vi.fn((_channel: string, _payload: unknown, listener: (event: any) => void) => {
          watchChange = listener;
          return { cancel: cancelWatch, promise: new Promise(() => {}) };
        }),
      },
      setView,
      t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
      addEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    },
    document,
    Date, Intl, Map, Set, Array, Object, String, Number, Promise, Error, Math, setTimeout, clearTimeout,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-model.js'), context, { filename: 'run-center-model.js' });
  vm.runInContext(read('src/renderer/modules/run-center-global.js'), context, { filename: 'run-center-global.js' });
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('global Run Center did not settle');
  };
  return {
    context, trigger, badge, setView, cancelWatch, waitFor,
    setProjection: (value: any) => { projection = value; },
    emitChange: (event = { type: 'change' }) => watchChange?.(event),
  };
}

describe('resident Run Center rail badge', () => {
  it('announces the full count on the rail entry and bounds the visual badge', async () => {
    const harness = loadGlobal({ tasks: Array.from({ length: 101 }, (_, i) => task('attention', i)), groups: [] });
    await harness.waitFor(() => harness.badge.dataset.state === 'attention');
    expect(harness.trigger.attributes['aria-label']).toContain('101');
    expect(harness.trigger.attributes['aria-label']).toContain('运行与协作');
    expect(harness.badge.textContent).toBe('99+');
    expect(harness.badge.hidden).toBe(false);
  });

  it('prioritizes attention over running in the badge', async () => {
    const harness = loadGlobal({
      tasks: [
        ...Array.from({ length: 6 }, (_, index) => task('attention', index + 1)),
        ...Array.from({ length: 2 }, (_, index) => task('running', index + 1)),
        task('completed', 1),
      ],
      groups: [],
    });
    await harness.waitFor(() => harness.badge.dataset.state === 'attention');
    expect(harness.badge.textContent).toBe('6');
  });

  it('shows running when no task needs attention and hides the idle badge', async () => {
    const harness = loadGlobal({ tasks: [task('running', 1), task('running', 2)], groups: [] });
    await harness.waitFor(() => harness.badge.dataset.state === 'running');
    expect(harness.badge.textContent).toBe('2');
    expect(harness.badge.hidden).toBe(false);

    harness.setProjection({ tasks: [], groups: [] });
    harness.emitChange();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await harness.waitFor(() => harness.badge.dataset.state === 'idle');
    expect(harness.badge.hidden).toBe(true);
    expect(harness.badge.textContent).toBe('');
  });

  it('keeps the last known count when a refresh fails and marks the data stale', async () => {
    const harness = loadGlobal({ tasks: [task('attention', 1)], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'ready');
    harness.setProjection(new Error('temporary projection failure'));
    harness.emitChange();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'stale');
    expect(harness.badge.textContent).toBe('1');
    expect(harness.trigger.attributes['aria-busy']).toBe('false');
  });

  it('no longer exposes the retired quick popover API', () => {
    const harness = loadGlobal({ tasks: [], groups: [] });
    expect(harness.context.window.openRunCenterGlobal).toBeUndefined();
    expect(harness.context.window.closeRunCenterGlobal).toBeUndefined();
    expect(typeof harness.context.window.openRunCenterForTask).toBe('function');
  });

  it('opens Run Center filtered to one conversation', () => {
    const harness = loadGlobal({ tasks: [], groups: [] });
    expect(harness.context.window.openRunCenterForTask('conversation-1')).toBe(true);
    expect(harness.setView).toHaveBeenCalledWith('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { query: { conversationId: 'conversation-1' } },
    });
    expect(harness.context.window.openRunCenterForTask('')).toBe(false);
  });

  it('builds three recency sections with full counts and at most five rows each', () => {
    const context: any = { window: {}, Date, Map, Set, Array, Object, String, Number, Math };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-model.js'), context);
    const projection = {
      tasks: [
        ...Array.from({ length: 7 }, (_, index) => task('attention', index + 1)),
        ...Array.from({ length: 6 }, (_, index) => task('running', index + 1)),
        ...Array.from({ length: 7 }, (_, index) => task('completed', index + 1)),
      ],
      groups: [],
    };

    const snapshot = context.window.CogSeedRunCenterModel.buildGlobalSnapshot(projection, { limit: 5 });
    expect({ ...snapshot.counts }).toEqual({ attention: 7, running: 6, recentCompleted: 7 });
    expect(Array.from(snapshot.attention)).toHaveLength(5);
    expect(Array.from(snapshot.running)).toHaveLength(5);
    expect(Array.from(snapshot.recentCompleted)).toHaveLength(5);
    expect(snapshot.attention[0].aggregateTask.taskId).toBe('attention-task-7');
    expect({ ...snapshot.attention[0].sequence }).toEqual({ index: 7, count: 7 });
  });

  it('counts logical Runs once and excludes archived and planned work from global activity', async () => {
    const parent = task('completed', 1, { taskId: 'parent', groupId: 'review' });
    const child = task('attention', 1, { taskId: 'child', groupId: 'review', parentTaskId: 'parent' });
    const failedAttempt = task('attention', 2, { executionId: 'retry', updatedAt: '2026-09-03T10:00:00Z' });
    const successfulAttempt = task('completed', 2, { executionId: 'retry', updatedAt: '2026-09-03T11:00:00Z' });
    const harness = loadGlobal({
      tasks: [parent, child, failedAttempt, successfulAttempt, task('running', 1),
        task('attention', 3, { column: 'archived' }),
        task('completed', 3, { column: 'archived' }),
        task('running', 3, { status: 'planned', column: 'pending' })],
      groups: [{ groupId: 'review', parentTaskId: 'parent' }],
    });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.snapshot !== null);
    const snapshot = harness.context.window.runCenterGlobalState.snapshot;
    expect(snapshot.counts).toEqual({ attention: 1, running: 1, recentCompleted: 1 });
    expect(snapshot.attention.map((run: any) => run.key)).toEqual(['group:review']);
    expect(snapshot.attention[0].aggregateTask).toMatchObject({ taskId: 'parent', interactionTaskId: 'child', status: 'waiting_user' });
    expect(snapshot.recentCompleted.map((run: any) => run.key)).toEqual(['execution:retry']);
    expect(snapshot.recentCompleted[0].aggregateTask.taskId).toBe(successfulAttempt.taskId);
  });

  it('returns to Run Center with the captured context unchanged', async () => {
    const harness = loadGlobal({ tasks: [], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.snapshot !== null);
    const restore = {
      sourceView: 'agents', taskScope: 'current', runMode: 'queue',
      filters: { search: 'review' }, selectedRunKey: 'execution:run-1',
      selectedAttemptKey: 'execution:attempt-2', scrollPositions: [{ key: 'main:agents', top: 90, left: 0 }],
      focusTarget: { selector: '[data-run-center-agent-filter="busy"]', index: 0 },
    };
    harness.context.window.__runCenterReturnContext = restore;

    expect(harness.context.window.returnToRunCenter()).toBe(true);
    expect(harness.setView).toHaveBeenCalledWith('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { restore },
    });
    expect(harness.context.window.__runCenterReturnContext).toBeNull();
  });

});
