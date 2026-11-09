import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agent/runner.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { LLMProvider } from '../src/providers/base.js';
import type { StreamEvent, Usage } from '../src/shared/types.js';
import { defineTool } from '../src/tools/base.js';
import { messageMetricsLine, foldSessionMetrics } from '../../renderer/modules/conversation-metrics.js';

function setup(usages: Array<Partial<Usage> | undefined>, failAfter = false, toolRounds = true, summaryUsage?: Usage) {
  let round = 0;
  const provider: LLMProvider = {
    id: 'usage-fixture', name: 'Usage fixture',
    async complete() {
      if (summaryUsage === undefined) throw new Error('Unexpected auxiliary request');
      return { content: [{ type: 'text' as const, text: 'Budget summary.' }], stopReason: 'end_turn' as const, usage: summaryUsage };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      if (round >= usages.length) throw new Error('synthetic terminal failure');
      const usage = usages[round++];
      const more = toolRounds && (round < usages.length || failAfter);
      yield {
        type: 'message_end', stopReason: more ? 'tool_use' : 'end_turn', usage,
        content: more
          ? [{ type: 'tool_use', id: `call-${round}`, name: 'receipt', input: { round } }]
          : [{ type: 'text', text: 'Finished.' }],
      };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory(provider.id, () => provider);
  const runner = new AgentRunner({
    config: createConfig({ agent: { defaultProvider: provider.id, defaultModel: 'fixture', maxRetries: 0,
      ...(summaryUsage !== undefined ? { maxToolLoops: 1 } : {}) } }),
    providers,
    tools: [defineTool({ name: 'receipt', description: 'Synthetic receipt', inputSchema: { type: 'object' },
      async execute() { return { content: 'Recorded.' }; },
    })],
  });
  return runner;
}
async function run(usages: Array<Partial<Usage> | undefined>, failAfter = false) {
  return setup(usages, failAfter).run({ message: 'Track usage.' });
}

const bare = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };
const cached = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 30, totalTokens: 155 };
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

describe('runner cache accounting', () => {
  it('sums complete cache usage without changing uncached input; keeps the final call separate', async () => {
    const last = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 70, cacheWriteTokens: 0, totalTokens: 84 };
    const { meta } = await run([cached, last]);
    expect(meta.usage).toStrictEqual({ inputTokens: 30, outputTokens: 9, cacheReadTokens: 170, cacheWriteTokens: 30, totalTokens: 239 });
    expect(meta.lastCallUsage).toStrictEqual(last);
    expect(meta.usage.inputTokens + meta.usage.cacheReadTokens! + meta.usage.cacheWriteTokens!).toBe(230);
    expect(meta.usage.totalTokens - meta.usage.outputTokens).toBe(230);
  });

  it.each([bare, zero, cached])('preserves missing, zero and positive cache counts on successful and failed runs: %j', async (usage) => {
    for (const failAfter of [false, true]) {
      const { meta } = await run([usage], failAfter);
      expect(meta.usage).toStrictEqual(usage);
      expect(meta.lastCallUsage).toStrictEqual(usage);
      expect(Boolean(meta.error)).toBe(failAfter);
    }
  });

  it.each([[bare, cached], [cached, bare]])('does not present partial cache sums as complete totals: %j', async (first, last) => {
    const { meta } = await run([first, last]);
    expect(meta.usage).toStrictEqual({ inputTokens: 40, outputTokens: 10, totalTokens: 180 });
    expect(meta.lastCallUsage).toStrictEqual(last);
  });

  it('tracks cache-read and cache-write completeness independently', async () => {
    const { meta } = await run([{ ...bare, cacheReadTokens: 0 }, { ...cached, cacheReadTokens: 0 }]);
    expect(meta.usage).toStrictEqual({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, totalTokens: 180 });
  });

  it.each([false, true])('does not invent any counters when the stream omits usage, failAfter=%s', async failAfter => {
    const { meta } = await run([undefined], failAfter);
    expect(meta.usage).toStrictEqual({});
    expect(meta.lastCallUsage).toStrictEqual({});
  });

  it('does not report cache observations before any provider response', async () => {
    const { meta } = await run([]);
    expect(meta.usage).toStrictEqual({});
    expect(meta.lastCallUsage).toBeUndefined();
    expect(meta.error).toBeDefined();
  });
});

