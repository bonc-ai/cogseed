import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

describe('skill detail design-system layout', () => {
  it('shares the resource detail measure and document surfaces', () => {
    const label = css.match(/\.skills-doc-section-label\s*{([^}]*)}/)?.[1] || '';

    expect(css).toMatch(/\.skills-doc-section\s*{[^}]*var\(--layout-resource-detail-width\)/);
    expect(label).toContain('color: var(--text-heading);');
    expect(label).toContain('font-weight: var(--font-weight-medium);');
    expect(css).toMatch(/#skills-detail-body\.skills-detail-body:not\(\.skills-detail-editing\),[\s\S]*?border:\s*1px solid var\(--line-default\);[\s\S]*?background:\s*var\(--surface-card\);/);
  });
});
