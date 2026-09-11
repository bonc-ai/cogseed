// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const buttonSource = fs.readFileSync(path.join(root, 'src/renderer/modules/ui-button.js'), 'utf8');
const modelSource = fs.readFileSync(path.join(root, 'src/renderer/modules/run-center-model.js'), 'utf8');
const boardSource = fs.readFileSync(path.join(root, 'src/renderer/modules/run-center-board.js'), 'utf8');
const detailSource = fs.readFileSync(path.join(root, 'src/renderer/modules/run-center-detail.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/run-center.js'), 'utf8');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function decodeHtml(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function datasetKey(attribute: string) {
  return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function projection(label: string) {
  return {
    schemaVersion: 1,
    repository: { path: `/private/${label}`, branch: label },
    worktrees: [{
      path: `/private/${label}-worktree`, name: `${label}-worktree`, branch: `${label}-branch`,
      head: label, dirty: false, verifiable: true,
    }],
  };
}

function agentListing() {
  return { agents: [{ agent_id: 'review-agent', name: 'Reviewer', enabled: true }] };
}

function spaceListing(...spaces: Array<{ space_id: string; name: string; updated_at?: string }>) {
  return { spaces };
}

function createHarness(options: {
  registryFailure?: boolean;
  includeRuntimePeer?: boolean;
  startFailure?: Error;
  initialSpaceId?: string;
} = {}) {
  const panelListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const diagnosticsRequests: Deferred<any>[] = [];
  const agentRequests: Deferred<any>[] = [];
  const worktreeRequests: Deferred<any>[] = [];
  const spacesRequests: Deferred<any>[] = [];
  const calls: Array<{ channel: string; payload: any }> = [];
  const documentState: any = { hidden: false, activeElement: null };
  let html = '';
  let controls: any[] = [];
  let renderCount = 0;
  let startFailure = options.startFailure;
  let agentRegistryCalls = 0;

  const rebuildControls = (markup: string) => {
    const nextControls: any[] = [];
    const tagPattern = /<(button|input|textarea|select|dialog|details)\b([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(markup))) {
      const [opening, tag, rawAttributes] = match;
      const attributeMap = new Map<string, string>();
      const attributes: Array<{ name: string; value: string }> = [];
      const attributePattern = /([:\w-]+)(?:="([^"]*)")?/g;
      let attributeMatch: RegExpExecArray | null;
      while ((attributeMatch = attributePattern.exec(rawAttributes))) {
        const name = attributeMatch[1];
        const value = decodeHtml(attributeMatch[2] || '');
        attributeMap.set(name, value);
        attributes.push({ name, value });
      }
      const dataset: Record<string, string> = {};
      for (const [name, value] of attributeMap) {
        if (name.startsWith('data-')) dataset[datasetKey(name)] = value;
      }
      let value = attributeMap.get('value') || '';
      if (tag === 'textarea') {
        const close = markup.indexOf('</textarea>', match.index + opening.length);
        value = close >= 0 ? decodeHtml(markup.slice(match.index + opening.length, close)) : '';
      } else if (tag === 'select') {
        const close = markup.indexOf('</select>', match.index + opening.length);
        const options = close >= 0 ? markup.slice(match.index + opening.length, close) : '';
        const selected = options.match(/<option\b[^>]*value="([^"]*)"[^>]*\sselected(?:\s|>)/);
        const first = options.match(/<option\b[^>]*value="([^"]*)"/);
        value = decodeHtml(selected?.[1] ?? first?.[1] ?? '');
      }
      const element: any = {
        tagName: tag.toUpperCase(), attributes, dataset, value,
        disabled: attributeMap.has('disabled'), open: attributeMap.has('open'),
        selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
        getClientRects: () => [{}],
        matches: (selector: string) => {
          const parsed = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
          if (!parsed) return false;
          return attributeMap.has(parsed[1]) && (parsed[2] === undefined || attributeMap.get(parsed[1]) === parsed[2]);
        },
        focus: () => { documentState.activeElement = element; },
        setSelectionRange: (start: number, end: number, direction: string) => {
          element.selectionStart = start;
          element.selectionEnd = end;
          element.selectionDirection = direction;
        },
      };
      if (tag === 'dialog') element.showModal = () => { element.open = true; };
      nextControls.push(element);
    }
    controls = nextControls;
  };

  const matchingControls = (selector: string) => selector.split(',').flatMap((part) => {
    const trimmed = part.trim();
    return controls.filter((control) => control.matches(trimmed));
  });
  const panel: any = {
    addEventListener: (type: string, listener: (event: any) => void) => panelListeners.set(type, listener),
    querySelector: (selector: string) => matchingControls(selector)[0] || null,
    querySelectorAll: (selector: string) => matchingControls(selector),
    contains: (element: unknown) => controls.includes(element),
    closest: () => ({ classList: { contains: () => true } }),
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value;
      renderCount += 1;
      rebuildControls(value);
    },
  };

  const invoke = vi.fn((channel: string, payload: any) => {
    calls.push({ channel, payload });
    if (channel === 'cogseed.dashboard.diagnostics') {
      const request = deferred<any>();
      diagnosticsRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.worktree.list') {
      const request = deferred<any>();
      worktreeRequests.push(request);
      return request.promise;
    }
    if (channel === 'spaces.list') {
      const request = deferred<any>();
      spacesRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.task.list') return Promise.resolve({ tasks: [], groups: [], counts: {} });
    if (channel === 'cogseed.session.list') return Promise.resolve({ sessions: [] });
    if (channel === 'cogseed.agent.list' && options.registryFailure) return Promise.reject(new Error('registry unavailable'));
    if (channel === 'cogseed.agent.list') {
      agentRegistryCalls += 1;
      return Promise.resolve({
        agents: [
          { agentId: 'review-agent', displayName: 'Reviewer', definitionSource: 'custom', dispatchable: true },
          ...(options.includeRuntimePeer
            ? agentRegistryCalls > 1
              ? [{
                  agentId: 'codex-agent', displayName: 'Codex', sourceKind: 'p3394',
                  definitionSource: 'custom', runtimeKind: 'p3394-gateway:codex', dispatchable: true,
                }]
              : [{ agentId: 'codex-peer', displayName: 'Codex', sourceKind: 'p3394', dispatchable: true }]
            : []),
        ],
        runtimes: [], channels: [],
      });
    }
    if (channel === 'agents.list') {
      const request = deferred<any>();
      agentRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.task.create') return Promise.resolve({});
    if (channel === 'cogseed.task.start') {
      if (startFailure) {
        const error = startFailure;
        startFailure = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected channel: ${channel}`));
  });
  const context: any = {
    window: {
      cogseed: {
        invoke,
        stream: () => ({ cancel: vi.fn(), promise: new Promise(() => {}) }),
      },
      addEventListener: vi.fn(), setTimeout, clearTimeout, confirm: vi.fn(() => true),
      getNewChatSpaceId: vi.fn(() => options.initialSpaceId || ''),
      uiIconHtml: (name: string) => `<i>${name}</i>`,
      CogSeedRunCenterAgents: { render: () => '' },
    },
    document: Object.assign(documentState, {
      getElementById: () => panel,
      addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, listener),
    }),
    t: (key: string) => key,
    getLang: () => 'en', Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(buttonSource, context);
  vm.runInContext(modelSource, context);
  vm.runInContext(boardSource, context);
  vm.runInContext(detailSource, context);
  vm.runInContext(source, context);
  context.window.renderRunCenter();

  const flush = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await flush();
    }
    throw new Error('renderer action did not settle');
  };
  const click = (dataset: Record<string, string>) => panelListeners.get('click')?.({
    target: { closest: (selector: string) => selector === 'button' ? { dataset } : null },
  });
  const input = (selector: string, value: string) => {
    const target = panel.querySelector(selector);
    if (!target) throw new Error(`missing input: ${selector}`);
    target.value = value;
    panelListeners.get('input')?.({ target, isComposing: false });
    return target;
  };
  const change = (selector: string, value: string) => {
    const target = panel.querySelector(selector);
    if (!target) throw new Error(`missing select: ${selector}`);
    target.value = value;
    panelListeners.get('change')?.({ target });
    return target;
  };
  const toggleAdvanced = (open = true) => {
    const target = panel.querySelector('[data-run-center-create-advanced]');
    if (!target) throw new Error('missing advanced options');
    target.open = open;
    panelListeners.get('toggle')?.({ target });
  };

  return {
    calls, diagnosticsRequests, agentRequests, worktreeRequests, spacesRequests, documentState, panel, click, input, change,
    toggleAdvanced, flush, waitFor,
    html: () => html, renderCount: () => renderCount,
  };
}

describe('Run Center asynchronous tool resilience', () => {
  it('saves a persistent to-do through the dedicated create channel without starting it', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.spacesRequests[0].resolve(spaceListing());
    await harness.waitFor(() => harness.html().includes('data-run-center-create-save'));

    harness.input('[data-run-center-create-task]', 'Review the release notes later');
    harness.click({ runCenterCreateSave: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.create'));

    expect(harness.calls.find((call) => call.channel === 'cogseed.task.create')?.payload).toMatchObject({
      task: 'Review the release notes later',
    });
    expect(harness.calls.filter((call) => call.channel === 'cogseed.task.start')).toHaveLength(0);
  });

  it('inherits the new-chat workspace without changing it and submits only the safe space id', async () => {
    const harness = createHarness({ initialSpaceId: 'sp_alpha' });
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.spacesRequests[0].resolve(spaceListing(
      { space_id: 'sp_beta', name: 'Beta', updated_at: '2026-08-31T00:00:00.000Z' },
      { space_id: 'sp_alpha', name: 'Alpha', updated_at: '2026-09-01T00:00:00.000Z' },
    ));
    await harness.waitFor(() => harness.panel.querySelector('[data-run-center-create-space]')?.value === 'sp_alpha');

    harness.input('[data-run-center-create-task]', 'Run in the inherited workspace');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));

    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ task: 'Run in the inherited workspace', spaceId: 'sp_alpha' });
    expect(start?.payload).not.toHaveProperty('workingDir');
    expect(start?.payload).not.toHaveProperty('worktreeName');
  });

  it('clears and disables Worktree isolation when a CogSeed workspace is selected', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.spacesRequests[0].resolve(spaceListing({ space_id: 'sp_project', name: 'Project' }));
    await harness.waitFor(() => harness.html().includes('value="sp_project"'));
    harness.input('[data-run-center-create-task]', 'Run without cross-space isolation');
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);
    harness.agentRequests[0].resolve(agentListing());
    harness.worktreeRequests[0].resolve(projection('space-isolation'));
    await harness.waitFor(() => harness.html().includes('space-isolation-branch'));
    harness.change('[data-run-center-create-worktree]', 'space-isolation-worktree');
    harness.change('[data-run-center-create-space]', 'sp_project');

    await harness.waitFor(() => harness.panel.querySelector('[data-run-center-create-worktree]')?.disabled === true);
    expect(harness.panel.querySelector('[data-run-center-create-worktree]').value).toBe('');
    expect(harness.html()).toContain('run_center.create_space_isolation_unavailable');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));
    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ spaceId: 'sp_project' });
    expect(start?.payload).not.toHaveProperty('worktreeName');
  });

  it('reloads Worktree isolation after returning to the default workspace', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.spacesRequests[0].resolve(spaceListing({ space_id: 'sp_project', name: 'Project' }));
    await harness.waitFor(() => harness.html().includes('value="sp_project"'));
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.worktreeRequests.length === 1);
    harness.worktreeRequests[0].resolve(projection('default-before-switch'));
    await harness.waitFor(() => harness.html().includes('default-before-switch-branch'));

    harness.change('[data-run-center-create-space]', 'sp_project');
    await harness.waitFor(() => harness.panel.querySelector('[data-run-center-create-worktree]')?.disabled === true);
    harness.change('[data-run-center-create-space]', '');
    await harness.waitFor(() => harness.worktreeRequests.length === 2);
    harness.worktreeRequests[1].resolve(projection('default-after-switch'));
    await harness.waitFor(() => harness.html().includes('default-after-switch-branch'));

    expect(harness.panel.querySelector('[data-run-center-create-worktree]')?.disabled).toBe(false);
  });

  it('submits in the default workspace when the workspace list cannot be read', async () => {
    const harness = createHarness({ initialSpaceId: 'sp_unavailable' });
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.spacesRequests[0].reject(new Error('private workspace failure'));
    await harness.waitFor(() => harness.html().includes('data-run-center-create-spaces-retry'));

    harness.input('[data-run-center-create-task]', 'Run in the fallback workspace');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));

    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ task: 'Run in the fallback workspace' });
    expect(start?.payload).not.toHaveProperty('spaceId');
    expect(start?.payload).not.toHaveProperty('workingDir');
  });

  it('does not reload Worktrees when the workspace list settles after advanced options', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.worktreeRequests.length === 1);
    harness.worktreeRequests[0].resolve(projection('single-load'));
    await harness.waitFor(() => harness.html().includes('single-load-branch'));

    harness.spacesRequests[0].resolve(spaceListing());
    await harness.flush();

    expect(harness.worktreeRequests).toHaveLength(1);
  });

  it('keeps the latest workspace request across reopen and recovers a failed read in place', async () => {
    const harness = createHarness({ initialSpaceId: 'sp_stale' });
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 1);
    harness.click({ runCenterCreateClose: '' });
    harness.click({ runCenterCreateOpen: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 2);

    harness.spacesRequests[1].reject(new Error('private workspace failure'));
    await harness.waitFor(() => harness.html().includes('data-run-center-create-spaces-retry'));
    expect(harness.html()).toContain('run_center.create_space_unavailable');
    expect(harness.html()).not.toContain('private workspace failure');
    harness.click({ runCenterCreateSpacesRetry: '' });
    await harness.waitFor(() => harness.spacesRequests.length === 3);
    harness.spacesRequests[2].resolve(spaceListing({ space_id: 'sp_current', name: 'Current' }));
    await harness.waitFor(() => harness.html().includes('value="sp_current"'));
    harness.spacesRequests[0].resolve(spaceListing({ space_id: 'sp_stale', name: 'Stale' }));
    await harness.flush();

    expect(harness.html()).toContain('value="sp_current"');
    expect(harness.html()).not.toContain('value="sp_stale"');
    harness.input('[data-run-center-create-task]', 'Use the recovered workspace list');
    harness.change('[data-run-center-create-space]', 'sp_current');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));
    expect(harness.calls.find((call) => call.channel === 'cogseed.task.start')?.payload)
      .toMatchObject({ task: 'Use the recovered workspace list', spaceId: 'sp_current' });
  });

  it('retries task Worktrees without losing task, Agent, focus, or current-workspace submission', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    expect(harness.worktreeRequests).toHaveLength(0);
    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(0);
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);
    harness.agentRequests[0].resolve(agentListing());
    await harness.waitFor(() => harness.worktreeRequests.length === 1);
    const taskBeforeFailure = harness.input('[data-run-center-create-task]', 'Keep this task text intact');
    harness.change('[data-run-center-create-agent]', 'review-agent');
    taskBeforeFailure.selectionStart = 5;
    taskBeforeFailure.selectionEnd = 14;
    taskBeforeFailure.selectionDirection = 'backward';
    taskBeforeFailure.focus();
    harness.worktreeRequests[0].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('data-run-center-create-worktrees-retry'));

    const taskAfterFailure = harness.panel.querySelector('[data-run-center-create-task]');
    expect(taskAfterFailure).not.toBe(taskBeforeFailure);
    expect(taskAfterFailure.value).toBe('Keep this task text intact');
    expect(harness.panel.querySelector('[data-run-center-create-agent]').value).toBe('review-agent');
    expect(harness.documentState.activeElement).toBe(taskAfterFailure);
    expect([taskAfterFailure.selectionStart, taskAfterFailure.selectionEnd, taskAfterFailure.selectionDirection])
      .toEqual([5, 14, 'backward']);
    expect(harness.panel.querySelector('[data-run-center-create-worktree]').value).toBe('');
    expect(harness.panel.querySelector('[data-run-center-create-worktree]').disabled).toBe(false);

    taskAfterFailure.focus();
    harness.click({ runCenterCreateWorktreesRetry: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === 2);
    harness.worktreeRequests[1].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('data-run-center-create-worktrees-retry'));
    const taskBeforeSuccess = harness.panel.querySelector('[data-run-center-create-task]');
    taskBeforeSuccess.focus();
    harness.click({ runCenterCreateWorktreesRetry: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === 3);
    harness.worktreeRequests[2].resolve(projection('task-recovered'));
    await harness.waitFor(() => harness.html().includes('task-recovered-branch'));

    expect(harness.html()).not.toContain('run_center.create_worktree_unavailable');
    const taskAfterSuccess = harness.panel.querySelector('[data-run-center-create-task]');
    expect(taskAfterSuccess.value).toBe('Keep this task text intact');
    expect(harness.panel.querySelector('[data-run-center-create-agent]').value).toBe('review-agent');
    expect(harness.documentState.activeElement).toBe(taskAfterSuccess);
    expect([taskAfterSuccess.selectionStart, taskAfterSuccess.selectionEnd, taskAfterSuccess.selectionDirection])
      .toEqual([5, 14, 'backward']);
    harness.change('[data-run-center-create-worktree]', '');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));
    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ task: 'Keep this task text intact', agentId: 'review-agent' });
    expect(start?.payload).not.toHaveProperty('worktreeName');
  });

  it('keeps basic task creation available when advanced reads fail', async () => {
    const harness = createHarness();
    await harness.flush();

    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(0);
    expect(harness.worktreeRequests).toHaveLength(0);
    harness.click({ runCenterCreateOpen: '' });
    harness.input('[data-run-center-create-task]', 'Create this with the defaults');
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);

    harness.agentRequests[0].reject(new Error('private agent catalog failure'));
    harness.worktreeRequests[0].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('run_center.create_worktree_unavailable'));
    expect(harness.panel.querySelector('[data-run-center-create-submit]')?.disabled).toBe(false);

    harness.toggleAdvanced(false);
    expect(harness.panel.querySelector('[data-run-center-create-advanced]')?.open).toBe(false);
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));

    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ task: 'Create this with the defaults' });
    expect(start?.payload).not.toHaveProperty('agentId');
    expect(start?.payload).not.toHaveProperty('worktreeName');
  });

  it('retries the Agent catalog after a transient advanced-options failure', async () => {
    const harness = createHarness({ registryFailure: true });
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    harness.input('[data-run-center-create-task]', 'Retry the local Agent catalog');
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);

    harness.agentRequests[0].reject(new Error('temporary Agent catalog failure'));
    harness.worktreeRequests[0].resolve(projection('agent-catalog-retry'));
    await harness.waitFor(() => harness.html().includes('data-run-center-create-agents-retry'));
    expect(harness.html()).toContain('temporary Agent catalog failure');

    harness.click({ runCenterCreateAgentsRetry: '' });
    await harness.waitFor(() => harness.agentRequests.length === 2);
    harness.agentRequests[1].resolve(agentListing());
    await harness.waitFor(() => harness.html().includes('value="review-agent"'));

    expect(harness.html()).not.toContain('data-run-center-create-agents-retry');
    expect(harness.panel.querySelector('[data-run-center-create-task]').value)
      .toBe('Retry the local Agent catalog');
  });

  it('uses the lightweight Agent listing when the registry projection is unavailable', async () => {
    const harness = createHarness({ registryFailure: true });
    await harness.flush();

    harness.click({ runCenterCreateOpen: '' });
    harness.input('[data-run-center-create-task]', 'Use the fallback Agent listing');
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);

    harness.agentRequests[0].resolve(agentListing());
    harness.worktreeRequests[0].resolve(projection('fallback'));
    await harness.waitFor(() => harness.html().includes('value="review-agent"'));

    const agent = harness.panel.querySelector('[data-run-center-create-agent]');
    expect(agent?.disabled).toBe(false);
    harness.change('[data-run-center-create-agent]', 'review-agent');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));
    expect(harness.calls.find((call) => call.channel === 'cogseed.task.start')?.payload)
      .toMatchObject({ task: 'Use the fallback Agent listing', agentId: 'review-agent' });
  });

  it('excludes bare runtime peers and clears localized Agent failures before a valid retry', async () => {
    const harness = createHarness({
      includeRuntimePeer: true,
      startFailure: new Error('CogSeed Agent is unavailable'),
    });
    await harness.flush();

    harness.click({ runCenterCreateOpen: '' });
    harness.input('[data-run-center-create-task]', 'Create a daily report');
    harness.toggleAdvanced();
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);

    expect(harness.html()).toContain('value="review-agent"');
    expect(harness.html()).not.toContain('value="codex-peer"');
    harness.agentRequests[0].resolve(agentListing());
    harness.worktreeRequests[0].resolve(projection('agent-retry'));
    await harness.waitFor(() => harness.html().includes('value="codex-agent"'));
    expect(harness.html()).toContain('Codex · run_center.agent_option_local_external');
    expect(harness.html()).not.toContain('value="codex-peer"');

    harness.change('[data-run-center-create-agent]', 'review-agent');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.html().includes('run_center.selected_agent_unavailable'));
    expect(harness.html()).not.toContain('CogSeed Agent is unavailable');

    harness.change('[data-run-center-create-agent]', '');
    expect(harness.html()).not.toContain('run_center.selected_agent_unavailable');

    harness.change('[data-run-center-create-agent]', 'codex-peer');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.flush();
    expect(harness.calls.filter((call) => call.channel === 'cogseed.task.start')).toHaveLength(1);
    expect(harness.html()).toContain('run_center.selected_agent_unavailable');

    harness.change('[data-run-center-create-agent]', 'review-agent');
    expect(harness.html()).not.toContain('run_center.selected_agent_unavailable');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.filter((call) => call.channel === 'cogseed.task.start').length === 2);
    expect(harness.calls.filter((call) => call.channel === 'cogseed.task.start').at(-1)?.payload)
      .toMatchObject({ task: 'Create a daily report', agentId: 'review-agent' });
  });
});
