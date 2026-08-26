// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * Run Center renderer test harness (RC-T01 / spec §8).
 *
 * Why this exists
 * ---------------
 * Before this harness, `test/renderer/run-center.test.ts` proved the Run Center
 * "works" by reading its own source with `readFileSync` and asserting
 * `toContain("invoke('cogseed.session.read'")`. That catches a rename and
 * nothing else — no click, no IPC call, no DOM. Phase 1–3 of the hardening are
 * all behaviour changes, so the scaffolding has to come first.
 *
 * Four constraints shaped the design; each one is load-bearing.
 *
 * 0. jsdom is used as a *library*, not as a Vitest environment.
 *    `// @vitest-environment jsdom` is what spec §8 prescribes, and it was tried
 *    first. It is unusable here: `test/setup-env.ts` does `import 'tsx/cjs'`,
 *    which loads esbuild, and esbuild asserts
 *    `new TextEncoder().encode('') instanceof Uint8Array` at load time. Under a
 *    jsdom environment that encoder comes from jsdom's realm, so the invariant
 *    is false and the file dies before a single test is collected. Patching the
 *    globals in the shared setup would fix this one file by changing load-time
 *    conditions for all ~900 others. Constructing a JSDOM per harness instead
 *    leaves Node's globals untouched, gives real per-test isolation, and matches
 *    how `test/renderer/` already works (57 files hand-build a window through
 *    `vm.runInContext`; this is the same idea with a real DOM behind it).
 *
 * 1. `window.cogseed` is a frozen contextBridge object.
 *    In the real preload it is installed with `{writable:false,
 *    configurable:false}` on a frozen object, so a test that loads
 *    `run-center.js` and *then* assigns `window.cogseed = mock` fails silently.
 *    This harness installs the bridge with those exact descriptors, before any
 *    module source is evaluated — reproducing the production constraint rather
 *    than working around it.
 *
 * 2. jsdom does no layout.
 *    `getBoundingClientRect()` is permanently `{0,0,0,0}` here, so any assertion
 *    of the form "the completed column is visible" would pass unconditionally
 *    and mean nothing. Layout visibility belongs to the Electron/CDP smoke
 *    (RC-T05), never to this harness. What *is* testable here is structure:
 *    which column nodes exist, and which cards they contain.
 *
 * 3. No source-string assertions.
 *    Every test built on this harness must assert a runtime artefact — an IPC
 *    channel that was actually invoked, a DOM node that was actually rendered,
 *    or a spy that was actually called.
 *
 * Usage:
 *
 *   const harness = await createRunCenterHarness({ board, sessions, detail });
 *   await harness.render();
 *   expect(harness.channels()).toContain('cogseed.task.list');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.join(__dirname, '../..');

/**
 * Load order matters and is not arbitrary: it mirrors the `run-center` entry in
 * `src/renderer/modules/lazy-features.js`, where the board renderer is listed
 * before the controller. `run-center.js` reads `window.CogSeedRunCenterBoard`
 * at render time and degrades to a "loading" placeholder when it is missing, so
 * loading them out of order would quietly test the placeholder instead.
 */
const MODULE_SOURCES = [
  'src/renderer/modules/run-center-board.js',
  'src/renderer/modules/run-center.js',
] as const;

export interface RunCenterInvocation {
  channel: string;
  payload: Record<string, unknown>;
}

/** A canned reply, or a function computing one from the payload. */
export type RunCenterResponse =
  | unknown
  | ((payload: Record<string, unknown>, callIndex: number) => unknown);

export interface RunCenterFixtures {
  /** Reply for `cogseed.task.list` — a `CogSeedRendererBoardProjection`. */
  board?: RunCenterResponse;
  /** Reply for `cogseed.session.list` — `{ sessions: [...] }`. */
  sessions?: RunCenterResponse;
  /** Reply for `cogseed.session.read` — `{ session, collaboration }`. */
  detail?: RunCenterResponse;
  /** Reply for `cogseed.task.action` — a collaboration snapshot. */
  action?: RunCenterResponse;
  /** Any other channel, keyed by name. */
  responses?: Record<string, RunCenterResponse>;
  /** UI language for `t()` / `getLang()`. Defaults to `en`. */
  lang?: 'en' | 'zh';
  /** What `window.confirm` returns (the abort flow gates on it). Default true. */
  confirmResult?: boolean;
}

