import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('skill card shared UI adoption', () => {
  it('integrates the shared resource toolbar into the production skills page', () => {
    const html = read('src/renderer/index.html');
    const source = read('src/renderer/modules/skills.js');
    const css = read('src/renderer/style.css');

    expect(html).toContain('class="skills-resource-toolbar"');
    expect(html).toContain('id="skills-search-field"');
    expect(html).toContain('class="btn ui-button ui-button--secondary ui-button--sm" id="create-skill-btn"');
    expect(source).toContain("placeholder: t('skills.search_placeholder')");
    expect(source).toContain("ariaLabel: t('skills.category_filter_label')");
    expect(source).toContain("title: t('skills.no_match')");
    expect(css).toMatch(/\.skills-resource-toolbar\s*{[^}]*display:\s*flex;[^}]*margin-bottom:\s*var\(--space-4\);/);
    expect(css).toMatch(/\.skills-embedded-panel \.skills-grid-header\s*{[^}]*display:\s*none;/);
  });

  it('requires production shared primitives instead of local fallbacks', () => {
    const source = read('src/renderer/modules/skills.js');

    for (const seam of ['uiButton', 'uiIconButton', 'uiSegmentedControl', 'uiInput', 'uiTextarea', 'uiEmptyState']) {
      expect(source).toContain(`skills require ${seam}`);
    }
    expect(source).not.toContain('function _skillUiAttrsHtml');
  });

  it('routes standard card actions through shared buttons and icons', () => {
    const source = read('src/renderer/modules/skills.js');

    expect(source).toMatch(/icon: 'more-horizontal',\r?\n      className: 'skill-card-more'/);
    expect(source).toMatch(/role: 'primary',\r?\n      size: 'sm',\r?\n      className: 'skill-card-use'/);
    expect(source).toMatch(/role: 'secondary',\r?\n      size: 'sm',\r?\n      icon: expanded \? 'chevron-down' : 'chevron-right'/);
    expect(source).toContain("className: 'skills-security-recheck'");
    expect(source).not.toContain('>⋯</button>');
    expect(source).not.toContain('class="skills-security-recheck" data-skills-recheck');
  });

  it('keeps only layout composition on the skill card action classes', () => {
    const css = read('src/renderer/style.css');

    expect(css).toContain('.skill-card-more.ui-icon-button {');
    expect(css).toContain('width: var(--control-height-sm);');
    expect(css).toContain('.skill-card-more:focus-visible { opacity: 1; pointer-events: auto; }');
    expect(css).toContain('.skill-card-actions > .skill-card-use.ui-button { margin-left: auto; }');
    expect(css).toContain('.skill-card-disclosure.ui-button {');
    expect(css).toContain('.skills-security-recheck.ui-button { flex: 0 0 auto; }');
    expect(css).toMatch(/\.skill-card\s*{[^}]*min-height:\s*176px;/);
    expect(css).toMatch(/\.skills-source-section-head\s*{[^}]*border-bottom:\s*1px solid var\(--line-hairline\);/);
  });
});
