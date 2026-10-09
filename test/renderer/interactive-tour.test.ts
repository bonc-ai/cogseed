import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Extract the tour start/complete logic from interactive-tour.js and run it in
// a sandbox with a mocked window.cogseed, so we can verify the real branching:
//  1. once-per-account gate — a completed account skips the tour entirely;
//  2. persistence — finishing OR skipping calls prefs.setTourCompleted.
const tourSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/interactive-tour.js'),
  'utf8',
);

const startIdx = tourSource.indexOf('async function startTour()');
const startEnd = tourSource.indexOf('function _startTourReanchor', startIdx);
if (startIdx < 0 || startEnd < 0) throw new Error('could not locate startTour source range');
const startSource = tourSource.slice(startIdx, startEnd);

const completeIdx = tourSource.indexOf('function _completeTour(opts)');
const completeEnd = tourSource.indexOf('function _showTourFinishCard', completeIdx);
if (completeIdx < 0 || completeEnd < 0) throw new Error('could not locate _completeTour source range');
const completeSource = tourSource.slice(completeIdx, completeEnd);

interface InvokeLog {
  channel: string;
  payload: unknown;
}

interface SandboxState {
  sandbox: any;
  invokeLog: InvokeLog[];
  appended: number;
  shownSteps: number;
  teardownCalls: number;
  finishCardCalls: number;
}

function buildSandbox(routes: Record<string, unknown | ((payload: unknown) => unknown)>): SandboxState {
  const invokeLog: InvokeLog[] = [];
  const state: SandboxState = {
    sandbox: null as any,
    invokeLog,
    appended: 0,
    shownSteps: 0,
    teardownCalls: 0,
    finishCardCalls: 0,
  };
  const el = () => ({
    className: '',
    style: {},
    classList: { add() {}, remove() {} },
    innerHTML: '',
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
  });
  const sandbox: any = {
    Array,
    Math,
    String,
    Boolean,
    Promise,
    console,
    clearTimeout,
    setTimeout,
    _tourLog: { info() {}, warn() {}, error() {} },
    // Fresh tour state per sandbox: not started, no tooltip yet.
    _tourState: null,
    _tourBackdrop: null,
    _tourTooltip: null,
    _tourObserver: null,
    _tourRepositionTimer: null,
    _tourFinishTimer: null,
    _setupTourListeners() {},
    _startTourReanchor() {},
    _showTourStep() { state.shownSteps += 1; },
    _teardownTour() { state.teardownCalls += 1; },
    _showTourFinishCard() { state.finishCardCalls += 1; },
    document: {
      createElement: () => el(),
      body: { appendChild: () => { state.appended += 1; } },
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
    },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      setView: undefined,
      cogseed: {
        invoke: async (channel: string, payload: unknown) => {
          invokeLog.push({ channel, payload });
          const route = routes[channel];
          if (typeof route === 'function') return route(payload);
          if (route === undefined) throw new Error(`no mock for channel ${channel}`);
          return route;
        },
      },
    },
  };
  vm.runInNewContext(`${startSource}\n${completeSource}`, sandbox, { filename: 'interactive-tour.js' });
  state.sandbox = sandbox;
  return state;
}

describe('interactive tour once-per-account gate', () => {
  it('skips the tour entirely when this account already completed it', async () => {
    const st = buildSandbox({
      'prefs.getTourCompleted': { completed: true },
    });
    await st.sandbox.startTour();
    expect(st.invokeLog.map(e => e.channel)).toEqual(['prefs.getTourCompleted']);
    expect(st.appended).toBe(0);
    expect(st.shownSteps).toBe(0);
  });

  it('starts the tour when the account has not completed it yet', async () => {
    const st = buildSandbox({
      'prefs.getTourCompleted': { completed: false },
    });
    await st.sandbox.startTour();
    expect(st.invokeLog.map(e => e.channel)).toEqual(['prefs.getTourCompleted']);
    expect(st.appended).toBe(2); // backdrop + tooltip
    expect(st.shownSteps).toBe(1);
  });

  it('still starts the tour when the gate read fails (fail-open, never blocks the walkthrough)', async () => {
    const st = buildSandbox({});
    await st.sandbox.startTour();
    expect(st.appended).toBe(2);
    expect(st.shownSteps).toBe(1);
  });
});

describe('interactive tour completion persistence', () => {
  it('persists completion when the tour is finished', async () => {
    const st = buildSandbox({
      'prefs.setTourCompleted': { completed: true },
    });
    // Finished path: tooltip exists, not skipped.
    st.sandbox._tourTooltip = {};
    st.sandbox._completeTour({});
    // Fire-and-forget: give the promise a microtask tick.
    await Promise.resolve();
    expect(st.invokeLog.some(e => e.channel === 'prefs.setTourCompleted')).toBe(true);
    expect(st.finishCardCalls).toBe(1);
  });

  it('persists completion when the tour is skipped', async () => {
    const st = buildSandbox({
      'prefs.setTourCompleted': { completed: true },
    });
    st.sandbox._completeTour({ skipped: true });
    await Promise.resolve();
    expect(st.invokeLog.some(e => e.channel === 'prefs.setTourCompleted')).toBe(true);
    expect(st.teardownCalls).toBe(1);
  });

  it('does not throw when persistence fails — logs and keeps teardown running', async () => {
    const st = buildSandbox({});
    st.sandbox._completeTour({ skipped: true });
    await Promise.resolve();
    // invoke rejects (no mock) but _completeTour must not crash.
    expect(st.teardownCalls).toBe(1);
    expect(st.invokeLog.some(e => e.channel === 'prefs.setTourCompleted')).toBe(true);
  });
});
