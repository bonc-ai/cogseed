import { createHiddenMetadataFilter, stripHiddenMetadata } from '../../../util/hidden-metadata';
import { assembleRuntimePrompt, type AssembledRuntimeContext } from './prompt-assembler';
import { DEFAULT_RUNTIME_KERNEL_CONFIG } from './config';
import { assembleRuntimeContextForPrompt } from './context/importer';
import { loadRuntimeMemorySummary } from './memory/injector';
import type { RuntimeModelAdapter, RuntimeModelToolCall } from './model-adapter';
import type { RuntimeToolRunner } from './tools/runner';
import type { RuntimeToolResult } from './tools/file-tools';
import type { RuntimeKernelEvent, RuntimeKernelRequest } from './types';
import { isRuntimeAborted } from './cancellation';
import { getRuntimeOpenAIToolCatalog } from './tools/catalog';
import { createTranscriptGate } from './transcript-gate';
import { parseTextToolCalls } from './text-tool-calls';
import { appendRuntimeRoundMetric, appendRuntimeToolMetric } from './metrics-store';

export interface RuntimeExecutionLoopDeps {
  modelAdapter: RuntimeModelAdapter;
  toolRunner: RuntimeToolRunner;
  maxToolRounds: number;
  /** Independent read-only calls in one assistant step run in this pool. */
  maxParallelToolCalls?: number;
  /** Outer deadline for one tool call; 0 disables it. */
  toolTimeoutMs?: number;
  /** Max gap between model stream events; 0 disables it. */
  streamIdleTimeoutMs?: number;
  /** Retries for a model round that produced no text and no tool call. */
  maxModelRetries?: number;
  /** In-turn tool-history budget. Past `maxChars`, the oldest results are excerpted. */
  toolHistoryBudget?: { maxChars: number; headChars: number; tailChars: number; keepRecent: number };
  maxPromptContextChars?: number;
  maxMemoryInjectionChars?: number;
  contextAssembler?: (request: RuntimeKernelRequest) => Promise<AssembledRuntimeContext> | AssembledRuntimeContext;
  memoryProvider?: (request: RuntimeKernelRequest) => Promise<string | undefined> | string | undefined;
  memoryExtractor?: (input: { request: RuntimeKernelRequest; finalText: string }) => Promise<void> | void;
}

export interface RuntimeExecutionLoopOptions {
  signal?: AbortSignal | null;
  priorRecords?: import('./session-store').NativeRuntimeTurnRecord[];
  onRecord?: (role: 'user' | 'assistant' | 'tool' | 'system', content: string, tool?: import('./session-store').NativeRuntimeTurnRecord['tool']) => Promise<void> | void;
}

function eventBase(request: RuntimeKernelRequest): Pick<RuntimeKernelEvent, 'requestId' | 'runtimeSessionId'> {
  return { requestId: request.requestId, runtimeSessionId: request.runtimeSessionId };
}

const MODEL_STREAM_IDLE = Symbol('model-stream-idle');

/** A model that stops emitting events must not own the turn. Races one
 * `iterator.next()` against the configured idle gap; a late rejection after
 * the timeout is observed here so it cannot become an unhandled rejection. */
