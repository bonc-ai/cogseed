// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

interface TaskFixture {
  taskId: string;
  sessionId: string;
  conversationId?: string;
  retryOfTaskId?: string;
  executionKind?: string;
  status?: string;
  updatedAt: string;
  createdAt?: string;
  resultDeliveryState?: string;
  actions?: Record<string, boolean>;
}

function boardTask(fixture: TaskFixture) {
  const status = fixture.status ?? 'failed';
  return {
    taskId: fixture.taskId,
    sessionId: fixture.sessionId,
    // A retry child inherits its source's session, so `logicalRunKey` separates
    // the two runs by execution id — mirror that here or every fixture would
    // collapse into one run.
    executionId: `exec-${fixture.taskId}`,
    requestId: `req-${fixture.taskId}`,
    status,
    title: fixture.taskId,
    titleKey: 'run_center.task_kind_cogseed',
    createdAt: fixture.createdAt ?? fixture.updatedAt,
    updatedAt: fixture.updatedAt,
    sourceKind: 'cogseed',
    conversationMode: 'standard',
    participantCount: 0,
    resumable: false,
    resultDeliveryState: fixture.resultDeliveryState ?? 'not-applicable',
    column: status === 'failed' ? 'attention' : 'completed',
    sessionTitle: fixture.sessionId,
    sessionTitleKey: 'run_center.task_kind_cogseed',
    ...(fixture.conversationId ? { conversationId: fixture.conversationId } : {}),
    ...(fixture.retryOfTaskId ? { retryOfTaskId: fixture.retryOfTaskId } : {}),
    ...(fixture.executionKind ? { executionKind: fixture.executionKind } : {}),
    actions: {
      retry: status === 'failed',
      skip: false,
      resume: false,
      recoverResult: false,
      abort: false,
      archive: false,
      ...(fixture.actions ?? {}),
    },
  };
}

function board(fixtures: TaskFixture[]) {
  return {
    schemaVersion: 1,
    tasks: fixtures.map(boardTask),
    groups: [],
    counts: { pending: 0, running: 0, attention: fixtures.length, completed: 0, archived: 0 },
  };
}

/**
 * Drives the real Run Center controller against the real board module, so run
 * aggregation and selection are exercised rather than stubbed.
 */
