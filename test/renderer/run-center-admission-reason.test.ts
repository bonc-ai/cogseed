// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Agent admission rejections must reach the user through the machine reason
 * Main attaches, never through the English sentence it happens to throw. The
 * renderer used to match `message.includes('CogSeed Agent is unavailable')`,
 * which made a human-readable string into a wire protocol.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const AGENT_ID = 'review-agent';
const TASK_ID = 'cogseed-task-admission';

function boardProjection() {
  return {
    schemaVersion: 1,
    tasks: [{
      taskId: TASK_ID,
      sessionId: 'cogseed-session-admission',
      requestId: 'req-admission',
      executionId: 'exec-admission',
      status: 'completed',
      title: 'Admission task',
      titleKey: 'run_center.task_kind_cogseed',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      sourceKind: 'cogseed',
      conversationMode: 'standard',
      participantCount: 0,
      resumable: false,
      resultDeliveryState: 'not-applicable',
      column: 'completed',
      conversationId: 'conv-admission',
      sessionTitle: 'Admission task',
      sessionTitleKey: 'run_center.task_kind_cogseed',
      actions: { retry: false, skip: false, resume: false, recoverResult: false, abort: false, archive: false },
    }],
    groups: [],
    counts: { pending: 0, running: 0, attention: 0, completed: 1, archived: 0 },
  };
}

/**
 * `rejection` is what the create/reassign channel throws. `viaEnvelope` sends it
 * the way the real IPC layer does — `{ ok: false, error, code }` through the Run
 * Center's own invoke wrapper — instead of rejecting with a ready-made Error.
 */
