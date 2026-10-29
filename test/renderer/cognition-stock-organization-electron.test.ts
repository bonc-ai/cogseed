import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireCjs = createRequire(import.meta.url);
it('reviews and saves a stock suggestion through the production Electron page and IPC', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-stock-organization.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@STOCK_UI@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@STOCK_UI@@'.length));
  process.stdout.write(`STOCK_UI ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toHaveLength(16);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);


it('rechecks legacy and located sources through the production Electron page and IPC', () => {
  const env = { ...process.env, COGSEED_TEST_SOURCE_RECHECK: '1' }; delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-stock-organization.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@STOCK_UI@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@STOCK_UI@@'.length));
  process.stdout.write(`SOURCE_UI ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toHaveLength(13);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);


it('confirms independent stock suggestions and recovers conflicts on desktop and narrow Electron pages', () => {
  const env = { ...process.env, COGSEED_TEST_CONFIRMATION_CONFLICTS: '1' }; delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-stock-organization.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@STOCK_UI@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@STOCK_UI@@'.length));
  process.stdout.write(`CONFIRMATION_UI ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]);
  expect(outcome.passed).toHaveLength(16);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