export interface RunCenterHarness {
  /** Every `cogseed.invoke(channel, payload)` in call order. */
  readonly invocations: RunCenterInvocation[];
  /** Channel names in call order — the usual assertion target. */
  channels(): string[];
  /** Invocations for one channel only. */
  callsTo(channel: string): RunCenterInvocation[];
  /** `window.setView(view, id)` calls — the "Open Task" button's exit. */
  readonly setViewCalls: Array<[string, string]>;
  /** Arguments passed to `window.confirm`. */
  readonly confirmCalls: string[];
  /** Swap one channel's reply mid-test to simulate a runtime state flip. */
  setResponse(channel: string, response: RunCenterResponse): void;
  /** Swap several at once. */
  setResponses(responses: Record<string, RunCenterResponse>): void;
  /** Make a channel reject, to exercise error paths. */
  setFailure(channel: string, error: Error | string): void;
  /** Run `window.renderRunCenter()` (bind + refresh) and settle. */
  render(): Promise<void>;
  /** Click the first node matching `selector` and settle. Throws if absent. */
  click(selector: string): Promise<void>;
  /** Type into a search/input node and settle. */
  type(selector: string, value: string): Promise<void>;
  /** Let queued promises and timers run. */
  flush(): Promise<void>;
  /** First matching element inside the panel. */
  $(selector: string): Element | null;
  /** All matching elements inside the panel. */
  $$(selector: string): Element[];
  /** The panel element itself. */
  readonly root: HTMLElement;
  /** This harness's isolated window — for descriptor/global assertions. */
  readonly window: Window & typeof globalThis & Record<string, unknown>;
  /** Panel innerHTML — for debugging, never as a primary assertion. */
  html(): string;
  /** How many `setInterval` registrations are currently live (RC-P0-02). */
  activeIntervals(): number;
  /** Fire every live interval callback once, then settle. */
  tick(): Promise<void>;
  /** Toggle `document.hidden` and dispatch `visibilitychange`. */
  setHidden(hidden: boolean): Promise<void>;
  /** Add/remove `active` on `#panel-run-center`, as the view router does. */
  setPanelActive(active: boolean): void;
  /** Tear the jsdom window down. */
  destroy(): void;
}

const DEFAULT_CHANNELS = {
  board: 'cogseed.task.list',
  sessions: 'cogseed.session.list',
  detail: 'cogseed.session.read',
  action: 'cogseed.task.action',
} as const;