describe('runner usage presence through cumulative and renderer session metrics', () => {
  const metric = (meta) => ({ startedAt: 0, firstTokenAt: 10, completedAt: 100,
    usage: { ...meta.usage, ...(meta.lastCallUsage !== undefined ? { lastCallUsage: meta.lastCallUsage } : {}) } });
  const opts = { contextWindow: 1000, price: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 } };

  it.each([{}, { outputTokens: 0 }, zero])('uses the loop-limit summary usage as the final call, including unknown and zero: %j', async usage => {
    const { meta } = await setup([cached, cached, cached], false, true, usage).run({ message: 'Stop at the loop budget.' });
    expect(meta.lastCallUsage).toStrictEqual(usage);
    expect(foldSessionMetrics([metric(meta)], opts).ctxText).toBe(usage === zero ? '0/1K·0%' : null);
  });

  it.each([
    [cached, {}, cached], [cached, undefined, cached], [{}, cached, {}], [zero, {}, zero],
  ])('does not resurrect missing counters across tool rounds: %j', async (...usages) => {
    for (const failAfter of [false, true]) {
      const { meta } = await run(usages, failAfter);
      expect(meta.usage).toStrictEqual({});
      expect(meta.lastCallUsage).toStrictEqual(usages.at(-1) ?? {});
      const persisted = JSON.parse(JSON.stringify(metric(meta)));
      const folded = foldSessionMetrics([persisted], opts);
      expect(folded.inText).toBe('—');
      expect(folded.outText).toBe('—');
      expect(folded.cacheHitText).toBeNull();
      expect(folded.costText).toBeNull();
      expect(folded.ctxText).toBe(usages.at(-1) === cached ? '150/1K·15%' : usages.at(-1) === zero ? '0/1K·0%' : null);
    }
  });

  it('keeps reported output zero independently known without inventing input or total', async () => {
    for (const failAfter of [false, true]) {
      const { meta } = await run([cached, { outputTokens: 0 }], failAfter);
      expect(meta.usage).toStrictEqual({ outputTokens: 5 });
      expect(meta.lastCallUsage).toStrictEqual({ outputTokens: 0 });
      expect(messageMetricsLine(metric(meta))).toMatchObject({ inText: '—', outText: '5', cacheHitText: null, inFreshText: null });
      expect(foldSessionMetrics([metric(meta)], opts)).toMatchObject({ ctxText: null, costText: null, cacheHitText: null });
    }
  });

  it('keeps independent user turns separate while session folding preserves unknown totals after JSON persistence', async () => {
    const runner = setup([cached, undefined, { outputTokens: 0 }, zero], false, false);
    const metrics = [];
    for (const expected of [cached, {}, { outputTokens: 0 }, zero]) {
      const { meta } = await runner.run({ message: 'Next user turn.' });
      expect(meta.usage).toStrictEqual(expected);
      expect(meta.lastCallUsage).toStrictEqual(expected);
      metrics.push(JSON.parse(JSON.stringify(metric(meta))));
    }
    expect(runner.getSession().getMessages().filter(message => message.role === 'user')).toHaveLength(4);
    expect(foldSessionMetrics(metrics, opts)).toMatchObject({ inText: '≥150', outText: '≥5', cacheHitText: null, costText: null, ctxText: '0/1K·0%' });
    expect(foldSessionMetrics(metrics.slice(0, 2), opts)).toMatchObject({ ctxText: null, cacheHitText: null, costText: null });
    expect(messageMetricsLine(metrics[1])).toMatchObject({ inText: null, outText: null, titleLines: [] });
    expect(messageMetricsLine(metrics[2])).toMatchObject({ inText: '—', outText: '0', cacheHitText: null });
  });

  it.each([-1, 0.5, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1])('does not leak invalid input/output/total counts into final-call metadata or failed results: %s', async invalid => {
    const usage = { inputTokens: invalid, outputTokens: invalid, totalTokens: invalid } as unknown as Usage;
    for (const failAfter of [false, true]) {
      const { meta } = await run([usage], failAfter);
      expect(meta.usage).toStrictEqual({});
      expect(meta.lastCallUsage).toStrictEqual({});
    }
  });
});

describe('cache count validity in the runner first response', () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, '0', '100', Number.MAX_SAFE_INTEGER + 1])('sanitizes cache counts before final-call usage or first accumulation: %s', async (invalid) => {
    for (const failAfter of [false, true]) {
      const malformed = { ...bare, cacheReadTokens: invalid, cacheWriteTokens: invalid } as unknown as Usage;
      const { meta } = await run([malformed], failAfter);
      expect(meta.usage).toStrictEqual(bare);
      expect(meta.lastCallUsage).toStrictEqual(bare);
    }
  });
});
