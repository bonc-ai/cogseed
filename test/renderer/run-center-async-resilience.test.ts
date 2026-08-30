// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
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

function diagnostics(taskCount: number) {
  return {
    taskCount, sessionCount: taskCount, activeTaskCount: 0, attentionTaskCount: 0,
    sourceCounts: {}, statusCounts: {}, runtime: { activeTaskCount: 0, stateMatchesProjection: true }, errorCodes: [],
  };
}

function createHarness(options: { registryFailure?: boolean } = {}) {
  const panelListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const diagnosticsRequests: Deferred<any>[] = [];
  const agentRequests: Deferred<any>[] = [];
  const worktreeRequests: Deferred<any>[] = [];
  const calls: Array<{ channel: string; payload: any }> = [];
  const documentState: any = { hidden: false, activeElement: null };
  let html = '';
  let controls: any[] = [];
  let renderCount = 0;

  const rebuildControls = (markup: string) => {
    const nextControls: any[] = [];
    const tagPattern = /<(button|input|textarea|select)\b([^>]*)>/g;
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
        disabled: attributeMap.has('disabled'), selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
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
    if (channel === 'cogseed.task.list') return Promise.resolve({ tasks: [], groups: [], counts: {} });
    if (channel === 'cogseed.session.list') return Promise.resolve({ sessions: [] });
    if (channel === 'cogseed.agent.list' && options.registryFailure) return Promise.reject(new Error('registry unavailable'));
    if (channel === 'cogseed.agent.list') return Promise.resolve({
      agents: [{ agentId: 'review-agent', displayName: 'Reviewer', dispatchable: true }], runtimes: [], channels: [],
    });
    if (channel === 'agents.list') {
      const request = deferred<any>();
      agentRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.task.start') return Promise.resolve({});
    return Promise.reject(new Error(`unexpected channel: ${channel}`));
  });
  const context: any = {
    window: {
      cogseed: {
        invoke,
        stream: () => ({ cancel: vi.fn(), promise: new Promise(() => {}) }),
      },
      addEventListener: vi.fn(), setTimeout, clearTimeout, confirm: vi.fn(() => true),
      uiIconHtml: (name: string) => `<i>${name}</i>`,
      CogSeedRunCenterBoard: {
        filteredLogicalTasks: () => [], taskForSession: () => null, logicalRunKey: () => '', render: () => '',
      },
      CogSeedRunCenterOverview: { render: () => '' },
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

  return {
    calls, diagnosticsRequests, agentRequests, worktreeRequests, documentState, panel, click, input, change, flush, waitFor,
    html: () => html, renderCount: () => renderCount,
  };
}

describe('Run Center asynchronous tool resilience', () => {
  it('keeps the latest Diagnostics request across reopen, stale rejection, and close', async () => {
    const harness = createHarness();
    await harness.flush();

    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 1);
    harness.click({ runCenterDiagnosticsClose: '' });
    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 2);

    harness.diagnosticsRequests[1].resolve(diagnostics(22));
    await harness.waitFor(() => harness.html().includes('>22<'));
    harness.diagnosticsRequests[0].resolve(diagnostics(11));
    await harness.flush();
    expect(harness.html()).toContain('>22<');
    expect(harness.html()).not.toContain('>11<');
    expect(harness.html()).not.toContain('run_center.diagnostics_load_failed');

    harness.click({ runCenterDiagnosticsClose: '' });
    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 3);
    harness.click({ runCenterDiagnosticsClose: '' });
    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 4);
    harness.diagnosticsRequests[2].resolve(diagnostics(33));
    await harness.flush();
    expect(harness.html()).toContain('run_center.diagnostics_loading');
    expect(harness.html()).not.toContain('>33<');
    harness.click({ runCenterDiagnosticsClose: '' });
    harness.diagnosticsRequests[3].reject(new Error('late diagnostics failure'));
    await harness.flush();
    expect(harness.html()).not.toContain('data-run-center-diagnostics-dialog');
    expect(harness.html()).not.toContain('late diagnostics failure');

    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 5);
    harness.click({ runCenterDiagnosticsClose: '' });
    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 6);
    harness.diagnosticsRequests[5].resolve(diagnostics(44));
    await harness.waitFor(() => harness.html().includes('>44<'));
    harness.diagnosticsRequests[4].reject(new Error('stale diagnostics rejection'));
    await harness.flush();
    expect(harness.html()).toContain('>44<');
    expect(harness.html()).not.toContain('run_center.diagnostics_load_failed');
  });

  it('retries Diagnostics in place and clears the prior localized error on success', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterDiagnosticsOpen: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 1);

    harness.diagnosticsRequests[0].reject(new Error('private diagnostics detail'));
    await harness.waitFor(() => harness.html().includes('data-run-center-diagnostics-retry'));
    expect(harness.html()).toContain('run_center.diagnostics_load_failed');
    expect(harness.html()).not.toContain('private diagnostics detail');

    harness.click({ runCenterDiagnosticsRetry: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 2);
    harness.diagnosticsRequests[1].reject(new Error('second private detail'));
    await harness.waitFor(() => harness.html().includes('data-run-center-diagnostics-retry'));
    harness.click({ runCenterDiagnosticsRetry: '' });
    await harness.waitFor(() => harness.diagnosticsRequests.length === 3);
    harness.diagnosticsRequests[2].resolve(diagnostics(33));
    await harness.waitFor(() => harness.html().includes('>33<'));

    expect(harness.html()).not.toContain('run_center.diagnostics_load_failed');
    expect(harness.html()).not.toContain('data-run-center-diagnostics-retry');
  });

  it('gives Worktree manager and task creation one latest-wins shared projection', async () => {
    const harness = createHarness();
    await harness.flush();

    const initialAgentCalls = harness.calls.filter((call) => call.channel === 'agents.list').length;
    const initialAgentRequests = harness.agentRequests.length;
    const initialWorktreeRequests = harness.worktreeRequests.length;
    harness.click({ runCenterCreateOpen: '' });
    await harness.flush();
    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(initialAgentCalls);
    expect(harness.worktreeRequests).toHaveLength(initialWorktreeRequests);
    expect(harness.html()).not.toContain('id="run-center-create-advanced-panel"');

    harness.click({ runCenterCreateAdvanced: '' });
    await harness.waitFor(() => harness.agentRequests.length === initialAgentRequests + 1
      && harness.worktreeRequests.length === initialWorktreeRequests + 1);
    const createAgentRequest = harness.agentRequests[initialAgentRequests];
    const staleCreateWorktreeRequest = harness.worktreeRequests[initialWorktreeRequests];
    createAgentRequest.resolve(agentListing());
    await harness.flush();
    harness.click({ runCenterCreateClose: '' });
    harness.click({ runCenterWorktreesOpen: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === initialWorktreeRequests + 2);

    staleCreateWorktreeRequest.resolve(projection('stale-create'));
    await harness.flush();
    expect(harness.html()).toContain('run_center.worktrees_loading');
    expect(harness.html()).not.toContain('stale-create-branch');

    harness.worktreeRequests[initialWorktreeRequests + 1].resolve(projection('manager-new'));
    await harness.waitFor(() => harness.html().includes('manager-new-branch'));
    expect(harness.html()).not.toContain('stale-create-branch');

    harness.click({ runCenterWorktreesClose: '' });
    harness.click({ runCenterCreateOpen: '' });
    const agentCallsBeforeSecondOpen = harness.calls.filter((call) => call.channel === 'agents.list').length;
    const worktreesBeforeSecondOpen = harness.worktreeRequests.length;
    await harness.flush();
    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(agentCallsBeforeSecondOpen);
    expect(harness.worktreeRequests).toHaveLength(worktreesBeforeSecondOpen);
    harness.click({ runCenterCreateAdvanced: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === worktreesBeforeSecondOpen + 1);
    harness.click({ runCenterCreateClose: '' });
    harness.click({ runCenterWorktreesOpen: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === worktreesBeforeSecondOpen + 2);
    harness.worktreeRequests[worktreesBeforeSecondOpen + 1].resolve(projection('manager-fast'));
    await harness.waitFor(() => harness.html().includes('manager-fast-branch'));
    harness.worktreeRequests[worktreesBeforeSecondOpen].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.flush();
    expect(harness.html()).toContain('manager-fast-branch');
    expect(harness.html()).not.toContain('run_center.worktree_error_repository_unavailable');

    harness.click({ runCenterWorktreesClose: '' });
    harness.click({ runCenterWorktreesOpen: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === worktreesBeforeSecondOpen + 3);
    harness.click({ runCenterWorktreesClose: '' });
    harness.worktreeRequests[worktreesBeforeSecondOpen + 2].resolve(projection('closed-late'));
    await harness.flush();
    expect(harness.html()).not.toContain('data-run-center-worktrees-dialog');
    expect(harness.html()).not.toContain('closed-late-branch');
  });

  it('retries Worktree manager reads without losing branch/base focus or selection', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    expect(harness.worktreeRequests).toHaveLength(0);
    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(0);
    harness.click({ runCenterCreateAdvanced: '' });
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);
    harness.agentRequests[0].resolve(agentListing());
    await harness.waitFor(() => harness.worktreeRequests.length === 1);
    harness.worktreeRequests[0].resolve(projection('cached'));
    await harness.waitFor(() => harness.html().includes('cached-branch'));
    harness.click({ runCenterCreateClose: '' });
    harness.click({ runCenterWorktreesOpen: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === 2);
    harness.worktreeRequests[1].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('data-run-center-worktrees-retry'));

    const branchBeforeRetry = harness.input('[data-run-center-worktree-branch]', 'feature/resilient-panel');
    harness.input('[data-run-center-worktree-base]', 'origin/develop');
    branchBeforeRetry.selectionStart = 8;
    branchBeforeRetry.selectionEnd = 17;
    branchBeforeRetry.selectionDirection = 'forward';
    branchBeforeRetry.focus();
    const rendersBeforeRetry = harness.renderCount();
    harness.click({ runCenterWorktreesRetry: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === 3);

    const branchWhileLoading = harness.panel.querySelector('[data-run-center-worktree-branch]');
    expect(harness.renderCount()).toBeGreaterThan(rendersBeforeRetry);
    expect(branchWhileLoading).not.toBe(branchBeforeRetry);
    expect(branchWhileLoading.value).toBe('feature/resilient-panel');
    expect(harness.panel.querySelector('[data-run-center-worktree-base]').value).toBe('origin/develop');
    expect(harness.documentState.activeElement).toBe(branchWhileLoading);
    expect([branchWhileLoading.selectionStart, branchWhileLoading.selectionEnd, branchWhileLoading.selectionDirection])
      .toEqual([8, 17, 'forward']);

    harness.worktreeRequests[2].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('data-run-center-worktrees-retry'));
    const branchBeforeSecondRetry = harness.panel.querySelector('[data-run-center-worktree-branch]');
    branchBeforeSecondRetry.focus();
    harness.click({ runCenterWorktreesRetry: '' });
    await harness.waitFor(() => harness.worktreeRequests.length === 4);
    harness.worktreeRequests[3].resolve(projection('recovered'));
    await harness.waitFor(() => harness.html().includes('recovered-branch'));

    expect(harness.html()).not.toContain('run_center.worktree_error_repository_unavailable');
    const branchAfterSuccess = harness.panel.querySelector('[data-run-center-worktree-branch]');
    expect(branchAfterSuccess.value).toBe('feature/resilient-panel');
    expect(harness.panel.querySelector('[data-run-center-worktree-base]').value).toBe('origin/develop');
    expect(harness.documentState.activeElement).toBe(branchAfterSuccess);
    expect([branchAfterSuccess.selectionStart, branchAfterSuccess.selectionEnd, branchAfterSuccess.selectionDirection])
      .toEqual([8, 17, 'forward']);
  });

  it('retries task Worktrees without losing task, Agent, focus, or current-workspace submission', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.click({ runCenterCreateOpen: '' });
    expect(harness.worktreeRequests).toHaveLength(0);
    expect(harness.calls.filter((call) => call.channel === 'agents.list')).toHaveLength(0);
    harness.click({ runCenterCreateAdvanced: '' });
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
    harness.click({ runCenterCreateAdvanced: '' });
    await harness.waitFor(() => harness.agentRequests.length === 1 && harness.worktreeRequests.length === 1);

    harness.agentRequests[0].reject(new Error('private agent catalog failure'));
    harness.worktreeRequests[0].reject(new Error('E_WORKTREE_REPOSITORY_UNAVAILABLE'));
    await harness.waitFor(() => harness.html().includes('run_center.create_worktree_unavailable'));
    expect(harness.panel.querySelector('[data-run-center-create-submit]')?.disabled).toBe(false);

    harness.click({ runCenterCreateAdvanced: '' });
    expect(harness.html()).not.toContain('id="run-center-create-advanced-panel"');
    harness.click({ runCenterCreateSubmit: '' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.task.start'));

    const start = harness.calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({ task: 'Create this with the defaults' });
    expect(start?.payload).not.toHaveProperty('agentId');
    expect(start?.payload).not.toHaveProperty('worktreeName');
  });

  it('uses the lightweight Agent listing when the registry projection is unavailable', async () => {
    const harness = createHarness({ registryFailure: true });
    await harness.flush();

    harness.click({ runCenterCreateOpen: '' });
    harness.input('[data-run-center-create-task]', 'Use the fallback Agent listing');
    harness.click({ runCenterCreateAdvanced: '' });
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
});
