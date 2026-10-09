import type { RuntimeToolPolicy } from './types';

export const DEFAULT_RUNTIME_KERNEL_CONFIG = Object.freeze({
  idleTimeoutMs: 30 * 60 * 1000,
  streamIdleTimeoutMs: 3 * 60 * 1000,
  maxToolRounds: 80,
  maxModelRetries: 2,
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
