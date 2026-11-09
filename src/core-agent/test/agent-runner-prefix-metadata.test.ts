import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../src/agent/runner.js';
import { Session } from '../src/agent/session.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ContextOverflowError } from '../src/shared/errors.js';
import type { CompletionParams, LLMProvider } from '../src/providers/base.js';
import type { Message, StreamEvent, Usage } from '../src/shared/types.js';
import { defineTool } from '../src/tools/base.js';

// These runner fixtures register their own provider. Keep SDK transports out
// of this contract test; real wire parsing has separate provider fixtures.
vi.mock('../src/providers/pi-provider.js', () => ({
  createPiProvider() { throw new Error('Unexpected real provider'); },
  createAnthropicProvider() { throw new Error('Unexpected real provider'); },
  createOpenAIProvider() { throw new Error('Unexpected real provider'); },
  listPiProviders() { return []; },
}));

const text = (value: string): Message['content'] => [{ type: 'text', text: value }];
const json = (value: unknown) => JSON.stringify(value);
const usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, totalInputTokens: 120, cacheReadTokens: 100 };
const done = (extra: Partial<Extract<StreamEvent, { type: 'message_end' }>> = {}): StreamEvent => ({
  type: 'message_end', stopReason: 'end_turn', content: text('Finished'), ...extra,
});
const receipt = defineTool({
  name: 'receipt', description: 'Synthetic receipt', inputSchema: { type: 'object' },
  executionMode: 'parallel',
  async execute() { return { content: 'tool evidence from receipt' }; },
});

