// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function loadAttemptsApi() {
  const context: any = {
    window: {}, document: {}, Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center.js'), context);
  return context.window.CogSeedRunCenterAttempts;
}

describe('Run Center run and attempt identity', () => {
  it('deduplicates execution IDs, keeps group parents as targets, and sorts stably', () => {
    const attemptsApi = loadAttemptsApi();
    const members = [
      { taskId: 'child-middle', parentTaskId: 'parent-middle', executionId: 'execution-middle', sessionId: 'session-middle', status: 'failed', createdAt: '2026-08-27T10:00:00.000Z', updatedAt: '2026-08-27T10:30:00.000Z' },
      { taskId: 'latest', executionId: 'execution-latest', sessionId: 'session-latest', status: 'completed', createdAt: '2026-08-27T11:00:00.000Z', updatedAt: '2026-08-27T12:00:00.000Z' },
      { taskId: 'old', executionId: 'execution-old', sessionId: 'session-old', status: 'failed', createdAt: '2026-08-27T08:00:00.000Z', updatedAt: '2026-08-27T09:00:00.000Z' },
      { taskId: 'parent-middle', executionId: 'execution-middle', sessionId: 'session-middle', status: 'running', createdAt: '2026-08-27T10:00:00.000Z', updatedAt: '2026-08-27T10:15:00.000Z' },
    ];

    const first = attemptsApi.buildAttemptModels({ members });
    const reordered = attemptsApi.buildAttemptModels({ members: [...members].reverse() });

    expect(first).toHaveLength(3);
    expect(first.map((attempt: any) => attempt.key)).toEqual([
      'execution:execution-latest', 'execution:execution-middle', 'execution:execution-old',
    ]);
    expect(reordered.map((attempt: any) => attempt.key)).toEqual(first.map((attempt: any) => attempt.key));
    expect(first[1].members).toHaveLength(2);
    expect(first[1].representative.taskId).toBe('parent-middle');
    expect(first[1].status).toBe('failed');
  });

  it('preserves a selected attempt by key across reorder and falls back when it disappears', () => {
    const attemptsApi = loadAttemptsApi();
    const members = [
      { taskId: 'new', executionId: 'new', updatedAt: '2026-08-27T12:00:00.000Z' },
      { taskId: 'selected', executionId: 'selected', updatedAt: '2026-08-27T11:00:00.000Z' },
      { taskId: 'old', executionId: 'old', updatedAt: '2026-08-27T10:00:00.000Z' },
    ];
    const selected = attemptsApi.reconcileAttemptSelection({ members }, 'execution:selected', '');
    const reordered = attemptsApi.reconcileAttemptSelection({ members: [...members].reverse() }, selected.selected.key, '');
    const removed = attemptsApi.reconcileAttemptSelection({ members: [members[0], members[2]] }, selected.selected.key, '');

    expect(reordered.selected.key).toBe('execution:selected');
    expect(reordered.index).toBe(1);
    expect(removed.selected.key).toBe('execution:new');
    expect(attemptsApi.failureCategory('provider_error')).toBe('provider');
    expect(attemptsApi.failureCategory('private-unmapped-code')).toBe('other');
  });

  it('maps every failure code to its category and treats near-miss codes as unmapped', () => {
    const attemptsApi = loadAttemptsApi();

    expect(attemptsApi.failureCategory('model_preflight')).toBe('model');
    expect(attemptsApi.failureCategory('provider_error')).toBe('provider');
    expect(attemptsApi.failureCategory('group_chat_run_failed')).toBe('collaboration');
    expect(attemptsApi.failureCategory('unknown_code')).toBe('other');

    // An absent code is "no failure", not an unmapped one: the detail pane keys
    // its error banner off 'none', so a succeeded run must never reach 'other'.
    for (const empty of [undefined, null, '', 0, false, NaN]) {
      expect(attemptsApi.failureCategory(empty)).toBe('none');
    }

    // Matching is exact: a code that differs only by case or padding falls to
    // 'other' and loses its category, so producers must emit the literal code.
    for (const nearMiss of ['Provider_Error', 'PROVIDER_ERROR', ' provider_error', 'provider_error ']) {
      expect(attemptsApi.failureCategory(nearMiss)).toBe('other');
    }

    // A truthy non-string is unmapped rather than throwing.
    expect(attemptsApi.failureCategory(42)).toBe('other');
    expect(attemptsApi.failureCategory({})).toBe('other');
  });

  it('uses queue and board modes, embeds summary/history, reveals collaboration on demand, and retains stable selection', async () => {
    const panelListeners = new Map<string, (event: any) => void>();
    const documentListeners = new Map<string, (event: any) => void>();
    const calls: Array<{ channel: string; payload: any }> = [];
    const documentState: any = { hidden: false, activeElement: null };
    let watchChange: ((event: any) => void) | null = null;
    let deferredTaskId = '';
    let resolveDeferred: ((value: any) => void) | null = null;
    let html = '';

    const taskAOld = {
      taskId: 'task-a-old', groupId: 'group-a', executionId: 'exec-a-old', sessionId: 'session-shared',
      sourceKind: 'agent', agentId: 'agent-a', title: 'Old attempt', status: 'failed', column: 'attention',
      createdAt: '2026-08-27T09:00:00.000Z', updatedAt: '2026-08-27T09:10:00.000Z',
      errorCode: 'provider_error', eventCount: 1, prompt: 'PRIVATE_PROMPT', path: 'PRIVATE_PATH',
      rawPayload: 'PRIVATE_PAYLOAD', actions: {},
    };
    const taskANew = {
      ...taskAOld, taskId: 'task-a-new', executionId: 'exec-a-new', title: 'Current attempt',
      status: 'completed', column: 'completed', createdAt: '2026-08-27T09:30:00.000Z',
      updatedAt: '2026-08-27T09:40:00.000Z', eventCount: 4, errorCode: '',
    };
    const taskB = {
      ...taskAOld, taskId: 'task-b', groupId: '', executionId: 'exec-b', title: 'Completed run',
      status: 'completed', column: 'completed', createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:10:00.000Z', eventCount: 2, errorCode: '',
    };
    const taskC = {
      ...taskAOld, taskId: 'task-c', groupId: '', executionId: 'exec-c', title: 'Team run',
      status: 'running', column: 'running', createdAt: '2026-08-27T11:00:00.000Z',
      updatedAt: '2026-08-27T11:10:00.000Z', participantCount: 2, eventCount: 3, errorCode: '',
    };
    let tasks: any[] = [taskAOld, taskC, taskB, taskANew];

    const dataProperty = (name: string) => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const parseDataset = (tag: string) => Object.fromEntries(Array.from(
      tag.matchAll(/\sdata-([a-z0-9-]+)(?:="([^"]*)")?/g),
      (match) => [dataProperty(match[1]), match[2] || ''],
    ));
    const matchesSelector = (element: any, selector: string): boolean => {
      if (selector.includes(',')) return selector.split(',').some((part) => matchesSelector(element, part.trim()));
      const data = selector.match(/\[data-([a-z0-9-]+)(?:=["']?([^"'\]]+)["']?)?\]/);
      if (data) {
        const property = dataProperty(data[1]);
        if (!Object.prototype.hasOwnProperty.call(element.dataset || {}, property)) return false;
        if (data[2] !== undefined && String(element.dataset[property]) !== data[2].replace(/\\/g, '')) return false;
      }
      const id = selector.match(/#([a-zA-Z0-9_-]+)/);
      if (id && element.id !== id[1]) return false;
      const className = selector.match(/\.([a-zA-Z0-9_-]+)/);
      if (className && !(element.className || '').split(/\s+/).includes(className[1])) return false;
      if (selector.trim() === 'button' && element.tagName !== 'BUTTON') return false;
      return !!(data || id || className || selector.trim() === 'button');
    };
    const makeControl = (tag: string, tagName: string) => {
      const dataset = parseDataset(tag);
      const element: any = {
        tagName: tagName.toUpperCase(),
        id: tag.match(/\sid="([^"]+)"/)?.[1] || '',
        className: tag.match(/\sclass="([^"]*)"/)?.[1] || '',
        dataset,
        attributes: Array.from(tag.matchAll(/\s(data-[a-z0-9-]+|id|class)(?:="([^"]*)")?/g), (match) => ({ name: match[1], value: match[2] || '' })),
        tabIndex: Number(tag.match(/\stabindex="(-?\d+)"/)?.[1] || 0),
        focus: () => { documentState.activeElement = element; },
        scrollIntoView: vi.fn(),
      };
      element.matches = (selector: string) => matchesSelector(element, selector);
      element.closest = (selector: string) => selector === 'button' && element.tagName === 'BUTTON'
        ? element : matchesSelector(element, selector) ? element : null;
      return element;
    };
    const scrollNodes = new Map<string, any>();
    const panel: any = {
      addEventListener: (type: string, listener: (event: any) => void) => panelListeners.set(type, listener),
      contains: (element: unknown) => controls.includes(element),
      closest: () => ({ classList: { contains: (name: string) => name === 'active' } }),
      querySelector: (selector: string) => {
        if (selector.startsWith('.')) {
          if (!scrollNodes.has(selector)) scrollNodes.set(selector, { scrollTop: 0, scrollLeft: 0 });
          return scrollNodes.get(selector);
        }
        return controls.find((control) => matchesSelector(control, selector)) || null;
      },
      querySelectorAll: (selector: string) => controls.filter((control) => matchesSelector(control, selector)),
      get innerHTML() { return html; },
      set innerHTML(value: string) {
        html = value;
        controls = Array.from(value.matchAll(/<(button|input|select|textarea)\b[^>]*>/g), (match) => makeControl(match[0], match[1]));
      },
    };
    let controls: any[] = [];

    const detailFor = (task: any, marker = '') => {
      const selected = { ...task, ...(marker ? { worktreeName: marker } : {}) };
      const isTeam = selected.taskId === taskC.taskId;
      const session = { sessionId: selected.sessionId, title: 'Shared session', latestTaskId: selected.taskId, updatedAt: selected.updatedAt, participantCount: isTeam ? 2 : 1 };
      return {
        session,
        collaboration: {
          session, task: selected,
          tasks: selected.groupId === 'group-a' ? [taskAOld, taskANew] : [selected],
          actors: isTeam ? [{ actorId: 'agent-c', role: 'worker', status: 'running' }] : [],
          workflow: isTeam ? { childTaskIds: [], steps: [{ stepId: 'step-c', status: 'running', attemptCount: 1 }] } : { childTaskIds: [], steps: [] },
          reviews: [], conflicts: [], activity: [],
          timeline: Array.from({ length: selected.eventCount || 0 }, (_item, index) => ({
            eventId: `event-${selected.taskId}-${index}`, taskId: selected.taskId, type: 'task.started', createdAt: selected.updatedAt,
          })),
          actions: {},
        },
      };
    };
    const taskById = (taskId: string) => tasks.find((task) => task.taskId === taskId)
      || [taskAOld, taskANew, taskB, taskC].find((task) => task.taskId === taskId);
    const invoke = vi.fn(async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'cogseed.task.list') return { tasks, groups: [], counts: {} };
      if (channel === 'cogseed.session.list') return { sessions: [{ sessionId: 'session-shared', title: 'Shared session', latestTaskId: taskC.taskId, updatedAt: taskC.updatedAt }] };
      if (channel === 'cogseed.agent.list') return {
        agents: [
          { agentId: 'agent-a', displayName: 'Agent A', dispatchable: true },
          { agentId: 'agent-c', displayName: 'Agent C', dispatchable: true },
        ], runtimes: [], channels: [],
      };
      if (channel === 'agents.list') return { agents: [] };
      if (channel === 'cogseed.session.read') {
        const selected = taskById(payload.taskId);
        if (!selected) throw new Error('unknown run');
        if (payload.taskId === deferredTaskId) {
          deferredTaskId = '';
          return new Promise((resolve) => { resolveDeferred = resolve; });
        }
        return detailFor(selected);
      }
      throw new Error(`unexpected channel: ${channel}`);
    });
    const context: any = {
      window: {
        cogseed: {
          invoke,
          stream: (_channel: string, _payload: unknown, onEvent: (event: any) => void) => {
            watchChange = onEvent;
            return { cancel: vi.fn(), promise: new Promise(() => {}) };
          },
        },
        addEventListener: vi.fn(), setTimeout, clearTimeout, matchMedia: () => ({ matches: true }),
        uiIconHtml: (name: string) => `<i>${name}</i>`, confirm: vi.fn(() => true),
      },
      document: Object.assign(documentState, {
        getElementById: () => panel,
        addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, listener),
      }),
      t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
      getLang: () => 'en', Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center.js'), context);
    context.window.renderRunCenter('runs');

    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let index = 0; index < 240; index += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`run center did not settle: ${label}`);
    };
    const click = (control: any) => {
      expect(control, 'expected control to exist').toBeTruthy();
      panelListeners.get('click')?.({ target: control });
    };
    const queueKey = (key: string) => panel.querySelector(`[data-run-center-queue-run-key="${key}"]`);
    const detailTab = (tab: string) => panel.querySelector(`[data-run-center-detail-tab="${tab}"]`);
    const readCallsFor = (taskId: string) => calls.filter((call) => call.channel === 'cogseed.session.read' && call.payload.taskId === taskId);

    await waitFor(() => readCallsFor(taskANew.taskId).length > 0 && html.includes('class="run-center-run-detail"'), 'initial queue/detail');
    expect(html).toContain('class="run-center-layout is-runs is-queue-mode"');
    expect(html).toContain('data-run-center-mode="queue"');
    expect(html).toContain('data-run-center-mode="board"');
    expect(html).toContain('data-run-center-detail-tab="summary"');
    expect(html).toContain('data-run-center-detail-tab="history"');
    expect(html).toContain('run_center.run_sequence');
    expect(html).toContain('data-run-center-queue-run-key="group:group-a"');

    click(panel.querySelector('[data-run-center-mode="board"]'));
    expect(html).toContain('class="run-center-layout is-runs is-board-mode"');
    expect(html).toContain('data-dashboard-board-run-key="group:group-a"');
    click(panel.querySelector('[data-run-center-mode="queue"]'));
    expect(html).toContain('class="run-center-layout is-runs is-queue-mode"');

    click(queueKey('group:group-a'));
    await waitFor(() => readCallsFor(taskANew.taskId).length > 0 && html.includes('is-detail-open'), 'selected run summary');
    expect(html).toContain('class="run-center-run-detail-pane">');
    expect(html).toMatch(/data-run-center-detail-tab="summary"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-run-center-detail-tab="summary"/);
    for (const privateValue of [taskANew.prompt, taskANew.path, taskANew.rawPayload]) expect(html).not.toContain(privateValue);

    click(detailTab('history'));
    await waitFor(() => panel.querySelectorAll('[data-run-center-attempt-index]').length === 2, 'history attempts');
    expect(html).toContain('run_center.attempt_badge_latest');
    expect(html).toContain('run_center.attempt_badge_failed');
    const attemptKeyBeforeRace = context.window.CogSeedRunCenterAttempts
      .reconcileAttemptSelection({ members: [taskAOld, taskANew] }, 'execution:exec-a-new', '').selected.key;
    expect(attemptKeyBeforeRace).toBe('execution:exec-a-new');

    deferredTaskId = taskAOld.taskId;
    const oldAttemptControl = panel.querySelector('[data-run-center-attempt-index="1"]');
    const newAttemptControl = panel.querySelector('[data-run-center-attempt-index="0"]');
    click(oldAttemptControl);
    await waitFor(() => readCallsFor(taskAOld.taskId).length > 0 && resolveDeferred !== null, 'deferred old attempt');
    click(newAttemptControl);
    await waitFor(() => readCallsFor(taskANew.taskId).length >= 2 && html.includes('run_center.attempt_badge_latest'), 'new attempt wins');
    resolveDeferred?.(detailFor(taskAOld, 'LATE_PRIVATE_READ'));
    resolveDeferred = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(html).not.toContain('LATE_PRIVATE_READ');
    expect(html).toMatch(/aria-selected="true"[^>]*data-run-center-attempt-index="0"/);

    const listCallsBeforeRefresh = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    tasks = [taskC, taskB, { ...taskAOld, updatedAt: '2026-08-27T12:00:00.000Z' }, taskANew];
    watchChange?.({ type: 'change' });
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length > listCallsBeforeRefresh
      && html.includes('data-run-center-attempt-index="1"'), 'refresh reorder');
    expect(html).toContain('data-run-center-queue-run-key="group:group-a"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-run-center-attempt-index="1"/);

    click(queueKey('execution:exec-c'));
    await waitFor(() => readCallsFor(taskC.taskId).length >= 1 && html.includes('data-run-center-detail-tab="collaboration"'), 'collaboration availability');
    click(detailTab('collaboration'));
    await waitFor(() => html.includes('class="run-center-collaboration"'), 'collaboration tab');
    expect(html).not.toContain('class="run-center-layout is-collaboration"');

    click(panel.querySelector('[data-run-center-detail-back]'));
    expect(html).toContain('class="run-center-layout is-runs is-queue-mode"');
    expect(html).not.toContain('class="run-center-layout is-runs is-queue-mode is-detail-open"');
  });
});
