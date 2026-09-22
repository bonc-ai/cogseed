import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'src/renderer/workspace.css'), 'utf8');
const modelChip = fs.readFileSync(path.join(root, 'src/renderer/modules/model-chip.js'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const sidebarResize = fs.readFileSync(path.join(root, 'src/renderer/modules/sidebar-resize.js'), 'utf8');
const shellNavigation = fs.readFileSync(path.join(root, 'src/renderer/shell-navigation.css'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');

describe('macOS top drag regions', () => {
  it('bounds panel drag strips to main content so shell tools keep mouse hit targets', () => {
    const mainContentRule = css.match(/\.main-content\s*\{([^}]*)}/)?.[1] || '';
    const dragStripRule = css.match(/\.is-macos \.app-top-drag-strip\s*\{([^}]*)}/)?.[1] || '';

    expect(mainContentRule).toContain('position: relative;');
    expect(dragStripRule).toContain('position: absolute;');
    expect(dragStripRule).not.toContain('position: fixed;');
  });

  it('keeps sidebar drag geometry outside native controls and shell tools', () => {
    const sidebarDragRule = shellNavigation.match(/\.is-macos \.sidebar::before\s*\{([^}]*)}/)?.[1] || '';
    const sidebarLogoRule = shellNavigation.match(/\.is-macos \.sidebar-logo\s*\{([^}]*)}/)?.[1] || '';

    expect(sidebarDragRule).toContain('left: 76px;');
    expect(sidebarDragRule).toContain('right: var(--shell-tools-reserved-width);');
    expect(sidebarLogoRule).toContain('-webkit-app-region: no-drag;');
  });

  it('aligns native traffic lights and keeps the collapsed recovery gutter clickable', () => {
    expect(mainIndex).toContain('trafficLightPosition: { x: 12, y: 19 }');
    expect(html.indexOf('id="app-shell-tools"')).toBeLessThan(html.indexOf('<aside class="sidebar">'));
    expect(shellNavigation).toContain('html.is-macos .shell-sidebar-hidden .app-shell-tools');
    expect(shellNavigation).toContain('--shell-expand-left: 104px;');
    expect(shellNavigation).toMatch(/html\.is-macos body\.shell-sidebar-hidden \.main-content :is\([\s\S]*?-webkit-app-region:\s*no-drag;/);
    expect(shellNavigation).toMatch(/html\.is-macos body\.shell-sidebar-hidden \.main-content :is\([\s\S]*?\.ui-page-header__body[\s\S]*?-webkit-app-region:\s*drag;/);
  });

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

  it('keeps the update reminder banner clickable inside the macOS drag band', () => {
    // 回归钉子（更新提醒按钮点击无响应）：横幅固定在 top:12px，整条落进顶部
    // 40px 的原生拖拽带里。拖拽矩形在 OS 层优先命中、连 mousedown 都进不了
    // 页面，z-index（--z-toast）拦不住——横幅必须显式退出拖拽命中，
    // 否则页面上只有它在拖窗口，「查看更新 / 稍后」按下去没有任何反应。
    expect(css).toMatch(/\.is-macos \.updater-banner\s*\{[^}]*-webkit-app-region:\s*no-drag;/);
    expect(css).toMatch(/\.updater-banner\s*\{[^}]*position:\s*fixed;[^}]*top:\s*12px;/s);
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
    // 根本翻不动。onViewportChange 必须忽略来自菜单内部的 scroll；级联
    // 飞出层（provider → 模型 → 思考强度）同属这个菜单，也必须一并忽略。
    expect(modelChip).toContain('const t = e && e.target;');
    expect(modelChip).toContain('if (t && t.nodeType && (t === menu || menu.contains(t) || _inFlyout(t))) return;');
  });

  it('styles the model menu drill-down controls as inline icons, not full-width buttons', () => {
    // 回归钉子：model-chip.js 会生成 .model-chip-menu-arrow / -loading，
    // 但这批类曾完全没有 CSS——行容器是 column 布局，箭头按钮参与流式排版
    // 后被拉成文字下方的整行宽大按钮（吃全局按钮样式）。箭头必须绝对定位
    // 贴右缘；状态文字必须去默认按钮框。级联飞出层的行同样带箭头，行距规则
    // 与主菜单 --exec 一致（飞出层不是 --exec，需自带一条）。
    expect(css).toMatch(/\.model-chip-menu--exec \.model-chip-menu-item:has\(> \.model-chip-menu-arrow\)\s*{\s*padding-right:/);
    expect(css).toMatch(/\.model-chip-menu-arrow\s*{[^}]*position:\s*absolute;[^}]*border:\s*none;/);
    expect(css).toMatch(/\.model-chip-flyout \.model-chip-menu-item:has\(> \.model-chip-menu-arrow\)\s*{[^}]*padding-right:/);
    expect(css).toMatch(/\.model-chip-menu-loading\s*{[^}]*color:\s*var\(--muted\);/);
  });

  it('cancels a deferred outside-click listener when the model menu closes immediately', () => {
    let deferredListener: (() => void) | null = null;
    const listeners: string[] = [];
    const menu: any = { contains: () => false, remove: () => { activeMenu = null; } };
    const anchor = { contains: () => false };
    let activeMenu: any = menu;
    const context: any = {
      window: {
        innerWidth: 1024, innerHeight: 768,
        addEventListener: () => {}, removeEventListener: () => {},
      },
      document: {
        getElementById: () => activeMenu,
        addEventListener: (type: string) => listeners.push(type),
        removeEventListener: () => {},
        querySelectorAll: () => [],
      },
      createLogger: () => ({ warn: () => {} }),
      setTimeout: (callback: () => void) => { deferredListener = callback; return 17; },
      clearTimeout: (timer: number) => { if (timer === 17) deferredListener = null; },
      Map, Set, Object, String, Array, Math, Promise,
      menu, anchor,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(modelChip, context);
    vm.runInContext('_bindModelMenuDismiss(menu, anchor); _closeModelMenu();', context);
    deferredListener?.();

    expect(listeners).not.toContain('mousedown');
    expect(menu._onDocDownTimer).toBeNull();
  });

  it('ends a sidebar resize when the pointer leaves the window', () => {
    expect(sidebarResize).toContain("window.addEventListener('blur', onUp)");
    expect(sidebarResize).toContain("document.documentElement.addEventListener('mouseleave', onUp)");
    expect(sidebarResize).toContain("window.removeEventListener('blur', onUp)");
    expect(sidebarResize).toContain("document.documentElement.removeEventListener('mouseleave', onUp)");
  });
});
