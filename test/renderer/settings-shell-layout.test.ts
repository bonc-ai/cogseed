import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('standalone settings shell and sidebar UserMenu', () => {
  it('replaces the application rail with the dedicated settings navigation', () => {
    const html = read('src/renderer/index.html');
    const css = read('src/renderer/style.css');
    const shellCss = read('src/renderer/shell-navigation.css');
    const categories = [
      ['data', 'database'],
      ['configuration', 'key'],
      ['account', 'lock'],
      ['usage', 'clock'],
      ['general', 'settings'],
      ['security', 'shield'],
      ['about', 'info'],
    ];

    for (const [category, icon] of categories) {
      expect(html).toContain(`data-settings-tab="${category}"`);
      expect(html).toContain(`data-settings-pane="${category}"`);
      expect(html).toContain(`data-ui-icon="${icon}" data-ui-icon-class="settings-tab-icon"`);
    }
    expect(html).toContain('id="settings-back-btn"');
    expect(html.match(/class="settings-pane-title"/g)).toHaveLength(7);
    expect(css).toMatch(/body:has\(#panel-settings\.active\) > \.app-container > \.sidebar,[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/#panel-settings\s*\{[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.settings-container\s*\{[^}]*grid-template-columns:\s*var\(--layout-settings-nav-width\) minmax\(0, 1fr\);/s);
    expect(shellCss).toContain('body:has(#panel-settings.active) #settings-page-header .ui-page-header');
  });

  it('uses the shared UserMenu renderer in the real shell and gallery', () => {
    const html = read('src/renderer/index.html');
    const account = read('src/renderer/modules/account-chip.js');
    const gallery = read('src/renderer/component-gallery.html');
    const galleryScript = read('src/renderer/component-gallery.js');

    expect(html).toContain('./modules/ui-user-menu.js');
    expect(html.indexOf('./modules/ui-user-menu.js')).toBeLessThan(html.indexOf('./modules/account-chip.js'));
    expect(account).toContain('window.uiUserMenuTrigger({');
    expect(account).toContain('window.uiUserMenuPanel({');
    expect(gallery).toContain('id="user-menu-specimens"');
    expect(gallery).toContain('./modules/ui-user-menu.js');
    expect(galleryScript).toContain('function renderUserMenus()');
  });

  it('keeps the About pane changelog entry on the standalone changelog page', () => {
    // 2026-09-20 需求：关于我们里的「版本介绍」改名「更新日志」，跳转从官网
    // 首页锚点（#view=changelog）改到独立页 /changelog/。改名和换地址是一次
    // 动作：文案留在语言表、地址留在结构里，两边任何一半漏改都会退回旧入口。
    const html = read('src/renderer/index.html');
    const entry = html.match(/<a\b[^>]*data-i18n="settings\.updates\.view_intro"[^>]*>[^<]*<\/a>/i)?.[0] || '';

    expect(entry).not.toBe('');
    expect(entry).toContain('href="https://hub.example.com/changelog/"');
    expect(entry).toContain('target="_blank"');
    expect(entry).toContain('rel="noopener noreferrer"');
    expect(entry).not.toContain('#view=changelog');

    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const table = JSON.parse(read(`src/renderer/locales/${locale}.json`)) as Record<string, string>;
      expect(table['settings.updates.view_intro'], `${locale} 缺更新日志入口文案`).toBeTruthy();
    }
    const zh = JSON.parse(read('src/renderer/locales/zh.json')) as Record<string, string>;
    expect(zh['settings.updates.view_intro']).toBe('更新日志');
  });
});
