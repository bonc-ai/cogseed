import { describe, expect, it } from "vitest";
import { AgentRunner, READ_ONLY_STREAK_HARD, READ_ONLY_STREAK_WARN } from "../src/agent/runner.js";
import { Session } from "../src/agent/session.js";
import type { AgentRunEvent, AgentRunParams } from "../src/agent/types.js";
import { createConfig } from "../src/config/loader.js";
import type { CompletionParams, CompletionResult, LLMProvider } from "../src/providers/base.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { defineTool } from "../src/tools/base.js";
import { ContextOverflowError } from "../src/shared/errors.js";
import type { ToolResult } from "../src/tools/base.js";
import type { CoreAgentConfig } from "../src/config/schema.js";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const terminal = (): CompletionResult => ({
  content: [{ type: "text", text: "Finished." }], stopReason: "end_turn", usage, model: "synthetic",
});
const calls = (...items: Array<[string, Record<string, unknown>?]>): CompletionResult => ({
  content: items.map(([name, input], i) => ({ type: "tool_use", id: `call-${i}`, name, input: input ?? {} })),
  stopReason: "tool_use", usage, model: "synthetic",
});

// Only the provider transport and tool implementations are synthetic. All
// runner batching, preflight, protocol persistence and convergence are real.
function harness(responses: CompletionResult[], options: {
  session?: Session;
  beforeToolExecute?: ConstructorParameters<typeof AgentRunner>[0]["beforeToolExecute"];
  afterToolExecute?: ConstructorParameters<typeof AgentRunner>[0]["afterToolExecute"];
  execute?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  maxToolLoops?: number;
  beforeRequest?: (params: CompletionParams, requestNumber: number) => void;
  catalog?: CoreAgentConfig['models']['catalog'];
  summarize?: (params: CompletionParams) => Promise<CompletionResult>;
} = {}) {
  const requests: CompletionParams[] = [];
  const auxiliaryRequests: CompletionParams[] = [];
  const executed: string[] = [];
  let index = 0;
  const provider: LLMProvider = {
    id: "synthetic", name: "Synthetic",
    async complete(params) {
      auxiliaryRequests.push(params);
      if (options.summarize) return options.summarize(params);
      throw new Error("Synthetic summary unavailable");
    },
    async *stream(params) {
      requests.push(params);
      options.beforeRequest?.(params, requests.length);
      const original = responses[index++] ?? terminal();
      const response = { ...original, content: original.content.map((c) => c.type === "tool_use" ? { ...c, id: `${index}-${c.id}` } : c) };
      yield { type: "message_start" as const };
      for (const c of response.content) {
        if (c.type === "text") yield { type: "text_delta" as const, text: c.text };
        if (c.type === "tool_use") {
          yield { type: "tool_use_start" as const, id: c.id, name: c.name };
          yield { type: "tool_use_delta" as const, id: c.id, input: JSON.stringify(c.input) };
          yield { type: "tool_use_end" as const, id: c.id };
        }
      }
      yield { type: "message_end" as const, ...response };
    },
    async validateAuth() { return true; },
  };
  const providers = new ProviderRegistry();
  providers.registerFactory("synthetic", () => provider);
  const session = options.session ?? new Session();
  const tools = ["read_file", "write_file", "bash"].map((name) => defineTool({
    name, description: name, inputSchema: { type: "object" },
    ...(name === "read_file" ? { executionMode: "parallel" as const } : {}),
    async execute(input) {
      executed.push(`${name}:${input.key ?? input.command ?? ""}`);
      return options.execute?.(name, input) ?? { content: `${name} receipt ${input.key ?? ""}` };
    },
  }));
  const runner = new AgentRunner({
    config: createConfig({ models: { catalog: options.catalog ?? {} }, agent: {
      defaultProvider: "synthetic", defaultModel: "synthetic", maxRetries: 0,
      maxToolLoops: options.maxToolLoops ?? 60,
    } }),
    providers, session, tools, toolAllowlist: ["read_file", "write_file", "bash", "manage_execution_plan"],
    beforeToolExecute: options.beforeToolExecute,
    afterToolExecute: options.afterToolExecute,
  });
  async function run(params: Partial<AgentRunParams> = {}) {
    const events: AgentRunEvent[] = [];
    for await (const event of runner.runStream({ message: "Do the focused work", ...params })) events.push(event);
    const done = events.findLast((e) => e.type === "done");
    if (!done || done.type !== "done") throw new Error("Missing done");
    return { result: done.result, events };
  }
  return { runner, session, requests, auxiliaryRequests, executed, run };
}