function loadLocale(lang: 'en' | 'zh'): Record<string, string> {
  const file = path.join(ROOT, 'src/renderer/locales', `${lang}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
}

class HarnessImpl implements RunCenterHarness {
  readonly invocations: RunCenterInvocation[] = [];
  readonly setViewCalls: Array<[string, string]> = [];
  readonly confirmCalls: string[] = [];

  private readonly responses = new Map<string, RunCenterResponse>();
  private readonly failures = new Map<string, Error>();
  private readonly callCounts = new Map<string, number>();
  private readonly dom: JSDOM;
  /**
   * Interval registry. jsdom brings its own `window.setInterval`, which Vitest's
   * fake timers (which patch the Node global) never see. Swapping the window's
   * timer functions before the module is evaluated is the only seam that lets a
   * test drive the poll deterministically — and it also makes "exactly one
   * interval is live" directly observable.
   */
  readonly intervals = new Map<number, () => void>();
  private nextIntervalId = 1;
  /**
   * Pending `setTimeout` callbacks. RC-P1-03's convergence window waits on a 1s
   * cadence for up to 10 attempts; running that for real would add ten seconds
   * of wall time per test. `flush()` drains this queue instead, so the window
   * resolves as fast as the promises behind it can settle while still executing
   * every iteration the production code would.
   */
  private readonly timeouts = new Map<number, () => void>();
  private nextTimeoutId = 1;

  constructor(dom: JSDOM, fixtures: RunCenterFixtures) {
    this.dom = dom;
    for (const [key, channel] of Object.entries(DEFAULT_CHANNELS)) {
      const value = (fixtures as Record<string, RunCenterResponse>)[key];
      if (value !== undefined) this.responses.set(channel, value);
    }
    for (const [channel, value] of Object.entries(fixtures.responses || {})) {
      this.responses.set(channel, value);
    }
  }

  get window(): Window & typeof globalThis & Record<string, unknown> {
    return this.dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  }

  handleInvoke(channel: string, payload: Record<string, unknown>): Promise<unknown> {
    this.invocations.push({ channel, payload });
    const failure = this.failures.get(channel);
    if (failure) return Promise.reject(failure);
    const index = this.callCounts.get(channel) || 0;
    this.callCounts.set(channel, index + 1);
    if (!this.responses.has(channel)) {
      // Mirrors ipc-service's failure envelope so run-center's `ok === false`
      // branch is exercised rather than an undefined-shaped success.
      return Promise.resolve({ ok: false, error: `run-center harness: no fixture for ${channel}` });
    }
    const response = this.responses.get(channel);
    const value = typeof response === 'function'
      ? (response as (p: Record<string, unknown>, i: number) => unknown)(payload, index)
      : response;
    return Promise.resolve(value);
  }

  channels(): string[] {
    return this.invocations.map((call) => call.channel);
  }

  callsTo(channel: string): RunCenterInvocation[] {
    return this.invocations.filter((call) => call.channel === channel);
  }

  setResponse(channel: string, response: RunCenterResponse): void {
    this.failures.delete(channel);
    this.responses.set(channel, response);
  }

  setResponses(responses: Record<string, RunCenterResponse>): void {
    for (const [channel, response] of Object.entries(responses)) this.setResponse(channel, response);
  }

  setFailure(channel: string, error: Error | string): void {
    this.failures.set(channel, typeof error === 'string' ? new Error(error) : error);
  }

  get root(): HTMLElement {
    const node = this.dom.window.document.getElementById('run-center-root');
    if (!node) throw new Error('run-center harness: #run-center-root is missing');
    return node as HTMLElement;
  }

  async render(): Promise<void> {
    const boot = (this.dom.window as unknown as { renderRunCenter?: () => void }).renderRunCenter;
    if (typeof boot !== 'function') {
      throw new Error('run-center harness: window.renderRunCenter was not defined by run-center.js');
    }
    boot();
    await this.flush();
  }

  async click(selector: string): Promise<void> {
    const node = this.$(selector);
    if (!node) throw new Error(`run-center harness: no node matches ${selector}`);
    const MouseEvent = this.dom.window.MouseEvent;
    (node as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await this.flush();
  }

  async type(selector: string, value: string): Promise<void> {
    const node = this.$(selector) as HTMLInputElement | null;
    if (!node) throw new Error(`run-center harness: no node matches ${selector}`);
    node.value = value;
    node.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
    await this.flush();
  }

  /**
   * `refresh()` awaits `Promise.all([...])` and then `select()`, which awaits
   * again — so a single microtask drain is not enough. Alternating macrotask
   * and microtask turns settles the whole chain without racing a fixed delay.
   */
  async flush(): Promise<void> {
    // Bounded so a genuine infinite retry loop fails the test instead of
    // hanging it. 200 rounds comfortably covers RC-P1-03's 10 attempts.
    for (let round = 0; round < 200; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await Promise.resolve();
      }
      if (!this.drainTimeouts()) return;
    }
  }

  $(selector: string): Element | null {
    return this.root.querySelector(selector);
  }

  $$(selector: string): Element[] {
    return Array.from(this.root.querySelectorAll(selector));
  }

  html(): string {
    return this.root.innerHTML;
  }

  installTimerSeam(): void {
    const win = this.dom.window as unknown as Record<string, unknown>;
    win.setInterval = (fn: () => void) => {
      const id = this.nextIntervalId;
      this.nextIntervalId += 1;
      this.intervals.set(id, fn);
      return id;
    };
    win.clearInterval = (id: number) => { this.intervals.delete(id); };
    win.setTimeout = (fn: () => void) => {
      const id = this.nextTimeoutId;
      this.nextTimeoutId += 1;
      this.timeouts.set(id, fn);
      return id;
    };
    win.clearTimeout = (id: number) => { this.timeouts.delete(id); };
  }

  private drainTimeouts(): boolean {
    if (!this.timeouts.size) return false;
    const due = [...this.timeouts.entries()];
    this.timeouts.clear();
    for (const [, fn] of due) fn();
    return true;
  }

  activeIntervals(): number {
    return this.intervals.size;
  }

  async tick(): Promise<void> {
    for (const fn of [...this.intervals.values()]) fn();
    await this.flush();
  }

  async setHidden(hidden: boolean): Promise<void> {
    Object.defineProperty(this.dom.window.document, 'hidden', { value: hidden, configurable: true });
    this.dom.window.document.dispatchEvent(new this.dom.window.Event('visibilitychange'));
    await this.flush();
  }

  setPanelActive(active: boolean): void {
    const panel = this.dom.window.document.getElementById('panel-run-center');
    if (!panel) throw new Error('run-center harness: #panel-run-center is missing');
    panel.classList.toggle('active', active);
  }

  destroy(): void {
    this.intervals.clear();
    this.timeouts.clear();
    this.dom.window.close();
  }
}

/**
 * Builds a fresh Run Center instance over a mock IPC bridge, in its own window.
 *
 * Order is deliberate and must not be rearranged: DOM fixture → frozen bridge →
 * renderer globals → module evaluation. `run-center.js` reads `window.cogseed`
 * lazily today, but the harness pins the production ordering so that a future
 * change which captures the bridge at load time is caught by tests instead of
 * shipping.
 */
export async function createRunCenterHarness(fixtures: RunCenterFixtures = {}): Promise<RunCenterHarness> {
  // 1. Fresh DOM. `runScripts: 'outside-only'` gives us `window.eval` — needed
  //    so the renderer IIFEs resolve their bare `document` / `t` references
  //    against this window's scope chain — without letting page-authored
  //    <script> tags execute.
  // Mirrors index.html: the router toggles `active` on the panel, and RC-P0-02's
  // poll gates on exactly that class.
  const dom = new JSDOM('<!doctype html><html><body><section class="panel active" id="panel-run-center"><div id="run-center-root"></div></section></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://cogseed.test/',
  });
  const win = dom.window as unknown as Record<string, unknown>;

  const harness = new HarnessImpl(dom, fixtures);

  // 2. Frozen contextBridge, before any module source runs.
  const bridge = Object.freeze({
    invoke(channel: string, payload?: Record<string, unknown>): Promise<unknown> {
      return harness.handleInvoke(String(channel), payload || {});
    },
  });
  Object.defineProperty(dom.window, 'cogseed', {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // 3. Renderer globals that run-center.js reads by bare name. Mirrors the real
  //    `t()` in src/renderer/modules/i18n.js: fall back to the key itself when
  //    absent, and interpolate `{name}` placeholders.
  const lang = fixtures.lang || 'en';
  const table = loadLocale(lang);
  win.t = (key: string, vars?: Record<string, unknown>) => {
    const raw = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
  };
  win.getLang = () => lang;
  win.setView = (view: string, id: string) => { harness.setViewCalls.push([String(view), String(id)]); };
  const confirmResult = fixtures.confirmResult !== false;
  win.confirm = (message?: string) => {
    harness.confirmCalls.push(String(message ?? ''));
    return confirmResult;
  };

  // 4. Timer seam, before the module captures `setInterval`.
  harness.installTimerSeam();

  // 5. Evaluate module sources in manifest order, inside the jsdom realm.
  for (const relativePath of MODULE_SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    dom.window.eval(`${source}\n//# sourceURL=${relativePath}`);
  }

  return harness;
}

