import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');

describe('skills asset center layout', () => {
  it('keeps the Recall-style five tabs inside the skills asset center', () => {
    for (const page of ['overview', 'skills', 'candidates', 'receipts', 'assets']) {
      expect(html).toContain(`data-cognition-page="${page}"`);
      expect(html).toContain(`data-cognition-page-body="${page}"`);
    }
  });

  it('keeps the original skill library UI inside the Skills tab', () => {
    const skillsSectionStart = html.indexOf('id="skills-cognition-skills"');
    expect(skillsSectionStart).toBeGreaterThan(0);
    const skillsSectionEnd = html.indexOf('id="skills-cognition-candidates"');
    expect(skillsSectionEnd).toBeGreaterThan(skillsSectionStart);
    const skillsTabHtml = html.slice(skillsSectionStart, skillsSectionEnd);
    expect(skillsTabHtml).toContain('id="skills-grid-view"');
    expect(skillsTabHtml).toContain('id="create-skill-btn"');
    expect(skillsTabHtml).toContain('id="skills-more-btn"');
    expect(skillsTabHtml).toContain('id="skills-categories"');
    expect(skillsTabHtml).toContain('id="skills-grid"');
    expect(skillsTabHtml).toContain('id="skills-detail-view"');
    expect(skillsTabHtml).toContain('id="skills-chat-input"');
  });

  it('wraps header, tabs, and pages in one integrated surface', () => {
    expect(html).toContain('class="skills-cognition-surface"');
    const surfaceStart = html.indexOf('class="skills-cognition-surface"');
    const surfaceEnd = html.indexOf('<!-- Agents -->');
    expect(surfaceStart).toBeGreaterThan(0);
    expect(surfaceEnd).toBeGreaterThan(surfaceStart);
    const surfaceHtml = html.slice(surfaceStart, surfaceEnd);
    expect(surfaceHtml).toContain('class="skills-cognition-header"');
    expect(surfaceHtml).toContain('id="skills-cognition-tabs"');
    expect(surfaceHtml).toContain('id="skills-cognition-assets"');
  });


  it('uses PRD page semantics for cognition candidates and ability assets', () => {
    expect(html).toContain('data-i18n="cognition.candidates"');
    expect(html).toContain('data-i18n="cognition.assets"');
    expect(html).toContain('data-ability-assets-view="list"');
    expect(html).toContain('data-ability-assets-view="tree"');
    expect(html).not.toContain('data-ability-assets-view="evidence"');
    expect(html).toContain('data-ability-assets-view-panel="list"');
    expect(html).toContain('data-ability-assets-view-panel="tree"');
    expect(html).not.toContain('data-ability-assets-view-panel="evidence"');
  });


  it('keeps ability asset status chips compact inside list rows', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8');
    expect(css).toContain('.ability-asset-list-row .skills-cognition-status');
    expect(css).toContain('align-self: start');
    expect(css).toContain('height: fit-content');
  });

});
