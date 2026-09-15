import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Run Center global entry overlay boundary', () => {
  it('places exactly one resident entry between shell search and collapse, outside the sidebar', () => {
    const html = read('src/renderer/index.html');
    const tools = read('src/renderer/modules/ui-sidebar-tools.js');
    expect(html.indexOf('id="app-shell-tools"')).toBeLessThan(html.indexOf('<aside class="sidebar">'));
    expect(tools.match(/id="run-center-global-entry"/g)).toHaveLength(1);
    expect(tools).toMatch(/sidebar-search-btn[\s\S]*?run-center-global-entry[\s\S]*?sidebar-collapse-btn/);
    expect(html.split('<aside class="sidebar">')[1].split('</aside>')[0]).not.toContain('run-center-global-entry');
  });

  it('keeps the popover outside clipping containers and the icon usable in compact rails', () => {
    const css = read('src/renderer/style.css');
    const shellCss = read('src/renderer/shell-navigation.css');
    const globalRunCenter = read('src/renderer/modules/run-center-global.js');
    expect(globalRunCenter).toContain('document.body.appendChild(target)');
    expect(css).not.toContain('.main-content:not(:has(#panel-new-chat.active)) .run-center-global-btn');
    expect(shellCss).toContain('.shell-sidebar-hidden #run-center-global-entry');
    expect(shellCss).toMatch(/\.shell-sidebar-hidden #sidebar-search-btn,[\s\S]*?display:\s*none/);
    expect(shellCss).toMatch(/\.app-shell-tools \.run-center-global-btn\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.run-center-global-btn\.ui-icon-button\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.run-center-global-badge\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.run-center-quick-panel\s*\{[^}]*z-index:\s*var\(--z-popover\)/);
  });

  it('closes an open quick panel whenever view routing changes', () => {
    const globalRunCenter = read('src/renderer/modules/run-center-global.js');
    const boot = read('src/renderer/modules/boot.js');

    expect(globalRunCenter).toContain('function close()');
    expect(globalRunCenter).toContain('root.closeRunCenterGlobal = close;');
    expect(boot).toContain("if (typeof window.closeRunCenterGlobal === 'function') window.closeRunCenterGlobal();");
  });
});
