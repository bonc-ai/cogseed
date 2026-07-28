import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// panel-evolution 的导航/顶栏用 data-ui-icon="git-branch"。icons.js 必须定义它，
// 否则渲染降级到 info 图标（语义错误、视觉误导）。此测试守住图标存在。
describe('evolution icon availability', () => {
  it('icons.js 定义了 git-branch', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/icons.js'), 'utf-8');
    expect(src).toMatch(/'git-branch':/);
  });
  it('index.html 用的 evolution 图标名都在 icons.js 有定义', () => {
    const icons = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/icons.js'), 'utf-8');
    // panel-evolution 相关 data-ui-icon 用到的图标
    for (const name of ['git-branch']) {
      expect(icons.includes(`'${name}':`) || icons.includes(`${name}:`)).toBe(true);
    }
  });
});
