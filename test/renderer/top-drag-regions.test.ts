import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'src/renderer/workspace.css'), 'utf8');
const modelChip = fs.readFileSync(path.join(root, 'src/renderer/modules/model-chip.js'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const sidebarResize = fs.readFileSync(path.join(root, 'src/renderer/modules/sidebar-resize.js'), 'utf8');

describe('macOS top drag regions', () => {
  it.each(['connections', 'workspace'])('covers the %s panel top edge', (panel) => {
    expect(html).toMatch(new RegExp(`id="panel-${panel}"[\\s\\S]*?class="app-top-drag-strip"`));
  });

  it('keeps Connections tabs and unified page headers above the drag strip', () => {
    const raisedHeaderRule = css.match(/\.is-macos \.connections-tabs,\s*\.is-macos \.ws-page-top,\s*\.is-macos \.ui-page-header\s*{([^}]*)}/)?.[1] || '';
    expect(raisedHeaderRule).toContain('z-index: calc(var(--z-raised) + 1);');
    expect(css).toMatch(/\.is-macos \.ws-page-top button,[\s\S]*?\.is-macos \.connections-tabs button,[\s\S]*?-webkit-app-region:\s*no-drag;/);
    expect(css).toMatch(/\.is-macos \.ws-page-top button,[\s\S]*?\.is-macos \.ws-page-top input,[\s\S]*?-webkit-app-region:\s*no-drag;/);
    expect(css).toMatch(/\.is-macos \.ui-page-header button,[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });

  it('keeps the sticky Workspace detail header draggable while preserving its controls', () => {
    expect(workspaceCss).toMatch(/\.ws-space-head\s*{[^}]*position:\s*sticky;[^}]*z-index:\s*var\(--z-sticky\);/);
    expect(css).toMatch(/\.is-macos \.ws-page-top,[\s\S]*?\.is-macos \.ws-space-head,[\s\S]*?-webkit-app-region:\s*drag;/);
    expect(css).toMatch(/\.is-macos \.ws-space-head button,[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });

  it('makes the Knowledge Base top navigation draggable without swallowing its tabs', () => {
    expect(css).toMatch(/\.is-macos \.kb-eco-topnav,[\s\S]*?-webkit-app-region:\s*drag;/);
    expect(css).toMatch(/\.is-macos \.kb-eco-topnav button,[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });

  it('does not turn the full-width home action container into a no-drag strip', () => {
    const containerRule = css.match(/\.is-macos \.main-top-actions\s*{([^}]*)}/)?.[1] || '';
    expect(containerRule).not.toContain('-webkit-app-region');
    expect(css).toMatch(/\.is-macos \.model-guard-banner,[\s\S]*?\.is-macos \.main-top-actions button\s*{[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });

  it('closes and bounds the floating model menu when its viewport or view changes', () => {
    expect(modelChip).toContain('function _clampMenuLeft(preferredLeft, menuWidth)');
    expect(modelChip).toContain("window.addEventListener('resize', onViewportChange)");
    expect(modelChip).toContain("document.addEventListener('scroll', onViewportChange, true)");
    expect(modelChip).toContain('window.closeModelChipMenu = _closeModelMenu');
    expect(boot).toContain("if (typeof window.closeModelChipMenu === 'function') window.closeModelChipMenu();");
    expect(css).toMatch(/\.model-chip-menu\s*{[^}]*max-width:\s*min\(320px, calc\(100vw - 16px\)\);[^}]*z-index:\s*var\(--z-modal\);/s);
  });

  it('keeps the menu open when the SCROLL comes from inside the menu itself', () => {
    // 回归钉子：dismiss 在 document 上挂 capture scroll 监听，本意是页面
    // 滚动导致锚点移位时收起悬浮菜单；但菜单自身滚动（模型列表翻页、
    // 搜索框横滚）也会被 capture 捕获——用户滚一下菜单就秒关，长清单
    // 根本翻不动。onViewportChange 必须忽略来自菜单内部的 scroll。
    expect(modelChip).toContain('const t = e && e.target;');
    expect(modelChip).toContain('if (t && t.nodeType && (t === menu || menu.contains(t))) return;');
  });

  it('styles the model menu drill-down controls as inline icons, not full-width buttons', () => {
    // 回归钉子：model-chip.js 会生成 .model-chip-menu-arrow / -back /
    // -loading，但这批类曾完全没有 CSS——行容器是 column 布局，箭头按钮
    // 参与流式排版后被拉成文字下方的整行宽大按钮（吃全局按钮样式）。
    // 箭头必须绝对定位贴右缘；返回钮/状态文字必须去默认按钮框。
    expect(css).toMatch(/\.model-chip-menu--exec \.model-chip-menu-item:has\(> \.model-chip-menu-arrow\)\s*{\s*padding-right:/);
    expect(css).toMatch(/\.model-chip-menu-arrow\s*{[^}]*position:\s*absolute;[^}]*border:\s*none;/);
    expect(css).toMatch(/\.model-chip-menu-back\s*{[^}]*border:\s*none;/);
    expect(css).toMatch(/\.model-chip-menu-loading\s*{[^}]*color:\s*var\(--muted\);/);
  });

  it('ends a sidebar resize when the pointer leaves the window', () => {
    expect(sidebarResize).toContain("window.addEventListener('blur', onUp)");
    expect(sidebarResize).toContain("document.documentElement.addEventListener('mouseleave', onUp)");
    expect(sidebarResize).toContain("window.removeEventListener('blur', onUp)");
    expect(sidebarResize).toContain("document.documentElement.removeEventListener('mouseleave', onUp)");
  });
});
