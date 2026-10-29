import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

it('keeps the cognition header draggable and sidebar navigation and recovery clickable', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-header.cjs')], {
    env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const outcome = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toBeGreaterThanOrEqual(40);
}, 40_000);
