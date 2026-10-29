import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

it('keeps onboarding window chrome separate from scrolling content and clickable actions', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/onboarding-header.cjs')], {
    env, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const outcome = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toBeGreaterThanOrEqual(20);
}, 55_000);
