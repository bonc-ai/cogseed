import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool, LLMProvider } from '#core-agent';
import type { ChatExecutionLifecycle, StreamEvent } from '../../../../src/main/model/client';

type BuiltRunner = Awaited<ReturnType<typeof import('../../../../src/main/model/core-agent/runner').buildRunner>>;
const h = vi.hoisted(() => ({
  built: null as BuiltRunner | null,
  provider: null as LLMProvider | null,
  calls: 0,
  receiptBeforeRecovery: undefined as ReturnType<BuiltRunner['toolFailure']> | undefined,
}));
vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: vi.fn(), dialog: {}, shell: {} }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/model/core-agent/runner', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/model/core-agent/runner')>();
  return {
    ...actual,
    buildRunner: async (params: Parameters<typeof actual.buildRunner>[0]) => {
      // Keep real host tool assembly, failure guard, receipt callback and Core
      // runner. Substitute only the provider transport with a synthetic stream.
      const built = await actual.buildRunner({ ...params, toolAllowlist: ['receipt_read', 'cognition_ontology_query', 'create_cognition', 'receipt_write', 'manage_execution_plan'] });
      h.built = built;
      vi.spyOn(built.runner.getProviders(), 'get').mockImplementation(() => h.provider!);
      return built;
    },
  };
});

