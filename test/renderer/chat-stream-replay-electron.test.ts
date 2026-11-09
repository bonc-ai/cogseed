import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
it.skipIf(process.platform === 'win32')('restores replayed live replies on the production page without overriding disclosure choices', () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(requireCjs('electron'), [path.join(__dirname, 'fixtures/chat-stream-replay-page.cjs')], {
    env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || result.signal || ''}`).toBe(0);
  const report = JSON.parse(String(result.stdout).trim().split('\n').filter(Boolean).pop()!);
  expect(report).toMatchObject({ ok: true, widths: [1280, 600], executionRequests: 0, forbidden: [] });
  expect(report.streamChannels).toEqual(expect.arrayContaining(['sessionImport.events', 'cogseed.dashboard.watch']));
  // `autoTasks.events` 是 boot.js 在 2.5 s 延迟里建立的被动事件订阅（Stage C），
  // 慢机器上会落进观察窗口；它不触发执行，夹具与本断言同源放行。
  expect(report.streamChannels.every((channel: string) =>
    ['sessionImport.events', 'cogseed.dashboard.watch', 'autoTasks.events'].includes(channel))).toBe(true);
  expect(report.scenarios).toEqual([1280, 600].flatMap(width =>
    ['default', 'started', 'expanded', 'collapsed', 'terminal'].map(state => ({ width, state }))));
}, 70_000);
