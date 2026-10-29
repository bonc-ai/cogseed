import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireCjs = createRequire(import.meta.url);
it('reads ontology results, protects instructions and confirms the displayed version in Electron', () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/cognition-ontology-review.cjs')], { env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const line = result.stdout.split('\n').find(row => row.startsWith('@@ONTOLOGY_REVIEW_UI@@'));
  expect(line, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBeTruthy();
  const outcome = JSON.parse(line!.slice('@@ONTOLOGY_REVIEW_UI@@'.length));
  process.stdout.write(`ONTOLOGY_REVIEW_UI ${JSON.stringify(outcome)}\n`);
  expect(outcome.failed).toEqual([]); expect(outcome.passed).toHaveLength(16);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 70_000);
