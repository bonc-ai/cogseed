import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(process.env.COGSEED_LIVE_COGNITION_EDIT !== '1')('drives real native cognition edits through renderer approval, ordinary next-turn use and record readback', () => {
  const env = { ...process.env, COGSEED_RECALL_LIVE_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-edit-live.cjs')], { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_EDIT_LIVE@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@COGNITION_EDIT_LIVE@@'.length));
  process.stdout.write(`COGNITION_EDIT_LIVE ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed, outcome.reportFile).toEqual([]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 0);
