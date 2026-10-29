import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it('refreshes open cognition detail caches through production Electron IPC without touching real user data', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-detail-cache.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_DETAIL_CACHE@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@COGNITION_DETAIL_CACHE@@'.length));
  process.stdout.write(`COGNITION_DETAIL_CACHE ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toHaveLength(6);
  expect(outcome.modelCalls).toBe(0);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
