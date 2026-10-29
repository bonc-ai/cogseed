import { format } from 'node:util';

import { runRuntimeWorker } from './worker';

/**
 * The parent reads this process's stdout as a JSONL protocol stream. A stray
 * `console.*` from a provider SDK, a tool, or a dependency lands between two
 * frames and produces the host-side `invalid runtime worker json` warning —
 * at worst it can split a tool result and lose the event. Keep stdout for
 * protocol frames only (`process.stdout.write` in worker.ts) and divert every
 * console channel to stderr.
 */
function divertConsoleToStderr(): void {
  const write = (line: string) => {
    try { process.stderr.write(line); } catch { /* stderr already closed */ }
  };
  for (const channel of ['log', 'info', 'debug', 'trace', 'warn', 'error'] as const) {
    console[channel] = (...args: unknown[]) => write(`${format(...args)}\n`);
  }
}

divertConsoleToStderr();

runRuntimeWorker().catch((err) => {
  process.stderr.write(`[cogseed-runtime-worker] ${(err as Error).message || String(err)}\n`);
  process.exitCode = 1;
});
