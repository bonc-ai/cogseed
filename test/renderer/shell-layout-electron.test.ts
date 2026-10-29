import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

// Real Electron run of the production renderer shell (specs/008-shell-rail-layout):
// rail, contextual sidebar hosts, sidebar-less modules, global collapse and
// the KB navigation that moved out of the page header.
it('keeps the rail, contextual sidebar and collapse recovery working in the real renderer', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/shell-layout.cjs')], {
    env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const outcome = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toBeGreaterThanOrEqual(60);
}, 70_000);
