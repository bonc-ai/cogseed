// 真机回归：通过 @ 入口勾选成员后，焦点归还输入框时插入点不能丢到开头。
//
// 只有真实 Chromium 能复现：fake DOM 没有「focus 事件之后浏览器放置默认 caret」这一步，
// 而旧实现正是被这一步覆盖，并把假的 0 写回 textarea（权威插入点），于是 api.focus()
// 读到 0，用户看到光标跳回最左边。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

describe('composer caret across picker focus round-trip in Chromium', () => {
  // Windows hosted Chromium exits with STATUS_BREAKPOINT (0x80000003) on sibling fixtures.
  it.skipIf(process.platform === 'win32')('keeps the insertion point after the picker hands focus back', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/composer-caret-focus.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(output);
    expect(parsed.error, `${parsed.error || ''}\n${parsed.stack || ''}\n${result.stderr || ''}`).toBeUndefined();
    expect(parsed.failed).toEqual([]);
    expect(parsed.passed).toBe(parsed.total);
    expect(parsed.total).toBeGreaterThanOrEqual(5);
    expect(result.status).toBe(0);
  }, 70000);
});
