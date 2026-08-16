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
    const menuBlock = css.match(/\.hub-chip-menu\s*\{[\s\S]*?\}/)?.[0] || '';
    // 与状态栏重叠 6px：hover 在入口与面板之间移动不经过空隙、不闪断。
    expect(menuBlock).toContain('bottom: calc(100% - 6px)');
    expect(menuBlock).toContain('z-index: 120');
    expect(menuBlock).toContain('padding: 6px 6px 14px');
  });

  it('keeps open / pinned / active state styles for the merged footer panel', () => {
    const css = readRendererCss();
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip\s*\{/);
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip-chev\s*\{/);
    expect(css).toMatch(/\.sidebar-footer-account\.is-pinned \.hub-chip-pin\s*\{/);
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
