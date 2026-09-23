// 首页多 Agent 选择与展示的真实 DOM 验收（优化说明 v0.17 第 8.5 条）。
//
// CSS 源码契约测试只能保证「规则里没有 display:none」，防不住别的规则间接隐藏
// 核心信息；这里在真实 Chromium 里用真实 index.html 结构 + 生产 CSS 量 computed
// style，并在真实 composer-members.js 渲染的候选列表上验证三态与摘要一致。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

describe('home multi-agent selection in Chromium', () => {
  // Windows hosted Chromium exits with STATUS_BREAKPOINT (0x80000003) on the sibling fixture.
  it.skipIf(process.platform === 'win32')('keeps member/model names visible and renders every candidate state', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/composer-multiselect-dom.cjs')], {
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    const output = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(output);
    expect(parsed.error, `${parsed.error || ''}\n${parsed.stack || ''}\n${result.stderr || ''}`).toBeUndefined();
    expect(parsed.failed).toEqual([]);
    expect(parsed.passed).toBe(parsed.total);
    expect(parsed.total).toBeGreaterThanOrEqual(18);
    expect(result.status).toBe(0);
  }, 70000);
});
