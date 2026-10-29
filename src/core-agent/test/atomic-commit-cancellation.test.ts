import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agent/runner.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { defineTool, type ToolContext, type ToolResult } from '../src/tools/base.js';
import type { CompletionResult, LLMProvider } from '../src/providers/base.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function runnerFor(execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>) {
  const response: CompletionResult = { content: [{ type: 'tool_use', id: 'save-one', name: 'synthetic_save', input: {} }],
    stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'synthetic-model' };
  const provider: LLMProvider = { id: 'synthetic', name: 'Synthetic provider', complete: async () => response,
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'tool_use_start', id: 'save-one', name: 'synthetic_save' };
      yield { type: 'tool_use_delta', id: 'save-one', input: '{}' };
      yield { type: 'tool_use_end', id: 'save-one' };
      yield { type: 'message_end', ...response };
    }, validateAuth: async () => true };
  const providers = new ProviderRegistry();
  providers.registerFactory('synthetic', () => provider);
  return new AgentRunner({ providers, config: createConfig({ agent: { defaultProvider: 'synthetic', defaultModel: 'synthetic-model' } }),
    tools: [defineTool({ name: 'synthetic_save', description: 'Synthetic atomic save', inputSchema: { type: 'object' }, execute })] });
}

describe('atomic commit cancellation', () => {
  it('keeps the real tool receipt after Stop when an irreversible commit has started', async () => {
    const started = deferred<void>(), finish = deferred<void>();
    const receipt = JSON.stringify({ status: 'applied', receiptId: 'synthetic-durable-receipt', version: '2' });
    const runner = runnerFor(async (_input, context) => {
      context.beginAtomicCommit!();
      started.resolve();
      await finish.promise;
      return { content: receipt };
    });
    const controller = new AbortController();
    const events: any[] = [];
    const run = (async () => { for await (const event of runner.runStream({ message: 'save', signal: controller.signal })) events.push(event); })();
    await started.promise;
    controller.abort();
    // Allow the abort race to settle before the already started save finishes.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events.some(event => event.type === 'tool_end')).toBe(false);
    finish.resolve();
    await run;
    expect(events.find(event => event.type === 'tool_end')).toMatchObject({ name: 'synthetic_save', result: receipt });
    const results = runner.getSession().getMessages().flatMap(message => message.content.filter(content => content.type === 'tool_result'));
    expect(results).toEqual([expect.objectContaining({ toolUseId: 'save-one', content: receipt })]);
    expect(results[0]).not.toMatchObject({ isError: true });
  });
  it('still stops an uncommitted tool promptly and rejects its late commit handshake', async () => {
    const entered = deferred<ToolContext>();
    const runner = runnerFor(async (_input, context) => {
      entered.resolve(context);
      return new Promise<ToolResult>(() => {});
    });
    const controller = new AbortController();
    const events: any[] = [];
    const run = (async () => { for await (const event of runner.runStream({ message: 'save', signal: controller.signal })) events.push(event); })();
    const context = await entered.promise;
    controller.abort();
    await run;
    expect(() => context.beginAtomicCommit!()).toThrow();
    expect(events.find(event => event.type === 'tool_end')).toMatchObject({ isError: true, result: 'Tool execution aborted: Run aborted' });
  });
});
