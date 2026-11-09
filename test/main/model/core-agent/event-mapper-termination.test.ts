import { beforeEach, describe, expect, it } from 'vitest';
import { mapCoreAgentEvents } from '../../../../src/main/model/core-agent/event-mapper';
import { setCurrentUiLang } from '../../../../src/main/i18n';
import { AgentRunner, READ_ONLY_STREAK_HARD } from '../../../../src/core-agent/src/agent/runner';
import { createConfig } from '../../../../src/core-agent/src/config/loader';
import { ProviderRegistry } from '../../../../src/core-agent/src/providers/registry';
import { defineTool } from '../../../../src/core-agent/src/tools/base';
import type { AgentRunEvent, AgentRunResult } from '../../../../src/core-agent/src/agent/types';
import type { LLMProvider } from '../../../../src/core-agent/src/providers/base';
import type { StreamEvent } from '../../../../src/main/model/client';

beforeEach(() => setCurrentUiLang('en'));

// The real Core limit paths return end_turn with usage/timings and NO
// meta.error. The receipt is content, never the source of terminal status.
function receiptResult(text: string): AgentRunResult {
  return {
    text, content: [{ type: 'text', text }],
    meta: {
      durationMs: 12, model: 'synthetic', provider: 'synthetic', stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      lastCallUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      toolLoops: 1, compactionCount: 0,
      timings: { providerMs: 3, toolMs: 2, compactionMs: 0, retryWaitMs: 0, otherMs: 7 },
      toolNames: ['write_file'], skillsLoaded: [],
    },
  };
}

async function* stream(events: AgentRunEvent[]) { yield* events; }
async function collect(events: AsyncIterable<AgentRunEvent>) {
  const output: StreamEvent[] = [];
  const mapped = mapCoreAgentEvents(events);
  while (true) {
    const next = await mapped.next();
    if (next.done) return { output, returned: next.value };
    output.push(next.value);
  }
}