function createHarness(options: {
  boards: Array<ReturnType<typeof board>>;
  retryResponse?: Record<string, unknown>;
}) {
  const calls: Array<{ channel: string; payload: any }> = [];
  const documentState: any = { hidden: false, activeElement: null };
  let html = '';
  let controls: any[] = [];
  let boardIndex = 0;

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
      const dataset: Record<string, string> = {};
      for (const [key, value] of attributeMap) {
        if (key.startsWith('data-')) {
          dataset[key.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = value;
        }
      }
      const element: any = {
        tagName: match[1].toUpperCase(),
        dataset,
        disabled: attributeMap.has('disabled'),
        getClientRects: () => [{}],
        matches: (selector: string) => {
          const parsed = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
          if (!parsed) return false;
          return attributeMap.has(parsed[1]) && (parsed[2] === undefined || attributeMap.get(parsed[1]) === parsed[2]);
        },
        focus: () => { documentState.activeElement = element; },
      };
      element.closest = (selector: string) => {
        if (selector === element.tagName.toLowerCase()) return element;
        return element.matches(selector) ? element : null;
      };
      nextControls.push(element);
    }
    controls = nextControls;
  };

  const matchingControls = (selector: string) => selector.split(',').flatMap((part) => {
    const trimmed = part.trim();
    return controls.filter((control) => control.matches(trimmed));
  });

  let clickListener: ((event: any) => void) | null = null;
  const panel: any = {
    addEventListener: (type: string, listener: (event: any) => void) => {
      if (type === 'click') clickListener = listener;
    },
    querySelector: (selector: string) => matchingControls(selector)[0] || null,
    querySelectorAll: (selector: string) => matchingControls(selector),
    contains: (element: unknown) => controls.includes(element),
    closest: () => ({ classList: { contains: () => true } }),
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; rebuildControls(value); },
  };

  const invoke = vi.fn((channel: string, payload: any) => {
    calls.push({ channel, payload });
    if (channel === 'cogseed.task.list') {
      // Each refresh advances to the next projection, modelling what the
      // backend reports before and after the retry lands.
      const next = options.boards[Math.min(boardIndex, options.boards.length - 1)];
      boardIndex += 1;
      return Promise.resolve(next);
    }
    if (channel === 'cogseed.agent.list') return Promise.resolve({ agents: [], runtimes: [], channels: [], registryFreshness: 'fresh' });
    if (channel === 'cogseed.session.list') return Promise.resolve({ sessions: [] });
    if (channel === 'cogseed.session.read') return Promise.resolve({ task: null, collaboration: null });
    if (channel === 'cogseed.task.retry') return Promise.resolve(options.retryResponse ?? {});
    if (channel === 'cogseed.task.action') return Promise.resolve({});
    if (channel === 'cogseed.worktree.list') return Promise.resolve({ worktrees: [] });
    if (channel === 'cogseed.dashboard.diagnostics') return Promise.resolve({});
    if (channel === 'agents.list') return Promise.resolve({ agents: [] });
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
    document: Object.assign(documentState, {
      getElementById: () => panel,
      addEventListener: vi.fn(),
    }),
    t: (key: string) => key,
    getLang: () => 'en', Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number, JSON,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
  vm.runInContext(read('src/renderer/modules/run-center.js'), context);
  context.window.renderRunCenter();

  const flush = async () => {
    for (let index = 0; index < 40; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const click = (selector: string) => {
    const control = matchingControls(selector)[0];
    if (!control) throw new Error(`no control for ${selector}`);
    clickListener?.({ target: control, preventDefault: vi.fn() });
  };

  /** The Run Center opens on Overview; run actions live in the Runs view. */
  const openRunsView = async () => {
    click('[data-run-center-view="runs"]');
    await flush();
  };

  const selectedTaskIds = () => calls
    .filter((call) => call.channel === 'cogseed.session.read')
    .map((call) => call.payload?.taskId);

  return { calls, click, flush, invoke, selectedTaskIds, openRunsView, html: () => html };
}

const SOURCE = 'cogseed-task-source';
const CHILD = 'cogseed-task-child';
const DECOY = 'cogseed-task-decoy';

describe('Run Center retry lineage selection', () => {
  it('selects the replacement returned by the dedicated retry channel', async () => {
    const before = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    const after = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
      { taskId: CHILD, sessionId: 'cogseed-session-a', conversationId: 'conv-1', retryOfTaskId: SOURCE, status: 'running', updatedAt: '2026-09-01T10:00:05.000Z' },
    ]);
    const harness = createHarness({ boards: [before, after], retryResponse: { taskId: CHILD, sessionId: 'cogseed-session-a' } });
    await harness.flush();

    await harness.openRunsView();
    harness.click('[data-run-center-action="retry"]');
    await harness.flush();

    // The dedicated channel carries the replacement's identity; the generic
    // action channel returns only the source task's snapshot.
    expect(harness.calls.some((call) => call.channel === 'cogseed.task.retry')).toBe(true);
    expect(harness.calls.some((call) => call.channel === 'cogseed.task.action')).toBe(false);
    expect(harness.selectedTaskIds().at(-1)).toBe(CHILD);
  });

  /**
   * The regression this task exists for. Two runs land in the same conversation
   * moments apart and the unrelated one is newer. The removed heuristic took the
   * newest run key that shared a session or conversation, so it selected the
   * decoy — the user pressed retry and landed on someone else's run.
   */
  it('ignores a newer unrelated run in the same conversation', async () => {
    const before = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    const after = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
      { taskId: CHILD, sessionId: 'cogseed-session-a', conversationId: 'conv-1', retryOfTaskId: SOURCE, status: 'running', updatedAt: '2026-09-01T10:00:05.000Z' },
      // Same conversation, same session, and updated *after* the replacement.
      { taskId: DECOY, sessionId: 'cogseed-session-a', conversationId: 'conv-1', status: 'running', updatedAt: '2026-09-01T10:00:09.000Z' },
    ]);
    const harness = createHarness({ boards: [before, after], retryResponse: { taskId: CHILD, sessionId: 'cogseed-session-a' } });
    await harness.flush();
    await harness.openRunsView();

    harness.click('[data-run-center-action="retry"]');
    await harness.flush();

    const selected = harness.selectedTaskIds().at(-1);
    expect(selected).toBe(CHILD);
    expect(selected).not.toBe(DECOY);
  });

  it('falls back to the retryOfTaskId link when the response carries no id', async () => {
    const before = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    const after = board([
      { taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1', updatedAt: '2026-09-01T10:00:00.000Z' },
      { taskId: CHILD, sessionId: 'cogseed-session-a', conversationId: 'conv-1', retryOfTaskId: SOURCE, status: 'running', updatedAt: '2026-09-01T10:00:05.000Z' },
      { taskId: DECOY, sessionId: 'cogseed-session-a', conversationId: 'conv-1', status: 'running', updatedAt: '2026-09-01T10:00:09.000Z' },
    ]);
    // An older backend, or a response the renderer could not read, still leaves
    // the authoritative link in the projection.
    const harness = createHarness({ boards: [before, after], retryResponse: {} });
    await harness.flush();
    await harness.openRunsView();

    harness.click('[data-run-center-action="retry"]');
    await harness.flush();

    expect(harness.selectedTaskIds().at(-1)).toBe(CHILD);
  });

  it('keeps the source run selected for a Group Chat retry', async () => {
    const groupSource = { taskId: SOURCE, sessionId: 'cogseed-session-gconv-conv-1', conversationId: 'conv-1', executionKind: 'group-chat', updatedAt: '2026-09-01T10:00:00.000Z' };
    const before = board([groupSource]);
    const after = board([
      groupSource,
      // A newer run in the same conversation, with no lineage link. The old
      // heuristic would have jumped to it; there is no evidence it is related.
      { taskId: DECOY, sessionId: 'cogseed-session-gconv-conv-1', conversationId: 'conv-1', status: 'running', updatedAt: '2026-09-01T10:00:09.000Z' },
    ]);
    const harness = createHarness({ boards: [before, after] });
    await harness.flush();
    await harness.openRunsView();

    harness.click('[data-run-center-action="retry"]');
    await harness.flush();

    // Group Chat retry has no synchronous child identity, so it must stay on
    // the generic channel and must not guess a destination.
    expect(harness.calls.some((call) => call.channel === 'cogseed.task.action')).toBe(true);
    expect(harness.calls.some((call) => call.channel === 'cogseed.task.retry')).toBe(false);
    expect(harness.selectedTaskIds().at(-1)).not.toBe(DECOY);
  });

  it('does not follow an existing replacement when the action is not a retry', async () => {
    // This source was retried at some point in the past, so a task pointing at
    // it already exists. Recovering the source's retained result must not be
    // read as "go to the replacement" — the lineage lookup belongs to retry
    // alone.
    const tasks: TaskFixture[] = [
      {
        taskId: SOURCE, sessionId: 'cogseed-session-a', conversationId: 'conv-1',
        updatedAt: '2026-09-01T10:00:00.000Z', resultDeliveryState: 'pending-recovery',
        actions: { recoverResult: true },
      },
      {
        taskId: CHILD, sessionId: 'cogseed-session-b', conversationId: 'conv-1',
        retryOfTaskId: SOURCE, status: 'completed', updatedAt: '2026-09-01T10:00:05.000Z',
      },
    ];
    const harness = createHarness({ boards: [board(tasks), board(tasks)] });
    await harness.flush();
    await harness.openRunsView();

    harness.click('[data-run-center-action="recover-result"]');
    await harness.flush();

    expect(harness.calls.some((call) => call.channel === 'cogseed.task.retry')).toBe(false);
    expect(harness.selectedTaskIds().at(-1)).not.toBe(CHILD);
  });
});
