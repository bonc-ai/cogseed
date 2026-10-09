// `hidden` 必须真的隐藏。
//
// 2026-09-21 报障：「没检查到新版本时『下载更新』不该出现」修好状态判定之后，按钮
// 依然在页面上，而且点下去没反应。原因是 `.btn` / `.ui-button` 都在作者样式里声明了
// `display: inline-flex`，作者样式优先级高于 UA 的 `[hidden] { display: none }`：
//   · 元素带 `hidden=true` 仍然被布局出来（真机实测 78×28，且能命中点击）；
//   · 于是业务代码在点击回调里按状态 return，表现出来就是「按钮在、点不动」。
//
// 这条闸门盯住"共享按钮与设置行容器必须声明 [hidden] 覆盖"，否则同类问题会以
// "按钮/空行莫名其妙还在"的形式重新出现。CSS 的渲染结果由真机 Electron 校验，
// 这里只锁住这条声明不被顺手删掉。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

/** 该选择器块里是否用 `!important` 把 display 压成 none（选择器允许是逗号列表）。 */
function hidesWhenHidden(source: string, selector: string): boolean {
  // 先去注释：注释里没有花括号，但会被当成选择器文本的一部分，导致选择器比对失败。
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    if (/display\s*:\s*none\s*!important/.test(match[2])) return true;
  }
  return false;
}

describe('hidden attribute wins over component display', () => {
  it('shared buttons collapse when hidden', () => {
    const css = read('src/renderer/ui-components.css');
    // 前提：这两个类确实声明了 display，因而必须自带 [hidden] 覆盖。
    expect(css).toMatch(/\.ui-button\s*\{[^}]*display\s*:/);
    expect(read('src/renderer/style.css')).toMatch(/\.btn\s*\{[^}]*display\s*:/);
    expect(hidesWhenHidden(css, '.btn[hidden]')).toBe(true);
    expect(hidesWhenHidden(css, '.ui-button[hidden]')).toBe(true);
    // 图标按钮同属共享按钮家族，同样是作者样式的 display:inline-flex。
    expect(css).toMatch(/\.ui-icon-button\s*\{[^}]*display\s*:/);
    expect(hidesWhenHidden(css, '.ui-icon-button[hidden]')).toBe(true);
  });

  it('the settings update row container collapses when hidden', () => {
    const css = read('src/renderer/style.css');
    expect(css).toMatch(/\.settings-about-rows\s*\{[^}]*display\s*:/);
    expect(hidesWhenHidden(css, '.settings-about-rows[hidden]')).toBe(true);
  });

  it('keeps the per-element [hidden] patches this app already relies on', () => {
    const css = read('src/renderer/style.css');
    // 这两个是同一类问题的既有补丁：删掉任何一个，对应的行/横幅就会"隐藏不掉"。
    expect(css).toMatch(/\.settings-row\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
    expect(css).toMatch(/\.updater-banner\[hidden\]\s*\{[^}]*display\s*:\s*none/);
  });
});
