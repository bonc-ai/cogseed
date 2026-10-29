import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(!process.env.COGSEED_COGNITION_BUS_REPLAY_REPORT)(
  'replays recorded native output through the production renderer IPC and normal commander bus, including automatic v3 use and receipts', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-bus-replay.cjs')], {
      env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_BUS_REPLAY@@'));
    expect(line, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBeTruthy();
    const outcome = JSON.parse(line!.slice('@@COGNITION_BUS_REPLAY@@'.length));
    process.stdout.write(`COGNITION_BUS_REPLAY ${JSON.stringify(outcome)}\n`);
    expect(outcome.failed, outcome.reportFile).toEqual([]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.streamRequests).toHaveLength(1);
    expect(outcome.modelReplays).toHaveLength(1);
    expect(outcome.checkerReplays).toHaveLength(1);
    expect(outcome.coverage).toBe('production-renderer-preload-registered-ipc-facade-commander-bus-persistence-receipts-timeline; model-transport-replay');
  }, 65_000,
);
