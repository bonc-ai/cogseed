import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

describe('automation Run now in Chromium', () => {
  // Match the existing Electron DOM fixture limitation on Windows hosts.
  it.skipIf(process.platform === 'win32')('uses compact cards and dropdowns across real pages with recovery and keyboard navigation', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/auto-run-now-dom.cjs')], {
      env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    });
    expect(result.status, `${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const output = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop() || '{}');
    expect(output.failed).toEqual([]);
    expect(output.total).toBeGreaterThanOrEqual(44);
  }, 70000);
});
