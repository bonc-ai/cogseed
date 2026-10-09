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

function loadGlobal(initialProjection: any, mountTrigger = false) {
  let projection = initialProjection;
  let panelHtml = '';
  let triggerHtml = '';
  let mounted = !mountTrigger;
  const documentListeners = new Map<string, (event: any) => void>();
  const windowListeners = new Map<string, (event: any) => void>();
  const panelListeners = new Map<string, (event: any) => void>();
  const triggerListeners = new Map<string, (event: any) => void>();
  let watchChange: ((event: any) => void) | null = null;

  const element = (id: string) => ({
    id,
    hidden: false,
    dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); },
  });
  const trigger: any = {
    ...element('run-center-global-btn'),
    getBoundingClientRect: () => ({ left: 180, bottom: 66 }),
    appendChild: vi.fn(),
    focus: vi.fn(),
    addEventListener(type: string, listener: (event: any) => void) { triggerListeners.set(type, listener); },
  };
  const badge: any = element('run-center-global-badge');
  const host = {
    set innerHTML(value: string) {
      triggerHtml = value;
      mounted = true;
      for (const [, name, attrValue] of value.matchAll(/(aria-[\w-]+|title)="([^"]*)"/g)) trigger.attributes[name] = attrValue;
    },
    querySelector: () => trigger,
  };
  const returnButton: any = {
    ...element('run-center-return-btn'),
    addEventListener: vi.fn(),
  };
  let panel: any = null;
  const mainContent = {
    appendChild(child: any) { panel = child; },
  };
  const document: any = {
    readyState: 'complete',
    hidden: false,
    body: mainContent,
    getElementById(id: string) {
      if (id === trigger.id) return mounted ? trigger : null;
      if (id === 'run-center-global-entry') return host;
      if (id === badge.id) return badge;
      if (id === returnButton.id) return returnButton;
      if (id === 'run-center-quick-panel') return panel;
      return null;
    },
    querySelector(selector: string) { return selector === '.main-content' ? mainContent : null; },
    createElement() {
      const created: any = {
        id: '', className: '', hidden: false, dataset: {}, style: {}, attributes: {} as Record<string, string>,
        setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); },
        addEventListener(type: string, listener: (event: any) => void) { panelListeners.set(type, listener); },
      };
      Object.defineProperty(created, 'innerHTML', {
        get: () => panelHtml,
        set: (value: string) => { panelHtml = value; },
      });
      return created;
    },
    addEventListener(type: string, listener: (event: any) => void) { documentListeners.set(type, listener); },
  };
  const setView = vi.fn();
  const uiToast = vi.fn();
  const cancelWatch = vi.fn();
  const context: any = {
    window: {
      document,
      innerWidth: 1440,
      innerHeight: 900,
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
      uiToast,
      uiIconHtml: (name: string) => `<i>${name}</i>`,
      hydrateUiIcons: vi.fn(),
      t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
      getLang: () => 'en',
      addEventListener(type: string, listener: (event: any) => void) { windowListeners.set(type, listener); },
      setTimeout,
      clearTimeout,
    },
    document,
    Date,
    Intl,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Promise,
    Error,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/ui-button.js'), context, { filename: 'ui-button.js' });
  vm.runInContext(read('src/renderer/modules/ui-empty.js'), context, { filename: 'ui-empty.js' });
  vm.runInContext(read('src/renderer/modules/run-center-model.js'), context, { filename: 'run-center-model.js' });
  vm.runInContext(read('src/renderer/modules/run-center-global.js'), context, { filename: 'run-center-global.js' });

  const eventTarget = (dataset: Record<string, string>) => {
    const target: any = { dataset };
    target.closest = (selector: string) => selector === 'button' ? target : null;
    return target;
  };
  const clickPanel = (dataset: Record<string, string>) => {
    panelListeners.get('click')?.({ target: eventTarget(dataset) });
  };
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('global Run Center did not settle');
  };

  return {
    context,
    trigger,
    badge,
    setView,
    uiToast,
    clickPanel,
    open: () => triggerListeners.get('click')?.({ preventDefault: vi.fn() }),
    close: () => context.window.closeRunCenterGlobal?.(),
    html: () => panelHtml,
    triggerHtml: () => triggerHtml,
    panel: () => panel,
    keydown: (key: string, isComposing = false) => {
      const event = { key, isComposing, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
      documentListeners.get('keydown')?.(event);
      return event;
    },
    outsideClick: () => documentListeners.get('click')?.({ target: { closest: () => null } }),
    resize: (width: number, height: number) => {
      context.window.innerWidth = width;
      context.window.innerHeight = height;
      windowListeners.get('resize')?.({});
    },
    setProjection: (value: any) => { projection = value; },
    emitChange: (event = { type: 'change' }) => watchChange?.(event),
    waitFor,
  };
}

