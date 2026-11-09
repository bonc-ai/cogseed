import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);

it('production pages show request identity, pushed decisions and recover from a rejected delivery', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/consultation-delivery.cjs')], {
    env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.error || ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const line = result.stdout.split('\n').find(row => row.startsWith('@@CONSULTATION_PAGE@@'));
  expect(line, result.stdout).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@CONSULTATION_PAGE@@'.length));
  expect(outcome.error).toBeUndefined();
  expect(outcome.widths).toEqual([1280, 640]);
  expect(outcome.answers).toEqual([
    { id: 'acons-page', decision: 'approve' }, { id: 'acons-page', decision: 'approve', text: 'Owner approved wording' },
  ]);
}, 35000);
