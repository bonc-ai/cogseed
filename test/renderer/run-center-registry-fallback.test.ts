// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * When the Agent registry cannot be read, the Run Center falls back to the
 * plain `agents.list` channel. That channel carries no install, reachability,
 * runtime or peer facts, so the renderer used to synthesise
 * `dispatchable: enabled !== false` — a weaker rule than either the registry
 * projection or the execution admission gate, which is how an offline or
 * uninstalled Agent looked selectable.
 *
 * PD-2 settled the behaviour: show the candidates, mark them unknown, promise
 * nothing, and let Main's admission gate give the real answer.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const AGENT_ID = 'review-agent';
const TASK_ID = 'cogseed-task-fallback';

function boardProjection() {
  return {
    schemaVersion: 1,
    tasks: [{
      taskId: TASK_ID,
      sessionId: 'cogseed-session-fallback',
      requestId: 'req-fallback',
      executionId: 'exec-fallback',
      status: 'completed',
      title: 'Fallback task',
      titleKey: 'run_center.task_kind_cogseed',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      sourceKind: 'cogseed',
      conversationMode: 'standard',
      participantCount: 0,
      resumable: false,
      resultDeliveryState: 'not-applicable',
      column: 'completed',
      conversationId: 'conv-fallback',
      agentId: 'other-agent',
      sessionTitle: 'Fallback task',
      sessionTitleKey: 'run_center.task_kind_cogseed',
      actions: { retry: false, skip: false, resume: false, recoverResult: false, abort: false, archive: false },
    }],
    groups: [],
    counts: { pending: 0, running: 0, attention: 0, completed: 1, archived: 0 },
  };
}

