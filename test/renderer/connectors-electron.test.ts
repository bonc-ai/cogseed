import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

it.skipIf(process.platform === 'win32')('renders migrated connectors through real Electron IPC and shared onboarding controls', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/connectors-page.cjs')], {
    env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const output = String(result.stdout).trim().split('\n').filter(Boolean).pop()!;
  const parsed = JSON.parse(output);
  expect(parsed.error, parsed.stack).toBeUndefined();
  expect(parsed.failed).toEqual([]);
  expect(parsed.passed).toBeGreaterThanOrEqual(10);
}, 70_000);
