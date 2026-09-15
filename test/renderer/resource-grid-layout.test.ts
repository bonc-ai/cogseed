import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

describe('shared resource grids in Chromium', () => {
  it('switches at content-width breakpoints, fills tracks and stays overflow-free', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/resource-grid-layout.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('"passed":126');
  }, 35000);
});
