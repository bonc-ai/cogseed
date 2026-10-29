import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it('edits cognition through production renderer approval and real isolated domain services', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-edit.cjs')], {
    env, encoding: 'utf8', timeout: 50_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const outcome = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toBeGreaterThanOrEqual(18);
  expect(outcome.modelCalls).toBe(0);
  expect(outcome.environment).toBe('production-renderer-and-domain-electron-integration');
  process.stdout.write(`COGNITION_EDIT_ELECTRON ${JSON.stringify(outcome)}\n`);
}, 60_000);
