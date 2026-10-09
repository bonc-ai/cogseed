import { runRuntimeWorker } from './worker';

runRuntimeWorker().catch((err) => {
  process.stderr.write(`[cogseed-runtime-worker] ${(err as Error).message || String(err)}\n`);
  process.exitCode = 1;
});
