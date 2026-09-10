// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

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

class FakeClassList {
  values = new Set<string>();

  add(value: string) { this.values.add(value); }
  contains(value: string) { return this.values.has(value); }
}

class FakeElement {
  id: string;
  innerHTML = '';
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  classList = new FakeClassList();
  listeners = new Map<string, (event: any) => void>();
  focus = vi.fn();
  scrollIntoView = vi.fn();

  constructor(id: string) { this.id = id; }

  appendChild(child: FakeElement) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, listener);
  }
}

function registryProjection(activeTaskCount = 0) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-09-04T01:00:00.000Z',
    agents: [{
      agentId: 'codex-agent', displayName: 'Codex', sourceKind: 'local-cli',
      runtimeKind: 'cli:codex', installed: true, online: true, enabled: true,
      dispatchable: true, health: activeTaskCount ? 'busy' : 'ready',
      stats: { active: activeTaskCount, completed: 2, failed: 0 },
    }],
    runtimes: [{
      runtimeId: 'local-cli:codex', displayName: 'Codex', sourceKind: 'local-cli',
      runtimeKind: 'codex', installed: true, online: true, enabled: true,
      dispatchable: true, health: 'ready', gatewayRunning: false, gatewayControllable: true,
    }],
    channels: [{
      channelId: 'feishu-safe', displayName: 'Feishu', platform: 'feishu',
      enabled: true, online: true, health: 'ready',
    }],
  };
}

function worktreeProjection() {
  return {
    schemaVersion: 1,
    repository: { path: '/private/repository', branch: 'develop' },
    worktrees: [
      {
        path: '/private/cogseed-worktree-clean', name: 'cogseed-worktree-clean',
        branch: 'feature/clean', head: 'abc123', dirty: false, verifiable: true,
      },
      {
        path: '/private/cogseed-worktree-dirty', name: 'cogseed-worktree-dirty',
        branch: 'feature/dirty', head: 'def456', dirty: true, verifiable: true,
      },
      {
        path: '/private/cogseed-worktree-unverified', name: 'cogseed-worktree-unverified',
        branch: 'feature/unverified', head: 'ghi789', dirty: null, verifiable: false,
      },
    ],
  };
}

function diagnosticProjection(taskCount: number) {
  return {
    taskCount,
    sessionCount: taskCount + 1,
    activeTaskCount: 1,
    attentionTaskCount: 0,
    sourceCounts: { agent: taskCount },
    statusCounts: { running: 1 },
    runtime: { activeTaskCount: 1, stateMatchesProjection: true },
    errorCodes: [],
  };
}

function attrsHtml(attrs: Record<string, unknown> = {}) {
  return Object.entries(attrs).map(([name, value]) => {
    if (value === false || value == null) return '';
    if (value === true) return ` ${name}`;
    return ` ${name}="${String(value)}"`;
  }).join('');
}

