import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRendererCss() {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
}

function readShellCss() {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/shell-navigation.css'), 'utf8');
}

const tokensCss = fs.readFileSync(path.join(__dirname, '../../src/renderer/tokens.css'), 'utf8');

function zIndexForSelector(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?z-index:\\s*([^;]+)`));
  if (!match) return null;
  const raw = match[1].trim();
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) return numeric;
  // 层级已收敛为 token：解析 var(--z-*) 到 tokens.css 里的数值。
  const tokenMatch = raw.match(/^var\((--z-[a-z-]+)\)$/);
  if (tokenMatch) {
    const def = tokensCss.match(new RegExp(`${tokenMatch[1].replace(/-/g, '\\-')}\\s*:\\s*(\\d+)`));
    if (def) return Number(def[1]);
  }
  return null;
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

  it('keeps the user menu above its trigger with the shared popover layer', () => {
    const css = readRendererCss();
    // 锚定行首主块（折叠态的 body.sidebar-collapsed .hub-chip-menu 在更前面）。
    const menuBlock = css.match(/^\.hub-chip-menu\s*\{[\s\S]*?\}/m)?.[0] || '';
    expect(menuBlock).toContain('bottom: calc(100% + 6px)');
    expect(menuBlock).toContain('z-index: var(--z-popover)');
    expect(menuBlock).toContain('padding: var(--space-1)');
  });

  it('removes the collapsed rail while keeping the shell recovery entry', () => {
    const shellCss = readShellCss();
    // 折叠态现在区分「peek 预览」：主块带 :not(.sidebar-peek) 限定，语义不变。
    expect(shellCss).toMatch(/body\.sidebar-collapsed(?::not\(\.sidebar-peek\))? \.sidebar\s*\{[^}]*width:\s*0 !important/);
    expect(shellCss).toMatch(/body\.sidebar-collapsed(?::not\(\.sidebar-peek\))? \.sidebar > \*\s*\{[^}]*display:\s*none/);
    expect(shellCss).toMatch(/body\.shell-sidebar-hidden \.ui-page-header__shell,\s*body\.shell-no-sidebar \.ui-page-header__shell\s*\{[^}]*display:\s*flex/);
  });

  it('keeps open and active state styles for the footer user menu', () => {
    const css = readRendererCss();
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip\s*\{/);
    expect(css).toMatch(/\.sidebar-footer-account\.is-open \.hub-chip-chev\s*\{/);
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