function createHarness(options: {
  rejection?: { message: string; code?: string };
  viaEnvelope?: boolean;
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

  const rejectAdmission = () => {
    const { message, code } = options.rejection!;
    if (!options.viaEnvelope) {
      return Promise.reject(Object.assign(new Error(message), code ? { code } : {}));
    }
    // The shape `handleInvoke` actually returns; the Run Center's invoke wrapper
    // turns it into a rejection and copies `code` onto it.
    return Promise.resolve({ ok: false, error: message, ...(code ? { code } : {}) });
  };

  const invoke = vi.fn((channel: string, payload: any) => {
    calls.push({ channel, payload });
    if (channel === 'cogseed.task.list') return Promise.resolve(boardProjection());
    if (channel === 'cogseed.session.list') return Promise.resolve({ sessions: [] });
    if (channel === 'cogseed.session.read') return Promise.resolve({ task: null, collaboration: null });
    if (channel === 'cogseed.agent.list') {
      return Promise.resolve({
        registryFreshness: 'fresh', runtimes: [], channels: [],
        agents: [{ agentId: AGENT_ID, displayName: 'Reviewer', definitionSource: 'custom', dispatchable: true }],
      });
    }
    if (channel === 'agents.list') return Promise.resolve({ agents: [{ agent_id: AGENT_ID, name: 'Reviewer', enabled: true }] });
    if (channel === 'cogseed.worktree.list') return Promise.resolve({ worktrees: [] });
    if (channel === 'cogseed.task.start' || channel === 'cogseed.task.reassign') {
      if (options.rejection) return rejectAdmission();
      return Promise.resolve({ taskId: TASK_ID, sessionId: 'cogseed-session-admission' });
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

  return { calls, click, setValue, flush, html: () => html };
}

async function submitCreate(harness: ReturnType<typeof createHarness>) {
  await harness.flush();
  harness.click({ runCenterCreateOpen: '' });
  await harness.flush();
  harness.setValue('[data-run-center-create-task]', 'Draft the weekly summary', 'input');
  harness.click({ runCenterCreateAdvanced: '' });
  await harness.flush();
  harness.setValue('[data-run-center-create-agent]', AGENT_ID, 'change');
  harness.click({ runCenterCreateSubmit: '' });
  await harness.flush();
}

async function submitReassign(harness: ReturnType<typeof createHarness>) {
  await harness.flush();
  harness.click({ runCenterReassign: '' });
  await harness.flush();
  harness.setValue('[data-run-center-create-agent]', AGENT_ID, 'change');
  harness.click({ runCenterCreateSubmit: '' });
  await harness.flush();
}

const ALL_REASONS: Array<[string, string]> = [
  ['E_AGENT_ADMISSION_MANAGEMENT_ONLY', 'run_center.selected_agent_unavailable'],
  ['E_AGENT_ADMISSION_NOT_INSTALLED', 'run_center.selected_agent_unavailable'],
  ['E_AGENT_ADMISSION_OFFLINE', 'run_center.selected_agent_unavailable'],
  ['E_AGENT_ADMISSION_DISABLED', 'run_center.selected_agent_unavailable'],
  ['E_AGENT_ADMISSION_PEER_DISABLED', 'run_center.selected_agent_unavailable'],
  ['E_AGENT_ADMISSION_UNSUPPORTED_RUNTIME', 'run_center.selected_agent_runtime_unavailable'],
  ['E_AGENT_ADMISSION', 'run_center.selected_agent_unavailable'],
];

describe('Run Center Agent admission reason', () => {
  it.each(ALL_REASONS)('maps %s to its localized message on create', async (code, key) => {
    const harness = createHarness({ rejection: { message: 'CogSeed Agent is unavailable', code } });
    await submitCreate(harness);

    expect(harness.html()).toContain(key);
  });

  it.each(ALL_REASONS)('maps %s to its localized message on reassign', async (code, key) => {
    const harness = createHarness({ rejection: { message: 'CogSeed Agent is unavailable', code } });
    await submitReassign(harness);

    expect(harness.calls.some((call) => call.channel === 'cogseed.task.reassign')).toBe(true);
    expect(harness.html()).toContain(key);
  });

  it('uses the reason even when the message says nothing about it', async () => {
    const harness = createHarness({
      rejection: { message: 'Ein völlig unabhängiger Text.', code: 'E_AGENT_ADMISSION_OFFLINE' },
    });
    await submitCreate(harness);

    expect(harness.html()).toContain('run_center.selected_agent_unavailable');
    expect(harness.html()).not.toContain('Ein völlig unabhängiger Text.');
  });

  /**
   * The decisive test. The message is the exact sentence the old matcher keyed
   * on for "runtime is not executable", while the reason says the CLI is simply
   * not installed. Reading the prose gives the wrong answer.
   */
  it('follows the reason when the message contradicts it', async () => {
    const harness = createHarness({
      rejection: {
        message: 'CogSeed Agent runtime is not executable',
        code: 'E_AGENT_ADMISSION_NOT_INSTALLED',
      },
    });
    await submitCreate(harness);

    expect(harness.html()).toContain('run_center.selected_agent_unavailable');
    expect(harness.html()).not.toContain('run_center.selected_agent_runtime_unavailable');
  });

  it('carries the reason through the real invoke envelope', async () => {
    // `{ ok: false, error, code }` is what the main process returns; the Run
    // Center's invoke wrapper is what turns it back into a coded rejection.
    const harness = createHarness({
      viaEnvelope: true,
      rejection: { message: 'CogSeed Agent runtime is not executable', code: 'E_AGENT_ADMISSION_UNSUPPORTED_RUNTIME' },
    });
    await submitCreate(harness);

    expect(harness.html()).toContain('run_center.selected_agent_runtime_unavailable');
  });

  it('falls back to the raw message when there is no admission reason', async () => {
    const harness = createHarness({ rejection: { message: 'CogSeed conversation is unavailable' } });
    await submitCreate(harness);

    // Not an admission rejection: the backend text is the most specific thing
    // available, and it is shown rather than being force-fitted to a reason.
    expect(harness.html()).toContain('CogSeed conversation is unavailable');
    expect(harness.html()).not.toContain('run_center.selected_agent_unavailable');
  });

  it('does not classify an unrelated failure by its wording', async () => {
    // Prose that would have matched the deleted string protocol, with no code.
    const harness = createHarness({
      rejection: { message: 'upstream said: CogSeed Agent is unavailable right now' },
    });
    await submitCreate(harness);

    expect(harness.html()).not.toContain('run_center.selected_agent_unavailable');
  });
});
