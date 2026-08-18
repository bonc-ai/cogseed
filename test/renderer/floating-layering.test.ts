import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRendererCss() {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
}

function zIndexForSelector(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

describe('floating layer ordering', () => {
  it('keeps body-level pickers above shared dialog overlays', () => {
    const css = readRendererCss();
    const dialogZ = zIndexForSelector(css, '.ui-dialog-overlay');
    expect(dialogZ).not.toBeNull();

    for (const selector of ['.ai-select-popover', '.skill-picker']) {
      const pickerZ = zIndexForSelector(css, selector);
      expect(pickerZ, selector).not.toBeNull();
      expect(pickerZ, selector).toBeGreaterThan(dialogZ as number);
    }
  });

  it('keeps the merged footer panel seamlessly attached to its trigger', () => {
    const css = readRendererCss();
    // 锚定行首主块（折叠态的 body.sidebar-collapsed .hub-chip-menu 在更前面）。
    const menuBlock = css.match(/^\.hub-chip-menu\s*\{[\s\S]*?\}/m)?.[0] || '';
    // 与状态栏重叠 6px：面板与入口视觉连成一体。
    expect(menuBlock).toContain('bottom: calc(100% - 6px)');
    expect(menuBlock).toContain('z-index: 120');
    expect(menuBlock).toContain('padding: 6px 6px 14px');
  });

  it('keeps the collapsed-rail footer entry alive as an icon trigger', () => {
    const css = readRendererCss();
    // 侧栏折叠（48px 窄条）时融合入口仍常驻：只留头像图标，面板加最小宽度。
    expect(css).toMatch(/body\.sidebar-collapsed \.sidebar-footer-account\s*\{\s*display: block/);
    expect(css).toMatch(/body\.sidebar-collapsed \.hub-chip-meta,[\s\S]*?\{ display: none; \}/);
    expect(css).toContain('width: 236px');
  });

  it('keeps open / collapse / active state styles for the merged footer panel', () => {
    const css = readRendererCss();
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip\s*\{/);
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip-chev\s*\{/);
    const collapseBlock = css.match(/\.hub-chip-menu-collapse\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(collapseBlock).toContain('justify-content: center');
    expect(css).toMatch(/\.hub-chip-menu-collapse:hover\s*\{/);
    const activeBlock = css.match(/\.hub-chip-menu-item\.is-active\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(activeBlock).toContain('background: var(--primary-soft)');
    expect(activeBlock).toContain('color: var(--primary-text)');
  });

  it('keeps the generic has-dot rules from leaking past their opt-in class', () => {
    const css = readRendererCss();
    expect(css).toContain('.has-dot:not(.sidebar-footer-btn)::after');
    expect(css).not.toMatch(/(^|[,\n]\s*)\.has-dot::after\s*\{/);
    expect(css).not.toMatch(/(^|[,\n]\s*)\.has-dot\.is-(red|orange)::after\b/);
  });

  it('keeps primary disabled buttons visually disabled', () => {
    const css = readRendererCss();
    const primaryBlock = css.match(/\.btn-primary:disabled\s*\{[\s\S]*?\}/)?.[0] || '';

    expect(primaryBlock).toContain('opacity: 0.6');
    expect(primaryBlock).toContain('cursor: not-allowed');
  });
});
