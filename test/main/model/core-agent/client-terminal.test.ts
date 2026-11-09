import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatExecutionLifecycle, ChatOptions, StreamEvent } from '../../../../src/main/model/client';

type RunEvent = import('#core-agent').AgentRunEvent;
type Trip = { kind: string; code: string; reason: string; failures: number; tool: string };
const h = vi.hoisted(() => ({
  makeStream: null as null | (() => AsyncGenerator<RunEvent>),
  trip: null as Trip | null,
  build: vi.fn(), run: vi.fn(), heal: vi.fn(() => false), getSession: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: vi.fn(), dialog: {}, shell: {} }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: async (params: Record<string, unknown>) => {
    h.build(params);
    return {
      runner: { runStream: (params: unknown) => { h.run(params); return h.makeStream!(); } },
      resolvedSystemPrompt: 'sys', entryId: 'e1', profileId: 'p1',
      providerId: 'mock-provider', modelId: 'mock-model', toolDefs: [],
      skillDisplayNameById: new Map(), agentDisplayNameById: new Map(),
      toolFailure: () => h.trip,
    };
  },
}));
vi.mock('../../../../src/main/model/core-agent/session-store', () => ({
  getSession: (...args: unknown[]) => { h.getSession(...args); return { healAndPersist: h.heal }; },
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-client-terminal-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.clearAllMocks();
  h.trip = null;
});
afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const partial = 'Created the report draft; checking the remaining dependency.';
const reason = 'Missing template; last progress: report draft saved; install the template before retrying.';
function trip(kind = 'missing_dependency', code = 'missing_dependency') {
  h.trip = { kind, code, reason, failures: 3, tool: 'read_file' };
}
function done(text: string, error?: { kind: 'provider_error'; message: string }) : RunEvent {
  return { type: 'done', result: { text, meta: { model: 'mock-model', provider: 'mock-provider', durationMs: 1, ...(error ? { error } : {}) } } } as RunEvent;
}
function lifecycle() {
  return { queued: vi.fn(), started: vi.fn(), event: vi.fn(), artifact: vi.fn(), terminal: vi.fn() } satisfies ChatExecutionLifecycle;
}
async function drain(options: Partial<ChatOptions> = {}) {
  const client = await import('../../../../src/main/model/core-agent/client');
  const events: StreamEvent[] = [];
  for await (const event of client.streamChatWithModel({ userId: 'u1', sessionId: 'gconv-terminal', message: 'continue', ...options })) events.push(event);
  return events;
}
function result(events: StreamEvent[]) {
  return events.find(event => event.event?.stream === 'agent_run_result')?.event?.data;
}
function brokenStream(text = partial) {
  h.makeStream = () => (async function* () {
    if (text) yield { type: 'text_delta', text } as RunEvent;
    yield { type: 'tool_start', id: 'written', name: 'write_file', input: { path: 'draft.md', content: 'draft' } } as RunEvent;
    yield { type: 'tool_end', id: 'written', name: 'write_file', result: 'draft saved', isError: false } as RunEvent;
    trip();
    yield { type: 'tool_end', id: 'failed', name: 'read_file', result: reason, isError: true } as RunEvent;
    yield done(text);
  })();
}

describe('client terminal-state integration with a mocked runner', () => {
  it.each([partial, ''])('reports a breaker trip as failure and replaces the mapper terminal text (%j)', async text => {
    brokenStream(text);
    const sink = lifecycle();
    const events = await drain({ executionLifecycle: sink });
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ text: reason, failureKind: 'dependency', failureCode: 'missing_dependency', failurePhase: 'tool' }),
    ]);
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ stream: 'tool', data: expect.objectContaining({ name: 'write_file' }) }) }));
    if (text) expect(events).toContainEqual({ type: 'delta', text });
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'failed', sessionId: 'gconv-terminal', output: reason });
    expect(sink.event).toHaveBeenCalledWith('error', expect.objectContaining({ failureKind: 'dependency', failureCode: 'missing_dependency' }));
    expect(result(events)).toMatchObject({ result: 'failure', error_code: 'missing_dependency', failure_kind: 'dependency', failure_phase: 'tool' });
    expect(events.at(-1)?.type).toBe('done');
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('keeps recovered and recoverable tool errors successful when no breaker trips', async () => {
    h.makeStream = () => (async function* () {
      yield { type: 'tool_end', id: 'bad', name: 'read_file', result: 'invalid path', isError: true } as RunEvent;
      yield { type: 'tool_end', id: 'retry', name: 'read_file', result: 'retry elsewhere', isError: true, errorSeverity: 'recoverable' } as RunEvent;
      yield { type: 'tool_end', id: 'ok', name: 'read_file', result: 'found', isError: false } as RunEvent;
      yield done('Recovered answer');
    })();
    const sink = lifecycle();
    const events = await drain({ executionLifecycle: sink });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'final', text: 'Recovered answer' });
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'completed', sessionId: 'gconv-terminal', output: 'Recovered answer' });
    expect(result(events)).toMatchObject({ result: 'success' });
  });

  it('persists failed status, breaker details and prior work through the real lifecycle sink', async () => {
    const records = await import('../../../../src/main/features/execution-records');
    brokenStream();
    const sink = records.createLifecycleSink('u1', {
      executionId: 'exec-client-breaker', boundary: 'test-double', permissionMode: 'workspace-write',
    });
    await drain({ executionLifecycle: sink });
    const record = await records.read('u1', 'exec-client-breaker');
    expect(record.status).toBe('failed');
    expect(await records.readResult('u1', record.executionId, record.resultRef!)).toBe(reason);
    const events = await records.readEvents('u1', record.executionId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'output', metadata: { output: partial } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', metadata: expect.objectContaining({ tool: 'write_file', phase: 'result', isError: false }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', metadata: { failureKind: 'dependency', failureCode: 'missing_dependency', failurePhase: 'tool' } }));
    expect(events.at(-1)).toMatchObject({ type: 'terminal', metadata: { status: 'failed', sessionId: 'gconv-terminal' } });
  });

  it('preserves provider failure precedence and partial text after a breaker observation', async () => {
    h.makeStream = () => (async function* () {
      yield { type: 'text_delta', text: partial } as RunEvent;
      trip();
      yield done(partial, { kind: 'provider_error', message: 'provider failed' });
    })();
    const sink = lifecycle();
    const events = await drain({ executionLifecycle: sink });
    expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ text: 'provider failed', failureKind: 'model', failureCode: 'provider_error' })]);
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'failed', sessionId: 'gconv-terminal', output: partial });
    expect(sink.event).toHaveBeenCalledWith('error', expect.objectContaining({ failureKind: 'model', failureCode: 'provider_error' }));
    expect(result(events)).toMatchObject({ result: 'failure', error_code: 'provider_error', failure_kind: 'model' });
  });

  it.each(['tool_call_limit', 'read_only_limit'] as const)('forwards explicit Core %s and preserves its deterministic receipt', async terminationReason => {
    const receipt = 'Saved draft; execution stopped at the configured limit.';
    h.makeStream = () => (async function* () {
      yield { type: 'text_delta', text: partial } as RunEvent;
      trip(); // A host observation must not replace Core's explicit terminal reason.
      const terminal = done(receipt);
      if (terminal.type !== 'done') throw new Error('Expected a done fixture');
      terminal.result.meta.terminationReason = terminationReason;
      yield terminal;
    })();
    const sink = lifecycle();
    const events = await drain({ executionLifecycle: sink });
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ text: receipt, failureKind: 'runtime', failureCode: terminationReason, failurePhase: 'tool' }),
    ]);
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'failed', sessionId: 'gconv-terminal', output: receipt });
    expect(sink.event).toHaveBeenCalledWith('error', { failureKind: 'runtime', failureCode: terminationReason, failurePhase: 'tool' });
    expect(result(events)).toMatchObject({ result: 'failure', error_code: terminationReason, failure_kind: 'runtime' });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('gives cancellation precedence over breaker failure and salvages partial work', async () => {
    const controller = new AbortController();
    h.makeStream = () => (async function* () {
      yield { type: 'text_delta', text: partial } as RunEvent;
      trip();
      controller.abort();
      yield done(partial);
    })();
    const sink = lifecycle();
    const events = await drain({ abortSignal: controller.signal, executionLifecycle: sink });
    expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ aborted: true })]);
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'cancelled', sessionId: 'gconv-terminal', output: partial });
    expect(result(events)).toMatchObject({ result: 'aborted', error_code: 'aborted' });
    expect(result(events)).not.toHaveProperty('failure_kind');
  });

  it('blocking callers receive failure and partial work instead of a successful intermediate answer', async () => {
    brokenStream();
    const client = await import('../../../../src/main/model/core-agent/client');
    expect(await client.chatWithModel({ userId: 'u1', sessionId: 'gconv-terminal', message: 'continue' })).toEqual({ ok: false, text: partial, error: reason, aborted: false });
  });

  it.each([false, true])('never opens the disk session cache for ephemeral routing (preflight failure: %s)', async preflightFailure => {
    h.makeStream = () => (async function* () { yield done('route'); })();
    await drain({
      sessionId: 'kstar-routing-one-shot', ephemeralSession: true,
      ...(preflightFailure ? { thinkingLevel: 'high' as const, supportedReasoningLevels: ['low' as const] } : {}),
    });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.heal).not.toHaveBeenCalled();
    expect(h.build).toHaveBeenCalledWith(expect.objectContaining({ ephemeralSession: true }));
  });

  it('still heals persistent sessions before and after a turn', async () => {
    h.makeStream = () => (async function* () { yield done('ok'); })();
    await drain();
    expect(h.getSession).toHaveBeenCalledTimes(2);
    expect(h.heal).toHaveBeenCalledTimes(2);
  });

  it('forwards explicit execution controls including zero and false without interpreting message policy', async () => {
    h.makeStream = () => (async function* () { yield done('ok'); })();
    const toolDenylist = ['bash', 'write_file'] as const;
    await drain({ message: 'Do anything you need', maxToolCalls: 0, toolDenylist, suppressExecutionPlanInstructions: false });
    expect(h.run).toHaveBeenLastCalledWith(expect.objectContaining({ maxToolCalls: 0, suppressExecutionPlanInstructions: false }));
    expect(h.build).toHaveBeenLastCalledWith(expect.objectContaining({ toolDenylist }));
    await drain({ maxToolCalls: 2, suppressExecutionPlanInstructions: true });
    expect(h.run).toHaveBeenLastCalledWith(expect.objectContaining({ maxToolCalls: 2, suppressExecutionPlanInstructions: true }));
    await drain();
    expect(h.run.mock.lastCall?.[0]).not.toHaveProperty('maxToolCalls');
    expect(h.run.mock.lastCall?.[0]).not.toHaveProperty('suppressExecutionPlanInstructions');
    expect(h.build.mock.lastCall?.[0]).not.toHaveProperty('toolDenylist');
  });
});