function persistedResults(session: Session) {
  return session.getMessages().flatMap((m) => m.content.filter((c) => c.type === "tool_result"));
}

describe('provider execution-state prefix', () => {
  it('admits optional context against a smaller fallback allowance before dispatch', async () => {
    const h = harness([calls(['read_file', { key: 1 }]), terminal()], { catalog: {
      synthetic: { provider: 'synthetic', model: 'synthetic', contextWindow: 128_000, maxOutputTokens: 1_024 },
      fallback: { provider: 'synthetic', model: 'fallback', contextWindow: 4_096, maxOutputTokens: 2_048 },
    } });
    await h.run();
    expect(JSON.stringify(h.requests[1].messages)).not.toContain('Host execution state snapshot');
    expect(JSON.stringify(h.requests[1].messages)).toContain('Execution plan anchor');
  });

  it('sheds optional snapshots once on overflow without replaying tools or legacy compaction', async () => {
    const h = harness([calls(['read_file', { key: 1 }]), terminal()], {
      beforeRequest: (_params, requestNumber) => {
        if (requestNumber === 2) throw new ContextOverflowError('synthetic input estimate mismatch');
      },
    });
    const { result } = await h.run();
    expect(result.meta.error).toBeUndefined();
    expect(h.requests).toHaveLength(3);
    expect(h.executed).toEqual(['read_file:1']);
    expect(JSON.stringify(h.requests[2].messages)).not.toContain('Host execution state snapshot');
    expect(JSON.stringify(h.requests[2].messages)).toContain('Completed work ledger');
    expect(h.auxiliaryRequests).toHaveLength(0);
  });

  it('terminates if the canonical retry also overflows', async () => {
    const h = harness([calls(['read_file', { key: 1 }]), terminal()], {
      beforeRequest: (_params, requestNumber) => {
        if (requestNumber >= 2) throw new ContextOverflowError('synthetic canonical overflow');
      },
    });
    const { result } = await h.run();
    expect(result.meta.error?.kind).toBe('context_overflow');
    expect(h.requests).toHaveLength(3);
    expect(h.executed).toEqual(['read_file:1']);
    expect(h.auxiliaryRequests).toHaveLength(0);
  });

  it('appends ready tool rounds and updated state without rewriting prior provider messages', async () => {
    const h = harness([calls(['read_file', { key: 1 }]), calls(['read_file', { key: 2 }]), terminal()]);
    await h.run({ turnEphemeral: 'PRIVATE_RUNTIME_CONTEXT' });
    expect(h.requests).toHaveLength(3);
    for (let i = 1; i < h.requests.length; i++) {
      const previous = h.requests[i - 1].messages;
      expect(h.requests[i].messages.slice(0, previous.length)).toEqual(previous);
    }
    const current = JSON.stringify(h.requests[2].messages);
    expect(current).toContain('read_file receipt 2');
    expect(current).toContain('Completed work ledger');
    expect(JSON.stringify(h.session.getMessages())).not.toContain('PRIVATE_RUNTIME_CONTEXT');
    expect(JSON.stringify(h.session.getMessagesForSummary())).not.toContain('PRIVATE_RUNTIME_CONTEXT');
    expect(JSON.stringify(h.session.getSerializedContextState())).not.toContain('execution state snapshot');
  });
});

