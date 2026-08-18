import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 渲染层样式表的花括号必须闭合。
 *
 * 为什么值得单独一条测试：CSS 解析器遇到未闭合的块**不会报错**，而是把后面
 * 所有规则一路吞进那个块。a785e631 删除引用页脚 UI 时删掉了一个
 * `@media (max-width: 560px)` 的内容和右花括号、留下开括号，结果
 * recall-local.css 末尾 60 多条规则全部变成"只在 ≤560px 生效"——「使用与证明」
 * 的逐条展开、六段链条、回执与评价面板在桌面宽度下一条都没生效，事件行退回
 * 浏览器默认 <button> 外观（灰底、按内容宽度），排成参差的阶梯块。
 *
 * 这个故障存活了很多个提交：typecheck 看不到 CSS，单元测试不加载样式表，
 * 页面也不报错——只有量真实计算样式才看得出来。所以在这里钉一条最廉价的
 * 结构断言。
 */
const RENDERER_DIR = path.join(__dirname, '../../src/renderer');

function stylesheets(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // vendor/ 是第三方产物，不由本仓库维护，坏了也不该由这条测试拦。
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : stylesheets(path.join(dir, entry.name));
    return entry.name.endsWith('.css') ? [path.join(dir, entry.name)] : [];
  });
}

/** 花括号计数前先剥注释：注释里出现 `{` 是合法的，算进去会误报。 */
function braceBalance(source: string): { depth: number; lowest: number } {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let lowest = 0;
  for (const char of stripped) {
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth < lowest) lowest = depth;
    }
  }
  return { depth, lowest };
}

describe('renderer stylesheets', () => {
  const files = stylesheets(RENDERER_DIR);

  it('finds the renderer stylesheets to check', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('recall-local.css'))).toBe(true);
  });

  it.each(files.map((file) => path.relative(RENDERER_DIR, file)))(
    '%s closes every block it opens',
    (relative) => {
      const { depth, lowest } = braceBalance(fs.readFileSync(path.join(RENDERER_DIR, relative), 'utf8'));
      // depth > 0：有块没闭合，它会吞掉文件后面的全部规则。
      expect(depth, `${relative}: ${depth} 个未闭合的 {`).toBe(0);
      // lowest < 0：多了右花括号，从那里开始后续规则会落到错误的层级。
      expect(lowest, `${relative}: 出现了多余的 }`).toBe(0);
    },
  );
});
