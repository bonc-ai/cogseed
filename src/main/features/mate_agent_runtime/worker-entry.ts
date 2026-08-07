import { runRuntimeWorker } from './worker';

runRuntimeWorker().catch((err) => {
  process.stderr.write(`[mate-runtime-worker] ${(err as Error).message || String(err)}\n`);
  process.exitCode = 1;
});