async function withPersistentSession(check: (session: PersistentSession, file: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreground-heal-'));
  const file = path.join(dir, 'session.jsonl');
  try { await check(new PersistentSession({ sessionFile: file }), file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('persistent foreground after the host finally heal', () => {
  it('keeps final request bytes across repeated parallel-result normalization, with no ephemeral disk state', async () => {
    await withPersistentSession(async (session, file) => {
      const responses = Array.from({ length: 3 }, (_, turn) => [
        [done({ stopReason: 'tool_use', content: [
          { type: 'tool_use', id: `${turn}-a`, name: 'receipt', input: {} },
          { type: 'tool_use', id: `${turn}-b`, name: 'receipt', input: {} },
        ] })],
        [done()],
      ]).flat();
      const { runner, requests, config, providers } = setup(responses, session);
      let previous: Message[] = [];
      for (let turn = 0; turn < 3; turn++) {
        // The host constructs a new runner but reuses its cached PersistentSession.
        const current = turn === 0 ? runner : new AgentRunner({
          config, providers, session, tools: [receipt], toolAllowlist: ['receipt'],
        });
        const result = await current.run({ message: `User turn ${turn}`, turnEphemeral: `private-host-${turn}` });
        expect(result.meta.error).toBeUndefined();
        if (turn > 0) expect(requests[turn * 2].messages.slice(0, previous.length)).toStrictEqual(previous);
        previous = [...requests[turn * 2 + 1].messages, { role: 'assistant', content: text('Finished') }];
        session.addHistoryResource({ kind: 'final_output', path: `output-${turn}.md` });
        const disk = fs.readFileSync(file, 'utf8');
        const rawLength = session.length;
        expect(session.healAndPersist()).toBe(true);
        expect(session.length).toBe(rawLength - 1);
        expect(session.getLastToolProtocolRepairReport()).toMatchObject({
          mergedParallelResultMessages: 1, deduplicatedResults: 0,
          synthesizedOrphanResults: 0, droppedUnmatchedResults: 0,
        });
        expect(session.healAndPersist()).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toBe(disk);
        const persisted = disk + fs.readFileSync(`${file}.context.json`, 'utf8');
        expect(persisted).not.toContain('private-host-');
        expect(persisted).not.toContain('Host execution state snapshot');
        expect(persisted).not.toContain('foreground');
      }
      const reloaded = new PersistentSession({ sessionFile: file });
      expect(json(reloaded.getMessagesForModel())).not.toContain('private-host-');
    });
  });

  it.each(['orphan', 'dedup', 'reorder', 'unmatched', 'mutated-result'])('still invalidates foreground for %s repair', async (repair) => {
    await withPersistentSession(async (session) => {
      session.beginUserTurn(text('User request'));
      session.addAssistantMessage([
        { type: 'tool_use', id: 'a', name: 'receipt', input: {} },
        { type: 'tool_use', id: 'b', name: 'receipt', input: {} },
      ]);
      const ids = repair === 'orphan' ? ['a']
        : repair === 'dedup' ? ['a', 'b', 'a']
          : repair === 'reorder' ? ['b', 'a']
            : repair === 'unmatched' ? ['a', 'b', 'stray'] : ['a', 'b'];
      for (const id of ids) session.addToolResult(id, `result-${id}`);
      const projection = { scopeKey: 'persistent-scope', maxMessageTokens: 40_000 };
      const request = session.getForegroundMessagesForModel({ ...projection, turnContext: 'private-before-repair' });
      session.addAssistantMessage(text('Finished'));
      expect(session.recordForegroundTurn({ ...projection, messages: [...request, { role: 'assistant', content: text('Finished') }] })).toBe(true);
      session.completeActiveTurn();
      if (repair === 'mutated-result') {
        const result = session.getMessages()[2].content[0];
        if (result.type === 'tool_result') result.content = 'changed after foreground capture';
      }
      expect(session.healAndPersist()).toBe(true);
      session.beginUserTurn(text('Next request'));
      expect(json(session.getForegroundMessagesForModel(projection))).not.toContain('private-before-repair');
    });
  });
});
function setup(responses: Array<StreamEvent[] | Error>, session = new Session(), maxToolLoops = 100) {
  const requests: CompletionParams[] = [];
  let round = 0;
  const provider: LLMProvider = {
    id: 'foreground-fixture', name: 'Foreground fixture',
    async complete() { return { content: text('Auxiliary synthesis'), stopReason: 'end_turn', usage, model: 'auxiliary-alias', reportedModel: 'auxiliary-reported' }; },
    async *stream(params) {
      requests.push(structuredClone({ ...params, signal: undefined }));
      const response = responses[round++];
      if (response instanceof Error) throw response;
      if (!response) throw new Error('unexpected request');
      yield* response;
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory(provider.id, () => provider);
  const config = createConfig({
    agent: { defaultProvider: provider.id, defaultModel: 'routing-alias', maxRetries: 0, maxToolLoops },
    evolution: { enabled: false },
  });
  const runner = new AgentRunner({ config, providers, session, tools: [receipt], toolAllowlist: ['receipt'] });
  return { runner, requests, config, providers, session };
}
const tool = (id: string, reportedModel?: string): StreamEvent => done({
  stopReason: 'tool_use', usage, reportedModel,
  content: [{ type: 'tool_use', id, name: 'receipt', input: {} }],
});

describe('runner foreground continuity', () => {
  it('preserves actual final requests and responses across two completed turns including ephemeral and host snapshots', async () => {
    const { runner, requests, session } = setup([[tool('one')], [done({ usage })], [done({ usage })], [done({ usage })]]);
    await runner.run({ message: 'First', turnEphemeral: 'host turn one', systemPrompt: 'stable rules' });
    const terminalPrefix = [...requests[1].messages, { role: 'assistant', content: text('Finished') }];
    session.addHistoryResource({ kind: 'final_output', path: 'output-one.md' });
    await runner.run({ message: 'Second', turnEphemeral: 'host turn two', systemPrompt: 'stable rules' });
    expect(requests[2].messages.slice(0, terminalPrefix.length)).toStrictEqual(terminalPrefix);
    expect(json(requests[2].messages)).toContain('tool evidence from receipt');
    expect(json(requests[2].messages)).toContain('output-one.md');
    expect(json(requests[2].messages.at(-1))).toMatch(/supersed/i);
    const secondPrefix = [...requests[2].messages, { role: 'assistant', content: text('Finished') }];
    session.addHistoryResource({ kind: 'final_output', path: 'output-two.md' });
    await runner.run({ message: 'Third', turnEphemeral: 'host turn three', systemPrompt: 'stable rules' });
    expect(requests[3].messages.slice(0, secondPrefix.length)).toStrictEqual(secondPrefix);
    expect(json(requests[3].messages.at(-1))).toContain('output-two.md');
    expect(json(session.getMessages())).not.toContain('host turn one');
    expect(json(session.getMessagesForSummary())).not.toContain('host turn one');
  });

  it.each(['system', 'scope', 'suppression', 'tools', 'metadata'])('discards retained foreground after changing %s', async (change) => {
    const { runner, requests, session, config, providers } = setup([[done()], [done()]]);
    await runner.run({ message: 'First', turnEphemeral: 'previous-private-host-context', systemPrompt: 'system one', workingDir: '/scope-one' });
    const next = change === 'tools'
      ? new AgentRunner({ config, providers, session, disableTools: true }) : runner;
    await next.run({
      message: 'Second',
      systemPrompt: change === 'system' ? 'system two' : 'system one',
      workingDir: change === 'scope' ? '/scope-two' : '/scope-one',
      suppressExecutionPlanInstructions: change === 'suppression',
      ...(change === 'metadata' ? { requestMetadata: { visibility: 'restricted' } } : {}),
    });
    expect(json(requests[1].messages)).not.toContain('previous-private-host-context');
  });

  it('retries an optional-prefix overflow once with canonical context and no repeated tool execution', async () => {
    const { runner, requests } = setup([[done()], new ContextOverflowError('context limit'), [done()]]);
    await runner.run({ message: 'First', turnEphemeral: 'previous-ephemeral' });
    const result = await runner.run({ message: 'Second' });
    expect(result.meta.error).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(json(requests[1].messages)).toContain('previous-ephemeral');
    expect(json(requests[2].messages)).not.toContain('previous-ephemeral');
    expect(json(requests[2].messages)).toContain('Second');
  });
});

describe('runner wire totals and response identity', () => {
  it('keeps the requested alias and last foreground reported identity separately', async () => {
    const { runner } = setup([[tool('one', 'first-server')], [done({ usage, model: 'routing-alias', reportedModel: 'last-server' })]]);
    const { meta } = await runner.run({ message: 'Task' });
    expect(meta.model).toBe('routing-alias');
    expect(meta.reportedModel).toBe('last-server');
    expect(meta.usage.totalInputTokens).toBe(240);
    expect(meta.lastCallUsage).toStrictEqual(usage);
    expect(meta.usage).not.toHaveProperty('cacheWriteTokens');
  });

  it('does not carry earlier foreground identity into a successful response that omits it', async () => {
    const { runner } = setup([[tool('one', 'old-server')], [done({ usage })]]);
    expect((await runner.run({ message: 'Task' })).meta).not.toHaveProperty('reportedModel');
  });

  it('does not replace routing identity with an auxiliary synthesis model', async () => {
    const { runner } = setup([[tool('one', 'foreground-server')], [tool('two', 'last-foreground-server')]], new Session(), 1);
    const { meta } = await runner.run({ message: 'Task' });
    expect(meta.model).toBe('routing-alias');
    expect(meta.reportedModel).toBe('last-foreground-server');
  });

  it('keeps totals through errorResult but does not label a new failure with a stale response model', async () => {
    const { runner } = setup([[tool('one', 'old-server')], new Error('new request failed')]);
    const { meta } = await runner.run({ message: 'Task' });
    expect(meta.error).toBeDefined();
    expect(meta.model).toBe('routing-alias');
    expect(meta).not.toHaveProperty('reportedModel');
    expect(meta.usage.totalInputTokens).toBe(120);
    expect(meta.lastCallUsage?.totalInputTokens).toBe(120);
  });

  it.each([0, 120, Number.MAX_SAFE_INTEGER])('preserves a safe wire total without requiring cache buckets: %s', async (totalInputTokens) => {
    const { runner } = setup([[done({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalInputTokens } })]]);
    const { meta } = await runner.run({ message: 'Task' });
    expect(meta.usage.totalInputTokens).toBe(totalInputTokens);
    expect(meta.lastCallUsage?.totalInputTokens).toBe(totalInputTokens);
  });

  it.each([-1, 0.5, NaN, Infinity, '120', Number.MAX_SAFE_INTEGER + 1])('omits malformed prompt totals: %s', async (totalInputTokens) => {
    const { runner } = setup([[done({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalInputTokens } as unknown as Usage })]]);
    const { meta } = await runner.run({ message: 'Task' });
    expect(meta.usage).not.toHaveProperty('totalInputTokens');
    expect(meta.lastCallUsage).not.toHaveProperty('totalInputTokens');
  });
});
