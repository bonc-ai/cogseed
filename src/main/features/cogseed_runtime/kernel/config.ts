import type { RuntimeToolPolicy } from './types';

export const DEFAULT_RUNTIME_KERNEL_CONFIG = Object.freeze({
  idleTimeoutMs: 30 * 60 * 1000,
  streamIdleTimeoutMs: 3 * 60 * 1000,
  maxToolRounds: 80,
  maxModelRetries: 2,
  // Tool calls in one assistant step are independent unless a call can mutate
  // state. Independent reads therefore run in a bounded pool instead of
  // one-by-one; a write/shell/mutating-host call is a barrier between pools.
  maxParallelToolCalls: 4,
  // No single tool call may own the whole turn. Shell and skill calls keep
  // their own timeout; this is the outer deadline for everything else
  // (connectors, ontology, KB, host approval round-trips).
  toolTimeoutMs: 10 * 60 * 1000,
  // In-turn tool history is re-sent every round. Past this budget the oldest
  // results are replaced by head+tail excerpts (never the most recent two), so
  // one long turn cannot grow the prompt without bound. Borrowed from the
  // replay-safe tool-result pruner pattern: prune once, keep the pruned bytes
  // stable, and preserve the model's current working set.
  maxToolHistoryChars: 60_000,
  toolHistoryHeadChars: 4_000,
  toolHistoryTailChars: 1_000,
  toolHistoryKeepRecent: 2,
  requestLedgerRetentionMs: 14 * 24 * 60 * 60 * 1000,
  maxInlineToolResultChars: 24_000,
  maxPromptContextChars: 120_000,
  maxMemoryInjectionChars: 12_000,
  allowWriteToolsByDefault: false,
  allowShellByDefault: false,
  allowSkillRunByDefault: false,
});

export const DEFAULT_RUNTIME_CONCURRENCY = Object.freeze({
  maxConcurrentRuns: 3,
  maxConcurrentRunsPerUser: 2,
  maxConcurrentRunsPerSession: 1,
});

export const DEFAULT_RUNTIME_TOOL_POLICY = Object.freeze({
  fileRead: 'explicit_roots',
  fileWrite: 'none',
  shell: 'none',
  skillRun: 'none',
  network: 'none',
  connectors: 'none',
} as const satisfies RuntimeToolPolicy);

export const COGSEED_RUNTIME_TOOL_POLICY = Object.freeze({ ...DEFAULT_RUNTIME_TOOL_POLICY, connectors: 'enabled' } as const satisfies RuntimeToolPolicy);
