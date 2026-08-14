export interface ExecutionBoundaryInfo {
  mode: 'real' | 'degraded' | 'test-double';
  provider: 'cogseed-backend' | 'core-agent' | 'local-agent' | 'fixture';
  reason?: string;
}

/** Production invariant: every formal product Agent executes through CogSeed
 * Backend. Group Chat remains an entry/state/projection surface only. */
export const FORMAL_AGENT_EXECUTION_BOUNDARY: ExecutionBoundaryInfo = Object.freeze({
  mode: 'real',
  provider: 'cogseed-backend',
});

/** Legacy Group Chat Agent execution is retained only as an explicit test
 * double for old focused fixtures. Production builds cannot disable the
 * single-Backend wake gate with an environment variable. */
export function allowLegacyGroupChatFormalAgentExecutorForTest(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.ORKAS_P3394_WAKE_GATE === '0';
}

/** Legacy named / write-capable run_worker retained ONLY for existing
 * bus-integration.test.ts fixtures. Production + dev runs reject these
 * routes; the test flag requires NODE_ENV === "test" to take effect. */
export function allowLegacyRunWorkerTestRoutes(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.ORKAS_LEGACY_RUN_WORKER_TEST === '0';
}