const uid = 'runner-failure-receipt';
const recovered = 'Recovered answer from the available evidence.';
const auxiliary = vi.fn(async () => { throw new Error('Unexpected synthesis call'); });
const network = vi.fn(() => { throw new Error('Unexpected network call'); });
let root: string;
let previousWorkspace: string | undefined;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-breaker-receipt-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.stubGlobal('fetch', network);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const auth = await import('../../../../src/main/features/auth');
  vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
    { entryId: 'receipt-entry', profileId: 'receipt-profile', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-key' },
  ]);
});
beforeEach(() => {
  h.built = null;
  h.calls = 0;
  h.receiptBeforeRecovery = undefined;
  auxiliary.mockClear();
});
afterAll(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousWorkspace === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function run(executionMode: 'parallel' | 'sequential', recoverOnThird = false, independentTargets = false, thrown?: string | Error, trailingWrite = false) {
  let toolCalls = 0;
  const execute = vi.fn(async () => {
    if (++toolCalls === 3 && recoverOnThird) return { content: 'Corrected input; source read successfully.', isError: false };
    if (thrown) throw typeof thrown === 'string' ? new Error(thrown) : thrown;
    return { content: 'Missing dependency: template not installed.', isError: true };
  });
  const tool: AgentTool = {
    name: 'receipt_read', executionMode, description: 'Synthetic read fixture',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, execute,
  };
  const write = vi.fn(async () => ({ content: 'write completed' }));
  const writeTool: AgentTool = { name: 'receipt_write', description: 'Synthetic write', inputSchema: { type: 'object' }, execute: write };
  h.provider = {
    id: 'openai', name: 'Synthetic receipt provider', complete: auxiliary,
    async validateAuth() { return true; },
    async *stream() {
      if (++h.calls > 2) throw new Error('Unexpected provider retry');
      if (h.calls === 1) {
        yield {
          type: 'message_end', model: 'gpt-4o', stopReason: 'tool_use',
          content: [...Array.from({ length: 3 }, (_, index) => ({ type: 'tool_use' as const, id: `read-${index}`, name: tool.name, input: independentTargets ? { path: `source-${index}.ts` } : {} })),
            ...(trailingWrite ? [{ type: 'tool_use' as const, id: 'later-write', name: writeTool.name, input: {} }] : [])],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      } else {
        h.receiptBeforeRecovery = h.built!.toolFailure();
        yield { type: 'text_delta', text: recovered };
        yield {
          type: 'message_end', model: 'gpt-4o', stopReason: 'end_turn', content: [{ type: 'text', text: recovered }],
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        };
      }
    },
  };
  const sink = {
    queued: vi.fn(), started: vi.fn(), event: vi.fn(), artifact: vi.fn(), terminal: vi.fn(),
  } satisfies ChatExecutionLifecycle;
  const { streamChatWithModel } = await import('../../../../src/main/model/core-agent/client');
  const events: StreamEvent[] = [];
  for await (const event of streamChatWithModel({
    userId: uid, sessionId: `gworker-receipt-${executionMode}`, message: 'Read the supplied sources.',
    skillList: [], ephemeralSession: true, extraTools: [tool, writeTool], executionLifecycle: sink,
  })) events.push(event);
  return { events, sink, execute, write, telemetry: events.find(event => event.event?.stream === 'agent_run_result')?.event?.data };
}

describe('real runner failure receipts across the client boundary', () => {
  it('does not terminalize three failed parallel reads followed by model recovery', async () => {
    const { events, sink, execute, telemetry } = await run('parallel');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.calls).toBe(2);
    // Check before recovery as well: clearing an already-stale terminal receipt
    // on later success would not fix the observation/terminality distinction.
    expect(h.receiptBeforeRecovery).toBeNull();
    expect(h.built!.toolFailure()).toBeNull();
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'final', text: recovered });
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'completed', sessionId: 'gworker-receipt-parallel', output: recovered });
    expect(telemetry).toMatchObject({ result: 'success' });
    expect(auxiliary).not.toHaveBeenCalled();
  });

  it('continues after two serial failures when the third tool result succeeds', async () => {
    const { events, sink, execute, telemetry } = await run('sequential', true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.calls).toBe(2);
    expect(h.built!.toolFailure()).toBeNull();
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'final', text: recovered });
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'completed', sessionId: 'gworker-receipt-sequential', output: recovered });
    expect(telemetry).toMatchObject({ result: 'success' });
    expect(auxiliary).not.toHaveBeenCalled();
  });

  it('continues through independent serial failures without a false terminal receipt', async () => {
    const { events, sink, execute, telemetry } = await run('sequential', false, true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.calls).toBe(2);
    expect(h.receiptBeforeRecovery).toBeNull();
    expect(h.built!.toolFailure()).toBeNull();
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'final', text: recovered });
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'completed', sessionId: 'gworker-receipt-sequential', output: recovered });
    expect(telemetry).toMatchObject({ result: 'success' });
  });

  it.each(['ontology', 'joint'])('records a blocked %s write as a terminal failure, never stale successful narration', async (target) => {
    const write = vi.fn(async () => ({ content: 'Unexpected write', isError: false }));
    const tools: AgentTool[] = [
      { name: 'cognition_ontology_query', description: 'Synthetic query', inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: 'Missing dependency: template not installed.', isError: true }) },
      { name: 'create_cognition', description: 'Synthetic ontology write', inputSchema: { type: 'object', properties: { target: { type: 'string' } } }, execute: write },
    ];
    h.provider = {
      id: 'openai', name: 'Synthetic ontology provider', complete: auxiliary,
      async validateAuth() { return true; },
      async *stream() {
        if (++h.calls > 1) throw new Error('Unexpected model call after ontology stop');
        yield { type: 'text_delta', text: 'I will update the ontology.' };
        yield { type: 'message_end', model: 'gpt-4o', stopReason: 'tool_use', content: [
          { type: 'text', text: 'I will update the ontology.' },
          { type: 'tool_use', id: 'query', name: tools[0].name, input: {} },
          { type: 'tool_use', id: 'write', name: tools[1].name, input: { target } },
        ], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    };
    const sink = { queued: vi.fn(), started: vi.fn(), event: vi.fn(), artifact: vi.fn(), terminal: vi.fn() } satisfies ChatExecutionLifecycle;
    const { streamChatWithModel } = await import('../../../../src/main/model/core-agent/client');
    const events: StreamEvent[] = [];
    for await (const event of streamChatWithModel({ userId: uid, sessionId: 'gworker-ontology-receipt',
      message: 'Update the ontology after checking it.', skillList: [], ephemeralSession: true,
      extraTools: tools, executionLifecycle: sink })) events.push(event);
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toBe(1);
    expect(h.built!.toolFailure()).toMatchObject({ tool: 'create_cognition', kind: 'policy_denied', code: 'ontology_read_blocked' });
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', failureCode: 'ontology_read_blocked' }));
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', output: expect.stringContaining('已阻断') }));
  });

  it('counts normalized serial exceptions once, stops the later write and returns a failed receipt', async () => {
    const { events, sink, execute, write } = await run('sequential', false, false, 'OfficeCLI output exceeds limit', true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toBe(1);
    expect(h.built!.toolFailure()).toMatchObject({ tool: 'receipt_read', code: 'tool_error_unclassified', failures: 3 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', failureCode: 'tool_error_unclassified' }));
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', output: expect.stringContaining('OfficeCLI output exceeds limit') }));
    expect(auxiliary).not.toHaveBeenCalled();
  });

  it.each(['parallel', 'sequential'] as const)('preserves %s recovery for excluded transient exceptions', async executionMode => {
    const { execute, write, sink } = await run(executionMode, false, false, 'fetch failed', true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledOnce();
    expect(h.built!.toolFailure()).toBeNull();
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it.each([
    new TypeError('terminated'),
    Object.assign(new Error('transport closed'), { code: 'EPIPE' }),
    new TypeError('request failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
  ])('preserves network classification from a thrown socket error: %s', async error => {
    const { execute, write, sink } = await run('sequential', false, false, error, true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledOnce();
    expect(h.built!.toolFailure()).toBeNull();
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('preserves parallel exception recovery without a terminal receipt', async () => {
    const { execute, write, sink } = await run('parallel', false, false, 'OfficeCLI output exceeds limit', true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledOnce();
    expect(h.built!.toolFailure()).toBeNull();
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('guards the SDK plan tool and stops writes after three illegal plan updates', async () => {
    const write = vi.fn(async () => ({ content: 'unexpected write' }));
    h.provider = {
      id: 'openai', name: 'Synthetic plan provider', complete: auxiliary,
      async validateAuth() { return true; },
      async *stream() {
        if (++h.calls > 2) throw new Error('Unexpected model round');
        yield { type: 'message_end', model: 'gpt-4o', stopReason: h.calls === 1 ? 'tool_use' : 'end_turn',
          content: h.calls === 1 ? [
            { type: 'tool_use', id: 'plan', name: 'manage_execution_plan', input: { action: 'update', plan: [{ step: 'First milestone', status: 'in_progress' }] } },
            ...['Second', 'Third', 'Fourth'].map((step, index) => ({ type: 'tool_use' as const, id: `invalid-${index}`, name: 'manage_execution_plan', input: { action: 'append_step', step, status: 'in_progress' } })),
            { type: 'tool_use', id: 'write', name: 'receipt_write', input: {} },
          ] : [{ type: 'text', text: 'Unexpected successful answer' }], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const sink = { queued: vi.fn(), started: vi.fn(), event: vi.fn(), artifact: vi.fn(), terminal: vi.fn() } satisfies ChatExecutionLifecycle;
    const { streamChatWithModel } = await import('../../../../src/main/model/core-agent/client');
    const events: StreamEvent[] = [];
    for await (const event of streamChatWithModel({ userId: uid, sessionId: 'gworker-plan-receipt', message: 'Plan then write.',
      skillList: [], ephemeralSession: true, extraTools: [{ name: 'receipt_write', description: 'Synthetic write', inputSchema: { type: 'object' }, execute: write }], executionLifecycle: sink })) events.push(event);
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toBe(1);
    expect(h.built!.toolFailure()).toMatchObject({ tool: 'manage_execution_plan', code: 'invalid_args', failures: 3 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', failureCode: 'invalid_args' }));
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(sink.terminal).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(auxiliary).not.toHaveBeenCalled();
  });

  it('retains a serial endTurn receipt and reports failure without another model call', async () => {
    const { events, sink, execute, telemetry } = await run('sequential');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.calls).toBe(1);
    const receipt = h.built!.toolFailure();
    expect(receipt).toMatchObject({ code: 'missing_dependency', kind: 'missing_dependency', tool: 'receipt_read', failures: 3 });
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ text: receipt!.reason, failureKind: 'dependency', failureCode: 'missing_dependency', failurePhase: 'tool' }),
    ]);
    expect(events.some(event => event.type === 'final')).toBe(false);
    expect(sink.terminal).toHaveBeenCalledWith({ status: 'failed', sessionId: 'gworker-receipt-sequential', output: receipt!.reason });
    expect(telemetry).toMatchObject({ result: 'failure', error_code: 'missing_dependency', failure_kind: 'dependency' });
    expect(auxiliary).not.toHaveBeenCalled();
  });
});
