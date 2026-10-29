import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);
it('meets the desktop scale contract through the real renderer, preload, IPC router and isolated domain data', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-scale-electron.cjs')], {
    env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const line = result.stdout.split('\n').find(row => row.startsWith('@@COGNITION_SCALE@@'));
  expect(line, `${result.stdout}\n${result.stderr}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@COGNITION_SCALE@@'.length));
  expect(outcome.failed).toEqual([]);
  expect(outcome.inventory).toMatchObject({ persistedAssets: 1000, persistedUsageRecords: 10000, rendererAssets: 1000, immutableVersionJournalFiles: 1000 });
  expect(outcome.modelCalls).toBe(0);
  expect(outcome.environment).toBe('production-renderer-preload-ipc-router-domain-electron');
  if (process.env.COGSEED_SCALE_RECORDS_ONLY === '1') {
    expect(outcome.mode).toBe('records-only');
    expect(outcome.latency.records.samples).toBe(20);
    expect(outcome.latency.records.p95Ms).toBeLessThanOrEqual(800);
    expect(outcome.ipc['conversations.titles'].count).toBeGreaterThanOrEqual(20);
    expect(outcome.ipc['conversations.titles'].failures).toBe(0);
    process.stdout.write(`COGNITION_SCALE_RECORDS_ELECTRON ${JSON.stringify(outcome)}\n`);
    return;
  }
  for (const kind of ['search', 'filter']) expect(outcome.latency[kind].p95Ms).toBeLessThanOrEqual(300);
  for (const kind of ['detail', 'records']) expect(outcome.latency[kind].p95Ms).toBeLessThanOrEqual(800);
  expect(outcome.feedback.maxMs).toBeLessThanOrEqual(200);
  expect(outcome.freeze.rendererMaxLagMs).toBeLessThan(1000);
  expect(outcome.freeze.mainMaxLagMs).toBeLessThan(1000);
  process.stdout.write(`COGNITION_SCALE_ELECTRON ${JSON.stringify(outcome)}\n`);
}, 130_000);