async function nextModelEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | typeof MODEL_STREAM_IDLE> {
  const pending = iterator.next();
  pending.catch(() => {});
  if (timeoutMs <= 0) return pending;
  let timer: NodeJS.Timeout | null = null;
  const idle = new Promise<typeof MODEL_STREAM_IDLE>((resolve) => {
    timer = setTimeout(() => resolve(MODEL_STREAM_IDLE), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Earlier-turn records are replayed into every follow-up prompt. The full text
 * is already on disk (or re-fetchable), so only a bounded head is carried
 * forward. The most recent records keep more detail because they are the
 * model's working set; older ones are reduced to a pointer. Rendering stays
 * deterministic per record, so the transcript prefix is append-only and a
 * provider prefix cache can still reuse it.
 */
const PRIOR_RECENT_RECORDS = 6;
const PRIOR_RECENT_TOOL_CHARS = 1_600;
const PRIOR_OLD_TOOL_CHARS = 300;
const PRIOR_RECENT_ASSISTANT_CHARS = 4_000;
const PRIOR_OLD_ASSISTANT_CHARS = 1_200;
const PRIOR_RECENT_USER_CHARS = 2_000;
const PRIOR_OLD_USER_CHARS = 800;
const PRIOR_TRANSCRIPT_MAX_CHARS = 120_000;
const PRIOR_CATALOG_TOOLS = new Set(['list_connector_tools', 'list_skills', 'search_files']);

function truncatePrior(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${label} truncated: ${text.length - limit} more chars; the full record remains in the session store …]`;
}

function compactPriorRecord(
  row: { role: string; content: string; tool?: { name: string } },
  recent: boolean,
): string | null {
  if (row.role === 'system') return null; // the current system prompt already applies
  if (row.role !== 'tool' || !row.tool) {
    if (row.role === 'assistant') return truncatePrior(row.content, recent ? PRIOR_RECENT_ASSISTANT_CHARS : PRIOR_OLD_ASSISTANT_CHARS, 'earlier assistant reply');
    if (row.role === 'user') return truncatePrior(row.content, recent ? PRIOR_RECENT_USER_CHARS : PRIOR_OLD_USER_CHARS, 'earlier user message');
    return row.content;
  }
  const limit = PRIOR_CATALOG_TOOLS.has(row.tool.name)
    ? 300
    : recent ? PRIOR_RECENT_TOOL_CHARS : PRIOR_OLD_TOOL_CHARS;
  if (row.content.length <= limit) return row.content;
  return `${row.content.slice(0, limit)}\n[earlier result truncated: ${row.content.length - limit} more chars. Files written earlier are on disk; read a range or call the tool again only if you need the detail.]`;
}

/** One-line correction status derived from durable tool evidence, not prose. */
function describeCorrectionState(records: readonly { role: string; content: string; tool?: { result?: RuntimeToolResult } }[]): string {
  let line = 'not started';
  for (const row of records) {
    const evidence = row.tool?.result?.correction;
    if (!evidence) continue;
    if (evidence.state === 'applied') {
      const corrected = /corrected_path:\s*(\S+)/.exec(row.tool?.result?.content || '')?.[1];
      line = corrected ? `applied (corrected_path: ${corrected})` : 'applied';
    } else if (evidence.state === 'needs_confirmation' && !line.startsWith('applied')) {
      line = 'pending user confirmation';
    } else if (evidence.state === 'scanned' && line === 'not started') {
      line = 'scanned, not applied';
    } else if (evidence.state === 'blocked' && line === 'not started') {
      line = 'blocked; re-scan before writing';
    }
  }
  return line;
}

/** Large payload fields are summarized, never replayed verbatim: a write_file
 * body would otherwise double the prompt for no new information. */
const LARGE_ARG_KEYS: ReadonlySet<string> = new Set([
  'content', 'text', 'body', 'old_string', 'new_string', 'patch',
]);

function summarizeToolInput(input: Record<string, unknown> | undefined, maxChars: number): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === 'string' && LARGE_ARG_KEYS.has(key)) { summary[key] = `<${value.length} chars>`; continue; }
    if (typeof value === 'string' && value.length > 120) { summary[key] = `${value.slice(0, 120)}…(${value.length})`; continue; }
    if (Array.isArray(value)) { summary[key] = `<${value.length} items>`; continue; }
    summary[key] = value;
  }
  const raw = JSON.stringify(summary);
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
}

/**
 * Keep the assistant's own call next to its result. Without it the model sees
 * outputs whose arguments it cannot inspect, so it re-derives or re-runs the
 * same call. Arguments are bounded: a `write_file` payload can be larger than
 * the result it produces.
 */
function renderToolCall(call: RuntimeModelToolCall): string {
  return `<runtime-tool-call id="${call.id}" name="${call.name}">${summarizeToolInput(call.arguments, 800)}</runtime-tool-call>`;
}

function renderToolResult(call: RuntimeModelToolCall, result: RuntimeToolResult): string {
  return [
    renderToolCall(call),
    `<runtime-tool-result id="${call.id}" name="${call.name}" status="${result.isError ? 'error' : 'ok'}">`,
    result.content,
    `</runtime-tool-result>`,
  ].join('\n');
}

interface ToolHistoryEntry {
  text: string;
  /** Set once, then reused: a stable pruned string keeps the prompt prefix stable. */
  pruned?: string;
}

/**
 * Bound the in-turn tool history that every remaining round re-sends. The
 * oldest results lose their middle (head + tail + a fixed marker), the most
 * recent `keepRecent` stay intact because they are the model's working set.
 *
 * This mirrors the replay-safe pruner pattern used by mature runtimes:
 * prune once, keep the pruned bytes byte-stable, and never prune a call pair
 * whose result arrived in this same step. Unlike a newest-wins rewrite, a
 * second pass over the same entry is a no-op, so provider prefix caching is
 * invalidated at most once per prune event, not once per round.
 */
function pruneToolHistory(
  entries: readonly ToolHistoryEntry[],
  budget: { maxChars: number; headChars: number; tailChars: number; keepRecent: number },
): string[] {
  const rendered = entries.map((entry) => entry.pruned ?? entry.text);
  if (budget.maxChars <= 0) return rendered;
  let total = rendered.reduce((sum, text) => sum + text.length, 0);
  const protectedFrom = Math.max(0, entries.length - Math.max(0, budget.keepRecent));
  for (let index = 0; index < protectedFrom && total > budget.maxChars; index += 1) {
    const entry = entries[index];
    if (entry.pruned) continue;
    const kept = budget.headChars + budget.tailChars;
    if (entry.text.length <= kept + 64) continue;
    const omitted = entry.text.length - kept;
    const marker = `\n\n[... tool result middle pruned: ${omitted} chars ...]\n\n`;
    entry.pruned = `${entry.text.slice(0, budget.headChars)}${marker}${entry.text.slice(entry.text.length - budget.tailChars)}`;
    total -= entry.text.length - entry.pruned.length;
    rendered[index] = entry.pruned;
  }
  return rendered;
}

/**
 * Tools that only read state. Everything else — file writes, shell, skill
 * scripts, connector calls, delegation, approval round-trips — is a barrier:
 * it may mutate the workspace or the outside world, so it never shares a
 * batch with a call whose result could depend on it.
 */
const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'stat_file',
  'read_file',
  'search_files',
  'grep_files',
  'list_connector_tools',
  'search_mate_kb',
  'read_mate_kb',
  'ontology_graph_read',
  'office_read',
  'browser_snapshot',
  'cogseed_tasks',
]);

export function isParallelSafeRuntimeTool(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/** Run a bounded pool, preserving input order in the returned array. */
async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function* runRuntimeExecutionLoop(
  request: RuntimeKernelRequest,
  deps: RuntimeExecutionLoopDeps,
  options: RuntimeExecutionLoopOptions = {},
): AsyncGenerator<RuntimeKernelEvent, void, unknown> {
  const signal = options.signal ?? null;
  if (isRuntimeAborted(signal)) {
    yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
    return;
  }

  const assembledContext = deps.contextAssembler
    ? await deps.contextAssembler(request)
    : await assembleRuntimeContextForPrompt(request, {
      maxPromptContextChars: deps.maxPromptContextChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxPromptContextChars,
    });
  const memorySummary = deps.memoryProvider
    ? await deps.memoryProvider(request)
    : await loadRuntimeMemorySummary(request.userId, {
      agentId: request.agentId,
      maxChars: deps.maxMemoryInjectionChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxMemoryInjectionChars,
    });
  const prompt = assembleRuntimePrompt({ request, context: assembledContext, memorySummary });
  await options.onRecord?.('system', prompt.system);
  await options.onRecord?.('user', request.task);

  yield { type: 'started', ...eventBase(request) };

  const priorRecords = options.priorRecords ?? [];
  const writtenPaths = [...new Set(priorRecords.filter(row => row.tool?.name === 'write_file' && !row.tool.result.isError)
    .map(row => row.tool?.input.path).filter((value): value is string => typeof value === 'string'))];
  // Repeated pending retries carry the same full transcript. Keep the FIRST
  // occurrence of each correction receipt: newest-wins dedupe would delete an
  // earlier record and change bytes the previous request already cached.
  const receipts = new Set<string>();
  const contextRecords = priorRecords.filter(row => {
    const evidence = row.tool?.result.correction;
    if (!evidence) return true;
    const key = JSON.stringify([row.tool.name, evidence.docId, evidence.sourceHash, evidence.state]);
    if (receipts.has(key)) return false;
    receipts.add(key); return true;
  });
  const correctionInputs = new Set<string>();
  // The durable transcript is an APPEND-ONLY prefix: older records render the
  // same bytes on every follow-up, so a provider prefix cache can reuse the
  // whole prior session and prefill only the delta. The new request therefore
  // goes LAST. Putting it first changed the first token of every follow-up and
  // forced a full re-prefill of the session (measured on the meeting agent:
  // single model rounds of 85–188s over the replayed 30–60k-token prompt).
  const renderedRecords: string[] = [];
  for (let index = 0; index < contextRecords.length; index += 1) {
    const row = contextRecords[index];
    const recent = index >= contextRecords.length - PRIOR_RECENT_RECORDS;
    const content = compactPriorRecord(row, recent);
    if (content === null) continue;
    const exactInput = row.tool?.name.startsWith('transcript_glossary_') ? JSON.stringify(row.tool.input) : '';
    const includeInput = exactInput && !correctionInputs.has(exactInput);
    if (exactInput) correctionInputs.add(exactInput);
    // Newer records already carry the call block inside `content`; older ones
    // do not, so add exactly one compact call line ahead of a tool result.
    // Only recent records get an explicit call line: older results already name
    // the tool, and replaying every payload would erase the checkpoint's gain.
    const needsCallLine = recent && Boolean(row.tool) && !content.trimStart().startsWith('<runtime-tool-call');
    const callLine = needsCallLine && row.tool
      ? `[assistant] tool_call ${row.tool.name} ${summarizeToolInput(row.tool.input, 240)}`
      : '';
    renderedRecords.push(
      [callLine, `[${row.role}] ${content}${includeInput ? '\nExact correction input: ' + exactInput : ''}`]
        .filter(Boolean)
        .join('\n'),
    );
  }
  // Hard cap only after per-record compaction: dropping the oldest records is
  // the last resort because it changes the cached prefix.
  let omitted = 0;
  let transcriptChars = renderedRecords.reduce((sum, text) => sum + text.length, 0);
  while (transcriptChars > PRIOR_TRANSCRIPT_MAX_CHARS && renderedRecords.length > PRIOR_RECENT_RECORDS) {
    const removed = renderedRecords.shift();
    transcriptChars -= removed?.length ?? 0;
    omitted += 1;
  }
  const transcript = priorRecords.length ? [
    '## Previous execution in this same Agent session',
    'Resume from the exact results below. Completed correction and existing deliverables remain valid for the same source. Do not fetch the source, scan again, reread unchanged skills or create another minutes version just to acknowledge confirmation. Ask only unresolved questions. User changes to the source require a fresh scan.',
    ...(omitted ? [`[… ${omitted} earlier records omitted; their files remain on disk and the session state below carries the durable outcome …]`] : []),
    ...renderedRecords,
  ].join('\n\n') : '';
  const lastAssistant = [...priorRecords].reverse().find((row) => row.role === 'assistant' && row.content.trim());
  // Everything in this block can change between turns, so it sits AFTER the
  // append-only transcript and before the new request: the cached prefix stays
  // stable while the model still sees the current durable state up front.
  const sessionState = priorRecords.length ? [
    '## Session state',
    `- Written deliverables: ${writtenPaths.length ? JSON.stringify(writtenPaths.slice(0, 20)) : 'none'}`,
    `- Transcript correction: ${describeCorrectionState(contextRecords)}`,
    writtenPaths.length
      ? '- Deliverable policy: reuse these exact paths; no file discovery is needed.'
      : '- Deliverable policy: no deliverable yet; write the requested files directly with write_file (it creates parent directories), and do not probe for files that do not exist yet.',
    ...(lastAssistant ? [`- Last assistant reply: ${truncatePrior(lastAssistant.content, 600, 'last reply')}`] : []),
  ].join('\n') : '';
  const userMessage = priorRecords.length ? [
    transcript,
    sessionState,
    '## Current request',
    prompt.user,
  ].join('\n\n') : prompt.user;
  let message = userMessage;
  // Providers are stateless. Keep every result from this invocation, rather
  // than alternating between the transcript and subsequent file lookups.
  // This is bounded by maxToolRounds and the tool runner's result caps; it
  // never imports another actor's conversation or replays earlier sessions.
  const toolHistory: ToolHistoryEntry[] = [];
  const historyBudget = deps.toolHistoryBudget ?? {
    maxChars: DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolHistoryChars,
    headChars: DEFAULT_RUNTIME_KERNEL_CONFIG.toolHistoryHeadChars,
    tailChars: DEFAULT_RUNTIME_KERNEL_CONFIG.toolHistoryTailChars,
    keepRecent: DEFAULT_RUNTIME_KERNEL_CONFIG.toolHistoryKeepRecent,
  };
  const transcriptGate = createTranscriptGate(request);
  for (const row of priorRecords) {
    if (row.tool) transcriptGate.restore(row.tool.name, row.tool.input, row.tool.result);
  }
  // A confirmation continuation has exact host-owned source and candidates.
  // Apply that snapshot before asking the model to plan again. The host tool
  // still requires the scoped human token; prose cannot grant approval.
  const pending = new Map<string, NonNullable<import('./session-store').NativeRuntimeTurnRecord['tool']>>();
  for (const row of priorRecords) {
    const tool = row.tool;
    if (!tool?.result.correction) continue;
    const key = JSON.stringify([tool.result.correction.docId, tool.result.correction.sourceHash]);
    if (tool.result.correction.state === 'needs_confirmation') pending.set(key, tool);
    if (tool.result.correction.state === 'applied') pending.delete(key);
  }
  // Set when the host still holds undecided items after replaying the user's
  // decision. The Agent then reads the human reply and asks about what is
  // left, instead of the host repeating the same blocked notice verbatim.
  let awaitingConfirmation: string | undefined;
  for (const tool of pending.values()) {
    const call = { id: `resume-correction-${toolHistory.length}`, name: 'transcript_glossary_apply', arguments: tool.input };
    yield { type: 'tool_call', ...eventBase(request), metadata: { id: call.id, name: call.name, arguments: call.arguments } };
    const result = transcriptGate.before(call.name, call.arguments)
      ?? await deps.toolRunner.run(call.name, call.arguments, { signal });
    transcriptGate.after(call.name, call.arguments, result);
    const rendered = renderToolResult(call, result);
    await options.onRecord?.('tool', rendered, { name: call.name, input: call.arguments, result });
    toolHistory.push({ text: rendered });
    yield { type: 'tool_result', ...eventBase(request), text: result.content, metadata: { id: call.id, name: call.name, isError: !!result.isError } };
    if (result.correction?.state === 'needs_confirmation') {
      awaitingConfirmation = result.correction.confirmationItems?.length
        ? result.correction.confirmationItems.map(item => `- 「${item.wrong}」 → 「${item.correct}」 (${item.count})\n  ${item.context}`).join('\n')
        : result.content;
      continue;
    }
    if (result.correction?.state === 'blocked') {
      yield { type: 'error', ...eventBase(request), error: result.correction.confirmationItems?.length
        ? result.correction.confirmationItems.map(item => `- 「${item.wrong}」 → 「${item.correct}」 (${item.count})\n  ${item.context}`).join('\n')
        : result.content,
        metadata: { code: 'transcript_correction_incomplete' } };
      return;
    }
  }
  const awaitingNote = awaitingConfirmation ? [
    'Some correction items are still undecided: the user\'s latest message did not settle them in a form the host can apply.',
    'Read that message. Where the user stated the right form of a term as a lasting rule, you may record it with transcript_glossary_upsert.',
    'You cannot approve card items yourself, and must not call transcript_glossary_apply again in this turn or write minutes.',
    'End your turn with a short reply in the user\'s language: acknowledge what they said, then ask only about the undecided items.',
    'If their intent is clear, quote back the exact reply that encodes it, naming each item, for example 「ok 不改，其他都改」, and ask them to send exactly that or tick the card. A bare 「确认」 no longer approves anything here.',
  ].join(' ') : '';
  if (toolHistory.length) message = [userMessage, '## Resumed correction results', ...pruneToolHistory(toolHistory, historyBudget),
    awaitingNote || 'Continue from these results. If a result names corrected_path, the corrected transcript is already saved there: read that file when needed and never rewrite it. Otherwise persist the exact corrected text returned above; do not reconstruct replacements with shell substitutions. Do not scan or apply the same corrected source again. Missing optional meeting metadata can remain unknown; do not search unrelated files to fill it.'].join('\n\n');
  // A reasoning model can spend a whole round thinking and return no content
  // and no tool call. Completing on that leaves the user with no reply at all.
  let emptyRetried = false;
  // Files written in this invocation. A full re-read returns what the model
  // itself just wrote, and an identical rewrite changes nothing; both cost a
  // whole model round on long documents.
  const writtenThisTurn = new Map<string, string>();
  const repeatFileCall = (call: RuntimeModelToolCall): RuntimeToolResult | undefined => {
    const target = typeof call.arguments.path === 'string' ? call.arguments.path : '';
    if (!target || !writtenThisTurn.has(target)) return undefined;
    if (call.name === 'read_file' && call.arguments.charStart === undefined && call.arguments.charEnd === undefined) {
      return { content: `You wrote ${target} earlier in this turn; its content is exactly what you wrote. Do not re-read or rewrite it. Continue with the next step.` };
    }
    if (call.name === 'write_file' && call.arguments.content === writtenThisTurn.get(target)) {
      return { content: `Unchanged: ${target} already has this exact content. Continue with the next step.` };
    }
    return undefined;
  };
  for (let round = 0; round <= deps.maxToolRounds; round += 1) {
    let finalText = '';
    const textFilter = createHiddenMetadataFilter();
    const toolCalls: RuntimeModelToolCall[] = [];
    const roundStartedAt = Date.now();
    const roundUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};

    const streamIdleTimeoutMs = deps.streamIdleTimeoutMs ?? DEFAULT_RUNTIME_KERNEL_CONFIG.streamIdleTimeoutMs;
    const maxModelRetries = deps.maxModelRetries ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxModelRetries;
    let modelAttempt = 0;
    let streamFinished = false;
    while (!streamFinished) {
      const iterator = deps.modelAdapter.stream({
        userId: request.userId,
        requestId: request.requestId,
        runtimeSessionId: request.runtimeSessionId,
        message,
        systemPrompt: prompt.system,
        modelProfile: request.modelProfile,
        workingDir: request.workingDir,
        readOnlyRoots: request.readOnlyRoots,
        tools: getRuntimeOpenAIToolCatalog(deps.toolRunner.catalog),
      }, { signal })[Symbol.asyncIterator]();
      let interrupted = false;
      const retryable = (): boolean => finalText === '' && toolCalls.length === 0 && modelAttempt < maxModelRetries;
      try {
        for (;;) {
          const next = await nextModelEvent(iterator, streamIdleTimeoutMs);
          if (next === MODEL_STREAM_IDLE) {
            if (isRuntimeAborted(signal)) {
              yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
              void iterator.return?.().catch(() => {});
              return;
            }
            if (!retryable()) {
              yield {
                type: 'error',
                ...eventBase(request),
                error: `model stream produced no event for ${streamIdleTimeoutMs}ms`,
                metadata: { code: 'model_stream_idle' },
              };
              void iterator.return?.().catch(() => {});
              return;
            }
            interrupted = true;
            void iterator.return?.().catch(() => {});
            break;
          }
          if (next.done) break;
          const modelEvent = next.value;
          if (isRuntimeAborted(signal)) {
            yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
            void iterator.return?.().catch(() => {});
            return;
          }
          if (modelEvent.type === 'delta') {
            finalText += modelEvent.text;
            // An unverified "minutes are ready" must not leak through streaming.
            const visible = textFilter.push(modelEvent.text);
            if (!transcriptGate.closed() && visible) yield { type: 'model_delta', ...eventBase(request), text: visible };
          } else if (modelEvent.type === 'tool_call') {
            toolCalls.push(modelEvent.call);
            yield { type: 'tool_call', ...eventBase(request), metadata: { id: modelEvent.call.id, name: modelEvent.call.name, arguments: modelEvent.call.arguments } };
          } else if (modelEvent.type === 'usage') {
            const usage = modelEvent.usage;
            if (usage.inputTokens !== undefined) roundUsage.inputTokens = usage.inputTokens;
            if (usage.outputTokens !== undefined) roundUsage.outputTokens = usage.outputTokens;
            if (usage.totalTokens !== undefined) roundUsage.totalTokens = usage.totalTokens;
          } else if (modelEvent.type === 'error') {
            if (retryable()) {
              interrupted = true;
              void iterator.return?.().catch(() => {});
              break;
            }
            yield { type: 'error', ...eventBase(request), error: modelEvent.message, metadata: { code: modelEvent.code } };
            void iterator.return?.().catch(() => {});
            return;
          }
        }
      } catch (error) {
        if (isRuntimeAborted(signal)) {
          yield { type: 'cancelled', ...eventBase(request), metadata: { code: 'aborted' } };
          return;
        }
        if (!retryable()) {
          yield {
            type: 'error',
            ...eventBase(request),
            error: error instanceof Error ? error.message : String(error),
            metadata: { code: 'model_stream_error' },
          };
          return;
        }
        interrupted = true;
      }
      if (!interrupted) {
        streamFinished = true;
        break;
      }
      modelAttempt += 1;
      if (modelAttempt > maxModelRetries) {
        yield {
          type: 'error',
          ...eventBase(request),
          error: `model stream did not recover after ${maxModelRetries} retries`,
          metadata: { code: 'model_stream_idle' },
        };
        return;
      }
      roundUsage.inputTokens = undefined;
      roundUsage.outputTokens = undefined;
      roundUsage.totalTokens = undefined;
      await pause(200 * modelAttempt);
    }
    await appendRuntimeRoundMetric(request.userId, {
      kind: 'round',
      request_id: request.requestId,
      runtime_session_id: request.runtimeSessionId,
      ...(request.traceId ? { trace_id: request.traceId } : {}),
      round,
      prompt_chars: prompt.system.length + message.length,
      tool_calls: toolCalls.length,
      model_ms: Date.now() - roundStartedAt,
      ...(roundUsage.inputTokens !== undefined ? { input_tokens: roundUsage.inputTokens } : {}),
      ...(roundUsage.outputTokens !== undefined ? { output_tokens: roundUsage.outputTokens } : {}),
      ...(roundUsage.totalTokens !== undefined ? { total_tokens: roundUsage.totalTokens } : {}),
      ...(request.agentId ? { agent_id: request.agentId } : {}),
      created_at: new Date().toISOString(),
    });

    finalText = stripHiddenMetadata(finalText);
    if (!toolCalls.length) {
      const recovered = parseTextToolCalls(finalText, new Set(deps.toolRunner.catalog.map((entry) => entry.name)), `text-call-${round}`);
      if (recovered) {
        for (const call of recovered) {
          toolCalls.push(call);
          yield { type: 'tool_call', ...eventBase(request), metadata: { id: call.id, name: call.name, arguments: call.arguments } };
        }
        finalText = '';
      }
    }
    if (!toolCalls.length && !finalText.trim()) {
      if (!emptyRetried && round < deps.maxToolRounds) {
        emptyRetried = true;
        message = `${message}\n\nYour previous response was empty. Reply now with the next tool call, or with the final answer for the user. Keep reasoning short and write long documents with write_file.`;
        continue;
      }
      yield { type: 'error', ...eventBase(request), error: 'The model returned an empty response twice.', metadata: { code: 'empty_model_response' } };
      return;
    }
    if (!toolCalls.length) {
      if (transcriptGate.closed() && awaitingConfirmation) {
        if (finalText.trim()) await options.onRecord?.('assistant', finalText);
        yield { type: 'error', ...eventBase(request), error: awaitingConfirmation,
          metadata: { code: 'transcript_confirmation_required',
            ...(finalText.trim() ? { reply: finalText.trim().slice(0, 4000) } : {}) } };
        return;
      }
      if (transcriptGate.closed()) {
        yield { type: 'error', ...eventBase(request), error: 'Transcript correction is incomplete. Resolve correction errors or pending confirmation before generating minutes.', metadata: { code: 'transcript_correction_incomplete' } };
        return;
      }
      await options.onRecord?.('assistant', finalText);
      await deps.memoryExtractor?.({ request, finalText });
      yield { type: 'result', ...eventBase(request), text: finalText };
      return;
    }

    if (round >= deps.maxToolRounds) {
      const error = 'runtime exceeded max tool rounds';
      await options.onRecord?.('assistant', error);
      yield { type: 'error', ...eventBase(request), error, metadata: { code: 'max_tool_rounds', maxToolRounds: deps.maxToolRounds } };
      return;
    }

    // Independent reads in one assistant step run in a bounded pool; a call
    // that can mutate state is a barrier. Results, history and emitted events
    // stay in model order, so replay and the tool-receipt gates are unchanged.
    // Before this, a step with four independent reads paid four round-trips
    // serially — the dominant tool-side cost in measured meeting-agent turns.
    const maxParallel = deps.maxParallelToolCalls ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxParallelToolCalls;
    const toolTimeoutMs = deps.toolTimeoutMs ?? DEFAULT_RUNTIME_KERNEL_CONFIG.toolTimeoutMs;
    const timeoutResult = (call: RuntimeModelToolCall): RuntimeToolResult => ({
      content: `[E_RUNTIME_TOOL_TIMEOUT] ${call.name} exceeded the ${Math.round(toolTimeoutMs / 1000)}s per-call deadline. Treat the call as failed: narrow the input, read a smaller range, or continue without it.`,
      isError: true,
    });
    const runToolCall = async (call: RuntimeModelToolCall, round: number): Promise<RuntimeToolResult> => {
      const startedAt = Date.now();
      const record = async (result: RuntimeToolResult): Promise<RuntimeToolResult> => {
        await appendRuntimeToolMetric(request.userId, {
          kind: 'tool',
          request_id: request.requestId,
          runtime_session_id: request.runtimeSessionId,
          ...(request.traceId ? { trace_id: request.traceId } : {}),
          round,
          name: call.name,
          tool_ms: Date.now() - startedAt,
          is_error: result.isError === true,
          created_at: new Date().toISOString(),
        });
        return result;
      };
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      try {
        const running = deps.toolRunner.run(call.name, call.arguments, { signal: controller.signal });
        // A tool that ignores the abort signal must not own the turn: race the
        // real call against the deadline so the loop always moves on. The
        // abandoned call keeps its own lifecycle and its late failure is
        // observed here rather than surfacing as an unhandled rejection.
        running.catch(() => {});
        const deadline = new Promise<never>((_, reject) => {
          if (toolTimeoutMs <= 0) return;
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('tool deadline exceeded'));
          }, toolTimeoutMs);
        });
        const result = await Promise.race([running, deadline]);
        return await record(timedOut ? timeoutResult(call) : result);
      } catch (error) {
        if (timedOut) return await record(timeoutResult(call));
        return await record({
          content: `[E_RUNTIME_TOOL_ERROR] ${call.name}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        });
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
      }
    };
    const finalizeToolCall = async (
      call: RuntimeModelToolCall,
      result: RuntimeToolResult,
    ): Promise<{ events: RuntimeKernelEvent[]; stop: boolean }> => {
      transcriptGate.after(call.name, call.arguments, result);
      if (!result.isError && typeof call.arguments.path === 'string') {
        if (call.name === 'write_file' && typeof call.arguments.content === 'string') writtenThisTurn.set(call.arguments.path, call.arguments.content);
        if (call.name === 'edit_file') writtenThisTurn.delete(call.arguments.path);
      }
      const rendered = renderToolResult(call, result);
      toolHistory.push({ text: rendered });
      await options.onRecord?.('tool', rendered, { name: call.name, input: call.arguments, result });
      const events: RuntimeKernelEvent[] = [
        { type: 'tool_result', ...eventBase(request), text: result.content, metadata: { id: call.id, name: call.name, isError: !!result.isError } },
      ];
      if (call.name.startsWith('transcript_glossary_') && result.isError
        && result.content.startsWith('[E_RUNTIME_HOST_TOOL_SCOPE]')) {
        // A broken host binding cannot be repaired by changing transcript
        // arguments. Stop here instead of spending turns retrying private data.
        events.push({ type: 'error', ...eventBase(request), error: result.content,
          metadata: { code: 'transcript_scope_mismatch' } });
        return { events, stop: true };
      }
      if (result.correction?.state === 'blocked' || result.correction?.state === 'needs_confirmation') {
        events.push({
          type: 'error', ...eventBase(request),
          error: result.correction.confirmationItems?.length
            ? result.correction.confirmationItems.map(item => `- 「${item.wrong}」 → 「${item.correct}」 (${item.count})\n  ${item.context}`).join('\n')
            : 'Transcript correction requires resolution before minutes can be generated.',
          metadata: { code: result.correction.state === 'needs_confirmation' ? 'transcript_confirmation_required' : 'transcript_correction_incomplete' },
        });
        return { events, stop: true };
      }
      // 工具报错是可恢复输入，不是整轮致命错误：错误文本已经随 tool_result 回灌给
      // 模型（后续轮次的 toolHistory），让它自己换工具/改参数/如实说明。此前这里
      // 直接 yield error 并 return，导致任何一次工具失败都把整轮判死——真机上
      // cogseed_workflow（无 workflow 时必然报错）、路径写错、策略拒绝都因此变成
      // 「智能体未能完成本次回复，请重试」，而重试只会再撞同一面墙。
      // 终止仍由模型自身失败与 maxToolRounds 兜底（见上方与下方分支）。
      return { events, stop: false };
    };

    let cursor = 0;
    while (cursor < toolCalls.length) {
      const call = toolCalls[cursor];
      // Only the human can settle the open card; a rescan would just reissue it.
      const pre = (awaitingConfirmation && (call.name === 'transcript_glossary_scan' || call.name === 'transcript_glossary_apply')
        ? { content: '[E_TRANSCRIPT_CONFIRMATION_PENDING] The user has not decided the open items yet. Do not scan or apply now; end your turn and ask about the undecided items.', isError: true }
        : undefined)
        ?? transcriptGate.before(call.name, call.arguments)
        ?? repeatFileCall(call);
      if (!pre && isParallelSafeRuntimeTool(call.name)) {
        const group: RuntimeModelToolCall[] = [call];
        let next = cursor + 1;
        while (next < toolCalls.length && isParallelSafeRuntimeTool(toolCalls[next].name)) {
          group.push(toolCalls[next]);
          next += 1;
        }
        const results = await runBounded(group, maxParallel, async (item) => repeatFileCall(item) ?? await runToolCall(item, round));
        for (let index = 0; index < group.length; index += 1) {
          const outcome = await finalizeToolCall(group[index], results[index]);
          for (const event of outcome.events) yield event;
          if (outcome.stop) return;
        }
        cursor = next;
        continue;
      }
      const result = pre ?? await runToolCall(call, round);
      const outcome = await finalizeToolCall(call, result);
      for (const event of outcome.events) yield event;
      if (outcome.stop) return;
      cursor += 1;
    }

    message = [
      userMessage,
      '## Runtime tool results',
      ...pruneToolHistory(toolHistory, historyBudget),
      awaitingNote || 'Continue from all results above. Reuse successful reads instead of fetching identical inputs again. Do not repeat an action whose approval was denied. Produce the final answer or request the next needed tool.',
    ].join('\n\n');
  }
}