describe('Core terminal metadata → mapper runtime failure contract', () => {
  it('preserves raw input totals and endpoint identity separately from routing aliases', async () => {
    const result = receiptResult('Done');
    result.meta.reportedModel = 'backend-model-2026';
    result.meta.usage = { inputTokens: 20, outputTokens: 5, totalTokens: 105,
      totalInputTokens: 100, cacheReadTokens: 80 };
    result.meta.lastCallUsage = result.meta.usage;
    const { output } = await collect(stream([{ type: 'done', result }]));
    const data = output.find(e => e.event?.stream === 'usage')?.event?.data;
    expect(data).toMatchObject({ requestedModel: 'synthetic', reportedModel: 'backend-model-2026',
      totalInputTokens: 100, cacheReadTokens: 80,
      lastCallUsage: { totalInputTokens: 100, cacheReadTokens: 80 } });
    expect(data).not.toHaveProperty('cacheWriteTokens');
  });

  it('omits an invalid endpoint identifier without replacing the requested model', async () => {
    const result = receiptResult('Done');
    result.meta.reportedModel = 'unexpected response text with spaces';
    const { output } = await collect(stream([{ type: 'done', result }]));
    const data = output.find(e => e.event?.stream === 'usage')?.event?.data;
    expect(data?.requestedModel).toBe('synthetic');
    expect(data).not.toHaveProperty('reportedModel');
  });

  it.each(['tool_call_limit', 'read_only_limit'] as const)('maps %s independently of receipt wording', async terminationReason => {
    const text = 'Draft saved to report.md. Remaining: verify the dependency. Next step: focused retry.';
    const result = receiptResult(text);
    result.meta.terminationReason = terminationReason;
    const { output, returned } = await collect(stream([
      { type: 'text_delta', text: 'Working on the draft.' },
      { type: 'done', result },
    ]));
    expect(output.filter(e => e.type === 'error')).toEqual([{
      type: 'error', text, failureKind: 'runtime', failureCode: terminationReason, failurePhase: 'tool',
    }]);
    expect(output.some(e => e.type === 'final')).toBe(false);
    expect(returned).toEqual({ finalText: text, error: text });
    expect(output.find(e => e.event?.stream === 'usage')?.event?.data).toMatchObject(result.meta.usage);
  });

  it.each([
    '<agent-result status="partial">Stopped after reaching the tool call limit (1/1).</agent-result>',
    '<agent-result status="failure">20 consecutive read/search calls</agent-result>',
    'A quoted report says tool_call_limit and read_only_limit; the current task succeeded.',
  ])('never promotes assistant prose to runtime authority: %s', async text => {
    const { output, returned } = await collect(stream([{ type: 'done', result: receiptResult(text) }]));
    expect(output.filter(e => e.type === 'error')).toEqual([]);
    expect(output).toContainEqual({ type: 'final', text });
    expect(returned).toEqual({ finalText: text, error: null });
  });

  it('does not infer terminal failure from a tool error that later recovered', async () => {
    const { output } = await collect(stream([
      { type: 'tool_end', id: 'old', name: 'read_file', result: 'guard receipt', isError: true, errorCode: 'E_TOOL_CALL_LIMIT' },
      { type: 'done', result: receiptResult('Recovered answer.') },
    ]));
    expect(output).toContainEqual({ type: 'final', text: 'Recovered answer.' });
    expect(output.some(e => e.type === 'error')).toBe(false);
  });

  it.each([
    ['provider_error', 'PROVIDER_NETWORK_EXHAUSTED', 'provider_network', 'model_text'],
    ['auth', 'PROVIDER_AUTH_EXHAUSTED', 'provider_auth', 'model_text'],
    ['context_overflow', 'CONTEXT_OVERFLOW', 'context_overflow', 'compaction'],
  ] as const)('preserves %s failure precedence and streamed partial text', async (kind, code, failureCode, failurePhase) => {
    const result = receiptResult('Core partial receipt');
    result.meta.terminationReason = 'tool_call_limit';
    result.meta.error = { kind, code, message: 'Existing provider failure' };
    const { output, returned } = await collect(stream([
      { type: 'text_delta', text: 'Saved draft before provider failure.' }, { type: 'done', result },
    ]));
    expect(output.filter(e => e.type === 'error')).toEqual([{
      type: 'error', text: 'Existing provider failure', failureKind: 'model', failureCode, failurePhase,
    }]);
    expect(returned.finalText).toBe('Saved draft before provider failure.');
  });

  it.each(['tool_call_limit', 'read_only_limit'] as const)('preserves Core %s with only its permitted closure request', async reason => {
    let providerCalls = 0;
    let auxiliaryCalls = 0;
    let executed = 0;
    let coreResult: AgentRunResult | undefined;
    const toolName = reason === 'tool_call_limit' ? 'write_file' : 'bash';
    const provider: LLMProvider = {
      id: 'synthetic', name: 'Synthetic',
      async complete(params) {
        auxiliaryCalls++;
        expect(params.tools).toEqual([]);
        return { content: [{ type: 'text' as const, text: 'Observed progress receipt. Remaining output needs verification; next step: inspect the draft.' }],
          model: 'synthetic', stopReason: 'end_turn' as const, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } };
      },
      async *stream() {
        providerCalls++;
        const content = [{
          type: 'tool_use' as const, id: `call-${providerCalls}`, name: toolName,
          input: reason === 'tool_call_limit' ? { path: 'draft.md' } : { command: `grep -n needle${providerCalls} file.txt` },
        }];
        yield { type: 'message_end' as const, content, model: 'synthetic', stopReason: 'tool_use' as const,
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
      },
      async validateAuth() { return true; },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory('synthetic', () => provider);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'synthetic', defaultModel: 'synthetic', maxRetries: 0, maxToolLoops: 30 } }),
      providers, toolAllowlist: [toolName], tools: [defineTool({
        name: toolName, description: 'Synthetic receipt', inputSchema: { type: 'object' },
        async execute() { executed++; return { content: 'Observed progress receipt' }; },
      })],
    });
    const params = { message: 'Complete the focused task', ...(reason === 'tool_call_limit' ? { maxToolCalls: 1 } : {}) };
    async function* capture() {
      for await (const event of runner.runStream(params)) {
        if (event.type === 'done') coreResult = event.result;
        yield event;
      }
    }
    const { output } = await collect(capture());
    expect(coreResult?.meta).toMatchObject({ terminationReason: reason, stopReason: 'end_turn' });
    expect(coreResult?.meta.error).toBeUndefined();
    expect(coreResult?.text).toContain('Observed progress receipt');
    expect(output.filter(e => e.type === 'error')).toEqual([{
      type: 'error', text: coreResult?.text, failureKind: 'runtime', failureCode: reason, failurePhase: 'tool',
    }]);
    expect(output.some(e => e.type === 'final')).toBe(false);
    expect(providerCalls).toBe(reason === 'tool_call_limit' ? 1 : READ_ONLY_STREAK_HARD);
    expect(executed).toBe(reason === 'tool_call_limit' ? 1 : READ_ONLY_STREAK_HARD - 1);
    expect(auxiliaryCalls).toBe(reason === 'tool_call_limit' ? 1 : 0);
  });
});
