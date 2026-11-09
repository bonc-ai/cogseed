import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireCjs = createRequire(import.meta.url);

it('keeps Contacts reachable as a top-level module with badges, keyboard navigation and deep links', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [resolve(__dirname, 'fixtures/contacts-navigation-page.cjs')], {
    env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const report = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!);
  expect(report.failed).toEqual([]);
  expect(report.widths).toEqual([1280, 600]);
  expect(report.scenarios).toEqual(['rail-and-keyboard', 'route-and-layout', 'badge-clicks', 'notification-route', 'empty-and-pending', 'live-i18n']);
  expect(report.forbidden).toEqual([]);
}, 70_000);
