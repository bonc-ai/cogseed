import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import { createRuntimeSessionRunner } from '../../../../../src/main/features/cogseed_runtime/kernel/session-runner';
import { appendNativeSessionRecord, createNativeRuntimeSession } from '../../../../../src/main/features/cogseed_runtime/kernel/session-store';
import type { RuntimeModelAdapter, RuntimeModelEvent, RuntimeModelRequest } from '../../../../../src/main/features/cogseed_runtime/kernel/model-adapter';
import type { RuntimeToolResult } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import type { RuntimeKernelEvent, RuntimeKernelRequest } from '../../../../../src/main/features/cogseed_runtime/kernel/types';

const UID = 'runtime-loop-user';
const SESSION = 'mruntime-loop';

function request(overrides: Partial<RuntimeKernelRequest> = {}): RuntimeKernelRequest {
  return {
    userId: UID,
    requestId: 'req-loop',
    runtimeSessionId: SESSION,
    task: 'Use explicit inputs only.',
    context: [],
    attachments: [],
    readOnlyRoots: [],
    writableRoots: [],
    toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<RuntimeKernelEvent>): Promise<RuntimeKernelEvent[]> {
  const out: RuntimeKernelEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function adapterFromRuns(runs: RuntimeModelEvent[][]): RuntimeModelAdapter & { seen: RuntimeModelRequest[] } {
  const seen: RuntimeModelRequest[] = [];
  return {
    seen,
    async *stream(input: RuntimeModelRequest) {
      seen.push(input);
      const next = runs.shift() ?? [{ type: 'done' }];
      for (const event of next) yield event;
    },
  };
}

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('CogSeed Runtime native execution loop', () => {
  it('executes tool calls the model wrote as text instead of showing the markup as its answer', async () => {
    const model = adapterFromRuns([
      [{ type: 'delta', text: '<tool_calls>\n<tool_call name="read_file">\n<parameter name="path">/w/minutes.md</parameter>\n</tool_call>\n</tool_calls>' }, { type: 'done' }],
      [{ type: 'delta', text: 'Archived.' }, { type: 'done' }],
    ]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const runner = createRuntimeSessionRunner({ modelAdapter: model, maxToolRounds: 4,
      toolRunner: { catalog: [{ name: 'read_file', summary: '', kind: 'file', parameters: { type: 'object', properties: {} } }] as any,
        async run(name, args) { calls.push({ name, args }); return { content: 'MINUTES' }; } } });
    const events = await collect(runner.run(request()));
    expect(calls).toEqual([{ name: 'read_file', args: { path: '/w/minutes.md' } }]);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Archived.' });
  });

  it('answers a full re-read or identical rewrite of a file written this turn without touching disk', async () => {
    const write = { id: 'w', name: 'write_file', arguments: { path: '/w/m.md', content: '# minutes' } };
    const model = adapterFromRuns([
      [{ type: 'tool_call', call: write }, { type: 'done' }],
      [{ type: 'tool_call', call: { id: 'r', name: 'read_file', arguments: { path: '/w/m.md' } } },
        { type: 'tool_call', call: { ...write, id: 'w2' } },
        { type: 'tool_call', call: { id: 'r2', name: 'read_file', arguments: { path: '/w/m.md', charStart: 0, charEnd: 5 } } }, { type: 'done' }],
      [{ type: 'delta', text: 'Done.' }, { type: 'done' }],
    ]);
    const calls: string[] = [];
    const runner = createRuntimeSessionRunner({ modelAdapter: model, maxToolRounds: 4,
      toolRunner: { catalog: [], async run(name, args) { calls.push(`${name}:${JSON.stringify(args)}`); return { content: 'ok' }; } } });
    const events = await collect(runner.run(request()));
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Done.' });
    // Only the first write and the ranged read reach the tool runner.
    expect(calls).toEqual([`write_file:${JSON.stringify(write.arguments)}`, 'read_file:{"path":"/w/m.md","charStart":0,"charEnd":5}']);
    expect(model.seen[2].message).toContain('Do not re-read or rewrite it');
  });

  it('retries once after an empty model response and recovers', async () => {
    const model = adapterFromRuns([[{ type: 'done' }], [{ type: 'delta', text: 'Here are the minutes.' }, { type: 'done' }]]);
    const runner = createRuntimeSessionRunner({ modelAdapter: model, toolRunner: { catalog: [], async run() { return { content: '' }; } }, maxToolRounds: 4 });
    const events = await collect(runner.run(request()));
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Here are the minutes.' });
    expect(model.seen[1].message).toContain('Your previous response was empty');
  });

  it('fails visibly instead of completing with no reply when the model stays empty', async () => {
    const model = adapterFromRuns([[{ type: 'done' }], [{ type: 'done' }]]);
    const runner = createRuntimeSessionRunner({ modelAdapter: model, toolRunner: { catalog: [], async run() { return { content: '' }; } }, maxToolRounds: 4 });
    const events = await collect(runner.run(request()));
    expect(events.at(-1)).toMatchObject({ type: 'error', metadata: { code: 'empty_model_response' } });
    expect(events.some((event) => event.type === 'result')).toBe(false);
  });

  it('retains the transcript across later file lookups so the model can finish without fetching it again', async () => {
    const calls: string[] = [];
    let round = 0;
    const model: RuntimeModelAdapter = {
      async *stream(input) {
        round += 1;
        if (round === 1 || !input.message.includes('TRANSCRIPT: confirmed decision')) {
          yield { type: 'tool_call', call: { id: `transcript-${round}`, name: 'call_connector_tool', arguments: { record_file_id: 'meeting-1' } } };
        } else if (!input.message.includes('FILES: minutes.md')) {
          yield { type: 'tool_call', call: { id: 'files', name: 'search_files', arguments: {} } };
        } else {
          yield { type: 'delta', text: 'Minutes from confirmed decision.' };
        }
        yield { type: 'done' };
      },
    };
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: { catalog: [], async run(name) {
        calls.push(name);
        return { content: name === 'call_connector_tool' ? 'TRANSCRIPT: confirmed decision' : 'FILES: minutes.md' };
      } },
      maxToolRounds: 4,
    });
    const events = await collect(runner.run(request()));
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Minutes from confirmed decision.' });
    expect(calls).toEqual(['call_connector_tool', 'search_files']);
  });

  it('runs fake model → fake tool → fake model final and records session history', async () => {
    const model = adapterFromRuns([
      [
        { type: 'delta', text: 'Checking. ' },
        { type: 'tool_call', call: { id: 'call-1', name: 'lookup', arguments: { q: 'alpha' } } },
        { type: 'done' },
      ],
      [
        { type: 'delta', text: 'Answer after tool.' },
        { type: 'done' },
      ],
    ]);
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: {
        catalog: [{
          name: 'read_file',
          summary: 'Read a visible file.',
          kind: 'file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        }],
        async run(name, input): Promise<RuntimeToolResult> {
          toolCalls.push({ name, input });
          return { content: 'TOOL: alpha=42' };
        },
      },
      maxToolRounds: 4,
    });

    const events = await collect(runner.run(request()));

    expect(events.map((event) => event.type)).toEqual([
      'started',
      'model_delta',
      'tool_call',
      'tool_result',
      'model_delta',
      'result',
    ]);
    expect(toolCalls).toEqual([{ name: 'lookup', input: { q: 'alpha' } }]);
    expect(events.find((event) => event.type === 'result')?.text).toBe('Answer after tool.');
    expect(model.seen[0].tools).toEqual([{
      name: 'read_file',
      description: 'Read a visible file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }]);
    expect(model.seen[1].message).toContain('TOOL: alpha=42');
    // The model sees the call it made, not only the result.
    expect(model.seen[1].message).toContain('<runtime-tool-call id="call-1" name="lookup">{"q":"alpha"}</runtime-tool-call>');

    const sessionText = fs.readFileSync(paths.cogseedRuntimeSessionFile(UID, SESSION), 'utf8');
    expect(sessionText).toContain('Use explicit inputs only.');
    expect(sessionText).toContain('TOOL: alpha=42');
    expect(sessionText).toContain('Answer after tool.');
  });

  it('feeds a failed tool result back to the model instead of killing the turn', async () => {
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'call-1', name: 'bad_tool', arguments: {} } },
        { type: 'done' },
      ],
      [
        { type: 'delta', text: 'Recovered from the tool error.' },
        { type: 'done' },
      ],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: {
        catalog: [],
        async run(): Promise<RuntimeToolResult> {
          return { content: '[E_TOOL_FAILED] boom', isError: true };
        },
      },
      maxToolRounds: 4,
    });

    const events = await collect(runner.run(request()));

    // Observability is preserved: the failed tool result is still emitted.
    expect(events).toContainEqual({
      type: 'tool_result',
      requestId: 'req-loop',
      runtimeSessionId: SESSION,
      text: '[E_TOOL_FAILED] boom',
      metadata: { id: 'call-1', name: 'bad_tool', isError: true },
    });
    // The error is recoverable input, not a turn-fatal event.
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Recovered from the tool error.' });
    expect(model.seen[1].message).toContain('[E_TOOL_FAILED] boom');
  });

  it('still bounds a turn whose every tool round fails', async () => {
    let round = 0;
    const model: RuntimeModelAdapter = {
      async *stream() {
        round += 1;
        yield { type: 'tool_call', call: { id: `call-${round}`, name: 'always_fails', arguments: {} } };
        yield { type: 'done' };
      },
    };
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: {
        catalog: [],
        async run(): Promise<RuntimeToolResult> {
          return { content: '[E_TOOL_FAILED] boom', isError: true };
        },
      },
      maxToolRounds: 2,
    });

    const events = await collect(runner.run(request()));

    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: 'error',
      requestId: 'req-loop',
      runtimeSessionId: SESSION,
      error: 'runtime exceeded max tool rounds',
      metadata: { code: 'max_tool_rounds', maxToolRounds: 2 },
    });
  });

  it('stops with max-rounds error instead of looping forever', async () => {
    const model = adapterFromRuns([
      [{ type: 'tool_call', call: { id: 'call-1', name: 'again', arguments: {} } }, { type: 'done' }],
      [{ type: 'tool_call', call: { id: 'call-2', name: 'again', arguments: {} } }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: { catalog: [], async run() { return { content: 'again' }; } },
      maxToolRounds: 1,
    });

    const events = await collect(runner.run(request()));

    expect(events.at(-1)).toEqual({
      type: 'error',
      requestId: 'req-loop',
      runtimeSessionId: SESSION,
      error: 'runtime exceeded max tool rounds',
      metadata: { code: 'max_tool_rounds', maxToolRounds: 1 },
    });
  });

  it('emits cancelled when aborted before execution without replaying the task', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = adapterFromRuns([[{ type: 'delta', text: 'should not run' }, { type: 'done' }]]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: { catalog: [], async run() { return { content: 'unused' }; } },
    });

    const events = await collect(runner.run(request(), { signal: controller.signal }));

    expect(events).toEqual([{
      type: 'cancelled',
      requestId: 'req-loop',
      runtimeSessionId: SESSION,
      metadata: { code: 'aborted' },
    }]);
    expect(model.seen).toHaveLength(0);
  });

  it('runs independent read-only calls in one bounded pool', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'read-a', name: 'read_file', arguments: { path: '/w/a.md' } } },
        { type: 'tool_call', call: { id: 'read-b', name: 'read_file', arguments: { path: '/w/b.md' } } },
        { type: 'tool_call', call: { id: 'search-c', name: 'search_files', arguments: {} } },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 4,
      maxParallelToolCalls: 3,
      toolTimeoutMs: 5_000,
      toolRunner: {
        catalog: [],
        async run(name, input) {
          started.push(`${name}:${String(input.path ?? '')}`);
          await gate;
          return { content: 'ok' };
        },
      },
    });

    const pending = collect(runner.run(request()));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Serial execution would show one started call here and finish the rest
    // only after `release`; a bounded pool has all three in flight.
    expect(started).toHaveLength(3);
    release();
    const events = await pending;
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.metadata?.id))
      .toEqual(['read-a', 'read-b', 'search-c']);
  });

  it('keeps model order for results even when parallel reads finish out of order', async () => {
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'slow', name: 'read_file', arguments: { path: '/w/slow.md' } } },
        { type: 'tool_call', call: { id: 'fast', name: 'stat_file', arguments: { path: '/w/fast.md' } } },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 4,
      maxParallelToolCalls: 2,
      toolTimeoutMs: 5_000,
      toolRunner: {
        catalog: [],
        async run(name) {
          if (name === 'read_file') await new Promise((resolve) => setTimeout(resolve, 40));
          return { content: `${name}-ok` };
        },
      },
    });

    const events = await collect(runner.run(request()));

    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.metadata?.id))
      .toEqual(['slow', 'fast']);
    expect(model.seen[1].message.indexOf('read_file-ok')).toBeLessThan(model.seen[1].message.indexOf('stat_file-ok'));
  });

  it('treats a mutating call as a barrier between read pools', async () => {
    const log: string[] = [];
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'read-1', name: 'read_file', arguments: { path: '/w/before.md' } } },
        { type: 'tool_call', call: { id: 'write-1', name: 'write_file', arguments: { path: '/w/before.md', content: 'x' } } },
        { type: 'tool_call', call: { id: 'read-2', name: 'read_file', arguments: { path: '/w/after.md' } } },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 4,
      maxParallelToolCalls: 4,
      toolTimeoutMs: 5_000,
      toolRunner: {
        catalog: [],
        async run(name) {
          log.push(`start:${name}`);
          if (name === 'write_file') await writeGate;
          log.push(`end:${name}`);
          return { content: 'ok' };
        },
      },
    });

    const pending = collect(runner.run(request()));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The read after the write has not started while the write is still open.
    expect(log).toEqual(['start:read_file', 'end:read_file', 'start:write_file']);
    releaseWrite();
    await pending;
    expect(log).toEqual([
      'start:read_file', 'end:read_file',
      'start:write_file', 'end:write_file',
      'start:read_file', 'end:read_file',
    ]);
  });

  it('returns a timeout error to the model instead of letting one tool own the turn', async () => {
    const model = adapterFromRuns([
      [{ type: 'tool_call', call: { id: 'hang', name: 'read_file', arguments: { path: '/w/hang.md' } } }, { type: 'done' }],
      [{ type: 'delta', text: 'Recovered without the hung read.' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 4,
      toolTimeoutMs: 25,
      toolRunner: { catalog: [], async run() { return new Promise<RuntimeToolResult>(() => {}); } },
    });

    const events = await collect(runner.run(request()));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      text: expect.stringContaining('E_RUNTIME_TOOL_TIMEOUT'),
      metadata: { id: 'hang', name: 'read_file', isError: true },
    }));
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Recovered without the hung read.' });
    expect(model.seen[1].message).toContain('E_RUNTIME_TOOL_TIMEOUT');
  });

  it('prunes the middle of old in-turn tool results and keeps the recent working set', async () => {
    const body = 'x'.repeat(900);
    const calls = Array.from({ length: 4 }, (_, index) => ({
      id: `c${index}`,
      name: 'read_file',
      arguments: { path: `/w/${index}.md` },
    }));
    const model = adapterFromRuns([
      [...calls.map((call) => ({ type: 'tool_call' as const, call })), { type: 'done' }],
      [{ type: 'tool_call', call: { id: 'c4', name: 'read_file', arguments: { path: '/w/4.md' } } }, { type: 'done' }],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 5,
      maxParallelToolCalls: 4,
      toolTimeoutMs: 5_000,
      toolHistoryBudget: { maxChars: 2_000, headChars: 100, tailChars: 50, keepRecent: 1 },
      toolRunner: { catalog: [], async run() { return { content: body }; } },
    });

    const events = await collect(runner.run(request()));

    const markers = (text: string) => text.match(/\[\.\.\. tool result middle pruned: \d+ chars \.\.\.\]/g) ?? [];
    const roundTwo = model.seen[1].message;
    const roundThree = model.seen[2].message;
    expect(markers(roundTwo)).toHaveLength(3);
    // Only the newest result still carries its full body.
    expect(roundTwo.split(body)).toHaveLength(2);
    // Pruning is byte-stable: the next round reuses the same excerpted bytes
    // (a prefix-cache invalidation happens at most once per prune event).
    expect(markers(roundThree).slice(0, 3)).toEqual(markers(roundTwo));
    expect(markers(roundThree)).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' });
  });

  it('records one bounded metric line per model round', async () => {
    const uid = 'runtime-loop-metrics';
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'm1', name: 'read_file', arguments: { path: '/w/a.md' } } },
        { type: 'usage', usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 4,
      toolRunner: { catalog: [], async run() { return { content: 'ok' }; } },
    });

    await collect(runner.run({ ...request(), userId: uid, runtimeSessionId: 'mruntime-metrics', traceId: 'cogseed-task-trace' }));

    const file = path.join(paths.cogseedRuntimeRoot(uid), 'metrics.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const rounds = rows.filter((row) => row.kind === 'round');
    const tools = rows.filter((row) => row.kind === 'tool');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round: 0, tool_calls: 1, input_tokens: 120, output_tokens: 8 });
    expect(rounds[1]).toMatchObject({ round: 1, tool_calls: 0 });
    expect(rounds[0].prompt_chars).toBeGreaterThan(0);
    expect(rounds[0]).toMatchObject({ trace_id: 'cogseed-task-trace' });
    expect(tools[0]).toMatchObject({ trace_id: 'cogseed-task-trace' });
    expect(rounds[0]).not.toHaveProperty('message');
    // One tool span per executed call: name, duration, outcome.
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ round: 0, name: 'read_file', is_error: false });
    expect(typeof tools[0].tool_ms).toBe('number');
    fs.rmSync(paths.userRoot(uid), { recursive: true, force: true });
  });


  it('replays a compact session checkpoint instead of the whole transcript', async () => {
    const uid = 'runtime-loop-checkpoint';
    const sessionId = 'mruntime-checkpoint';
    await createNativeRuntimeSession(uid, sessionId, '2026-10-18T00:00:00');
    const oldBody = (tag: string) => `${tag}-HEAD ` + 'x'.repeat(5_000) + ` ${tag}-TAIL`;
    for (let index = 0; index < 10; index += 1) {
      await appendNativeSessionRecord(uid, sessionId, {
        type: 'turn', request_id: 'req-seed', role: 'tool',
        content: oldBody(`OLD-${index}`), created_at: '2026-10-18T00:00:01',
        tool: { name: 'read_file', input: { path: `/w/old-${index}.md` }, result: { content: oldBody(`OLD-${index}`) } },
      });
    }
    await appendNativeSessionRecord(uid, sessionId, {
      type: 'turn', request_id: 'req-seed', role: 'tool',
      content: 'status: applied ... corrected_path: /w/corrected.md',
      created_at: '2026-10-18T00:00:02',
      tool: {
        name: 'transcript_glossary_apply',
        input: { path: '/w/raw.md' },
        result: { content: 'status: applied ... corrected_path: /w/corrected.md', correction: { docId: 'doc', sourceHash: 'hash', state: 'applied' } },
      },
    });
    await appendNativeSessionRecord(uid, sessionId, {
      type: 'turn', request_id: 'req-seed', role: 'tool',
      content: 'wrote minutes', created_at: '2026-10-18T00:00:03',
      tool: { name: 'write_file', input: { path: '/w/minutes.md', content: 'x' }, result: { content: 'ok' } },
    });
    for (let index = 0; index < 2; index += 1) {
      await appendNativeSessionRecord(uid, sessionId, {
        type: 'turn', request_id: 'req-seed', role: 'tool',
        content: `RECENT-${index}-FULL`, created_at: '2026-10-18T00:00:04',
        tool: { name: 'read_file', input: { path: `/w/recent-${index}.md` }, result: { content: `RECENT-${index}-FULL` } },
      });
    }
    await appendNativeSessionRecord(uid, sessionId, {
      type: 'turn', request_id: 'req-seed', role: 'assistant', content: 'Correction applied; waiting for minutes confirmation.',
      created_at: '2026-10-18T00:00:05',
    });

    const model = adapterFromRuns([[{ type: 'delta', text: 'done' }, { type: 'done' }]]);
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 2,
      toolRunner: { catalog: [], async run() { return { content: 'unused' }; } },
    });
    const req = { ...request(), userId: uid, runtimeSessionId: sessionId, requestId: 'req-followup' };
    await collect(runner.run(req));

    const message = model.seen[0].message;
    expect(message).toContain('## Session state');
    expect(message).toContain('Transcript correction: applied (corrected_path: /w/corrected.md)');
    expect(message).toContain('Written deliverables: ["/w/minutes.md"]');
    expect(message).toContain('Last assistant reply: Correction applied');
    expect(message).toContain('RECENT-0-FULL');
    expect(message).toContain('RECENT-1-FULL');
    // Old tool output keeps its head and is explicitly truncated.
    // Call arguments travel only for the recent working set; old results keep
    // their tool name inside the result wrapper without replaying payloads.
    expect(message).toContain('[assistant] tool_call read_file {"path":"/w/recent-0.md"}');
    expect(message).not.toContain('/w/old-0.md');
    expect(message).toContain('OLD-0-HEAD');
    expect(message).not.toContain('OLD-0-TAIL');
    expect(message).toContain('earlier result truncated');
    // The compact replay is far below the sum of the seeded records.
    expect(message.length).toBeLessThan(40_000);
    fs.rmSync(paths.userRoot(uid), { recursive: true, force: true });
  });


  it('fails a model round that stops emitting events instead of hanging the turn', async () => {
    const neverEnding: RuntimeModelAdapter = {
      async *stream() { await new Promise<void>(() => {}); },
    };
    const runner = createRuntimeSessionRunner({
      modelAdapter: neverEnding,
      maxToolRounds: 2,
      streamIdleTimeoutMs: 25,
      maxModelRetries: 0,
      toolRunner: { catalog: [], async run() { return { content: 'unused' }; } },
    });

    const startedAt = Date.now();
    const events = await collect(runner.run(request()));

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      metadata: { code: 'model_stream_idle' },
    });
  });

  it('retries a model round that produced nothing before giving up', async () => {
    let calls = 0;
    const model: RuntimeModelAdapter = {
      async *stream() {
        calls += 1;
        if (calls === 1) { await new Promise<void>(() => {}); return; }
        yield { type: 'delta', text: 'recovered' };
        yield { type: 'done' };
      },
    };
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 2,
      streamIdleTimeoutMs: 25,
      maxModelRetries: 1,
      toolRunner: { catalog: [], async run() { return { content: 'unused' }; } },
    });

    const events = await collect(runner.run(request()));

    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'recovered' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('does not retry after partial output, so the user never sees duplicated text', async () => {
    const model: RuntimeModelAdapter = {
      async *stream() {
        yield { type: 'delta', text: 'partial' };
        await new Promise<void>(() => {});
      },
    };
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      maxToolRounds: 2,
      streamIdleTimeoutMs: 25,
      maxModelRetries: 2,
      toolRunner: { catalog: [], async run() { return { content: 'unused' }; } },
    });

    const events = await collect(runner.run(request()));

    expect(events.filter((event) => event.type === 'model_delta').map((event) => (event as { text: string }).text).join('')).toBe('partial');
    expect(events.at(-1)).toMatchObject({ type: 'error', metadata: { code: 'model_stream_idle' } });
  });

});