describe("hard actual tool-call budget", () => {
  it("allows one tool-free closure after the exact cap and accounts for its usage", async () => {
    const signal = new AbortController().signal;
    const summaryUsage = { inputTokens: 3, outputTokens: 4, totalTokens: 14, totalInputTokens: 10, cacheReadTokens: 7 };
    const initial = { ...calls(['write_file', { key: 1 }], ['write_file', { key: 2 }]),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 25, totalInputTokens: 20, cacheReadTokens: 10 } };
    const text = '已完成：两个文件已写入。未完成：未读回验证。下一步：核对交付物。';
    const h = harness([initial], { summarize: async () => ({ ...terminal(), content: [{ type: 'text', text }], usage: summaryUsage, reportedModel: 'summary-endpoint' }) });
    const { result, events } = await h.run({ maxToolCalls: 2, signal, cacheRetention: 'short',
      requestMetadata: { trace: 'closure-test' }, turnEphemeral: 'PRIVATE_RUNTIME_CONTEXT' });
    expect(h.executed).toEqual(['write_file:1', 'write_file:2']);
    expect(h.requests).toHaveLength(1);
    expect(h.auxiliaryRequests).toHaveLength(1);
    const request = h.auxiliaryRequests[0];
    expect(request).toMatchObject({ tools: [], maxTokens: 1200, signal, cacheRetention: 'short',
      sessionId: h.session.getSessionId(), requestMetadata: { trace: 'closure-test' } });
    expect(JSON.stringify(request.messages)).toContain('write_file receipt 2');
    expect(JSON.stringify(request.messages)).toContain('tool call limit (2/2)');
    expect(result.text).toContain(text);
    expect(result.text).toContain('tool call limit (2/2)');
    expect(result.meta).toMatchObject({ terminationReason: 'tool_call_limit', reportedModel: 'summary-endpoint',
      lastCallUsage: summaryUsage, usage: { inputTokens: 13, outputTokens: 9, totalInputTokens: 30, cacheReadTokens: 17 } });
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toContain(text);
    const persisted = JSON.stringify(h.session.getMessages());
    expect(persisted).not.toContain('Internal execution control');
    expect(persisted).not.toContain('PRIVATE_RUNTIME_CONTEXT');
    expect(h.session.getMessages().at(-1)?.content).toEqual([{ type: 'text', text: result.text }]);
  });

  it.each(['empty', 'tool_use', 'hidden_tool', 'max_tokens', 'provider_error'] as const)(
    'falls back once on %s closure without running extra tools', async shape => {
      const h = harness([calls(['read_file', { key: 1 }], ['write_file', { key: 'skipped' }])], {
        summarize: async () => {
          if (shape === 'provider_error') throw new Error('synthetic closure outage');
          return { ...terminal(), content: shape === 'empty' ? [] : [
            { type: 'text', text: 'UNTRUSTED_SUMMARY' },
            ...(shape === 'tool_use' || shape === 'hidden_tool' ? [{ type: 'tool_use' as const, id: 'late', name: 'bash', input: {} }] : []),
          ], stopReason: shape === 'tool_use' ? 'tool_use' : shape === 'max_tokens' ? 'max_tokens' : 'end_turn' };
        },
      });
      const { result } = await h.run({ maxToolCalls: 1 });
      expect(h.executed).toEqual(['read_file:1']);
      expect(h.requests).toHaveLength(1);
      expect(h.auxiliaryRequests).toHaveLength(1);
      expect(h.auxiliaryRequests[0].tools).toEqual([]);
      expect(result.meta.terminationReason).toBe('tool_call_limit');
      expect(result.text).toContain('read_file receipt 1');
      expect(result.text).toContain('Skipped proposed tool(s): write_file');
      expect(result.text).not.toContain('UNTRUSTED_SUMMARY');
      expect(persistedResults(h.session)).toHaveLength(2);
      if (shape !== 'provider_error') expect(result.meta.usage.outputTokens).toBe(10);
    },
  );

  it('permits closure at zero budget while never entering a tool', async () => {
    const h = harness([calls(['write_file'])], { summarize: async () => terminal() });
    const { result } = await h.run({ maxToolCalls: 0 });
    expect(h.executed).toEqual([]);
    expect(h.auxiliaryRequests).toHaveLength(1);
    expect(result.meta.terminationReason).toBe('tool_call_limit');
    expect(result.meta.toolNames).toEqual([]);
  });

  it.each(['before', 'during'] as const)('cancellation %s closure wins over the budget receipt', async timing => {
    const controller = new AbortController();
    const h = harness([calls(['write_file'])], {
      execute: async () => {
        if (timing === 'before') controller.abort();
        return { content: 'observed write' };
      },
      summarize: async () => {
        controller.abort();
        // Deliberately ignore the signal and return late success.
        return { ...terminal(), usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
      },
    });
    const { result } = await h.run({ maxToolCalls: 1, signal: controller.signal });
    expect(h.executed).toHaveLength(1);
    expect(h.auxiliaryRequests).toHaveLength(timing === 'before' ? 0 : 1);
    expect(result.meta.aborted).toBe(true);
    expect(result.meta.terminationReason).toBeUndefined();
    expect(result.text).not.toContain('Finished.');
    expect(result.meta.usage).toMatchObject(timing === 'during'
      ? { inputTokens: 13, outputTokens: 9, totalTokens: 22 }
      : { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.meta.lastCallUsage).toMatchObject(timing === 'during'
      ? { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
      : { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("caps a parallel batch, pairs every call with a result, and falls back after one closure attempt", async () => {
    const h = harness([calls(["read_file", { key: 1 }], ["read_file", { key: 2 }], ["read_file", { key: 3 }])]);
    const { result, events } = await h.run({ maxToolCalls: 2 });
    expect(h.executed).toEqual(["read_file:1", "read_file:2"]);
    expect(persistedResults(h.session)).toHaveLength(3);
    expect(h.session.getCompletedWorkLedger().map((e) => e.status)).toEqual(["succeeded", "succeeded", "skipped"]);
    expect(events.filter((e) => e.type === "tool_end")).toHaveLength(3);
    expect(result.text).toContain("tool call limit (2/2)");
    expect(result.meta.terminationReason).toBe("tool_call_limit");
    expect(result.text).toContain("read_file receipt 2");
    expect(result.text).toContain("Next step:");
    expect(result.meta.toolNames).toEqual(["read_file"]);
    expect(result.meta.permanentToolErrors).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    expect(h.auxiliaryRequests).toHaveLength(1);
  });

  it("shares the budget across rounds and sequential barriers, including zero", async () => {
    for (const limit of [0, 1, 3, 5]) {
      const h = harness([
        calls(["read_file", { key: 1 }], ["write_file", { key: 2 }]),
        calls(["read_file", { key: 3 }], ["read_file", { key: 4 }], ["bash", { key: 5 }], ["write_file", { key: 6 }]),
      ]);
      const { result } = await h.run({ maxToolCalls: limit });
      expect(h.executed).toHaveLength(limit);
      expect(result.text).toContain(`tool call limit (${limit}/${limit})`);
      expect(persistedResults(h.session)).toHaveLength(limit <= 2 ? 2 : 6);
      if (limit === 0) expect(result.meta.toolNames).toEqual([]);
    }
  });

  it("does not spend budget on unknown, denied, or historical-placeholder calls", async () => {
    const h = harness([calls(
      ["missing"], ["write_file", { key: "denied" }],
      ["read_file", { key: "placeholder", __cogseed_context_note: "old" }],
      ["write_file", { key: "actual" }], ["bash", { key: "excess" }],
    )], { beforeToolExecute: (_name, input) => input.key === "denied" ? { content: "Denied", isError: true } : undefined });
    const { result } = await h.run({ maxToolCalls: 1 });
    expect(h.executed).toEqual(["write_file:actual"]);
    expect(result.meta.toolNames).toEqual(["write_file"]);
    expect(persistedResults(h.session)).toHaveLength(5);
    expect(h.session.getCompletedWorkLedger().at(-1)?.status).toBe("skipped");
  });

  it("counts failed executions and retains their diagnostic boundary", async () => {
    const h = harness([calls(["write_file"], ["bash"])], {
      async execute() { throw new Error("synthetic write failure"); },
    });
    const { result } = await h.run({ maxToolCalls: 1 });
    expect(h.executed).toEqual(["write_file:"]);
    expect(result.text).toContain("synthetic write failure");
    expect((result.meta.permanentToolErrors ?? 0) + (result.meta.transientToolErrors ?? 0)).toBe(1);
  });

  it("bounds queued parallel work after async preflights and preserves image/result order", async () => {
    const h = harness([calls(...Array.from({ length: 12 }, (_, key): [string, Record<string, unknown>] => ["read_file", { key }]))], {
      async beforeToolExecute(_name, input) {
        await Promise.resolve();
        if (input.key === 0) return { content: "Denied", isError: true };
      },
      async execute() { return { content: "image receipt", images: [{ data: "fake", mediaType: "image/png" }] }; },
    });
    await h.run({ maxToolCalls: 9 });
    expect(h.executed).toHaveLength(9);
    const messages = h.session.getMessages();
    expect(persistedResults(h.session)).toHaveLength(12);
    const firstImage = messages.findIndex((m) => m.content.some((c) => c.type === "image"));
    const lastResult = messages.findLastIndex((m) => m.content.some((c) => c.type === "tool_result"));
    expect(firstImage).toBeGreaterThan(lastResult);
    expect(h.auxiliaryRequests).toHaveLength(1);
  });

  it("leaves uncapped execution and terminal tools unchanged; resets budget per run", async () => {
    const h = harness([calls(["write_file", { key: 1 }], ["bash", { key: 2 }]), terminal()]);
    expect((await h.run()).result.text).toBe("Finished.");
    expect(h.executed).toHaveLength(2);
    const end = harness([calls(["write_file"], ["bash"])], { async execute() { return { content: "handoff", endTurn: true }; } });
    const terminalResult = await end.run({ maxToolCalls: 1 });
    expect(end.executed).toHaveLength(1);
    expect(end.requests).toHaveLength(1);
    expect(end.auxiliaryRequests).toHaveLength(0);
    expect(terminalResult.result.meta.terminationReason).toBeUndefined();
    const reset = harness([calls(["write_file", { key: 1 }]), calls(["write_file", { key: 2 }])]);
    await reset.run({ maxToolCalls: 1 });
    await reset.run({ maxToolCalls: 1 });
    expect(reset.executed).toEqual(["write_file:1", "write_file:2"]);
  });
});

describe("per-run plan instruction suppression", () => {
  it("keeps convergence guidance without asking for plan updates", async () => {
    const h = harness([calls(["write_file", { key: 1 }]), calls(["write_file", { key: 2 }]), terminal()], { maxToolLoops: 3 });
    await h.run({ suppressExecutionPlanInstructions: true });
    const request = JSON.stringify(h.requests[2].messages);
    expect(request).toContain("approaching the tool loop round limit");
    expect(request).not.toContain("update the execution plan");
  });

  it("omits anchors and premature terminal nudges while retaining saved plan, history, and work ledger", async () => {
    const session = new Session();
    session.beginUserTurn([{ type: "text", text: "Original objective" }]);
    session.updateExecutionPlan({ steps: [{ step: "Unfinished milestone", status: "pending" }] });
    session.addAssistantMessage([{ type: "text", text: "Durable previous answer" }]);
    session.completeActiveTurn();
    const saved = session.getExecutionPlan();
    const h = harness([calls(["write_file", { key: "new work" }]), terminal(), terminal()], { session });
    await h.run({ suppressExecutionPlanInstructions: true });
    expect(h.requests).toHaveLength(2);
    const projected = JSON.stringify(h.requests[1].messages);
    expect(projected).not.toContain("Execution plan anchor");
    expect(projected).not.toContain("premature completion");
    expect(projected).toContain("Durable previous answer");
    expect(projected).toContain("Completed work ledger");
    expect(session.getExecutionPlan()).toEqual(saved);
    await h.run();
    expect(JSON.stringify(h.requests[2].messages)).toContain("Execution plan anchor");
    expect(JSON.stringify(h.requests[3].messages)).toContain("premature completion");
  });
});

const readCommand = (i: number) => [
  `grep -n 'needle${i}' file.txt`, `sed -n '${i + 1},${i + 2}p' file.txt`,
  `cat -n file${i}.txt`, `rg -n --glob '*.ts' 'needle${i}' src`,
  `cat file${i}.txt | grep -n needle | sed -n '1,5p'`,
][i % 5];

describe("conservative shell read streak", () => {
  it("warns and stops varied shell reads mixed with native reads", async () => {
    const h = harness(Array.from({ length: READ_ONLY_STREAK_HARD + 2 }, (_, i) => i % 6 === 0
      ? calls(["read_file", { key: i }]) : calls(["bash", { command: readCommand(i) }])));
    const { result } = await h.run();
    expect(h.executed).toHaveLength(READ_ONLY_STREAK_HARD - 1);
    expect(JSON.stringify(h.requests[READ_ONLY_STREAK_WARN].messages)).toContain("consecutive read/search calls");
    expect(result.text).toContain("consecutive read/search calls");
    expect(persistedResults(h.session)).toHaveLength(READ_ONLY_STREAK_HARD);
    expect(h.session.getCompletedWorkLedger().at(-1)?.status).toBe("skipped");
    expect(h.auxiliaryRequests).toHaveLength(0);
  });

  it.each([
    "sed -i 's/a/b/' file", "sed -n '1w output' file", "sed -n '1e' file", "sed 's/a/b/e' file",
    "rg --pre=touch needle file", "rg --hostname-bin touch needle file", "rg --search-zip needle file", "rg -z needle file",
    "cat file > output", "grep needle file; touch output", "cat $(touch output)",
    'cat "`touch output`"', "cat file && rm other", "unknown file", "cat file | tee output",
  ])("treats an unknown or potentially mutating command as a streak barrier: %s", async (command) => {
    const reads = Array.from({ length: 11 }, (_, i) => calls(["bash", { command: readCommand(i) }]));
    const h = harness([...reads, calls(["bash", { command }]), ...reads, terminal()]);
    expect((await h.run()).result.text).toBe("Finished.");
    expect(h.executed).toHaveLength(23);
    expect(JSON.stringify(h.requests)).not.toContain("consecutive read/search calls");
  });
});


describe("normalized tool completion policy boundaries", () => {
  it.each([false, true])("settles a parallel batch when the completion policy throws (tool also throws=%s)", async toolThrows => {
    const h = harness([calls(["read_file", { key: "first" }], ["read_file", { key: "second" }], ["write_file"])], {
      async execute(name) {
        if (toolThrows && name === "read_file") throw new Error("original tool failure");
        return { content: "completed" };
      },
      afterToolExecute(tool, _input, result) {
        if (tool.name === "read_file") throw new Error("completion policy failed");
        return result;
      },
    });
    const outcome = await Promise.race([h.run(), new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(outcome, "completion errors must settle and pair every declared result").not.toBeNull();
    expect(persistedResults(h.session)).toHaveLength(3);
    expect(outcome!.events.filter(e => e.type === "tool_end" && e.errorCode === "tool_result_processing_exception")).toHaveLength(2);
  });
  it("observes only actual admitted executions under exact budgets", async () => {
    const observed: string[] = [];
    const h = harness([calls(
      ["unknown"],
      ["read_file", { key: "denied" }],
      ["read_file", { key: "[old tool input string compacted: invalid]" }],
      ["read_file", { key: "first" }],
      ["read_file", { key: "second" }],
      ["write_file", { key: "over-budget" }],
    )], {
      beforeToolExecute: (_name, input) => input.key === "denied" ? { content: "Denied", isError: true } : undefined,
      afterToolExecute(tool, input, result) {
        observed.push(`${tool.name}:${input.key}`);
        return result;
      },
    });
    const { result } = await h.run({ maxToolCalls: 2 });
    expect(h.executed).toEqual(["read_file:first", "read_file:second"]);
    expect(observed.sort()).toEqual(["read_file:first", "read_file:second"]);
    expect(result.meta.terminationReason).toBe("tool_call_limit");
    expect(persistedResults(h.session)).toHaveLength(6);
  });

  it.each(["resolve", "reject", "late"] as const)("excludes cancelled %s completions from observation", async completion => {
    const controller = new AbortController();
    const observations: ToolResult[] = [];
    let settle: (() => void) | undefined;
    const h = harness([calls(["write_file"])], {
      async execute() {
        controller.abort();
        if (completion === "late") await new Promise<void>(resolve => { settle = resolve; });
        if (completion === "reject") throw new Error("Invalid cancelled operation");
        return { content: "Invalid cancelled operation", isError: true };
      },
      afterToolExecute(_tool, _input, result) {
        observations.push(result);
        return result;
      },
    });
    const { result } = await h.run({ signal: controller.signal });
    expect(result.meta.aborted).toBe(true);
    settle?.();
    // Drain the late implementation's promise reactions without a timer.
    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toEqual([]);
    expect(persistedResults(h.session)).toHaveLength(1);
  });
});
