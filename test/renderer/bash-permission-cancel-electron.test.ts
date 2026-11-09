import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(process.platform === 'win32')('cancels real approval dialogs and drains the production page queue', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/bash-permission-cancel-page.cjs')], {
    env, encoding: 'utf8', timeout: 60_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const report = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop()!);
  expect(report).toMatchObject({ ok: true, widths: [1280, 600], cancelledDenied: true,
    queueRecovered: true, staleAllowIgnored: true, keyboard: true, focusReturned: true, modeWrites: 0 });
}, 70_000);