describe('resident Run Center global surface', () => {
  it('mounts a named shared icon trigger, announces the full count, and bounds the visual badge', async () => {
    const harness = loadGlobal({ tasks: Array.from({ length: 101 }, (_, i) => task('attention', i)), groups: [] }, true);
    await harness.waitFor(() => harness.badge.dataset.state === 'attention');
    expect(harness.triggerHtml()).toContain('class="ui-icon-button run-center-global-btn"');
    expect(harness.triggerHtml()).toContain('aria-controls="run-center-quick-panel"');
    expect(harness.triggerHtml()).toContain('aria-haspopup="dialog"');
    expect(harness.triggerHtml()).not.toContain('ui-button__label');
    expect(harness.triggerHtml()).toContain('<i>activity</i>');
    expect(harness.trigger.attributes['aria-label']).toContain('101');
    expect(harness.badge.textContent).toBe('99+');
    expect(harness.trigger.appendChild).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-center-global-badge', attributes: { 'aria-hidden': 'true' },
    }));
  });

  it('anchors the panel to the sidebar, clamps on resize and returns focus on Escape', async () => {
    const harness = loadGlobal({ tasks: [], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'empty');
    harness.open();
    expect(harness.panel().style).toEqual({ left: '180px', top: '74px', maxHeight: '680px' });
    expect(harness.trigger.attributes['aria-expanded']).toBe('true');
    harness.resize(320, 640);
    expect(harness.panel().style).toEqual({ left: '12px', top: '74px', maxHeight: '554px' });
    harness.keydown('Escape', true);
    expect(harness.panel().hidden).toBe(false);
    const escape = harness.keydown('Escape');
    expect(harness.panel().hidden).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(harness.trigger.attributes['aria-expanded']).toBe('false');
    expect(harness.trigger.focus).toHaveBeenCalledOnce();
    harness.open();
    harness.outsideClick();
    expect(harness.panel().hidden).toBe(true);
    expect(harness.setView).not.toHaveBeenCalled();
  });

  it('restores refreshed keyboard focus only to the same action identity', async () => {
    const harness = loadGlobal({ tasks: [task('attention', 1)], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'ready');
    harness.open();
    await harness.waitFor(() => !harness.context.window.runCenterGlobalState.refreshInFlight);
    const identity = { runCenterGlobalTask: '', runCenterGlobalConversationId: 'conversation-1', runCenterGlobalRunKey: 'run-1' };
    const current = { dataset: identity };
    const other = { dataset: { ...identity, runCenterGlobalConversationId: 'conversation-2' }, focus: vi.fn() };
    const replacement = { dataset: { ...identity }, focus: vi.fn() };
    const close = { focus: vi.fn() };
    harness.context.document.activeElement = current;
    harness.panel().contains = (element: unknown) => element === current;
    harness.panel().querySelectorAll = () => [other, replacement];
    harness.panel().querySelector = () => close;
    harness.clickPanel({ runCenterGlobalRetry: '' });
    await harness.waitFor(() => !harness.context.window.runCenterGlobalState.refreshInFlight);
    expect(replacement.focus).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();

    harness.panel().querySelectorAll = () => [other];
    harness.clickPanel({ runCenterGlobalRetry: '' });
    await harness.waitFor(() => !harness.context.window.runCenterGlobalState.refreshInFlight);
    expect(close.focus).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('composes the production shared controls and empty state in the real quick panel', async () => {
    const harness = loadGlobal({ tasks: [], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'empty');
    harness.open();
    await harness.waitFor(() => harness.html().includes('run-center-quick-section is-attention'));

    expect(harness.html()).toContain('class="btn ui-button');
    expect(harness.html()).toContain('class="ui-icon-button');
    expect(harness.html().match(/class="ui-empty-state ui-empty-state--quiet"/g)).toHaveLength(3);
    expect(harness.html()).toContain('data-empty-kind="quiet"');
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

  it('keeps recent sections and Run sequences stable when timestamps tie and input order changes', async () => {
    const tasks = Array.from({ length: 7 }, (_, index) => task('running', index, {
      createdAt: '2026-09-03T09:00:00Z', updatedAt: '2026-09-03T10:00:00Z',
    }));
    const harness = loadGlobal({ tasks, groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.snapshot !== null);
    const before = harness.context.window.runCenterGlobalState.snapshot;
    harness.setProjection({ tasks: [...tasks].reverse(), groups: [] });
    harness.open();
    await harness.waitFor(() => !harness.context.window.runCenterGlobalState.refreshInFlight);
    const after = harness.context.window.runCenterGlobalState.snapshot;
    expect(after).not.toBe(before);
    expect(after.running).toEqual(before.running);
    expect(after.running.map((run: any) => run.key)).toEqual(tasks.slice(0, 5).map((item) => `execution:${item.executionId}`));
    expect(after.running.map((run: any) => run.sequence)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ index: index + 1, count: 7 })),
    );
  });

  it('prioritizes attention in the badge and renders privacy-safe rows', async () => {
    const projection = {
      tasks: [
        ...Array.from({ length: 6 }, (_, index) => task('attention', index + 1)),
        ...Array.from({ length: 2 }, (_, index) => task('running', index + 1)),
        task('completed', 1),
      ],
      groups: [],
    };
    const harness = loadGlobal(projection);
    await harness.waitFor(() => harness.badge.dataset.state === 'attention');

    expect(harness.badge.hidden).toBe(false);
    expect(harness.badge.textContent).toBe('6');
    harness.open();
    await harness.waitFor(() => harness.html().includes('run-center-quick-section is-attention'));
    const attentionSection = harness.html().match(/<section class="run-center-quick-section is-attention">([\s\S]*?)<\/section>/)?.[1] || '';
    expect(attentionSection.match(/class="run-center-quick-item"/g)).toHaveLength(5);
    expect(harness.html()).toContain('attention task 6');
    expect(harness.html()).toContain('agent-attention');
    expect(harness.html()).toContain('run_center.run_sequence');
    for (const privateValue of ['PRIVATE_PROMPT', '/private/', 'PRIVATE_PAYLOAD']) {
      expect(harness.html()).not.toContain(privateValue);
    }
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

  it('marks loading work as busy and recovers stale data through the local retry', async () => {
    let resolveInitial: (value: any) => void = () => undefined;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    const harness = loadGlobal(initial);

    expect(harness.panel()?.attributes['aria-busy']).toBe('true');
    expect(harness.context.window.runCenterGlobalState.dataState).toBe('loading');
    resolveInitial({ tasks: [task('attention', 1)], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'ready');
    expect(harness.panel()?.attributes['aria-busy']).toBe('false');

    harness.open();
    await harness.waitFor(() => harness.html().includes('attention task 1'));
    harness.setProjection(new Error('temporary projection failure'));
    harness.emitChange();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'stale');

    expect(harness.panel()?.attributes['aria-busy']).toBe('false');
    expect(harness.html()).toContain('attention task 1');
    expect(harness.html()).toContain('temporary projection failure');
    expect(harness.html()).toContain('data-run-center-global-retry');

    harness.setProjection({ tasks: [task('running', 2)], groups: [] });
    harness.clickPanel({ runCenterGlobalRetry: '' });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.dataState === 'ready'
      && harness.html().includes('running task 2'));
    expect(harness.html()).not.toContain('temporary projection failure');
    expect(harness.html()).not.toContain('data-run-center-global-retry');
  });

  it('opens filtered Tasks, starts creation, and preserves the panel on unavailable details', async () => {
    const harness = loadGlobal({ tasks: [task('attention', 1, { conversationId: '' })], groups: [] });
    await harness.waitFor(() => harness.badge.dataset.state === 'attention');
    harness.open();
    await harness.waitFor(() => harness.panel()?.hidden === false);

    harness.clickPanel({ runCenterGlobalViewAll: 'attention' });
    expect(harness.setView).toHaveBeenLastCalledWith('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { query: { filter: 'attention' } },
    });

    harness.open();
    harness.clickPanel({ runCenterGlobalCreate: '' });
    expect(harness.setView).toHaveBeenLastCalledWith('run-center', null, {
      runCenterView: 'tasks',
      runCenterOptions: { openCreate: true },
    });

    harness.open();
    const callsBeforeUnavailable = harness.setView.mock.calls.length;
    harness.clickPanel({ runCenterGlobalTask: '', runCenterGlobalConversationId: '' });
    expect(harness.setView).toHaveBeenCalledTimes(callsBeforeUnavailable);
    expect(harness.uiToast).toHaveBeenCalledWith('Task details are unavailable', { variant: 'warning' });
    expect(harness.panel()?.hidden).toBe(false);
  });

  it('opens an exact task with proof context and a Run Center return object', async () => {
    const harness = loadGlobal({ tasks: [task('completed', 1)], groups: [] });
    await harness.waitFor(() => harness.context.window.runCenterGlobalState.snapshot !== null);
    harness.open();
    harness.clickPanel({
      runCenterGlobalTask: '',
      runCenterGlobalConversationId: 'completed-conversation-1',
    });

    expect(harness.setView).toHaveBeenLastCalledWith(
      'conversation',
      'completed-conversation-1',
      expect.objectContaining({
        entryPoint: 'run-center',
        openRunContext: 'proof',
        runCenterReturn: expect.objectContaining({
          sourceView: 'tasks', taskScope: 'current', runMode: 'board',
        }),
      }),
    );
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

  it('closes the quick panel without stopping the resident status surface', async () => {
    const harness = loadGlobal({ tasks: [task('running', 1)], groups: [] });
    await harness.waitFor(() => harness.badge.dataset.state === 'running');
    harness.open();
    await harness.waitFor(() => harness.panel()?.hidden === false);

    harness.close();

    expect(harness.panel()?.hidden).toBe(true);
    expect(harness.context.window.runCenterGlobalState.watch).not.toBeNull();
  });
});
