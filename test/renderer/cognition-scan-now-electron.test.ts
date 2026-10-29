import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it('starts a scan from the settings button without confirmation and retains busy/error recovery', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // Worker hooks in NODE_OPTIONS make this GUI fixture miss the pending scan
  // button. The fixture is a normal Electron window and does not need them.
  env.NODE_OPTIONS = '';
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-scan-now.cjs')], {
    env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
  expect(result.stdout).toContain('@@SCAN_NOW_PASSED@@');
}, 35_000);
