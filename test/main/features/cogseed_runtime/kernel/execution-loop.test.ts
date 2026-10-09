import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../../../src/main/paths';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import { createRuntimeSessionRunner } from '../../../../../src/main/features/cogseed_runtime/kernel/session-runner';
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

    const sessionText = fs.readFileSync(paths.cogseedRuntimeSessionFile(UID, SESSION), 'utf8');
    expect(sessionText).toContain('Use explicit inputs only.');
    expect(sessionText).toContain('TOOL: alpha=42');
    expect(sessionText).toContain('Answer after tool.');
  });

  it('emits a stable error event when a tool fails', async () => {
    const model = adapterFromRuns([
      [
        { type: 'tool_call', call: { id: 'call-1', name: 'bad_tool', arguments: {} } },
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
    });

    const events = await collect(runner.run(request()));

    expect(events.at(-1)).toEqual({
      type: 'error',
      requestId: 'req-loop',
      runtimeSessionId: SESSION,
      error: '[E_TOOL_FAILED] boom',
      metadata: { code: 'runtime_tool_error', tool: 'bad_tool' },
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
});