function createHarness() {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id)!;
  };
  for (const id of [
    'settings-execution-collaboration', 'run-center-settings-agents-host',
    'run-center-settings-channels-host', 'run-center-settings-gateways',
    'run-center-settings-worktrees', 'run-center-settings-diagnostics',
    'settings-execution-agents', 'settings-execution-gateways',
    'settings-execution-worktrees', 'settings-execution-diagnostics',
    'settings-model-authorizations', 'legacy-agents-host', 'legacy-touchpoints-host',
  ]) element(id);
  const agentsPanel = element('panel-agents');
  const touchpoints = element('touchpoints-shell');
  element('legacy-agents-host').appendChild(agentsPanel);
  element('legacy-touchpoints-host').appendChild(touchpoints);

  const registryRequests: Deferred<any>[] = [];
  const worktreeRequests: Deferred<any>[] = [];
  const diagnosticsRequests: Deferred<any>[] = [];
  const calls: Array<{ channel: string; payload: any }> = [];
  let gatewayFailure: Error | string | null = null;
  let worktreeRemoveFailure: Error | null = null;
  const confirm = vi.fn(() => true);
  const downloaded: any[] = [];
  const loadAgents = vi.fn(async () => undefined);
  const refreshSelectedAgentDetail = vi.fn(async () => undefined);

  const invoke = vi.fn((channel: string, payload: any) => {
    calls.push({ channel, payload });
    if (channel === 'cogseed.agent.list') {
      const request = deferred<any>();
      registryRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.worktree.list') {
      const request = deferred<any>();
      worktreeRequests.push(request);
      return request.promise;
    }
    if (channel === 'cogseed.dashboard.diagnostics') {
      const request = deferred<any>();
      diagnosticsRequests.push(request);
      return request.promise;
    }
    if (channel === 'p3394.external.start' || channel === 'p3394.external.stop') {
      if (gatewayFailure) {
        const error = gatewayFailure;
        gatewayFailure = null;
        if (typeof error === 'string') return Promise.resolve({ ok: false, error });
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: true });
    }
    if (channel === 'cogseed.worktree.remove') {
      if (worktreeRemoveFailure) {
        const error = worktreeRemoveFailure;
        worktreeRemoveFailure = null;
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: true });
    }
    if (channel === 'cogseed.worktree.create') return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected channel: ${channel}`));
  });

  const windowListeners = new Map<string, (event: any) => void>();
  const createdAnchor = { href: '', download: '', click: vi.fn() };
  const context: any = {
    window: {
      cogseed: { invoke },
      confirm,
      addEventListener: (type: string, listener: (event: any) => void) => windowListeners.set(type, listener),
      setTimeout,
      matchMedia: () => ({ matches: true }),
      uiIconHtml: (name: string) => `<i>${name}</i>`,
      uiButton: (options: any) => `<button${options.disabled ? ' disabled' : ''}${attrsHtml(options.attrs)}>${options.label}</button>`,
      uiEmptyState: (options: any) => `<div class="ui-empty">${options.title || ''}${options.hint || ''}${options.action ? `<button${attrsHtml(options.action.attrs)}>${options.action.label}</button>` : ''}</div>`,
      uiField: (options: any) => `<label for="${options.id}">${options.label}<input id="${options.id}" value="${options.control?.value || ''}"${options.control?.disabled ? ' disabled' : ''}${attrsHtml(options.control?.attrs)}></label>`,
      uiForm: (options: any) => `<form>${(options.fields || []).join('')}${(options.actions || []).map((action: any) => `<button${action.disabled ? ' disabled' : ''}${attrsHtml(action.attrs)}>${action.label}</button>`).join('')}</form>`,
    },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelector: (selector: string) => selector === '.touchpoint-settings-shell' ? touchpoints : null,
      createElement: (tag: string) => tag === 'a' ? createdAnchor : new FakeElement(tag),
    },
    createLogger: () => ({ warn: vi.fn() }),
    loadAgents,
    refreshSelectedAgentDetail,
    t: (key: string) => key === 'run_center.worktree_error_process_active'
      ? 'A process is using this Worktree.' : key,
    URL: {
      createObjectURL: (blob: unknown) => { downloaded.push(blob); return 'blob:safe'; },
      revokeObjectURL: vi.fn(),
    },
    Blob,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Map,
    Set,
    Error,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-settings.js'), context, { filename: 'run-center-settings.js' });

  const flush = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100; index += 1) {
      if (predicate()) return;
      await flush();
    }
    throw new Error('settings action did not settle');
  };
  const click = (dataset: Record<string, string>) => {
    element('settings-execution-collaboration').listeners.get('click')?.({
      target: { closest: () => ({ dataset }) },
    });
  };
  const resolveInitialLoad = async (anchor = 'agents') => {
    const loadPromise = context.window.CogSeedRunCenterSettings.load({ anchor });
    await waitFor(() => registryRequests.length === 1 && worktreeRequests.length === 1 && diagnosticsRequests.length === 1);
    registryRequests[0].resolve(registryProjection());
    worktreeRequests[0].resolve(worktreeProjection());
    diagnosticsRequests[0].resolve(diagnosticProjection(4));
    await loadPromise;
    await flush();
  };

  return {
    api: context.window.CogSeedRunCenterSettings,
    elements,
    agentsPanel,
    touchpoints,
    registryRequests,
    worktreeRequests,
    diagnosticsRequests,
    calls,
    invoke,
    confirm,
    createdAnchor,
    downloaded,
    loadAgents,
    refreshSelectedAgentDetail,
    click,
    flush,
    waitFor,
    resolveInitialLoad,
    setGatewayFailure(error: Error | string) { gatewayFailure = error; },
    setWorktreeRemoveFailure(error: Error) { worktreeRemoveFailure = error; },
  };
}

describe('Run Center settings boundary', () => {
  it('keeps the configuration pane model-first (no embedded execution regions)', () => {
    const html = read('src/renderer/index.html');
    const lazyFeatures = read('src/renderer/modules/lazy-features.js');
    const settings = read('src/renderer/modules/settings_tabs.js');

    expect(html).toContain('data-settings-tab="configuration"');
    expect(html).toContain('data-settings-pane="configuration"');
    // 配置页从「模型配置」开始（2026-09-09 子安指令）：设置页不再内嵌
    // 执行与协作区——Agents 面板归连接页（#216 语义），管理面留在
    // run-center。run-center-settings 模块保留（host 缺失时 no-op），
    // run-center 菜单的 worktrees/diagnostics 锚点跳转静默降级。
    for (const id of [
      'settings-execution-agents', 'settings-execution-gateways',
      'settings-execution-worktrees', 'settings-execution-diagnostics',
      'settings-execution-collaboration',
    ]) expect(html).not.toContain(`id="${id}"`);
    expect(html).toContain('id="settings-model-authorizations"');
    expect(html.match(/id="panel-agents"/g)).toHaveLength(1);
    expect(html.match(/class="touchpoint-settings-shell/g)).toHaveLength(1);
    expect(settings).toContain("name === 'credentials' ? 'configuration' : name");
    expect(lazyFeatures).toContain("{ src: './modules/run-center-settings.js' }");
    expect(html).not.toContain('<script src="./modules/run-center-settings.js"></script>');
  });

  it('moves the existing Agent and channel DOM once, loads every region, and restores the anchor', async () => {
    const harness = createHarness();

    await harness.resolveInitialLoad('worktrees');

    expect(harness.agentsPanel.parentElement?.id).toBe('run-center-settings-agents-host');
    expect(harness.touchpoints.parentElement?.id).toBe('run-center-settings-channels-host');
    expect(harness.loadAgents).toHaveBeenCalledOnce();
    expect(harness.refreshSelectedAgentDetail).toHaveBeenCalledOnce();
    expect(harness.elements.get('run-center-settings-gateways')!.innerHTML).toContain('Codex');
    expect(harness.elements.get('run-center-settings-worktrees')!.innerHTML).toContain('feature/clean');
    expect(harness.elements.get('run-center-settings-diagnostics')!.innerHTML).toContain('>4<');
    expect(harness.elements.get('settings-execution-worktrees')!.scrollIntoView).toHaveBeenCalledWith({
      block: 'start', behavior: 'auto',
    });
    expect(harness.elements.get('settings-execution-worktrees')!.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('locks an active gateway and keeps a later gateway failure local to that row', async () => {
    const harness = createHarness();
    const loadPromise = harness.api.load({ anchor: 'gateways' });
    await harness.waitFor(() => harness.registryRequests.length === 1
      && harness.worktreeRequests.length === 1 && harness.diagnosticsRequests.length === 1);
    harness.registryRequests[0].resolve(registryProjection(1));
    harness.worktreeRequests[0].resolve(worktreeProjection());
    harness.diagnosticsRequests[0].resolve(diagnosticProjection(7));
    await loadPromise;

    expect(harness.elements.get('run-center-settings-gateways')!.innerHTML)
      .toContain('An active task is using this gateway.');
    const gatewayCallsBeforeLockedClick = harness.calls.filter((call) => call.channel === 'p3394.external.start').length;
    harness.click({ runCenterSettingsGateway: 'codex', runCenterSettingsGatewayAction: 'start' });
    await harness.flush();
    expect(harness.calls.filter((call) => call.channel === 'p3394.external.start')).toHaveLength(gatewayCallsBeforeLockedClick);

    const refresh = harness.api.refreshRegistry();
    await harness.waitFor(() => harness.registryRequests.length === 2);
    harness.registryRequests[1].resolve(registryProjection(0));
    await refresh;
    harness.setGatewayFailure('private gateway detail');
    harness.click({ runCenterSettingsGateway: 'codex', runCenterSettingsGatewayAction: 'start' });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'p3394.external.start'));
    await harness.waitFor(() => !!harness.api.__state.gatewayErrors.codex);

    const gatewayHtml = harness.elements.get('run-center-settings-gateways')!.innerHTML;
    expect(gatewayHtml).toContain('Could not change this gateway.');
    expect(gatewayHtml).not.toContain('private gateway detail');
    expect(harness.elements.get('run-center-settings-worktrees')!.innerHTML).toContain('feature/clean');
    expect(harness.elements.get('run-center-settings-diagnostics')!.innerHTML).toContain('>7<');
  });

  it('keeps diagnostics latest-wins, invalidates late results on deactivate, and redacts exports recursively', async () => {
    const harness = createHarness();
    await harness.resolveInitialLoad('diagnostics');

    const first = harness.api.refreshDiagnostics();
    const second = harness.api.refreshDiagnostics();
    await harness.waitFor(() => harness.diagnosticsRequests.length === 3);
    harness.diagnosticsRequests[2].resolve(diagnosticProjection(22));
    await second;
    harness.diagnosticsRequests[1].resolve(diagnosticProjection(11));
    await first;
    expect(harness.api.__state.diagnostics.taskCount).toBe(22);

    const late = harness.api.refreshDiagnostics();
    await harness.waitFor(() => harness.diagnosticsRequests.length === 4);
    harness.api.deactivate();
    harness.diagnosticsRequests[3].resolve(diagnosticProjection(33));
    await late;
    expect(harness.api.__state.diagnostics.taskCount).toBe(22);

    const clean = harness.api.sanitizeDiagnostics({
      taskCount: 2,
      prompt: 'private prompt',
      nested: {
        safeCount: 3,
        output: 'private output',
        note: '/Users/private/repository',
        label: 'healthy',
      },
      url: 'https://private.invalid',
    });
    expect(clean).toEqual({
      taskCount: 2,
      nested: { safeCount: 3, note: '[redacted]', label: 'healthy' },
    });
  });

  it('allows removal only for a clean verifiable managed Worktree and surfaces backend occupancy safely', async () => {
    const harness = createHarness();
    await harness.resolveInitialLoad('worktrees');
    const [clean, dirty, unverified] = worktreeProjection().worktrees;

    expect(harness.api.canRemoveWorktree(clean)).toBe(true);
    expect(harness.api.canRemoveWorktree(dirty)).toBe(false);
    expect(harness.api.canRemoveWorktree(unverified)).toBe(false);
    expect(harness.api.canRemoveWorktree({ ...clean, name: 'user-checkout' })).toBe(false);

    harness.click({
      runCenterSettingsWorktreeRemove: dirty.path,
      runCenterSettingsWorktreeBranch: dirty.branch,
    });
    await harness.flush();
    expect(harness.calls.some((call) => call.channel === 'cogseed.worktree.remove')).toBe(false);

    harness.confirm.mockReturnValueOnce(false);
    harness.click({
      runCenterSettingsWorktreeRemove: clean.path,
      runCenterSettingsWorktreeBranch: clean.branch,
    });
    await harness.flush();
    expect(harness.calls.some((call) => call.channel === 'cogseed.worktree.remove')).toBe(false);

    harness.setWorktreeRemoveFailure(Object.assign(new Error('private process details'), {
      code: 'E_WORKTREE_PROCESS_ACTIVE',
    }));
    harness.click({
      runCenterSettingsWorktreeRemove: clean.path,
      runCenterSettingsWorktreeBranch: clean.branch,
    });
    await harness.waitFor(() => harness.calls.some((call) => call.channel === 'cogseed.worktree.remove'));
    await harness.waitFor(() => !!harness.api.__state.worktreeRowErrors[clean.path]);

    expect(harness.calls.find((call) => call.channel === 'cogseed.worktree.remove')?.payload).toEqual({
      path: clean.path, expectedBranch: clean.branch,
    });
    expect(harness.elements.get('run-center-settings-worktrees')!.innerHTML)
      .toContain('A process is using this Worktree.');
    expect(harness.elements.get('run-center-settings-worktrees')!.innerHTML)
      .not.toContain('private process details');
  });
});
