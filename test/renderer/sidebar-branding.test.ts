import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/style.css'), 'utf8');

describe('sidebar branding at narrow widths', () => {
  it('uses a background-free version label and an icon-only compact state', () => {
    const sidebarRule = css.match(/\.sidebar\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const versionRule = css.match(/\.sidebar-logo-version\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    expect(sidebarRule).toContain('container-type: inline-size');
    expect(versionRule).toContain('background: transparent');
    expect(versionRule).toContain('min-width: 0');
    expect(css).toContain('.logo-text {\n  font-weight: 600;\n  font-size: 14px;\n  letter-spacing: -0.01em;\n  color: var(--text);\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}');
    expect(css).toMatch(/@container\s*\(max-width:\s*230px\)\s*\{[\s\S]*?\.sidebar-logo\s*\{[\s\S]*?justify-content:\s*center/);
    expect(css).toMatch(/@container\s*\(max-width:\s*230px\)\s*\{[\s\S]*?\.logo-text,[\s\S]*?\.sidebar-logo-version\s*\{[\s\S]*?display:\s*none/);
  });
});
