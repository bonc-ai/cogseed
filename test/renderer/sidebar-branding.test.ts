import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/style.css'), 'utf8');
const narrowBlock = css.match(/@container\s*\(max-width:\s*230px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

describe('sidebar branding at narrow widths', () => {
  it('keeps the brand text visible and drops the version label', () => {
    const sidebarRule = css.match(/\.sidebar\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const iconRule = css.match(/\.logo-icon\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const textRule = css.match(/\.logo-text\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    expect(sidebarRule).toContain('container-type: inline-size');
    expect(css).not.toMatch(/\.sidebar-logo-version/);

    // Fixed-size icon so narrowing never resizes or recenters it.
    expect(iconRule).toContain('width: 28px');
    expect(iconRule).toContain('height: 28px');

    expect(textRule).toContain('font-size: 14px');
    expect(textRule).toContain('transition: font-size 0.2s ease');

    // Narrow state shrinks only the text: no icon override, no alignment
    // jump, and the text stays visible.
    expect(narrowBlock).toContain('font-size: 12px');
    expect(narrowBlock).not.toContain('.logo-icon');
    expect(narrowBlock).not.toContain('justify-content');
    expect(narrowBlock).not.toContain('display: none');
  });
});
