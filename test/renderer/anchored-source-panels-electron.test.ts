import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

it('keeps real correction and meeting panels isolated through the source viewer lifecycle', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/anchored-source-panels.cjs')], {
    env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop();
  expect(lastLine, `${result.stdout}\n${result.stderr}`).toBeTruthy();
  const outcome = JSON.parse(lastLine!);
  expect(outcome.failed).toEqual([]);
  expect(outcome.scenarios).toEqual(['coexistence', 'reopen', 'document-switch', 'pending-read', 'optional-panel']);
}, 55_000);
