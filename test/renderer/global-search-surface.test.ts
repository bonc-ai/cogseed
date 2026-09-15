import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const tokens = read('src/renderer/tokens.css');
const components = read('src/renderer/ui-components.css');
const gallery = read('src/renderer/component-gallery.css');
const index = read('src/renderer/index.html');

describe('global search surface integration', () => {
  it('uses the shared dialog scrim and elevation without blurring the workspace', () => {
    expect(tokens).toContain('--color-command-scrim: var(--color-scrim);');
    expect(components).toMatch(/\.search-overlay,\s*\.gallery-command-overlay\s*\{[\s\S]*?background: var\(--color-scrim\);[\s\S]*?backdrop-filter: none;/);
    expect(components).toMatch(/\.search-overlay \.search-modal,\s*\.gallery-command\s*\{[\s\S]*?border-radius: var\(--radius-dialog\);[\s\S]*?box-shadow: var\(--shadow-dialog\);/);
    expect(gallery).not.toContain('background: var(--color-command-scrim)');
    expect(gallery).not.toContain('backdrop-filter: blur(2px)');
  });

  it('keeps the real page on the command layer with a responsive top offset', () => {
    expect(index).toContain('class="search-overlay" id="search-overlay"');
    expect(index).toContain('class="search-modal" role="dialog" aria-modal="true"');
    expect(components).toContain('.search-overlay { z-index: var(--z-command); }');
    expect(components).toContain('padding: clamp(64px, 10vh, var(--space-page)) var(--space-4) var(--space-4);');
    expect(components).toContain('max-height: calc(100dvh - clamp(64px, 10vh, var(--space-page)) - var(--space-4));');
  });
});
