import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

it('drives the standalone old-content plan through the production Electron page', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'),
    [resolve(__dirname, 'fixtures/cognition-old-content-plan.cjs')],
    { env, encoding: 'utf8', timeout: 100_000, maxBuffer: 10 * 1024 * 1024 });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@OLD_CONTENT_PLAN@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@OLD_CONTENT_PLAN@@'.length));
  process.stdout.write(`OLD_CONTENT_PLAN ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed.length).toBeGreaterThanOrEqual(10);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 110_000);
