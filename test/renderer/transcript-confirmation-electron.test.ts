import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const requireCjs = createRequire(import.meta.url);
it.skipIf(process.platform === 'win32')('recovers pending correction controls through production history reload and preload', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/transcript-confirmation-page.cjs')], {
    env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const report = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop()!);
  expect(report).toMatchObject({ ok: true, reloads: 2, confirmed: 0 });
}, 70_000);
