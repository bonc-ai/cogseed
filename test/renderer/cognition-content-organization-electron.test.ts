import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireCjs = createRequire(import.meta.url);
it('reviews and saves a whole content-organization group through the production Electron page and IPC', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-content-organization.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@ORGANIZATION_UI@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@ORGANIZATION_UI@@'.length));
  process.stdout.write(`ORGANIZATION_UI ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toHaveLength(14);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
