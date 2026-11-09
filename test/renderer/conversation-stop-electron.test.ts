import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
it('keeps the production stop button pending until acknowledgement and makes failures retryable', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/conversation-stop-page.cjs')], {
    env, encoding: 'utf8', timeout: 45_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const report = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop()!);
  expect(report).toMatchObject({ ok: true, widths: [1280, 600], stopCalls: 4,
    pendingUntilAck: true, duplicateStopsCoalesced: true, failureRetryable: true });
}, 50_000);