/**
 * Minimal but shape-accurate fixtures, matching the exported renderer
 * projection interfaces in `src/main/features/cogseed_backend/ipc-service.ts`.
 * Tests override only the fields they are asserting on.
 */
export const runCenterFixtures = {
  boardTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: 'task-1',
      sessionId: 'session-1',
      requestId: 'req-groupchat-run-1',
      status: 'running',
      title: '群聊运行',
      titleKey: 'run_center.task_kind_group_chat',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      executionKind: 'group-chat',
      column: 'running',
      sessionTitle: '群聊会话',
      sessionTitleKey: 'run_center.task_kind_group_chat',
      actions: { retry: false, skip: false, resume: false, abort: true },
      ...overrides,
    };
  },

  board(tasks: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const counts: Record<string, number> = { pending: 0, running: 0, attention: 0, completed: 0, archived: 0 };
    for (const task of tasks) counts[String(task.column)] = (counts[String(task.column)] || 0) + 1;
    return {
      schemaVersion: 1,
      updatedAt: '2026-08-26T00:01:00.000Z',
      tasks,
      groups: [],
      counts,
      ...overrides,
    };
  },

  session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 'session-1',
      title: '群聊会话',
      titleKey: 'run_center.task_kind_group_chat',
      latestTaskId: 'task-1',
      conversationId: 'conv-8fd6',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      taskCount: 1,
      activeTaskCount: 1,
      latestStatus: 'running',
      hasRecovery: false,
      ...overrides,
    };
  },

  /** `cogseed.session.read` returns `{ session, collaboration }`. */
  detail(task: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const collaboration = {
      schemaVersion: 1,
      sessionId: String(task.sessionId || 'session-1'),
      updatedAt: String(task.updatedAt || '2026-08-26T00:01:00.000Z'),
      session: runCenterFixtures.session({ sessionId: task.sessionId, latestTaskId: task.taskId }),
      task,
      actors: [],
      tasks: [task],
      workflow: { childTaskIds: [], steps: [] },
      reviews: [],
      conflicts: [],
      activity: [],
      recovery: { recoverable: false, taskIds: [] },
      timeline: [],
      // The snapshot carries its own action set, and `detailsHtml()` prefers it
      // over the board task's. Mirroring the task keeps the two consistent
      // unless a test deliberately overrides one of them.
      actions: task.actions || { retry: false, skip: false, resume: false, abort: false },
      ...overrides,
    };
    return { session: collaboration.session, collaboration };
  },
};