function createHarness(options: {
  /** Omit to model a registry that could not be read at all. */
  registry?: { registryFreshness?: string; agents: Array<Record<string, unknown>> };
  startRejection?: { message: string; code?: string };
} = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const calls: Array<{ channel: string; payload: any }> = [];
  const documentState: any = { hidden: false, activeElement: null };
  let html = '';
  let controls: any[] = [];

  const rebuildControls = (markup: string) => {
    const nextControls: any[] = [];
    const tagPattern = /<(button|input|textarea|select)\b([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(markup))) {
      const attributeMap = new Map<string, string>();
      const attributePattern = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
      let attribute: RegExpExecArray | null;
      while ((attribute = attributePattern.exec(match[2]))) {
        attributeMap.set(attribute[1], (attribute[2] ?? '')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
      }
      const element: any = {
        tagName: match[1].toUpperCase(),
        value: attributeMap.get('value') ?? '',
        dataset: {}, disabled: attributeMap.has('disabled'),
        selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
        getClientRects: () => [{}],
        matches: (selector: string) => {
          const parsed = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
          if (!parsed) return false;
          return attributeMap.has(parsed[1]) && (parsed[2] === undefined || attributeMap.get(parsed[1]) === parsed[2]);
        },
        focus: () => { documentState.activeElement = element; },
        setSelectionRange: () => {},
      };
      for (const [key, value] of attributeMap) {
        if (key.startsWith('data-')) {
          element.dataset[key.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = value;
        }
      }
      nextControls.push(element);
    }
    controls = nextControls;
  };

  const matching = (selector: string) => selector.split(',')
    .flatMap((part) => controls.filter((control) => control.matches(part.trim())));

  const panel: any = {
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    querySelector: (selector: string) => matching(selector)[0] || null,
    querySelectorAll: (selector: string) => matching(selector),
    contains: (element: unknown) => controls.includes(element),
    closest: () => ({ classList: { contains: () => true } }),
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; rebuildControls(value); },
  };

  const invoke = vi.fn((channel: string, payload: any) => {
    calls.push({ channel, payload });
    if (channel === 'cogseed.task.list') return Promise.resolve(boardProjection());
    if (channel === 'cogseed.session.list') return Promise.resolve({ sessions: [] });
    if (channel === 'cogseed.session.read') return Promise.resolve({ task: null, collaboration: null });
    if (channel === 'cogseed.agent.list') {
      return options.registry
        ? Promise.resolve({ runtimes: [], channels: [], ...options.registry })
        : Promise.reject(new Error('registry unavailable'));
    }
    // The degraded channel: an enable flag and a name, nothing else.
    if (channel === 'agents.list') {
      return Promise.resolve({ agents: [{ agent_id: AGENT_ID, name: 'Reviewer', enabled: true }] });
    }
    if (channel === 'cogseed.worktree.list') return Promise.resolve({ worktrees: [] });
    if (channel === 'cogseed.task.start' || channel === 'cogseed.task.reassign') {
      if (options.startRejection) {
        const { message, code } = options.startRejection;
        return Promise.reject(Object.assign(new Error(message), code ? { code } : {}));
      }
      return Promise.resolve({ taskId: TASK_ID, sessionId: 'cogseed-session-fallback' });
    }
    if (channel === 'cogseed.dashboard.diagnostics') return Promise.resolve({});
    return Promise.reject(new Error(`unexpected channel: ${channel}`));
  });

  const context: any = {
    window: {
      cogseed: { invoke, stream: () => ({ cancel: vi.fn(), promise: new Promise(() => {}) }) },
      addEventListener: vi.fn(), setTimeout, clearTimeout, confirm: vi.fn(() => true),
      uiIconHtml: (name: string) => `<i>${name}</i>`,
      CogSeedRunCenterOverview: { render: () => '' },
      CogSeedRunCenterAgents: { render: () => '' },
    },
    document: Object.assign(documentState, { getElementById: () => panel, addEventListener: vi.fn() }),
    t: (key: string) => key,
    getLang: () => 'en', Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number, JSON,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
  vm.runInContext(read('src/renderer/modules/run-center.js'), context);
  context.window.renderRunCenter();

  const flush = async () => {
    for (let index = 0; index < 30; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const click = (dataset: Record<string, string>) => listeners.get('click')?.({
    target: { closest: (selector: string) => (selector === 'button' ? { dataset } : null) },
  });
  const setValue = (selector: string, value: string, event: 'input' | 'change') => {
    const target = panel.querySelector(selector);
    if (!target) throw new Error(`missing control: ${selector}`);
    target.value = value;
    listeners.get(event)?.({ target, isComposing: false });
  };

  const openCreate = async () => {
    await flush();
    click({ runCenterCreateOpen: '' });
    await flush();
    setValue('[data-run-center-create-task]', 'Draft the weekly summary', 'input');
    click({ runCenterCreateAdvanced: '' });
    await flush();
  };
  const openReassign = async () => {
    await flush();
    click({ runCenterReassign: '' });
    await flush();
  };
  const submit = async (agentId: string) => {
    setValue('[data-run-center-create-agent]', agentId, 'change');
    click({ runCenterCreateSubmit: '' });
    await flush();
  };

  return { calls, click, setValue, flush, openCreate, openReassign, submit, html: () => html };
}

const startedAgentIds = (harness: ReturnType<typeof createHarness>) => harness.calls
  .filter((call) => call.channel === 'cogseed.task.start' || call.channel === 'cogseed.task.reassign')
  .map((call) => call.payload?.agentId);

describe('Run Center Agent registry fallback', () => {
  it('honours Main eligibility when the registry is fresh', async () => {
    const harness = createHarness({
      registry: {
        registryFreshness: 'fresh',
        agents: [
          { agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: true },
          { agentId: 'offline-agent', displayName: 'Offline', definitionSource: 'custom', dispatchable: false, eligibilityReason: 'offline', health: 'offline' },
        ],
      },
    });
    await harness.openCreate();

    expect(harness.html()).toContain(`value="${AGENT_ID}"`);
    // Main said it cannot take a run, so it is not offered.
    expect(harness.html()).not.toContain('value="offline-agent"');
    // Nothing is unknown here, so no staleness note.
    expect(harness.html()).not.toContain('run_center.create_agent_status_unknown');
    expect(harness.html()).not.toContain('run_center.agent_health_unknown');
  });

  it('marks fallback candidates unknown instead of calling them dispatchable', async () => {
    const harness = createHarness();
    await harness.openCreate();

    // Still listed — PD-2 chose "show but do not promise".
    expect(harness.html()).toContain(`value="${AGENT_ID}"`);
    // ...and visibly qualified, on the option and as a note.
    expect(harness.html()).toContain('run_center.agent_health_unknown');
    expect(harness.html()).toContain('run_center.create_agent_status_unknown');
  });

  it('does not upgrade an Agent that the fresh registry called offline', async () => {
    // Same Agent, both worlds. `agents.list` says enabled; the registry said
    // offline. The fallback must not read the enable flag as availability.
    const fresh = createHarness({
      registry: {
        registryFreshness: 'fresh',
        agents: [{ agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: false, eligibilityReason: 'offline' }],
      },
    });
    await fresh.openCreate();
    expect(fresh.html()).not.toContain(`value="${AGENT_ID}"`);

    const fallback = createHarness();
    await fallback.openCreate();
    expect(fallback.html()).toContain(`value="${AGENT_ID}"`);
    // Listed, but never presented as available.
    expect(fallback.html()).toContain('run_center.agent_health_unknown');
  });

  it('lets an unknown candidate reach Main, which then refuses it', async () => {
    // The end-to-end shape of PD-2: the renderer stops guessing, the admission
    // gate from task 2.1 answers, and task 3.5's structured reason is shown.
    const harness = createHarness({
      startRejection: { message: 'CogSeed Agent is unavailable', code: 'E_AGENT_ADMISSION_NOT_INSTALLED' },
    });
    await harness.openCreate();
    await harness.submit(AGENT_ID);

    expect(startedAgentIds(harness)).toEqual([AGENT_ID]);
    expect(harness.html()).toContain('run_center.selected_agent_unavailable');
  });

  it('still blocks locally when the registry is fresh and says no', async () => {
    const harness = createHarness({
      registry: {
        registryFreshness: 'fresh',
        agents: [
          { agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: true },
          { agentId: 'offline-agent', displayName: 'Offline', definitionSource: 'custom', dispatchable: false, eligibilityReason: 'offline' },
        ],
      },
    });
    await harness.openCreate();
    await harness.submit('offline-agent');

    // Main's answer is in hand, so the pointless round trip is avoided.
    expect(startedAgentIds(harness)).toEqual([]);
    expect(harness.html()).toContain('run_center.selected_agent_unavailable');
  });

  it('applies the same rules to reassign', async () => {
    const harness = createHarness({
      startRejection: { message: 'CogSeed Agent is unavailable', code: 'E_AGENT_ADMISSION_OFFLINE' },
    });
    await harness.openReassign();

    expect(harness.html()).toContain(`value="${AGENT_ID}"`);
    expect(harness.html()).toContain('run_center.agent_health_unknown');
    expect(harness.html()).toContain('run_center.create_agent_status_unknown');

    await harness.submit(AGENT_ID);
    expect(harness.calls.some((call) => call.channel === 'cogseed.task.reassign')).toBe(true);
    expect(harness.html()).toContain('run_center.selected_agent_unavailable');
  });

  it('treats a projection with no freshness field as fresh, not as a licence to guess', async () => {
    // An older projection that predates `registryFreshness`: the agents array
    // is Main's own answer, so it is still authoritative.
    const harness = createHarness({
      registry: { agents: [{ agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: true }] },
    });
    await harness.openCreate();

    expect(harness.html()).toContain(`value="${AGENT_ID}"`);
    expect(harness.html()).not.toContain('run_center.create_agent_status_unknown');
  });

  it('treats an unrecognised freshness value as unknown', async () => {
    const harness = createHarness({
      registry: {
        registryFreshness: 'stale',
        agents: [{ agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: false, eligibilityReason: 'offline' }],
      },
    });
    await harness.openCreate();

    // Not fresh, so nothing here is authoritative: the Agent is shown, marked
    // unknown, and no local gate is applied.
    expect(harness.html()).toContain(`value="${AGENT_ID}"`);
    expect(harness.html()).toContain('run_center.create_agent_status_unknown');
    await harness.submit(AGENT_ID);
    expect(startedAgentIds(harness)).toEqual([AGENT_ID]);
  });
});
